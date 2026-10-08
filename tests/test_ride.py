"""Modo Ruta: perfiles, física y RidePlayer."""

import asyncio
import time

import pytest

from rodillo.trainer import ride
from rodillo.trainer.ride import (
    RidePlayer,
    build_profile,
    profile_from_garmin_details,
    profile_from_gpx,
    profile_from_km_grades,
    steady_speed,
)

MASS = 69 + ride.BIKE_KG


@pytest.mark.parametrize("power,grade,lo,hi", [
    (200, 0.0, 30, 37),     # plano: ~33 km/h a 200 W
    (250, 8.0, 10, 14),     # Alpe: ~12 km/h a 250 W
    (150, 4.0, 13, 19),
])
def test_steady_speed_is_realistic(power, grade, lo, hi):
    kmh = steady_speed(power, grade, MASS) * 3.6
    assert lo <= kmh <= hi, kmh


def test_coasting_downhill_accelerates():
    assert steady_speed(0, -6.0, MASS) * 3.6 > 40


def test_km_grades_profile_distance_and_climb():
    p = profile_from_km_grades(id="climb:t", name="T", start_ele=1000, km_grades=[5, 10])
    assert p.total_m == pytest.approx(2000)
    assert p.climb_m == pytest.approx(150, abs=3)
    assert p.grade_at(500) == pytest.approx(5, abs=0.6)
    assert p.grade_at(1500) == pytest.approx(10, abs=0.6)
    assert not p.has_gps


GPX = """<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Subidita</name><trkseg>
    <trkpt lat="-33.3700" lon="-70.5800"><ele>700</ele></trkpt>
    <trkpt lat="-33.3710" lon="-70.5800"><ele>705</ele></trkpt>
    <trkpt lat="-33.3720" lon="-70.5800"><ele>710</ele></trkpt>
    <trkpt lat="-33.3730" lon="-70.5800"><ele>715</ele></trkpt>
  </trkseg></trk>
</gpx>"""


def test_gpx_parse_distance_grade_and_position():
    p = profile_from_gpx(GPX, id="gpx:x")
    assert p.name == "Subidita"
    assert p.total_m == pytest.approx(333.6, abs=2)       # 3 × 0.001° lat ≈ 111 m
    assert p.grade_at(p.total_m / 2) == pytest.approx(4.5, abs=0.6)
    lat, lon = p.latlon_at(p.total_m / 2)
    assert lat == pytest.approx(-33.3715, abs=1e-4) and lon == pytest.approx(-70.58)


def test_gpx_without_elevation_is_rejected():
    with pytest.raises(ValueError):
        profile_from_gpx(GPX.replace("<ele>", "<x>").replace("</ele>", "</x>"), id="gpx:x")


def test_garmin_details_uses_sum_distance_and_skips_gaps():
    keys = ["sumDistance", "directLatitude", "directLongitude", "directElevation"]
    rows = [[i * 50.0, -33.37 - i * 0.00045, -70.58, 700 + i * 2.5] for i in range(20)]
    rows[5][1] = None                                        # punto sin GPS
    details = {
        "metricDescriptors": [{"key": k, "metricsIndex": i} for i, k in enumerate(keys)],
        "activityDetailMetrics": [{"metrics": r} for r in rows],
    }
    p = profile_from_garmin_details(details, id="act:1", name="Subida")
    assert p.total_m == pytest.approx(950)
    assert p.grade_at(400) == pytest.approx(5, abs=0.5)
    assert p.has_gps


def test_slice_keeps_only_the_climb():
    p = profile_from_km_grades(id="climb:t", name="T", start_ele=0, km_grades=[0, 8, 0])
    s = p.slice(1000, 2000)
    assert s.total_m == pytest.approx(1000, abs=STEP if (STEP := ride.STEP_M) else 0)
    assert s.climb_m == pytest.approx(80, abs=4)


def test_build_profile_needs_distances_without_gps():
    with pytest.raises(ValueError):
        build_profile(id="x", name="x", source="climb", points=[(None, None, 1), (None, None, 2)])


class FakeTrainer:
    def __init__(self):
        self.grades: list[float] = []

    async def set_grade(self, pct):
        self.grades.append(pct)

    async def set_target_power(self, w):
        pass


def test_trainer_grade_scaled_by_difficulty_and_clamped():
    rp = RidePlayer(FakeTrainer())
    rp.difficulty = 0.5
    assert rp.trainer_grade_for(8.0) == 4.0
    rp.difficulty = 1.0
    assert rp.trainer_grade_for(15.0) == ride.TRAINER_MAX_GRADE
    assert rp.trainer_grade_for(-12.0) == ride.TRAINER_MIN_GRADE


