"""Modo Ruta: rodar un lugar real con el rodillo en modo simulación (slope).

Piezas:
- `RouteProfile`: perfil remuestreado cada `STEP_M` metros (distancia, altura,
  pendiente suavizada y, si hay, lat/lon). Se arma desde un GPX, desde una
  actividad de Garmin (details con lat/lon/altura) o desde pendientes por km
  (subidas clásicas sin GPS).
- `virtual_speed_step`: física de ciclismo (gravedad + rodadura + aire + inercia)
  para convertir watts reales en velocidad virtual sobre la pendiente — como
  Zwift: la distancia avanza según tu potencia, no según el volante del rodillo.
- `RidePlayer`: state machine que integra la distancia, manda la pendiente al
  rodillo (escalada por "dificultad", como el trainer difficulty de Zwift) y
  anota cada Sample con posición/altura/distancia virtual para el TCX.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

logger = logging.getLogger(__name__)

STEP_M = 10.0                 # resolución del perfil
GRADE_HALF_WINDOW_M = 30.0    # pendiente = Δaltura en ±30 m (suaviza GPS)
ELE_SMOOTH_HALF_M = 20.0      # media móvil de altura en ±20 m
MAX_GRADE = 20.0

# Física (bici de ruta, posición de manos arriba)
G = 9.81
RHO = 1.2       # densidad del aire kg/m3
CDA = 0.32      # m2
CRR = 0.004
DRIVETRAIN_EFF = 0.976
BIKE_KG = 8.5

# Rango que acepta el Flux S en simulación (más allá satura igual)
TRAINER_MIN_GRADE = -5.0
TRAINER_MAX_GRADE = 10.0


# ---------------------------------------------------------------- perfil ----

@dataclass
class RouteProfile:
    id: str
    name: str
    source: str                         # "activity" | "gpx" | "climb"
    dist: list[float]                   # m, cada STEP_M
    ele: list[float]                    # m (suavizada)
    grade: list[float]                  # % (suavizada)
    lat: list[float] | None = None
    lon: list[float] | None = None
    description: str = ""
    meta: dict = field(default_factory=dict)
    # Segundos (en movimiento) en que la actividad original pasó por cada punto:
    # permite correr contra el "fantasma" de tu propia salida.
    time: list[float] | None = None

    @property
    def total_m(self) -> float:
        return self.dist[-1] if self.dist else 0.0

    @property
    def has_gps(self) -> bool:
        return self.lat is not None and self.lon is not None

    @property
    def climb_m(self) -> float:
        return sum(max(0.0, b - a) for a, b in zip(self.ele, self.ele[1:]))

    def _idx(self, d: float) -> tuple[int, float]:
        """Índice del tramo y fracción dentro de él para la distancia d."""
        if d <= 0 or len(self.dist) < 2:
            return 0, 0.0
        if d >= self.total_m:
            return len(self.dist) - 2, 1.0
        i = min(int(d // STEP_M), len(self.dist) - 2)
        return i, (d - self.dist[i]) / STEP_M

    def _interp(self, arr: list[float], d: float) -> float:
        i, f = self._idx(d)
        return arr[i] + (arr[i + 1] - arr[i]) * f

    def ele_at(self, d: float) -> float:
        return self._interp(self.ele, d)

    def grade_at(self, d: float) -> float:
        return self._interp(self.grade, d)

    def latlon_at(self, d: float) -> tuple[float, float] | None:
        if not self.has_gps:
            return None
        assert self.lat is not None and self.lon is not None
        return self._interp(self.lat, d), self._interp(self.lon, d)

    def climb_between(self, d0: float, d1: float) -> float:
        i0 = max(0, int(d0 // STEP_M))
        i1 = min(len(self.ele) - 1, int(d1 // STEP_M))
        return sum(max(0.0, self.ele[i + 1] - self.ele[i]) for i in range(i0, i1))

    def grade_bins(self) -> dict[int, float]:
        """Metros recorridos por pendiente redondeada al 1% (para estimar tiempos)."""
        bins: dict[int, float] = {}
        for i in range(1, len(self.dist)):
            g = int(round(self.grade[i]))
            bins[g] = bins.get(g, 0.0) + (self.dist[i] - self.dist[i - 1])
        return {g: round(m) for g, m in sorted(bins.items())}

    def find_climbs(self, min_gain: float = 100.0, min_avg: float = 3.0, max_dip: float = 20.0) -> list[dict]:
        """Subidas: desde un mínimo hasta el máximo siguiente, tolerando bajadas < max_dip."""
        out: list[dict] = []
        n = len(self.ele)
        i0 = 0           # inicio candidato (mínimo)
        imax = 0         # cumbre candidata
        look = max(1, int(500 // STEP_M))
        for i in range(1, n):
            if self.ele[i] < self.ele[i0]:
                i0 = imax = i                       # nuevo mínimo
            elif self.ele[i] > self.ele[imax]:
                imax = i
            if imax > i0 and (self.ele[imax] - self.ele[i] > max_dip or i == n - 1):
                # Recortar el arranque plano: la subida empieza donde los
                # próximos 500 m suben al menos 3%.
                s0 = i0
                while s0 < imax - look and (self.ele[s0 + look] - self.ele[s0]) < 0.03 * (self.dist[s0 + look] - self.dist[s0]):
                    s0 += 1
                i0 = s0
                gain = self.ele[imax] - self.ele[i0]
                length = self.dist[imax] - self.dist[i0]
                if gain >= min_gain and length > 0 and gain / length * 100 >= min_avg:
                    out.append({
                        "from_m": round(self.dist[i0]), "to_m": round(self.dist[imax]),
                        "gain_m": round(gain), "length_m": round(length),
                        "avg_grade_pct": round(gain / length * 100, 1),
                        "max_grade_pct": round(max(self.grade[i0:imax + 1]), 1),
                        "top_ele_m": round(self.ele[imax]),
                        "start": [round(self.lat[i0], 5), round(self.lon[i0], 5)] if self.lat and self.lon else None,
                        "end": [round(self.lat[imax], 5), round(self.lon[imax], 5)] if self.lat and self.lon else None,
                    })
                i0 = imax = i
        return out

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "description": self.description,
            "distance_m": round(self.total_m),
            "climb_m": round(self.climb_m),
            "max_grade_pct": round(max(self.grade), 1) if self.grade else 0.0,
            "has_gps": self.has_gps,
            **self.meta,
        }

    def to_dict(self, max_points: int = 3000) -> dict:
        """Perfil completo para la UI (decimado si es muy largo)."""
        n = len(self.dist)
        stride = max(1, math.ceil(n / max_points))
        idx = list(range(0, n, stride))
        if idx[-1] != n - 1:
            idx.append(n - 1)
        out = {
            **self.summary(),
            "step_m": STEP_M * stride,
            "dist": [round(self.dist[i], 1) for i in idx],
            "ele": [round(self.ele[i], 1) for i in idx],
            "grade": [round(self.grade[i], 2) for i in idx],
        }
        if self.has_gps:
            assert self.lat is not None and self.lon is not None
            out["lat"] = [round(self.lat[i], 6) for i in idx]
            out["lon"] = [round(self.lon[i], 6) for i in idx]
        if self.time is not None:
            out["time"] = [round(self.time[i], 1) for i in idx]
        return out

    def slice(self, from_m: float, to_m: float) -> RouteProfile:
        """Sub-ruta [from_m, to_m] (ej. solo la subida de una salida)."""
        from_m = max(0.0, min(from_m, self.total_m))
        to_m = max(from_m + STEP_M * 2, min(to_m, self.total_m))
        i0 = int(from_m // STEP_M)
        i1 = min(len(self.dist), int(math.ceil(to_m / STEP_M)) + 1)
        base = self.dist[i0]
        meta = dict(self.meta)
        if meta.get("landmarks"):
            # los detalles (curvas, pueblos) se corren junto con el tramo
            end = self.dist[i1 - 1] - base
            meta["landmarks"] = [{**m, "d": m["d"] - base} for m in meta["landmarks"] if 0 <= m["d"] - base <= end]
        if meta.get("treeless_from_m") is not None:
            meta["treeless_from_m"] = meta["treeless_from_m"] - base
        sliced = RouteProfile(
            id=f"{self.id}@{round(from_m)}-{round(to_m)}",
            name=f"{self.name} (km {from_m/1000:.1f}–{to_m/1000:.1f})",
            source=self.source,
            dist=[d - base for d in self.dist[i0:i1]],
            ele=self.ele[i0:i1],
            grade=self.grade[i0:i1],
            lat=self.lat[i0:i1] if self.lat else None,
            lon=self.lon[i0:i1] if self.lon else None,
            description=self.description,
            meta=meta,
            time=[t - self.time[i0] for t in self.time[i0:i1]] if self.time else None,
        )
        return sliced


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def _resample(dist: list[float], *series: list[float]) -> tuple[list[float], list[list[float]]]:
    """Interpola series (alineadas a `dist`) a una grilla cada STEP_M."""
    total = dist[-1]
    n = int(total // STEP_M) + 1
    grid = [i * STEP_M for i in range(n)]
    if grid[-1] < total:
        grid.append(total)
    out: list[list[float]] = [[] for _ in series]
    j = 0
    for g in grid:
        while j < len(dist) - 2 and dist[j + 1] < g:
            j += 1
        d0, d1 = dist[j], dist[j + 1]
        f = 0.0 if d1 <= d0 else min(1.0, max(0.0, (g - d0) / (d1 - d0)))
        for k, s in enumerate(series):
            out[k].append(s[j] + (s[j + 1] - s[j]) * f)
    return grid, out


def _smooth(values: list[float], half: int) -> list[float]:
    if half <= 0 or len(values) < 3:
        return list(values)
    # prefix sums → media móvil O(n)
    pre = [0.0]
    for v in values:
        pre.append(pre[-1] + v)
    n = len(values)
    out = []
    for i in range(n):
        # ventana simétrica que se achica en los bordes: sin sesgo en los extremos
        h = min(half, i, n - 1 - i)
        a, b = i - h, i + h + 1
        out.append((pre[b] - pre[a]) / (b - a))
    return out


def _grades(dist: list[float], ele: list[float]) -> list[float]:
    k = max(1, int(GRADE_HALF_WINDOW_M // STEP_M))
    n = len(ele)
    out = []
    for i in range(n):
        a, b = max(0, i - k), min(n - 1, i + k)
        span = dist[b] - dist[a]
        g = 0.0 if span <= 0 else (ele[b] - ele[a]) / span * 100.0
        out.append(max(-MAX_GRADE, min(MAX_GRADE, g)))
    return out


def build_profile(
    *, id: str, name: str, source: str,
    points: list[tuple[float | None, float | None, float]],
    distances: list[float] | None = None,
    description: str = "", meta: dict | None = None,
    times: list[float] | None = None,
) -> RouteProfile:
    """points = [(lat, lon, ele)]; lat/lon pueden ser None si no hay GPS.

    Si no vienen `distances`, se calculan por haversine (requiere lat/lon).
    """
    keep = [i for i, p in enumerate(points) if p[2] is not None]
    pts = [points[i] for i in keep]
    if times is not None:
        times = [times[i] for i in keep]
    if len(pts) < 2:
        raise ValueError("La ruta necesita al menos 2 puntos con altura")
    has_gps = all(p[0] is not None and p[1] is not None for p in pts)
    if distances is None:
        if not has_gps:
            raise ValueError("Sin lat/lon hay que pasar distancias")
        distances = [0.0]
        for a, b in zip(pts, pts[1:]):
            distances.append(distances[-1] + _haversine_m(a[0], a[1], b[0], b[1]))  # type: ignore[arg-type]
    else:
        distances = [distances[i] for i in keep]
    # Distancias estrictamente crecientes (GPS parado repite puntos)
    clean_d, clean_p = [distances[0]], [pts[0]]
    clean_t = [times[0]] if times is not None else []
    for j in range(1, len(pts)):
        if distances[j] > clean_d[-1] + 0.5:
            clean_d.append(distances[j])
            clean_p.append(pts[j])
            if times is not None:
                clean_t.append(times[j])
    if len(clean_d) < 2 or clean_d[-1] < STEP_M * 3:
        raise ValueError("La ruta es demasiado corta")
    eles = [p[2] for p in clean_p]
    if has_gps:
        lats = [p[0] for p in clean_p]
        lons = [p[1] for p in clean_p]
        grid, (ele_r, lat_r, lon_r) = _resample(clean_d, eles, lats, lons)  # type: ignore[arg-type]
    else:
        grid, (ele_r,) = _resample(clean_d, eles)
        lat_r = lon_r = None
    ele_s = _smooth(ele_r, int(ELE_SMOOTH_HALF_M // STEP_M))
    time_r = None
    if times is not None and len(clean_t) == len(clean_d):
        _, (time_r,) = _resample(clean_d, clean_t)
        t0 = time_r[0]
        time_r = [t - t0 for t in time_r]
    return RouteProfile(
        id=id, name=name, source=source,
        dist=grid, ele=ele_s, grade=_grades(grid, ele_s),
        lat=lat_r, lon=lon_r, description=description, meta=meta or {},
        time=time_r,
    )


def profile_from_gpx(text: str, *, id: str, name: str | None = None) -> RouteProfile:
    """Parser GPX 1.0/1.1 (trkpt o rtept con <ele>)."""
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        raise ValueError(f"GPX inválido: {e}") from e
    ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
    pts: list[tuple[float | None, float | None, float]] = []
    for tag in ("trkpt", "rtept"):
        for el in root.iter(f"{ns}{tag}"):
            ele_el = el.find(f"{ns}ele")
            if ele_el is None or ele_el.text is None:
                continue
            pts.append((float(el.get("lat")), float(el.get("lon")), float(ele_el.text)))
        if pts:
            break
    if not pts:
        raise ValueError("El GPX no tiene puntos con altura (<ele>)")
    gpx_name = name
    if not gpx_name:
        n = root.find(f".//{ns}name")
        gpx_name = n.text.strip() if n is not None and n.text else "Ruta GPX"
    return build_profile(id=id, name=gpx_name, source="gpx", points=pts)


def profile_from_garmin_details(details: dict, *, id: str, name: str, meta: dict | None = None) -> RouteProfile:
    """Desde `details` de una actividad de Garmin (activityDetailMetrics)."""
    desc = {m["key"]: m["metricsIndex"] for m in details.get("metricDescriptors", [])}
    need = ("directLatitude", "directLongitude", "directElevation")
    if not all(k in desc for k in need):
        raise ValueError("La actividad no tiene GPS + altura")
    pts: list[tuple[float | None, float | None, float]] = []
    dists: list[float] = []
    times: list[float] = []
    has_dist = "sumDistance" in desc
    tkey = "sumMovingDuration" if "sumMovingDuration" in desc else (
        "sumDuration" if "sumDuration" in desc else None)
    for row in details.get("activityDetailMetrics", []):
        m = row.get("metrics") or []
        lat, lon, ele = (m[desc[k]] for k in need)
        if lat is None or lon is None or ele is None:
            continue
        d = m[desc["sumDistance"]] if has_dist else None
        if has_dist and d is None:
            continue
        t = m[desc[tkey]] if tkey else None
        if tkey and t is None:
            t = times[-1] if times else 0.0
        pts.append((lat, lon, ele))
        if has_dist:
            dists.append(float(d))
        if tkey:
            times.append(float(t))
    return build_profile(id=id, name=name, source="activity", points=pts,
                         distances=dists if has_dist else None, meta=meta,
                         times=times if tkey else None)


def profile_from_km_grades(
    *, id: str, name: str, start_ele: float, km_grades: list[float],
    description: str = "", meta: dict | None = None,
) -> RouteProfile:
    """Subida sintética: pendiente media por km (sin GPS)."""
    dist, ele = [0.0], [start_ele]
    for g in km_grades:
        for _ in range(10):              # 100 m por paso dentro de cada km
            dist.append(dist[-1] + 100.0)
            ele.append(ele[-1] + g)      # g % de 100 m = g metros
    pts = [(None, None, e) for e in ele]
    return build_profile(id=id, name=name, source="climb", points=pts,
                         distances=dist, description=description, meta=meta)


# ---------------------------------------------------------------- física ----

def virtual_speed_step(v: float, power_w: float, grade_pct: float, mass_kg: float, dt: float) -> float:
    """Integra la velocidad (m/s) un paso dt con inercia.

    m·dv/dt = P·η/v − (gravedad + rodadura + aire). Con v→0 la fuerza de pedaleo
    se acota (v mínima 1 m/s en el denominador) para no explotar al arrancar.
    """
    theta = math.atan(grade_pct / 100.0)
    f_grav = mass_kg * G * math.sin(theta)
    f_roll = CRR * mass_kg * G * math.cos(theta)
    m_eff = mass_kg + 1.5     # inercia de ruedas
    steps = max(1, int(math.ceil(dt / 0.05)))
    h = dt / steps
    for _ in range(steps):
        f_drive = (power_w * DRIVETRAIN_EFF) / max(v, 1.0)
        f_aero = 0.5 * RHO * CDA * v * v
        a = (f_drive - f_grav - f_roll - f_aero) / m_eff
        v = max(0.0, v + a * h)
        if power_w <= 0 and v < 0.3 and grade_pct >= 0:
            v = 0.0
    return v


def steady_speed(power_w: float, grade_pct: float, mass_kg: float) -> float:
    """Velocidad de equilibrio (m/s) — útil para tests y estimaciones."""
    v = 5.0
    for _ in range(4000):
        v = virtual_speed_step(v, power_w, grade_pct, mass_kg, 0.25)
    return v


# ---------------------------------------------------------------- player ----

class GradeTrainer(Protocol):
    async def set_grade(self, percent: float) -> None: ...
    async def set_target_power(self, watts: int) -> None: ...


RideEvent = Callable[[dict], Awaitable[None]]


class RidePlayer:
    """Estados: idle | loaded | running | paused | finished."""

    TICK_S = 0.25
    POWER_STALE_S = 2.5

    def __init__(self, trainer: GradeTrainer, on_event: RideEvent | None = None,
                 rider_kg: float = 69.0) -> None:
        self._trainer = trainer
        self._on_event = on_event
        self.route: RouteProfile | None = None
        self.state = "idle"
        self.rider_kg = rider_kg
        self.difficulty = 0.5          # 0..1, como "trainer difficulty" de Zwift
        # False = solo escenario: un workout ERG maneja el rodillo y la ruta
        # aporta paisaje + física de velocidad. Al llegar al final da otra vuelta.
        self.grade_control = True
        self.laps = 0
        self.distance_m = 0.0
        self.speed_mps = 0.0
        self.elapsed_s = 0.0
        self._last_power = 0.0
        self._last_power_at = 0.0
        self._last_cadence: float | None = None
        self._sent_grade: float | None = None
        self._sent_at = 0.0
        self._task: asyncio.Task | None = None

    @property
    def mass_kg(self) -> float:
        return self.rider_kg + BIKE_KG

    # ----- API -----

    def load(self, route: RouteProfile) -> None:
        if self.state in ("running", "paused"):
            raise RuntimeError("Hay una ruta en curso, detenela antes de cargar otra")
        self.route = route
        self.state = "loaded"
        self.distance_m = self.speed_mps = self.elapsed_s = 0.0
        self.laps = 0
        self._sent_grade = None
        logger.info("Ruta cargada: %s (%.1f km, +%d m)", route.name, route.total_m / 1000, route.climb_m)

    def unload(self) -> None:
        if self.state in ("running", "paused"):
            raise RuntimeError("Detené la ruta antes de quitarla")
        self.route = None
        self.state = "idle"

    async def start(self) -> None:
        if self.route is None:
            raise RuntimeError("No hay ruta cargada")
        if self.state == "running":
            return
        if self.state == "paused":
            await self.resume()
            return
        if self.state == "finished":
            self.distance_m = self.speed_mps = self.elapsed_s = 0.0
            self.laps = 0
        self.state = "running"
        self._sent_grade = None
        await self._apply_grade(force=True)
        self._task = asyncio.create_task(self._run())
        await self._emit("started")

    async def pause(self) -> None:
        if self.state != "running":
            return
        self.state = "paused"
        self.speed_mps = 0.0
        if self.grade_control:
            await self._safe_grade(0.0)
        await self._emit("paused")

    async def resume(self) -> None:
        if self.state != "paused":
            return
        self.state = "running"
        self._sent_grade = None
        await self._apply_grade(force=True)
        await self._emit("resumed")

    async def stop(self) -> None:
        was_active = self.state in ("running", "paused")
        self.state = "loaded" if self.route else "idle"
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self.grade_control:
            await self._safe_grade(0.0)
        if was_active:
            await self._emit("stopped")

    async def set_difficulty(self, pct: float) -> None:
        self.difficulty = max(0.0, min(1.0, float(pct) / 100.0))
        if self.state == "running":
            await self._apply_grade(force=True)

    def feed(self, power_w: int | None, cadence_rpm: float | None = None) -> None:
        """Llamado por cada sample del rodillo (sync)."""
        if power_w is not None:
            self._last_power = float(power_w)
            self._last_power_at = time.monotonic()
        self._last_cadence = cadence_rpm

    def annotate(self, sample) -> None:  # noqa: ANN001 — Sample del trainer
        """Pisa distancia/velocidad con las virtuales y agrega posición."""
        if self.route is None or self.state not in ("running", "paused"):
            return
        sample.distance_m = int(self.distance_m)
        sample.speed_kmh = round(self.speed_mps * 3.6, 2)
        sample.altitude_m = round(self.route.ele_at(self.distance_m), 1)
        ll = self.route.latlon_at(self.distance_m)
        if ll is not None:
            sample.lat, sample.lon = ll

    def progress(self) -> dict:
        if self.route is None:
            return {"state": self.state}
        r = self.route
        d = self.distance_m
        ll = r.latlon_at(d)
        ahead = min(r.total_m, d + 500.0)
        grade_ahead = ((r.ele_at(ahead) - r.ele_at(d)) / (ahead - d) * 100.0) if ahead - d > 20 else 0.0
        return {
            "state": self.state,
            "route_id": r.id,
            "route_name": r.name,
            "distance_m": round(d, 1),
            "total_m": round(r.total_m, 1),
            "remaining_m": round(max(0.0, r.total_m - d), 1),
            "pct": round(d / r.total_m * 100.0, 2) if r.total_m else 0.0,
            "ele_m": round(r.ele_at(d), 1),
            "grade_pct": round(r.grade_at(d), 1),
            "grade_ahead_500m_pct": round(grade_ahead, 1),
            "trainer_grade_pct": self._sent_grade,
            "difficulty_pct": round(self.difficulty * 100),
            "speed_kmh": round(self.speed_mps * 3.6, 1),
            "elapsed_s": round(self.elapsed_s, 1),
            "avg_speed_kmh": round(d / self.elapsed_s * 3.6, 1) if self.elapsed_s > 1 else 0.0,
            "climbed_m": round(r.climb_between(0, d)),
            "remaining_climb_m": round(r.climb_between(d, r.total_m)),
            "lat": ll[0] if ll else None,
            "lon": ll[1] if ll else None,
            "grade_control": self.grade_control,
            "laps": self.laps,
        }

    # ----- internals -----

    def trainer_grade_for(self, route_grade: float) -> float:
        g = route_grade * self.difficulty
        return round(max(TRAINER_MIN_GRADE, min(TRAINER_MAX_GRADE, g)), 1)

    def tick(self, dt: float) -> bool:
        """Avanza la simulación dt segundos. Devuelve True si llegó a la meta."""
        assert self.route is not None
        fresh = (time.monotonic() - self._last_power_at) <= self.POWER_STALE_S
        power = self._last_power if fresh else 0.0
        grade = self.route.grade_at(self.distance_m)
        self.speed_mps = virtual_speed_step(self.speed_mps, power, grade, self.mass_kg, dt)
        if self.speed_mps > 0 or power > 0:
            self.elapsed_s += dt
        d = self.distance_m + self.speed_mps * dt
        if d >= self.route.total_m and not self.grade_control:
            # Escenario de un workout: la ruta se acabó antes → otra vuelta
            self.laps += 1
            self.distance_m = d - self.route.total_m
            return False
        self.distance_m = min(self.route.total_m, d)
        return self.distance_m >= self.route.total_m

    async def _apply_grade(self, force: bool = False) -> None:
        assert self.route is not None
        if not self.grade_control:
            return
        target = self.trainer_grade_for(self.route.grade_at(self.distance_m))
        now = time.monotonic()
        changed = self._sent_grade is None or abs(target - self._sent_grade) >= 0.2
        if force or (changed and now - self._sent_at >= 1.0) or now - self._sent_at >= 10.0:
            if await self._safe_grade(target):
                self._sent_grade = target
                self._sent_at = now

    async def _safe_grade(self, pct: float) -> bool:
        try:
            await self._trainer.set_grade(pct)
            return True
        except Exception as e:  # noqa: BLE001 — BLE puede fallar puntualmente
            logger.warning("set_grade(%.1f) falló: %s", pct, e)
            return False

    async def _emit(self, kind: str) -> None:
        if self._on_event is None:
            return
        try:
            await self._on_event({"kind": kind, **self.progress()})
        except Exception as e:  # noqa: BLE001
            logger.error("Ride event handler raised: %s", e)

    async def _run(self) -> None:
        last = time.monotonic()
        try:
            while True:
                await asyncio.sleep(self.TICK_S)
                now = time.monotonic()
                dt, last = now - last, now
                if self.state == "paused":
                    continue
                if self.state != "running":
                    return
                if self.tick(min(dt, 1.0)):
                    self.state = "finished"
                    self.speed_mps = 0.0
                    if self.grade_control:
                        await self._safe_grade(0.0)
                    await self._emit("finished")
                    return
                await self._apply_grade()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("RidePlayer loop error: %s", e)
            self.state = "loaded"
            await self._emit("error")
