"""Biblioteca de workouts del rodillo, definidos en % de FTP.

Los watts se calculan al pedirlos con el FTP de los ajustes: cuando cambiás
el FTP (por ejemplo después de un test), toda la biblioteca se re-escala sola.

Mezcla workouts ERG (`pct`: fracción de FTP) y de pendiente (`grade`).
"""

from __future__ import annotations

import logging

from rodillo.trainer.workout import Segment, Workout

logger = logging.getLogger(__name__)

DEFAULT_FTP = 200


def _p(minutes: float, pct: float, label: str) -> tuple:
    return ("pct", minutes * 60, pct, label)


def _g(minutes: float, grade: float, label: str) -> tuple:
    return ("grade", minutes * 60, grade, label)


def _warmup(minutes: int = 10) -> list[tuple]:
    half = minutes / 2
    return [_p(half, 0.50, "Calentamiento Z1"), _p(half, 0.65, "Calentamiento Z2")]


def _cooldown(minutes: int = 5) -> list[tuple]:
    return [_p(minutes, 0.45, "Vuelta a la calma")]


def _z2(minutes: int) -> list[tuple]:
    main = minutes - 15
    return _warmup(10) + [_p(main, 0.72, f"Z2 sostenido ({main}')")] + _cooldown()


def _repeat(n: int, work: list[tuple], rest: list[tuple]) -> list[tuple]:
    out: list[tuple] = []
    for i in range(n):
        out += [(k, d, v, f"{lbl} {i + 1}/{n}") for k, d, v, lbl in work]
        if i < n - 1:
            out += rest
    return out