def test_tick_advances_with_power_and_annotates_sample():
    p = profile_from_gpx(GPX, id="gpx:x")
    rp = RidePlayer(FakeTrainer())
    rp.load(p)
    rp.state = "running"
    rp.feed(250)
    for _ in range(40):            # 10 s
        rp.tick(0.25)
        rp.feed(250)
    assert 15 < rp.distance_m < 60
    from rodillo.trainer.client import Sample
    s = Sample(timestamp_s=1.0, power_w=250, speed_kmh=30.0, distance_m=999)
    rp.annotate(s)
    assert s.distance_m == int(rp.distance_m)
    assert s.lat is not None and s.altitude_m == pytest.approx(p.ele_at(rp.distance_m), abs=0.1)
    assert s.speed_kmh == pytest.approx(rp.speed_mps * 3.6, abs=0.01)


def test_stale_power_means_no_push():
    p = profile_from_km_grades(id="climb:t", name="T", start_ele=0, km_grades=[6])
    rp = RidePlayer(FakeTrainer())
    rp.load(p)
    rp.state = "running"
    rp._last_power, rp._last_power_at = 300.0, time.monotonic() - 10
    for _ in range(20):
        rp.tick(0.25)
    assert rp.distance_m == 0.0


async def test_ride_runs_to_finish_and_resets_grade(monkeypatch):
    p = profile_from_km_grades(id="climb:t", name="T", start_ele=0, km_grades=[2])
    trainer = FakeTrainer()
    events: list[str] = []

    async def on_event(e):
        events.append(e["kind"])

    rp = RidePlayer(trainer, on_event=on_event)
    monkeypatch.setattr(RidePlayer, "TICK_S", 0.01)
    rp.load(p)
    await rp.start()
    rp.distance_m = p.total_m - 1.0
    rp.speed_mps = 10.0
    rp.feed(200)
    for _ in range(100):
        await asyncio.sleep(0.01)
        if rp.state == "finished":
            break
    assert rp.state == "finished"
    assert events[0] == "started" and events[-1] == "finished"
    assert trainer.grades[0] == 1.0          # 2 % × dificultad 50 %
    assert trainer.grades[-1] == 0.0


def test_garmin_details_keeps_ghost_times_and_slices_them():
    keys = ["sumDistance", "sumMovingDuration", "directLatitude", "directLongitude", "directElevation"]
    rows = [[i * 50.0, i * 10.0, -33.37 - i * 0.00045, -70.58, 700 + i * 2.5] for i in range(30)]
    details = {
        "metricDescriptors": [{"key": k, "metricsIndex": i} for i, k in enumerate(keys)],
        "activityDetailMetrics": [{"metrics": r} for r in rows],
    }
    p = profile_from_garmin_details(details, id="act:1", name="M")
    assert p.time is not None and p.time[0] == 0
    assert p._interp(p.time, 500) == pytest.approx(100, abs=1)     # 50 m cada 10 s
    s = p.slice(500, 1000)
    assert s.time[0] == 0 and s.time[-1] == pytest.approx(100, abs=2)
    assert "time" in s.to_dict()


def test_find_climbs_detects_climb_and_ignores_rollers():
    p = profile_from_km_grades(id="climb:t", name="T", start_ele=500,
                               km_grades=[0, 1, -1, 0, 6, 7, 6, 0, -5, -5, 0, 2, -2])
    climbs = p.find_climbs()
    assert len(climbs) == 1
    c = climbs[0]
    assert 3600 <= c["from_m"] <= 4200 and 6800 <= c["to_m"] <= 7200   # ventana de recorte de 500 m
    assert c["gain_m"] == pytest.approx(190, abs=10)
    assert c["avg_grade_pct"] == pytest.approx(6.3, abs=0.5)


def test_grade_bins_cover_whole_route():
    p = profile_from_km_grades(id="climb:t", name="T", start_ele=0, km_grades=[2, 5])
    bins = p.grade_bins()
    assert sum(bins.values()) == pytest.approx(p.total_m, abs=15)
    assert bins.get(5, 0) > 800


async def test_scenery_mode_never_touches_grade_and_loops():
    p = profile_from_km_grades(id="climb:t", name="T", start_ele=0, km_grades=[3])
    trainer = FakeTrainer()
    rp = RidePlayer(trainer)
    rp.grade_control = False
    rp.load(p)
    await rp.start()
    rp.distance_m = p.total_m - 2
    rp.speed_mps = 10.0
    rp.feed(250)
    assert rp.tick(0.5) is False
    assert rp.laps == 1 and rp.distance_m < 10
    await rp.stop()
    assert trainer.grades == []


def test_slice_shifts_landmarks_with_the_route():
    from rodillo.server.epic_routes import build_epic
    p = build_epic("alpe")
    s = p.slice(6000, 14000)
    lms = s.meta["landmarks"]
    assert all(0 <= m["d"] <= s.total_m + 1 for m in lms)
    huez = next(m for m in lms if m["label"] == "Huez")
    assert huez["d"] == 9400 - 6000
