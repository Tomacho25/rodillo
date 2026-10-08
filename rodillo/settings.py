"""Ajustes del ciclista y carpeta de datos.

Todo vive en ~/.rodillo/ (o en $RODILLO_HOME):
  settings.json   FTP, peso, FC máxima, nombre
  routes/         GPX que subís desde la app
  sessions/       cada sesión: CSV con todas las muestras + TCX para Garmin/Strava
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


def data_dir() -> Path:
    d = Path(os.environ.get("RODILLO_HOME") or Path.home() / ".rodillo")
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Settings:
    name: str = "Ciclista"
    ftp_w: int = 200
    weight_kg: float = 72.0
    max_hr: int = 190

    def hr_zones(self) -> list[tuple[int, int]]:
        """5 zonas de FC como % de la FC máxima (aproximación estándar)."""
        cuts = [0, 0.68, 0.78, 0.86, 0.93, 1.0]
        return [(round(self.max_hr * cuts[i]), round(self.max_hr * cuts[i + 1])) for i in range(5)]


def _path() -> Path:
    return data_dir() / "settings.json"


def load_settings() -> Settings:
    try:
        raw = json.loads(_path().read_text())
        return Settings(
            name=str(raw.get("name") or Settings.name)[:40],
            ftp_w=max(50, min(600, int(raw.get("ftp_w") or Settings.ftp_w))),
            weight_kg=max(30.0, min(200.0, float(raw.get("weight_kg") or Settings.weight_kg))),
            max_hr=max(120, min(230, int(raw.get("max_hr") or Settings.max_hr))),
        )
    except FileNotFoundError:
        return Settings()
    except (ValueError, TypeError, OSError) as e:
        logger.warning("settings.json inválido (%s) — uso valores por defecto", e)
        return Settings()


def save_settings(data: dict) -> Settings:
    cur = asdict(load_settings())
    cur.update({k: v for k, v in data.items() if k in cur and v not in (None, "")})
    _path().write_text(json.dumps(cur, indent=2, ensure_ascii=False))
    return load_settings()
