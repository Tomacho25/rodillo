"""Estado de la sesión: timer, samples acumulados, summary, grabación a CSV."""

from __future__ import annotations

import csv
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from rodillo.trainer.client import Sample

logger = logging.getLogger(__name__)

# Mantenemos hasta ~10 minutos de samples para el gráfico de la UI (4 Hz × 600s)
GRAPH_BUFFER_MAXLEN = 4 * 600


@dataclass
class SessionStats:
    duration_s: float = 0.0
    samples: int = 0
    avg_power_w: float = 0.0
    max_power_w: int = 0
    avg_cadence_rpm: float = 0.0
    avg_speed_kmh: float = 0.0
    distance_m: int = 0
    avg_hr_bpm: float = 0.0
    max_hr_bpm: int = 0
    normalized_power_w: float = 0.0  # NP estimado simple (RMS de 30s)


@dataclass
class Session:
    started_at: float | None = None
    paused: bool = True
    samples: list[Sample] = field(default_factory=list)
    rolling: deque[Sample] = field(default_factory=lambda: deque(maxlen=GRAPH_BUFFER_MAXLEN))

    def start(self) -> None:
        self.started_at = time.monotonic()
        self.paused = False
        self.samples.clear()
        self.rolling.clear()
        logger.info("Sesión iniciada")

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def stop(self) -> None:
        self.paused = True
        logger.info("Sesión detenida — %d samples", len(self.samples))

    def add(self, sample: Sample) -> None:
        if self.paused or self.started_at is None:
            return
        self.samples.append(sample)
        self.rolling.append(sample)

    def stats(self) -> SessionStats:
        if not self.samples:
            return SessionStats()
        powers = [s.power_w for s in self.samples if s.power_w is not None]
        cadences = [s.cadence_rpm for s in self.samples if s.cadence_rpm is not None]
        speeds = [s.speed_kmh for s in self.samples if s.speed_kmh is not None]
        hrs = [s.heart_rate_bpm for s in self.samples if s.heart_rate_bpm is not None]
        last_distance = next(
            (s.distance_m for s in reversed(self.samples) if s.distance_m is not None),
            0,
        )
        # NP simplificado: media^4 → rms, ventana de 30s (~120 samples a 4Hz)
        np_w = 0.0
        if len(powers) >= 30:
            window = 120
            ma = []
            for i in range(len(powers) - window + 1):
                chunk = powers[i : i + window]
                ma.append(sum(chunk) / window)
            if ma:
                np_w = (sum(p**4 for p in ma) / len(ma)) ** 0.25
        return SessionStats(
            duration_s=(self.samples[-1].timestamp_s - self.samples[0].timestamp_s),
            samples=len(self.samples),
            avg_power_w=sum(powers) / len(powers) if powers else 0,
            max_power_w=max(powers) if powers else 0,
            avg_cadence_rpm=sum(cadences) / len(cadences) if cadences else 0,
            avg_speed_kmh=sum(speeds) / len(speeds) if speeds else 0,
            distance_m=last_distance or 0,
            avg_hr_bpm=sum(hrs) / len(hrs) if hrs else 0,
            max_hr_bpm=max(hrs) if hrs else 0,
            normalized_power_w=np_w,
        )

    def save_csv(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(
                ["t_s", "power_w", "cadence_rpm", "speed_kmh", "hr_bpm", "distance_m",
                 "lat", "lon", "altitude_m"]
            )
            for s in self.samples:
                w.writerow(
                    [
                        f"{s.timestamp_s:.2f}",
                        s.power_w if s.power_w is not None else "",
                        s.cadence_rpm if s.cadence_rpm is not None else "",
                        s.speed_kmh if s.speed_kmh is not None else "",
                        s.heart_rate_bpm if s.heart_rate_bpm is not None else "",
                        s.distance_m if s.distance_m is not None else "",
                        f"{s.lat:.7f}" if s.lat is not None else "",
                        f"{s.lon:.7f}" if s.lon is not None else "",
                        s.altitude_m if s.altitude_m is not None else "",
                    ]
                )
        logger.info("Sesión guardada en %s (%d samples)", path, len(self.samples))
        return path

    def default_save_path(self, root: Path) -> Path:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        return root / f"session_{ts}.csv"
