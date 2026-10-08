"""Servidor aiohttp: WebSocket de muestras/comandos del rodillo + API + estáticos."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from rodillo.server import ride_library
from rodillo.server.route_library import get_route, get_routes
from rodillo.settings import data_dir, load_settings, save_settings
from rodillo.tcx import session_to_tcx
from rodillo.trainer.client import Sample, TacxClient
from rodillo.trainer.hr_client import HRClient
from rodillo.trainer.ride import RidePlayer
from rodillo.trainer.session import Session
from rodillo.trainer.simulator import TacxSimulator
from rodillo.trainer.workout import WorkoutPlayer, workout_from_dict, workout_from_fit, workout_from_json

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 15_000_000
MIN_PERSIST_S = 120      # al cortar a mano, sesiones más cortas no se guardan

POWER_ZONES = [
    ("Z1", "Recuperación", 0.0, 0.55), ("Z2", "Resistencia", 0.55, 0.75), ("Z3", "Tempo", 0.75, 0.90),
    ("Z4", "Umbral", 0.90, 1.05), ("Z5", "VO2máx", 1.05, 1.20), ("Z6", "Anaeróbico", 1.20, 2.50),
]


def sessions_dir() -> Path:
    d = data_dir() / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def athlete_info() -> dict:
    s = load_settings()
    return {
        "name": s.name, "ftp_w": s.ftp_w, "ftp_day": None, "weight_kg": s.weight_kg, "max_hr": s.max_hr,
        "power_zones": [{"key": k, "name": n, "min_w": round(lo * s.ftp_w), "max_w": round(hi * s.ftp_w)}
                        for k, n, lo, hi in POWER_ZONES],
        "hr_zones": [{"key": f"Z{i + 1}", "min": lo, "max": hi} for i, (lo, hi) in enumerate(s.hr_zones())],
    }


class AppState:
    def __init__(self, trainer: TacxClient | TacxSimulator, hr_client: HRClient | None = None) -> None:
        self.trainer = trainer
        self.hr_client = hr_client
        self.simulated = isinstance(trainer, TacxSimulator)
        self.session = Session()
        self.sockets: set[web.WebSocketResponse] = set()
        self.last_sample: Sample | None = None
        self.workout = WorkoutPlayer(trainer, on_event=self._on_workout_event)
        self.ride = RidePlayer(trainer, on_event=self._on_ride_event)
        self._persisted_started_at: float | None = None
        self.refresh_athlete()

    # ----- datos del ciclista
    def refresh_athlete(self) -> dict:
        self.athlete = athlete_info()
        self.ride.rider_kg = float(self.athlete["weight_kg"])
        return self.athlete

    # ----- modos
    @property
    def combo(self) -> bool:
        """Workout ERG corriendo sobre una ruta usada como escenario."""
        return (self.workout.state in ("running", "paused")
                and self.ride.state in ("running", "paused") and not self.ride.grade_control)

    def combo_name(self) -> str:
        wk, route = self.workout.workout, self.ride.route
        name = wk.name if wk else "Workout"
        return f"{name} · en {route.name}" if route else name

    @property
    def mode(self) -> str:
        if self.combo:
            return "combo"
        if self.ride.state in ("running", "paused"):
            return "ride"
        if self.workout.state in ("running", "paused"):
            return "workout"
        return "free"

    # ----- eventos de los players
    async def _on_workout_event(self, payload: dict) -> None:
        await self._fanout(json.dumps({"type": "workout_event", "data": payload}))
        await self.broadcast_state()
        kind = payload.get("kind")
        if kind in ("finished", "error"):
            wk = self.workout.workout
            name = wk.name if wk else "Workout"
            if self.ride.state in ("running", "paused") and not self.ride.grade_control:
                name = self.combo_name()
                await self.ride.stop()
            await self.persist_session(name, finished=kind == "finished")

    async def _on_ride_event(self, payload: dict) -> None:
        await self._fanout(json.dumps({"type": "ride_event", "data": payload}))
        await self.broadcast_state()
        if payload.get("kind") in ("finished", "error"):
            await self.persist_session(f"Ruta · {payload.get('route_name') or 'libre'}",
                                       finished=payload.get("kind") == "finished")

    # ----- guardar sesión: CSV (todas las muestras) + TCX (para subir a Garmin/Strava)
    async def persist_session(self, name: str, *, finished: bool) -> str | None:
        try:
            return await self._persist_session(name, finished=finished)
        except Exception as e:  # noqa: BLE001
            logger.warning("No pude guardar la sesión: %s", e)
            return None

    async def _persist_session(self, name: str, *, finished: bool) -> str | None:
        started = self.session.started_at
        if started is None or started == self._persisted_started_at or not self.session.samples:
            return None
        stats = self.session.stats()
        if not finished and stats.duration_s < MIN_PERSIST_S:
            logger.info("Sesión de %.0fs sin terminar — no se guarda", stats.duration_s)
            return None
        self._persisted_started_at = started
        self.session.stop()
        if self.simulated:
            await self._fanout(json.dumps({"type": "session_saved", "data": {"id": None, "name": name, "simulated": True}}))
            return None
        start = datetime.now().astimezone() - timedelta(seconds=stats.duration_s)
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "sesion"
        stem = f"{start:%Y%m%d_%H%M}_{slug}"
        samples = list(self.session.samples)
        self.session.save_csv(sessions_dir() / f"{stem}.csv")
        tcx = await asyncio.to_thread(session_to_tcx, name, start, samples)
        (sessions_dir() / f"{stem}.tcx").write_text(tcx, encoding="utf-8")
        meta = {
            "name": name, "start": start.isoformat(timespec="seconds"), "duration_s": round(stats.duration_s),
            "avg_power_w": round(stats.avg_power_w) or None, "np_w": round(stats.normalized_power_w) or None,
            "avg_hr": round(stats.avg_hr_bpm) or None, "max_hr": stats.max_hr_bpm or None,
            "avg_cadence": round(stats.avg_cadence_rpm) or None, "distance_m": stats.distance_m or None,
            "finished": finished,
        }
        (sessions_dir() / f"{stem}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        logger.info("Sesión guardada: %s", stem)
        await self._fanout(json.dumps({"type": "session_saved", "data": {"id": stem, "name": name}}))
        return stem

    # ----- WebSocket
    async def _safe_send(self, ws: web.WebSocketResponse, msg: str) -> None:
        try:
            await ws.send_str(msg)
        except Exception:  # noqa: BLE001 — pestaña cerrada a mitad de envío
            self.sockets.discard(ws)

    async def _fanout(self, msg: str) -> None:
        for ws in list(self.sockets):
            if ws.closed:
                self.sockets.discard(ws)
                continue
            await self._safe_send(ws, msg)

    def on_sample(self, sample: Sample) -> None:
        if sample.heart_rate_bpm is None and self.hr_client is not None:
            sample.heart_rate_bpm = self.hr_client.latest_bpm
        ride_active = self.ride.state in ("running", "paused")
        if ride_active:
            self.ride.feed(sample.power_w, sample.cadence_rpm)
            self.ride.annotate(sample)
        self.last_sample = sample
        self.session.add(sample)
        payload: dict = {"type": "sample", "data": sample.to_dict()}
        if ride_active:
            payload["ride"] = self.ride.progress()
        if self.workout.state in ("running", "paused"):
            payload["workout"] = self.workout.progress()
        msg = json.dumps(payload)
        for ws in list(self.sockets):
            if ws.closed:
                self.sockets.discard(ws)
                continue
            asyncio.create_task(self._safe_send(ws, msg))

    async def broadcast_state(self) -> None:
        st = self.session.stats()
        await self._fanout(json.dumps({"type": "state", "data": {
            "connected": self.trainer.is_connected,
            "simulated": self.simulated,
            "target_power": self.trainer.target_power,
            "grade_pct": getattr(self.trainer, "grade_pct", None),
            "hr_connected": self.hr_client is not None and self.hr_client.is_connected,
            "hr_device_name": self.hr_client.device_name if self.hr_client else None,
            "session_active": not self.session.paused and self.session.started_at is not None,
            "mode": self.mode,
            "combo": self.combo,
            "workout": self.workout.progress(),
            "workout_loaded": self.workout.workout.to_dict() if self.workout.workout else None,
            "ride": self.ride.progress(),
            "ride_route": self.ride.route.summary() if self.ride.route else None,
            "athlete": self.athlete,
            "stats": {
                "duration_s": round(st.duration_s, 1), "samples": st.samples,
                "avg_power_w": round(st.avg_power_w, 1), "max_power_w": st.max_power_w,
                "avg_cadence_rpm": round(st.avg_cadence_rpm, 1), "avg_speed_kmh": round(st.avg_speed_kmh, 2),
                "distance_m": st.distance_m, "avg_hr_bpm": round(st.avg_hr_bpm, 1), "max_hr_bpm": st.max_hr_bpm,
                "normalized_power_w": round(st.normalized_power_w, 1),
            },
        }}))


async def _ws_error(ws: web.WebSocketResponse, message: str) -> None:
    try:
        await ws.send_str(json.dumps({"type": "error", "message": message}))
    except Exception:  # noqa: BLE001
        pass


async def _handle_command(state: AppState, cmd: dict, ws: web.WebSocketResponse) -> None:  # noqa: C901
    action = cmd.get("action")
    try:
        if action == "set_target_power":
            if state.mode != "free":
                await _ws_error(ws, "Hay un workout o ruta en curso.")
                return
            await state.trainer.set_target_power(int(cmd.get("watts", 100)))
        elif action == "set_grade":
            if state.mode != "free":
                return
            await state.trainer.set_grade(float(cmd.get("percent", 0.0)))
        elif action == "request_control":
            await state.trainer.request_control()
        elif action == "trainer_start":
            await state.trainer.start()
        elif action == "trainer_stop":
            await state.trainer.stop()
        elif action == "trainer_reset":
            await state.trainer.reset()
        elif action == "session_start":
            try:
                await state.trainer.start()
            except Exception as e:  # noqa: BLE001
                logger.warning("trainer.start desde session_start falló: %s", e)
            state.session.start()
        elif action == "session_stop":
            if state.mode == "free":
                await state.persist_session("Rodaje libre", finished=False)
            state.session.stop()
        elif action == "session_save":
            stem = await state.persist_session("Rodaje libre", finished=True)
            await ws.send_str(json.dumps({"type": "saved", "path": stem}))
        elif action == "workout_load_route":
            route = get_route(str(cmd.get("name") or ""))
            if route is None:
                await _ws_error(ws, f"Workout '{cmd.get('name')}' no encontrado")
                return
            state.workout.load(route)
        elif action == "workout_load_json":
            payload = cmd.get("workout")
            if isinstance(payload, str):
                wk = workout_from_json(payload)
            elif isinstance(payload, dict):
                wk = workout_from_dict(payload)
            else:
                await _ws_error(ws, "workout_load_json: 'workout' debe ser objeto o JSON")
                return
            state.workout.load(wk)
        elif action == "workout_start":
            if state.mode in ("ride", "combo"):
                await _ws_error(ws, "Hay una ruta en curso — terminala antes de empezar un workout.")
                return
            try:
                await state.trainer.start()
            except Exception as e:  # noqa: BLE001
                logger.warning("trainer.start desde workout_start falló: %s", e)
            fresh = state.workout.state != "paused"
            await state.workout.start()
            if fresh and (state.session.started_at is None or state.session.paused):
                state.session.start()
        elif action == "workout_pause":
            combo = state.combo
            await state.workout.pause()
            if combo:
                await state.ride.pause()
        elif action == "workout_resume":
            await state.workout.resume()
            if state.ride.state == "paused" and not state.ride.grade_control:
                await state.ride.resume()
        elif action == "workout_skip":
            await state.workout.skip()
        elif action == "workout_stop":
            was_active = state.workout.state in ("running", "paused")
            combo = state.combo
            name = state.combo_name() if combo else None
            await state.workout.stop()
            if combo:
                await state.ride.stop()
            if was_active:
                wk = state.workout.workout
                await state.persist_session(name or (wk.name if wk else "Workout"), finished=False)
        elif action == "combo_start":
            if state.mode != "free":
                await _ws_error(ws, "Ya hay algo en curso — terminalo antes.")
                return
            if state.workout.workout is None or state.ride.route is None:
                await _ws_error(ws, "Cargá un workout y una ruta de escenario.")
                return
            try:
                await state.trainer.start()
            except Exception as e:  # noqa: BLE001
                logger.warning("trainer.start desde combo_start falló: %s", e)
            state.ride.grade_control = False
            await state.ride.start()
            await state.workout.start()
            state.session.start()
        elif action == "ride_load":
            route_id = str(cmd.get("route_id") or "")
            try:
                route = await asyncio.to_thread(ride_library.get_route, route_id)
            except KeyError:
                await _ws_error(ws, f"Ruta '{route_id}' no encontrada")
                return
            except ValueError as e:
                await _ws_error(ws, f"Ruta inválida: {e}")
                return
            from_m, to_m = cmd.get("from_m"), cmd.get("to_m")
            if from_m is not None or to_m is not None:
                route = route.slice(float(from_m or 0), float(to_m or route.total_m))
            if cmd.get("name"):
                route = dataclasses.replace(route, name=str(cmd["name"])[:120])
            state.ride.load(route)
        elif action == "ride_unload":
            state.ride.unload()
        elif action == "ride_start":
            if state.mode in ("workout", "combo"):
                await _ws_error(ws, "Hay un workout en curso — terminalo antes de rodar una ruta.")
                return
            try:
                await state.trainer.start()
            except Exception as e:  # noqa: BLE001
                logger.warning("trainer.start desde ride_start falló: %s", e)
            fresh = state.ride.state != "paused"
            if fresh:
                state.ride.grade_control = True
            await state.ride.start()
            if fresh:
                state.session.start()
        elif action == "ride_pause":
            await state.ride.pause()
        elif action == "ride_resume":
            await state.ride.resume()
        elif action == "ride_stop" and state.combo:
            await _handle_command(state, {"action": "workout_stop"}, ws)
            return
        elif action == "ride_stop":
            was_active = state.ride.state in ("running", "paused")
            name = state.ride.route.name if state.ride.route else "libre"
            await state.ride.stop()
            if was_active:
                await state.persist_session(f"Ruta · {name}", finished=False)
        elif action == "ride_difficulty":
            await state.ride.set_difficulty(float(cmd.get("pct", 50)))
        else:
            logger.warning("Comando desconocido: %s", action)
            return
        await state.broadcast_state()
    except Exception as e:  # noqa: BLE001
        logger.error("Error ejecutando %s: %s", action, e)
        await _ws_error(ws, str(e))


# ---------------------------------------------------------------- HTTP ----

async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html")


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    state: AppState = request.app["state"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    state.sockets.add(ws)
    await state.broadcast_state()
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                cmd: dict[str, Any] = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            await _handle_command(state, cmd, ws)
    finally:
        state.sockets.discard(ws)
    return ws


async def api_workouts(request: web.Request) -> web.Response:
    return web.json_response({"routes": [w.to_dict() for w in get_routes()]})


async def _read_upload(request: web.Request) -> tuple[str, bytes] | web.Response:
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "file":
        return web.json_response({"error": "Falta el archivo (campo 'file')"}, status=400)
    chunks, size = [], 0
    while chunk := await field.read_chunk():
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            return web.json_response({"error": "Archivo demasiado grande"}, status=413)
        chunks.append(chunk)
    return field.filename or "archivo", b"".join(chunks)


async def api_upload_fit(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    got = await _read_upload(request)
    if isinstance(got, web.Response):
        return got
    tmp = data_dir() / "_upload.fit"
    tmp.write_bytes(got[1])
    try:
        wk = await asyncio.to_thread(workout_from_fit, tmp)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": f"No pude leer el .fit: {e}"}, status=400)
    finally:
        tmp.unlink(missing_ok=True)
    state.workout.load(wk)
    await state.broadcast_state()
    return web.json_response({"workout": wk.to_dict()})


async def api_ride_routes(request: web.Request) -> web.Response:
    routes = await asyncio.to_thread(ride_library.list_routes)
    sections = await asyncio.to_thread(ride_library.featured)
    return web.json_response({"routes": routes, "sections": sections})


async def api_ride_route(request: web.Request) -> web.Response:
    route_id = request.query.get("id", "")
    try:
        route = await asyncio.to_thread(ride_library.get_route, route_id)
    except KeyError:
        return web.json_response({"error": f"Ruta '{route_id}' no encontrada"}, status=404)
    except ValueError as e:
        return web.json_response({"error": f"Ruta inválida: {e}"}, status=422)
    try:
        f, t = request.query.get("from_m"), request.query.get("to_m")
        if f is not None or t is not None:
            route = route.slice(float(f or 0), float(t or route.total_m))
    except ValueError:
        return web.json_response({"error": "from_m/to_m inválidos"}, status=400)
    return web.json_response(route.to_dict())


async def api_ride_upload_gpx(request: web.Request) -> web.Response:
    got = await _read_upload(request)
    if isinstance(got, web.Response):
        return got
    try:
        prof = await asyncio.to_thread(ride_library.save_gpx, got[0], got[1])
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=422)
    return web.json_response({"route": prof.summary()})


async def api_settings_get(request: web.Request) -> web.Response:
    return web.json_response(dataclasses.asdict(load_settings()))


async def api_settings_post(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    try:
        data = await request.json()
        s = save_settings(data if isinstance(data, dict) else {})
    except (ValueError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)
    state.refresh_athlete()
    await state.broadcast_state()
    return web.json_response(dataclasses.asdict(s))


async def api_sessions(request: web.Request) -> web.Response:
    out = []
    for f in sorted(sessions_dir().glob("*.json"), reverse=True)[:30]:
        try:
            out.append({"id": f.stem, **json.loads(f.read_text())})
        except (OSError, ValueError):
            continue
    return web.json_response({"sessions": out})


async def api_session_tcx(request: web.Request) -> web.StreamResponse:
    sid = request.match_info["sid"]
    path = sessions_dir() / f"{sid}.tcx"
    if not re.fullmatch(r"[0-9]{8}_[0-9]{4}_[a-z0-9-]+", sid) or not path.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="{sid}.tcx"'})


def build_app(trainer: TacxClient | TacxSimulator, hr_client: HRClient | None = None) -> web.Application:
    app = web.Application(client_max_size=MAX_UPLOAD_BYTES + 1024)
    state = AppState(trainer, hr_client=hr_client)
    trainer.set_sample_callback(state.on_sample)
    app["state"] = state
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/routes", api_workouts)
    app.router.add_post("/api/upload/fit", api_upload_fit)
    app.router.add_get("/api/ride/routes", api_ride_routes)
    app.router.add_get("/api/ride/route", api_ride_route)
    app.router.add_post("/api/ride/upload-gpx", api_ride_upload_gpx)
    app.router.add_get("/api/settings", api_settings_get)
    app.router.add_post("/api/settings", api_settings_post)
    app.router.add_get("/api/sessions", api_sessions)
    app.router.add_get("/api/sessions/{sid}/tcx", api_session_tcx)
    app.router.add_static("/static/", STATIC_DIR, show_index=False)
    return app
