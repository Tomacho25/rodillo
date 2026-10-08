"""Cliente BLE para banda cardíaca (Heart Rate Service estándar 0x180D).

Compatible con cualquier strap que implemente el GATT Heart Rate Service:
Polar H7/H9/H10, Wahoo Tickr, Garmin HRM-Dual/Pro, etc.

El Tacx Flux S no propaga HR por FTMS, así que necesitamos una conexión
BLE separada al strap.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable

from bleak import BleakClient, BleakScanner

logger = logging.getLogger(__name__)

HR_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb"
HR_MEASUREMENT_UUID = "00002a37-0000-1000-8000-00805f9b34fb"

HRCallback = Callable[[int], None]


@dataclass
class DiscoveredHRStrap:
    name: str
    address: str
    rssi: int | None = None


def _parse_hr_measurement(data: bytes) -> int | None:
    """Parse Heart Rate Measurement (UUID 0x2A37).

    Layout (Bluetooth GATT spec):
      Byte 0: flags
        bit 0 = 0 → HR value en uint8 (byte 1)
        bit 0 = 1 → HR value en uint16 LE (bytes 1-2)
      (los demás bits — sensor contact, energy expended, RR — los ignoramos)
    """
    if not data:
        return None
    is_16bit = (data[0] & 0x01) == 0x01
    if is_16bit:
        if len(data) < 3:
            return None
        return int.from_bytes(data[1:3], "little")
    if len(data) < 2:
        return None
    return data[1]


class HRClient:
    """Conexión BLE al HR strap. Mantiene el último BPM y dispara callback."""

    def __init__(self) -> None:
        self._client: BleakClient | None = None
        self._latest_bpm: int | None = None
        self._cb: HRCallback | None = None
        self._address: str | None = None
        self._name: str | None = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    @property
    def latest_bpm(self) -> int | None:
        return self._latest_bpm

    @property
    def device_name(self) -> str | None:
        return self._name

    def set_callback(self, cb: HRCallback) -> None:
        self._cb = cb

    @staticmethod
    async def scan(timeout: float = 8.0) -> list[DiscoveredHRStrap]:
        logger.info("Escaneando BLE %ss buscando Heart Rate Service...", timeout)
        devices = await BleakScanner.discover(
            timeout=timeout, return_adv=True, service_uuids=[HR_SERVICE_UUID]
        )
        results: list[DiscoveredHRStrap] = []
        for addr, (device, adv) in devices.items():
            if HR_SERVICE_UUID in (adv.service_uuids or []):
                results.append(
                    DiscoveredHRStrap(
                        name=(device.name or adv.local_name or "?").strip() or "?",
                        address=addr,
                        rssi=adv.rssi,
                    )
                )
        return results

    @staticmethod
    async def find_one(timeout: float = 8.0) -> DiscoveredHRStrap | None:
        results = await HRClient.scan(timeout)
        results.sort(key=lambda d: -(d.rssi or -200))
        return results[0] if results else None

    async def connect(self, address: str, name: str | None = None) -> None:
        logger.info("Conectando a HR strap %s ...", address)
        self._client = BleakClient(address)
        await self._client.connect()
        if not self._client.is_connected:
            raise RuntimeError(f"No pude conectar al HR strap {address}")
        await self._client.start_notify(HR_MEASUREMENT_UUID, self._on_notify)
        self._address = address
        self._name = name
        logger.info("HR strap conectado y suscripto a notifications")

    def _on_notify(self, _handle, data: bytearray) -> None:
        bpm = _parse_hr_measurement(bytes(data))
        if bpm is not None and bpm > 0:
            self._latest_bpm = bpm
            if self._cb:
                try:
                    self._cb(bpm)
                except Exception as e:
                    logger.error("HR callback raised: %s", e)

    async def disconnect(self) -> None:
        if self._client and self._client.is_connected:
            try:
                await self._client.stop_notify(HR_MEASUREMENT_UUID)
            except Exception as e:
                logger.warning("Error desuscribiendo HR: %s", e)
            await self._client.disconnect()
            logger.info("HR strap desconectado")
