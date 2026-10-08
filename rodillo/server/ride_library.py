"""Catálogo del modo Ruta: rutas épicas recreadas + GPX que subas.

- `climb:<key>` — rutas épicas (epic_routes.py): Alpe d'Huez, Ventoux, Stelvio…
- `gpx:<slug>`  — GPX guardados en ~/.rodillo/routes/
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from rodillo.server.epic_routes import EPICS, build_epic
from rodillo.settings import data_dir
from rodillo.trainer.ride import RouteProfile, profile_from_gpx

logger = logging.getLogger(__name__)

_cache: dict[str, tuple[float, RouteProfile]] = {}


def routes_dir() -> Path:
    d = data_dir() / "routes"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_route(route_id: str) -> RouteProfile:
    kind, _, key = route_id.partition(":")
    if kind == "climb":
        if key not in EPICS:
            raise KeyError(route_id)
        if route_id not in _cache:
            _cache[route_id] = (0.0, build_epic(key))
        return _cache[route_id][1]
    if kind == "gpx":
        path = routes_dir() / f"{key}.gpx"
        if not re.fullmatch(r"[a-z0-9_-]+", key) or not path.exists():
            raise KeyError(route_id)
        mtime = path.stat().st_mtime
        hit = _cache.get(route_id)
        if hit and hit[0] == mtime:
            return hit[1]
        prof = profile_from_gpx(path.read_text(encoding="utf-8"), id=route_id)
        prof.meta = {"group": "Tus GPX", "subtitle": "GPX"}
        _cache[route_id] = (mtime, prof)
        return prof
    raise KeyError(route_id)


def _summary(prof: RouteProfile) -> dict:
    return {**prof.summary(), "gbins": prof.grade_bins()}


def list_routes() -> list[dict]:
    out = [_summary(get_route(f"climb:{k}")) for k in EPICS]
    for gp in sorted(routes_dir().glob("*.gpx"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            out.append(_summary(get_route(f"gpx:{gp.stem}")))
        except Exception as e:  # noqa: BLE001
            logger.warning("GPX %s inválido: %s", gp.name, e)
    return out


def featured() -> list[dict]:
    routes = list_routes()
    sections = [{"key": "classics", "title": "Épicas", "routes": [r for r in routes if r["id"].startswith("climb:")]}]
    gpx = [r for r in routes if r["id"].startswith("gpx:")]
    if gpx:
        sections.append({"key": "gpx", "title": "Tus GPX", "routes": gpx})
    return sections


def save_gpx(filename: str, content: bytes) -> RouteProfile:
    stem = re.sub(r"[^a-z0-9_-]+", "-", Path(filename).stem.lower()).strip("-") or "ruta"
    text = content.decode("utf-8", errors="replace")
    profile_from_gpx(text, id=f"gpx:{stem}")           # valida antes de guardar
    (routes_dir() / f"{stem}.gpx").write_text(text, encoding="utf-8")
    return get_route(f"gpx:{stem}")
