"""rodillo: busca tu rodillo inteligente (Bluetooth FTMS), conecta y abre la app.

Uso:
  python -m rodillo                  # busca el rodillo y conecta
  python -m rodillo --sim            # simulador (sin rodillo, para probar)
  python -m rodillo --address XX:..  # conecta a una dirección específica
  python -m rodillo --port 8080      # cambia el puerto
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import webbrowser

from aiohttp import web

from rodillo.server.app import build_app
from rodillo.trainer.client import TacxClient
from rodillo.trainer.hr_client import HRClient
from rodillo.trainer.simulator import TacxSimulator

logger = logging.getLogger(__name__)


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    # Silenciar cosas charlatanas
    for noisy in ("aiohttp.access", "bleak.backends.corebluetooth.client"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


async def setup_trainer(args) -> TacxClient | TacxSimulator:
    if args.sim:
        sim = TacxSimulator()
        await sim.connect()
        return sim

    client = TacxClient()
    if args.address:
        await client.connect(args.address)
    else:
        logger.info("Buscando rodillo FTMS por Bluetooth...")
        device = await client.find_one(timeout=args.scan_timeout)
        if not device:
            logger.error(
                "No encontré ningún trainer FTMS. "
                "Asegurate de que el rodillo esté encendido y NO conectado a otra app."
            )
            logger.info("Tip: probá 'python -m rodillo --sim' para usar el simulador.")
            sys.exit(2)
        logger.info("Encontrado: %s (%s, RSSI %s)", device.name, device.address, device.rssi)
        await client.connect(device.address)

    # Tomamos control + start automático para que ERG funcione desde el primer slider.
    # El Flux S a veces rechaza con GATT 0x80 si el rodillo está quieto o el CCCD no
    # propagó todavía — retry con backoff resuelve la mayoría de los casos.
    last_err: Exception | None = None
    for attempt in range(5):
        try:
            await client.request_control()
            await client.start()
            last_err = None
            break
        except Exception as e:
            last_err = e
            if attempt < 4:
                delay = 2 ** attempt
                logger.warning(
                    "request_control intento %d/5 falló (%s) — reintento en %ds",
                    attempt + 1, e, delay,
                )
                await asyncio.sleep(delay)
    if last_err is not None:
        logger.error(
            "No pude tomar control del trainer tras 5 intentos: %s. "
            "Probá pedalear 10 vueltas y mandar request_control desde la UI, "
            "o apagá y prendé el rodillo.",
            last_err,
        )
    return client


async def setup_hr(args) -> HRClient | None:
    """Conecta a una banda cardíaca BLE estándar. Devuelve None si no hay o falla."""
    if args.sim or args.no_hr:
        return None
    hr = HRClient()
    if args.hr_address:
        try:
            await hr.connect(args.hr_address)
            return hr
        except Exception as e:
            logger.warning("No pude conectar al HR strap (%s): %s", args.hr_address, e)
            return None
    logger.info("Buscando banda cardíaca por BLE...")
    try:
        device = await HRClient.find_one(timeout=args.hr_scan_timeout)
    except Exception as e:
        logger.warning("Error escaneando HR: %s", e)
        return None
    if not device:
        logger.warning(
            "No encontré banda cardíaca (Heart Rate Service 0x180D). "
            "Continuando sin HR — usá --hr-address XX:.. o --no-hr para silenciar."
        )
        return None
    logger.info(
        "HR strap encontrado: %s (%s, RSSI %s)", device.name, device.address, device.rssi
    )
    try:
        await hr.connect(device.address, name=device.name)
        return hr
    except Exception as e:
        logger.warning("No pude conectar al HR strap: %s", e)
        return None


async def amain(args) -> None:
    setup_logging(args.verbose)
    trainer = await setup_trainer(args)
    hr_client = await setup_hr(args)
    app = build_app(trainer, hr_client=hr_client)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="127.0.0.1", port=args.port)
    try:
        await site.start()
    except OSError as e:
        logger.error(
            "No pude bindear el puerto %d (%s). "
            "Probablemente otro proceso lo está usando — comprobá con "
            "`lsof -i :%d`. Probá `--port XXXX` con otro número (ej 8766).",
            args.port, e, args.port,
        )
        await runner.cleanup()
        return
    url = f"http://127.0.0.1:{args.port}/"
    logger.info("Server corriendo en %s", url)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    print(f"\n  Abrí {url} en tu navegador.\n  Ctrl-C para terminar.\n")

    # Loop infinito hasta Ctrl-C
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main() -> None:
    p = argparse.ArgumentParser(description="rodillo")
    p.add_argument("--sim", action="store_true", help="Modo simulador (no usa BLE)")
    p.add_argument("--address", help="MAC del trainer (skipea el scan)")
    p.add_argument("--scan-timeout", type=float, default=10.0)
    p.add_argument(
        "--hr-address",
        help="MAC de la banda cardíaca (skipea el scan de HR)",
    )
    p.add_argument(
        "--hr-scan-timeout",
        type=float,
        default=8.0,
        help="Timeout del scan de HR strap",
    )
    p.add_argument(
        "--no-hr",
        action="store_true",
        help="No buscar/conectar banda cardíaca (modo trainer-only)",
    )
    # servers. Sobreescribí con --port XXXX si necesitás.
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("\nBye.")


if __name__ == "__main__":
    main()
