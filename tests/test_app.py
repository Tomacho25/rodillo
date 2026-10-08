"""Servidor: combo workout+ruta, guardado de sesiones con TCX y ajustes."""

import asyncio
import json

from rodillo.server.app import AppState, _handle_command, sessions_dir
from rodillo.settings import load_settings, save_settings
from rodillo.trainer.client import Sample
from rodillo.trainer.ride import profile_from_km_grades
from rodillo.trainer.simulator import TacxSimulator
from rodillo.trainer.workout import Segment, Workout


class FakeWS:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_str(self, s):
        self.sent.append(json.loads(s))


async def test_combo_runs_workout_on_route_without_grade():
    trainer = TacxSimulator()
    await trainer.connect()
    state = AppState(trainer)
    grades: list[float] = []
    orig = trainer.set_grade

    async def spy(pct):
        grades.append(pct)
        await orig(pct)
    trainer.set_grade = spy

    state.workout.load(Workout(name="Z2", segments=[Segment(duration_s=0.4, target_w=150, label="Z2")]))
    state.ride.load(profile_from_km_grades(id="climb:t", name="Alpe", start_ele=0, km_grades=[8]))
    ws = FakeWS()
    await _handle_command(state, {"action": "combo_start"}, ws)
    assert state.mode == "combo" and state.combo_name() == "Z2 · en Alpe"
    await _handle_command(state, {"action": "workout_pause"}, ws)
    assert state.ride.state == "paused"
    await _handle_command(state, {"action": "workout_resume"}, ws)
    await asyncio.sleep(0.9)
    assert state.workout.state == "finished"
    assert state.ride.state in ("loaded", "idle")
    assert grades == []
    await trainer.disconnect()



async def test_finished_session_writes_csv_tcx_and_meta(monkeypatch):
    trainer = TacxSimulator()
    state = AppState(trainer)
    state.simulated = False
    state.session.start()
    for i in range(20):
        s = Sample(timestamp_s=float(i * 10), power_w=200, cadence_rpm=90, speed_kmh=30, distance_m=i * 80, heart_rate_bpm=140)
        s.lat, s.lon, s.altitude_m = -33.4 + i * 1e-4, -70.6, 700 + i
        state.session.add(s)
    stem = await state.persist_session("Ruta · Alpe d'Huez", finished=True)
    assert stem and stem.endswith("ruta-alpe-d-huez")
    d = sessions_dir()
    tcx = (d / f"{stem}.tcx").read_text()
    assert "<Position>" in tcx and "<Watts>200</Watts>" in tcx and "<HeartRateBpm>" in tcx
    meta = json.loads((d / f"{stem}.json").read_text())
    assert meta["avg_power_w"] == 200 and meta["name"] == "Ruta · Alpe d'Huez"
    assert (d / f"{stem}.csv").exists()


async def test_simulated_sessions_are_not_saved():
    state = AppState(TacxSimulator())
    state.session.start()
    for i in range(20):
        state.session.add(Sample(timestamp_s=float(i * 60), power_w=200))
    assert await state.persist_session("x", finished=True) is None
    assert not list(sessions_dir().glob("*"))


def test_settings_roundtrip_and_clamping():
    assert load_settings().ftp_w == 200
    s = save_settings({"ftp_w": 9999, "weight_kg": 69, "name": "Ana", "otro": 1})
    assert s.ftp_w == 600 and s.weight_kg == 69 and s.name == "Ana"
    assert len(s.hr_zones()) == 5


def test_workout_library_scales_with_ftp():
    from rodillo.server.route_library import get_route
    save_settings({"ftp_w": 300})
    wk = get_route("Sweet Spot 4×8")
    assert max(s.target_w or 0 for s in wk.segments) == 270     # 90% de 300
