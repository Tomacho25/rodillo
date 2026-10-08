"""Modelo de Workout + parsers (JSON, FIT) + WorkoutPlayer.

Un Workout es una secuencia de Segment. Cada segmento define una duración y
un objetivo, que puede ser:
  - target_w (modo ERG): el rodillo mantiene esos watts independiente de la cadencia
  - grade_pct (modo Slope): el rodillo simula esa pendiente (rider controla power)
  - ninguno (free): no manda nada al rodillo, libre

El WorkoutPlayer corre como una task asyncio que avanza por los segmentos
y empuja el control al trainer en el cambio de cada bloque.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Protocol

logger = logging.getLogger(__name__)


@dataclass
class Segment:
    duration_s: float
    target_w: int | None = None
    grade_pct: float | None = None
    label: str | None = None

    @property
    def mode(self) -> str:
        if self.target_w is not None:
            return "power"
        if self.grade_pct is not None:
            return "grade"
        return "free"

    def to_dict(self) -> dict:
        return {
            "duration_s": round(self.duration_s, 2),
            "target_w": self.target_w,
            "grade_pct": self.grade_pct,
            "label": self.label,
            "mode": self.mode,
        }


@dataclass
class Workout:
    name: str
    segments: list[Segment] = field(default_factory=list)
    description: str | None = None
    source: str = "custom"  # "library" | "json" | "fit"
    category: str | None = None   # agrupa la biblioteca en la UI (Base, Umbral, …)

    @property
    def total_duration_s(self) -> float:
        return sum(s.duration_s for s in self.segments)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "source": self.source,
            "category": self.category,
            "total_duration_s": round(self.total_duration_s, 1),
            "segments": [s.to_dict() for s in self.segments],
        }


# ---------- Parsers ----------


def workout_from_dict(d: dict) -> Workout:
    """Parser del JSON propio (formato simple, lo que escupe el bot).

    {
      "name": "Mi entrenamiento",
      "description": "opcional",
      "segments": [
        {"duration_s": 300, "target_w": 100, "label": "Warmup"},
        {"duration_s": 480, "target_w": 220, "label": "Sweet spot"},
        {"duration_s": 240, "grade_pct": 4.0, "label": "Subida 4%"},
        ...
      ]
    }
    """
    if not isinstance(d, dict):
        raise ValueError("Workout JSON tiene que ser un objeto")
    name = str(d.get("name") or "Custom workout")
    description = d.get("description")
    raw_segments = d.get("segments") or d.get("steps") or []
    if not isinstance(raw_segments, list) or not raw_segments:
        raise ValueError("Workout JSON necesita una lista 'segments' no vacía")
    segments: list[Segment] = []
    for i, raw in enumerate(raw_segments):
        if not isinstance(raw, dict):
            raise ValueError(f"Segmento {i} no es un objeto")
        dur = raw.get("duration_s") or raw.get("duration")
        if dur is None or float(dur) <= 0:
            raise ValueError(f"Segmento {i}: 'duration_s' inválido")
        target_w = raw.get("target_w") or raw.get("watts") or raw.get("power")
        grade = raw.get("grade_pct") or raw.get("grade") or raw.get("slope")
        segments.append(
            Segment(
                duration_s=float(dur),
                target_w=int(target_w) if target_w is not None else None,
                grade_pct=float(grade) if grade is not None else None,
                label=str(raw.get("label") or raw.get("notes") or "") or None,
            )
        )
    return Workout(name=name, description=description, segments=segments, source="json")


def workout_from_json(text: str) -> Workout:
    return workout_from_dict(json.loads(text))


def workout_from_fit(path: str | Path) -> Workout:
    """Parser de archivos .FIT exportados por Garmin Connect.

    Solo soporta steps con duration_type=time. Para target_type=power, usa
    el promedio de custom_target_power_low/high (los valores en FIT vienen
    con offset +1000 W para representar negativos como unsigned).
    Otros target types (HR zone, cadence) quedan sin target en el segmento.
    """
    from fitparse import FitFile

    fit = FitFile(str(path))

    name: str = Path(path).stem
    for msg in fit.get_messages("workout"):
        v = msg.get_value("wkt_name")
        if v:
            name = str(v)
            break

    segments: list[Segment] = []
    for msg in fit.get_messages("workout_step"):
        fields: dict[str, Any] = {f.name: f.value for f in msg}
        dur_type = str(fields.get("duration_type") or "")
        if dur_type != "time":
            continue
        # duration_value en FIT es en ms para duration_type=time
        duration_raw = fields.get("duration_time") or fields.get("duration_value") or 0
        try:
            duration_s = float(duration_raw) / 1000.0
        except (TypeError, ValueError):
            duration_s = 0.0
        if duration_s <= 0:
            continue

        target_w: int | None = None
        target_type = str(fields.get("target_type") or "")
        if target_type == "power":
            low = fields.get("custom_target_power_low") or fields.get(
                "custom_target_value_low"
            )
            high = fields.get("custom_target_power_high") or fields.get(
                "custom_target_value_high"
            )
            if low is not None and high is not None:
                low_w = max(0, int(low) - 1000)
                high_w = max(0, int(high) - 1000)
                target_w = round((low_w + high_w) / 2)
            else:
                v = fields.get("target_value")
                if v is not None and int(v) > 1000:
                    target_w = int(v) - 1000

        intensity = fields.get("intensity")
        notes = fields.get("notes")
        label = str(notes or intensity or "active")

        segments.append(
            Segment(duration_s=duration_s, target_w=target_w, label=label)
        )

    if not segments:
        raise ValueError("El archivo FIT no contiene workout_steps con duration_type=time")
    return Workout(name=name, segments=segments, source="fit")


# ---------- Trainer protocol (lo que el player necesita) ----------


class TrainerControlProtocol(Protocol):
    async def set_target_power(self, watts: int) -> None: ...
    async def set_grade(self, percent: float) -> None: ...


# ---------- Player ----------


PlayerEvent = Callable[[dict], Awaitable[None]]


class WorkoutPlayer:
    """Ejecuta un Workout sobre el trainer, segmento por segmento.

    Estados: idle | loaded | running | paused | finished.
    El player es exclusivo: si está running, el control manual del slider
    se ignora (el caller decide eso en la UI).
    """

    def __init__(
        self,
        trainer: TrainerControlProtocol,
        on_event: PlayerEvent | None = None,
    ) -> None:
        self._trainer = trainer
        self._on_event = on_event
        self._workout: Workout | None = None
        self._task: asyncio.Task | None = None
        self._state: str = "idle"
        self._segment_idx: int = 0
        # tiempo virtual: cuántos segundos del workout llevamos ejecutados
        self._elapsed_in_workout_s: float = 0.0
        self._segment_started_at: float | None = None
        self._paused_at: float | None = None
        self._skip_event: asyncio.Event = asyncio.Event()

    # ----- public API -----

    @property
    def state(self) -> str:
        return self._state

    @property
    def workout(self) -> Workout | None:
        return self._workout

    def load(self, workout: Workout) -> None:
        if self._state in ("running", "paused"):
            raise RuntimeError("Hay un workout corriendo, detenelo antes de cargar otro")
        self._workout = workout
        self._segment_idx = 0
        self._elapsed_in_workout_s = 0.0
        self._segment_started_at = None
        self._paused_at = None
        self._state = "loaded"
        logger.info("Workout cargado: %s (%d segmentos, %.1fs)",
                    workout.name, len(workout.segments), workout.total_duration_s)

    async def start(self) -> None:
        if self._workout is None:
            raise RuntimeError("No hay workout cargado")
        if self._state == "running":
            return
        if self._state == "paused":
            await self.resume()
            return
        self._segment_idx = 0
        self._elapsed_in_workout_s = 0.0
        self._state = "running"
        self._task = asyncio.create_task(self._run())

    async def pause(self) -> None:
        if self._state != "running":
            return
        self._state = "paused"
        self._paused_at = time.monotonic()
        # Liberar el rodillo mientras está pausado
        try:
            await self._trainer.set_target_power(0)
        except Exception as e:
            logger.warning("set_target_power(0) on pause falló: %s", e)

    async def resume(self) -> None:
        if self._state != "paused":
            return
        # ajustar segment_started_at para descontar el tiempo pausado
        if self._paused_at is not None and self._segment_started_at is not None:
            paused_for = time.monotonic() - self._paused_at
            self._segment_started_at += paused_for
        self._paused_at = None
        self._state = "running"
        # re-aplicar target del segmento actual
        seg = self._current_segment()
        if seg is not None:
            await self._apply_segment_target(seg)

    async def skip(self) -> None:
        if self._state == "running":
            self._skip_event.set()

    async def stop(self) -> None:
        self._state = "idle" if self._workout is None else "loaded"
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # Volver a libre
        try:
            await self._trainer.set_target_power(0)
        except Exception as e:
            logger.warning("set_target_power(0) on stop falló: %s", e)

    def progress(self) -> dict:
        """Snapshot del estado para mandar a la UI."""
        if self._workout is None:
            return {"state": self._state}
        seg = self._current_segment()
        seg_total = seg.duration_s if seg else 0.0
        seg_elapsed = self._segment_elapsed_s()
        total_elapsed = self._elapsed_in_workout_s + seg_elapsed
        total = self._workout.total_duration_s
        return {
            "state": self._state,
            "workout_name": self._workout.name,
            "workout_source": self._workout.source,
            "total_duration_s": round(total, 1),
            "total_elapsed_s": round(min(total_elapsed, total), 1),
            "total_remaining_s": round(max(0.0, total - total_elapsed), 1),
            "segment_idx": self._segment_idx,
            "segment_count": len(self._workout.segments),
            "segment_label": seg.label if seg else None,
            "segment_mode": seg.mode if seg else None,
            "segment_target_w": seg.target_w if seg else None,
            "segment_grade_pct": seg.grade_pct if seg else None,
            "segment_total_s": round(seg_total, 1),
            "segment_elapsed_s": round(min(seg_elapsed, seg_total), 1),
            "segment_remaining_s": round(max(0.0, seg_total - seg_elapsed), 1),
        }

    # ----- internals -----

    def _current_segment(self) -> Segment | None:
        if self._workout is None:
            return None
        if 0 <= self._segment_idx < len(self._workout.segments):
            return self._workout.segments[self._segment_idx]
        return None

    def _segment_elapsed_s(self) -> float:
        if self._segment_started_at is None:
            return 0.0
        if self._state == "paused" and self._paused_at is not None:
            return self._paused_at - self._segment_started_at
        return time.monotonic() - self._segment_started_at

    async def _apply_segment_target(self, seg: Segment) -> None:
        try:
            if seg.mode == "power":
                assert seg.target_w is not None
                await self._trainer.set_target_power(int(seg.target_w))
            elif seg.mode == "grade":
                assert seg.grade_pct is not None
                await self._trainer.set_grade(float(seg.grade_pct))
            else:
                # free: liberar el rodillo
                await self._trainer.set_target_power(0)
        except Exception as e:
            logger.warning("Error aplicando target de segmento: %s", e)

    async def _emit(self, kind: str) -> None:
        if self._on_event is None:
            return
        try:
            await self._on_event({"kind": kind, **self.progress()})
        except Exception as e:
            logger.error("Workout event handler raised: %s", e)

    async def _run(self) -> None:
        assert self._workout is not None
        try:
            await self._emit("started")
            for idx, seg in enumerate(self._workout.segments):
                self._segment_idx = idx
                self._segment_started_at = time.monotonic()
                self._skip_event.clear()
                await self._apply_segment_target(seg)
                await self._emit("segment_change")

                # esperar duración, respetando pause y skip
                while True:
                    if self._state == "paused":
                        # mientras pausado, dormir corto y rechecar
                        await asyncio.sleep(0.25)
                        continue
                    # El deadline se recalcula cada vuelta: resume() corre
                    # `_segment_started_at` por el tiempo pausado. Con un deadline
                    # fijo, una pausa más larga que el bloque se lo saltaba entero.
                    now = time.monotonic()
                    remaining = self._segment_started_at + seg.duration_s - now
                    if remaining <= 0:
                        break
                    try:
                        await asyncio.wait_for(self._skip_event.wait(), timeout=min(0.5, remaining))
                        # skip
                        break
                    except asyncio.TimeoutError:
                        continue
                self._elapsed_in_workout_s += seg.duration_s
            self._state = "finished"
            self._segment_idx = len(self._workout.segments)
            await self._trainer.set_target_power(0)
            await self._emit("finished")
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.exception("WorkoutPlayer loop error: %s", e)
            self._state = "idle"
            await self._emit("error")
