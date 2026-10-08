"""Simulador del Tacx para probar la UI sin tener el rodillo encendido.

Implementa la misma interfaz que TacxClient (subset usado por el server).
Genera datos plausibles que reaccionan al target_power: si subís el target,
la "potencia" sube (con ruido y un poco de lag), y la cadencia/velocidad
también suben.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Callable

from rodillo.trainer.client import Sample

logger = logging.getLogger(__name__)


class TacxSimulator:
    def __init__(self) -> None:
        self._sample_cb: Callable[[Sample], None] | None = None
        self._mode: str = "power"   # "power" | "grade"
        self._target_power: int = 150
        self._grade_pct: float = 0.0
        self._current_power: float = 150.0
        self._task: asyncio.Task | None = None
        self._connected = False
        # `_running` simula al rider pedaleando. Por default arranca pausado:
        # un Tacx real no genera potencia si nadie está encima del rodillo.
        # Se activa con `start()` (lo llama workout_start / session_start /
        # trainer_start desde el server) y se pausa con `stop()`.
        self._running = False
        self._distance_m = 0
        self._t0: float = 0.0

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def target_power(self) -> int | None:
        return self._target_power if self._mode == "power" else None

    @property
    def grade_pct(self) -> float | None:
        return self._grade_pct if self._mode == "grade" else None

    @staticmethod
    async def scan(timeout: float = 1.0):
        await asyncio.sleep(0.1)
        from rodillo.trainer.client import DiscoveredTrainer

        return [DiscoveredTrainer(name="Tacx Flux S (sim)", address="00:00:00:00:00:00", rssi=-40)]

    @staticmethod
    async def find_one(timeout: float = 1.0):
        results = await TacxSimulator.scan()
        return results[0]

    async def connect(self, address: str = "sim") -> None:
        self._connected = True
        self._t0 = time.monotonic()
        self._task = asyncio.create_task(self._loop())
        logger.info("Simulador conectado (address=%s)", address)

    async def disconnect(self) -> None:
        self._connected = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Simulador desconectado")

    def set_sample_callback(self, cb: Callable[[Sample], None]) -> None:
        self._sample_cb = cb

    async def request_control(self) -> None:
        await asyncio.sleep(0.05)

    async def start(self) -> None:
        await asyncio.sleep(0.05)
        self._running = True
        # Reset del current_power a un valor inicial razonable cerca del target
        self._current_power = float(self._target_power) if self._mode == "power" else 130.0
        logger.info("Sim start → pedaleando")

    async def stop(self) -> None:
        await asyncio.sleep(0.05)
        self._running = False
        logger.info("Sim stop → pausado")

    async def reset(self) -> None:
        await asyncio.sleep(0.05)
        self._distance_m = 0
        self._current_power = 0.0
        self._running = False

    async def set_target_power(self, watts: int) -> None:
        self._mode = "power"
        self._target_power = max(0, int(watts))
        logger.info("Sim target_power=%d", self._target_power)

    async def set_grade(self, percent: float) -> None:
        self._mode = "grade"
        self._grade_pct = float(percent)
        logger.info("Sim grade=%+.1f%%", self._grade_pct)

    async def set_resistance_level(self, level: int) -> None:
        # Mapeo grosero: nivel 0-100 → power equivalente 0-300W
        self._mode = "power"
        self._target_power = max(0, min(400, int(level) * 3))
        logger.info("Sim resistance_level=%d (~%dW)", int(level), self._target_power)

    async def _loop(self) -> None:
        """Genera un Sample cada 250ms (~4Hz, igual que el Flux real).

        Sólo emite samples cuando `_running` es True (alguien está pedaleando).
        En estado pausado no emite nada — la UI queda con los últimos valores
        o con "—" si nunca arrancó.
        """
        try:
            while self._connected:
                await asyncio.sleep(0.25)
                if not self._running:
                    continue   # nadie en el rodillo → sin samples
                t = time.monotonic() - self._t0
                # En modo grade, la "potencia natural" depende de la pendiente:
                # rider pedalea con un esfuerzo base que escala con grade.
                if self._mode == "grade":
                    target = max(40.0, 130.0 + self._grade_pct * 22.0)
                else:
                    target = float(self._target_power)
                # Power tiende a target con lag + ruido + oscilación pedaleo
                self._current_power += (target - self._current_power) * 0.25
                noise = random.gauss(0, 8)
                pedal_osc = 6 * math.sin(t * 8)  # cadence beat
                power = max(0.0, self._current_power + noise + pedal_osc)
                # Cadence ~ 75-95 rpm dependiendo del power
                cadence = 70 + min(30, power / 12) + random.gauss(0, 1.5)
                # Speed ~ relación lineal grosera con power
                speed = max(0.0, power * 0.10 + random.gauss(0, 0.4))
                # Distance integrada
                self._distance_m += (speed * 1000.0 / 3600.0) * 0.25
                sample = Sample(
                    timestamp_s=t,
                    power_w=int(power),
                    cadence_rpm=round(cadence, 1),
                    speed_kmh=round(speed, 2),
                    heart_rate_bpm=int(110 + power / 6 + random.gauss(0, 3)),
                    distance_m=int(self._distance_m),
                    resistance=None,
                )
                if self._sample_cb:
                    self._sample_cb(sample)
        except asyncio.CancelledError:
            return