# (nombre, categoría, descripción, pasos)
_LIBRARY: list[tuple[str, str, str, list[tuple]]] = [
    ("Recuperación 30'", "Recuperación",
     "30 minutos suaves al 50% FTP. Para el día después de algo duro.",
     [_p(30, 0.50, "Recuperación")]),
    ("Z2 45'", "Base", "Base aeróbica corta: 30' de Z2 sostenido al 72% FTP.", _z2(45)),
    ("Z2 60'", "Base", "Una hora de base. El pan de cada día en pretemporada.", _z2(60)),
    ("Z2 90'", "Base", "Fondo largo en el rodillo. Ideal con una ruta de escenario.", _z2(90)),
    ("Z2 con cadencia 60'", "Base",
     "Z2 con 6 bloques de 1' a cadencia alta (100+ rpm) para soltar la pedalada.",
     _warmup(10) + _repeat(6, [_p(6, 0.72, "Z2"), _p(1, 0.72, "Cadencia 100+ rpm")], []) + [_p(3, 0.70, "Z2")] + _cooldown()),
    ("Z3 10'+8'+2'", "Umbral",
     "Fondo de 1h30 con bloques de Z3: 10', 5' Z2, 8' Z3 y 2' Z3/Z4. El resto en Z2.",
     _warmup(10) + [_p(15, 0.72, "Z2"), _p(10, 0.88, "★ Z3 10'"), _p(5, 0.70, "Z2"),
                    _p(8, 0.88, "★ Z3 8'"), _p(2, 0.97, "★ Z3/Z4 2'"), _p(35, 0.72, "Z2")] + _cooldown()),
    ("3×5' Z3 en fondo", "Umbral",
     "3×5' en Z3 con 2' de recuperación dentro de un fondo Z2.",
     _warmup(10) + [_p(10, 0.72, "Z2")] + _repeat(3, [_p(5, 0.88, "★ Z3")], [_p(2, 0.65, "Recuperación")])
     + [_p(16, 0.72, "Z2")] + _cooldown()),
    ("Tempo 2×20'", "Umbral", "Dos bloques largos al 82% FTP: aguante en tempo.",
     _warmup(10) + _repeat(2, [_p(20, 0.82, "★ Tempo")], [_p(5, 0.60, "Recuperación")]) + _cooldown()),
    ("Sweet Spot 4×8", "Umbral", "4 bloques de 8' al 90% FTP con 4' suaves.",
     _warmup(10) + _repeat(4, [_p(8, 0.90, "★ Sweet spot")], [_p(4, 0.60, "Recuperación")]) + _cooldown()),
    ("Over-unders 3×9'", "Umbral",
     "Bloques de 9' alternando 2' al 95% y 1' al 105%: enseña a limpiar lactato sobre el umbral.",
     _warmup(10) + _repeat(3, [_p(2, 0.95, "Under"), _p(1, 1.05, "Over"), _p(2, 0.95, "Under"), _p(1, 1.05, "Over"),
                               _p(2, 0.95, "Under"), _p(1, 1.05, "Over")], [_p(5, 0.55, "Recuperación")]) + _cooldown()),
    ("Pirámide 1-2-3-4-3-2-1", "VO2máx",
     "Escalera al 105–115% FTP con recuperación igual al bloque.",
     _warmup(12) + [step for m in (1, 2, 3, 4, 3, 2, 1)
                    for step in (_p(m, 1.15 if m <= 2 else 1.08, f"★ {m}'"), _p(m, 0.55, "Recuperación"))]
     + _cooldown()),
    ("VO2máx 4×4'", "VO2máx", "4×4' al 112% FTP con 3' suaves. Quema pulmones.",
     _warmup(10) + _repeat(4, [_p(4, 1.12, "★ VO2")], [_p(3, 0.55, "Recuperación")]) + _cooldown()),
    ("Sprints 8×30s", "Sprint", "8 sprints de 30\" al 200% con 3' de recuperación.",
     _warmup(10) + _repeat(8, [_p(0.5, 2.0, "★ Sprint")], [_p(3, 0.50, "Recuperación")]) + _cooldown()),
    ("FTP Test 20min", "Test",
     "Protocolo Coggan: calentamiento, 5' fuerte, 10' suave y 20' al máximo sostenible (en pendiente 0%, "
     "vos ponés el ritmo). FTP = 95% del promedio de los 20'.",
     [_p(5, 0.45, "Cale. Z1"), _p(5, 0.60, "Cale. Z2"), _p(5, 0.70, "Cale. tempo"),
      _g(1, 0.0, "Transición — abrí el motor"), _g(5, 0.0, "★ 5' fuerte (pacealo, no sprintees)"),
      _p(10, 0.45, "Recuperación Z1"), _g(20, 0.0, "★★ 20' SOSTENIDO MÁXIMO"), _p(10, 0.40, "Vuelta a la calma")]),
    ("Subida sostenida", "Pendiente",
     "Calentás en plano y la pendiente sube cada 4' hasta 10%.",
     [_g(5, 0.0, "Plano"), _g(4, 2.0, "Subida 2%"), _g(4, 4.0, "Subida 4%"), _g(4, 6.0, "Subida 6%"),
      _g(4, 8.0, "Subida 8%"), _g(4, 10.0, "Cumbre 10%"), _g(5, -3.0, "Bajada")]),
    ("Colinas", "Pendiente", "Perfil ondulado 4–8% con bajadas. Vos controlás la cadencia.",
     [_g(5, 0.0, "Plano"), _g(3, 4.0, "Colina 4%"), _g(2, 0.0, "Llano"), _g(4, 6.0, "Colina 6%"),
      _g(3, -2.0, "Bajada"), _g(2, 8.0, "Rampa 8%"), _g(2, 0.0, "Llano"), _g(5, 5.0, "Falso llano 5%"),
      _g(3, -3.0, "Bajada"), _g(5, 0.0, "Llano")]),
]


def current_ftp() -> int:
    from rodillo.settings import load_settings
    return int(load_settings().ftp_w or DEFAULT_FTP)


def _build(name: str, category: str, desc: str, steps: list[tuple], ftp: int) -> Workout:
    segs = []
    for kind, dur, val, label in steps:
        if kind == "pct":
            segs.append(Segment(duration_s=dur, target_w=int(round(val * ftp)), label=label))
        else:
            segs.append(Segment(duration_s=dur, grade_pct=val, label=label))
    return Workout(name=name, description=desc, segments=segs, source="library", category=category)


def get_routes(ftp: int | None = None) -> list[Workout]:
    ftp = ftp or current_ftp()
    return [_build(n, c, d, s, ftp) for n, c, d, s in _LIBRARY]


def get_route(name: str, ftp: int | None = None) -> Workout | None:
    for n, c, d, s in _LIBRARY:
        if n == name:
            return _build(n, c, d, s, ftp or current_ftp())
    return None
