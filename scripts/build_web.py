"""Arma la versión web estática (GitHub Pages) en ./site.

La app web corre entera en el navegador (static/engine.js): se conecta al
rodillo por Web Bluetooth y no necesita servidor. Este script copia los
estáticos, activa el motor web y pre-genera los datos que en la versión con
Python calcula el servidor: perfiles de las rutas épicas y la biblioteca de
workouts (en % de FTP, el navegador los escala con el FTP de cada usuario).

    python scripts/build_web.py          # → site/
    python -m http.server -d site 8000   # probarlo en http://localhost:8000
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from rodillo.server.epic_routes import EPICS, build_epic  # noqa: E402
from rodillo.server.route_library import _LIBRARY  # noqa: E402

STATIC = ROOT / "rodillo" / "server" / "static"
OUT = ROOT / "site"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(STATIC, OUT / "static")

    html = (STATIC / "index.html").read_text(encoding="utf-8")
    html = html.replace('"/static/', '"./static/')
    html = html.replace("<head>", '<head>\n    <meta name="rodillo-mode" content="web">', 1)
    html = html.replace('<script src="./static/rig.js', '<script src="./static/engine.js?v=1"></script>\n<script src="./static/rig.js', 1)
    (OUT / "index.html").write_text(html, encoding="utf-8")

    data = OUT / "data" / "routes"
    data.mkdir(parents=True)
    index = []
    for key in EPICS:
        prof = build_epic(key)
        d = prof.to_dict()
        (data / f"climb_{key}.json").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
        index.append({**prof.summary(), "gbins": prof.grade_bins()})
    (data / "index.json").write_text(json.dumps(index, ensure_ascii=False))

    workouts = [{"name": n, "category": c, "description": d, "steps": [list(s) for s in steps]}
                for n, c, d, steps in _LIBRARY]
    (OUT / "data" / "workouts.json").write_text(json.dumps(workouts, ensure_ascii=False))
    (OUT / ".nojekyll").write_text("")
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"site/ listo: {len(EPICS)} rutas, {len(workouts)} workouts, {size:.1f} MB")


if __name__ == "__main__":
    main()
