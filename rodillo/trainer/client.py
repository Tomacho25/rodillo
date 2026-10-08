"""Cliente BLE al Tacx Flux S vía pycycling/bleak.

Notas críticas (verificadas):
- El trainer solo acepta UNA conexión BLE simultánea. Cerrá Zwift,
  Tacx Training, Garmin Express, etc. antes de conectar.
- Notification rate de Indoor Bike Data ~4 Hz.
- ERG (set_target_power) requiere request_control() PRIMERO.
- En macOS bleak usa Core Bluetooth, los UUIDs van en formato 128-bit largo.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Callable

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from pycycling.fitness_machine_service import FitnessMachineService

logger = logging.getLogger(__name__)

FTMS_SERVICE_UUID = "00001826-0000-1000-8000-00805f9b34fb"
DEFAULT_NAME_HINTS = ("tacx", "flux")


@dataclass
class Sample:
    """Muestra parseada del Indoor Bike Data."""

    timestamp_s: float
    power_w: int | None = None
    cadence_rpm: float | None = None
    speed_kmh: float | None = None
    heart_rate_bpm: int | None = None
    distance_m: int | None = None
    resistance: int | None = None
    # Solo en modo Ruta (los pone RidePlayer.annotate): posición virtual
    lat: float | None = None
    lon: float | None = None
    altitude_m: float | None = None

    def to_dict(self) -> dict:
        return {
            "t": round(self.timestamp_s, 2),
            "power": self.power_w,
            "cadence": self.cadence_rpm,
            "speed": self.speed_kmh,
            "hr": self.heart_rate_bpm,
            "distance": self.distance_m,
            "resistance": self.resistance,
        }


SampleCallback = Callable[[Sample], None]


@dataclass
class DiscoveredTrainer:
    name: str
    address: str
    rssi: int | None = None


class TacxClient:
    """Wrapper alrededor de FitnessMachineService.

    El loop interno mantiene la conexión BLE viva. Los samples se
    entregan via callback (sync) — el caller se encarga de despacharlos
    a su propio sink (websocket, csv, etc.).
    """

    def __init__(self) -> None:
        self._client: BleakClient | None = None
        self._ftms: FitnessMachineService | None = None
        self._sample_cb: SampleCallback | None = None
        self._connected_at: float | None = None
        self._target_power: int | None = None
        self._grade_pct: float | None = None
        self._device: BLEDevice | None = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    @property
    def target_power(self) -> int | None:
        return self._target_power

    @property
    def grade_pct(self) -> float | None:
        return self._grade_pct

    # ---------- Discovery ----------

    @staticmethod
    async def scan(timeout: float = 8.0) -> list[DiscoveredTrainer]:
        """Lista devices BLE que matcheen 'tacx'/'flux' o expongan FTMS."""
        logger.info("Escaneando BLE %s segundos...", timeout)
        devices = await BleakScanner.discover(
            timeout=timeout, return_adv=True, service_uuids=[FTMS_SERVICE_UUID]
        )
        results: list[DiscoveredTrainer] = []
        # devices es dict[str, tuple[BLEDevice, AdvertisementData]]
        for addr, (device, adv) in devices.items():
            name = (device.name or adv.local_name or "").strip()
            looks_tacx = any(h in name.lower() for h in DEFAULT_NAME_HINTS)
            advertises_ftms = FTMS_SERVICE_UUID in (adv.service_uuids or [])
            if looks_tacx or advertises_ftms:
                results.append(DiscoveredTrainer(name=name or "?", address=addr, rssi=adv.rssi))
        return results

    @staticmethod
    async def find_one(timeout: float = 8.0) -> DiscoveredTrainer | None:
        results = await TacxClient.scan(timeout)
        return results[0] if results else None

    # ---------- Connection ----------

    async def connect(self, address: str) -> None:
        logger.info("Conectando a %s ...", address)
        self._client = BleakClient(address)
        await self._client.connect()
        if not self._client.is_connected:
            raise RuntimeError(f"No pude conectar a {address}")

        self._ftms = FitnessMachineService(self._client)
        self._ftms.set_indoor_bike_data_handler(self._on_ibd)
        self._ftms.set_control_point_response_handler(self._on_control_response)
        await self._ftms.enable_indoor_bike_data_notify()
        await self._ftms.enable_control_point_indicate()
        # Algunas firmwares del Flux S rechazan writes al Control Point con
        # GATT 0x80 si la suscripción a indications no terminó de propagarse.
        await asyncio.sleep(0.3)
        self._connected_at = asyncio.get_event_loop().time()
        logger.info("Conectado y suscripto a IBD + Control Point")

    async def disconnect(self) -> None:
        if self._client and self._client.is_connected:
            try:
                if self._ftms:
                    await self._ftms.disable_indoor_bike_data_notify()
                    await self._ftms.disable_control_point_indicate()
            except Exception as e:
                logger.warning("Error desuscribiendo: %s", e)
            await self._client.disconnect()
            logger.info("Desconectado")

    # ---------- Samples ----------

    def set_sample_callback(self, cb: SampleCallback) -> None:
        self._sample_cb = cb

    def _on_ibd(self, ibd) -> None:
        if self._connected_at is None:
            return
        t = asyncio.get_event_loop().time() - self._connected_at
        sample = Sample(
            timestamp_s=t,
            power_w=ibd.instant_power,
            cadence_rpm=ibd.instant_cadence,
            speed_kmh=ibd.instant_speed,
            heart_rate_bpm=ibd.heart_rate,
            distance_m=ibd.total_distance,
            resistance=ibd.resistance_level,
        )
        if self._sample_cb is not None:
            try:
                self._sample_cb(sample)
            except Exception as e:
                logger.error("Sample callback raised: %s", e)

    def _on_control_response(self, response) -> None:
        logger.debug("Control Point response: %s", response)

    # ---------- Control (ERG) ----------

    async def request_control(self) -> None:
        if not self._ftms:
            raise RuntimeError("No conectado")
        await self._ftms.request_control()

    async def start(self) -> None:
        if not self._ftms:
            raise RuntimeError("No conectado")
        await self._ftms.start_or_resume()

    async def stop(self) -> None:
        if not self._ftms:
            raise RuntimeError("No conectado")
        await self._ftms.stop_or_pause(pause=False)

    async def reset(self) -> None:
        if not self._ftms:
            raise RuntimeError("No conectado")
        await self._ftms.reset()

    async def set_target_power(self, watts: int) -> None:
        if not self._ftms:
            raise RuntimeError("No conectado")
        watts = max(0, int(watts))
        await self._ftms.set_target_power(watts)
        self._target_power = watts
        self._grade_pct = None
        logger.info("Target power → %d W", watts)

    async def set_grade(self, percent: float) -> None:
        """Modo Slope: simula pendiente vía Set Indoor Bike Simulation Parameters.

        El Flux ajusta resistencia para emular esa pendiente; los watts pasan
        a depender de la cadencia/marcha que pone el rider. Defaults razonables
        para una bici de ruta: wind=0, Crr=0.004, Cw=0.51 kg/m.
        """
        if not self._ftms:
            raise RuntimeError("No conectado")
        # Unidades FTMS: wind 0.001 m/s, grade 0.01 %, crr 0.0001, cw 0.01 kg/m
        grade_raw = max(-32768, min(32767, int(round(percent * 100))))
        await self._ftms.set_simulation_parameters(0, grade_raw, 40, 51)
        self._grade_pct = float(percent)
        self._target_power = None
        logger.info("Grade → %+.1f%%", percent)

    async def set_resistance_level(self, level: int) -> None:
        """Resistencia raw 0-100 (escape hatch — preferí set_target_power o set_grade)."""
        if not self._ftms:
            raise RuntimeError("No conectado")
        level = max(0, min(200, int(level)))
        await self._ftms.set_target_resistance_level(level)
        self._target_power = None
        self._grade_pct = None
        logger.info("Resistance level → %d", level)
