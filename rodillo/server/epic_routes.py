"""Rutas épicas recreadas: perfil + geometría + detalles para la escena 3D.

No tenemos el GPS real de estos puertos, así que se RECREAN de forma aproximada
a partir de datos públicos conocidos (largo, desnivel, número de curvas):

- Perfil: pendiente media por km.
- Geometría: tramos con curvas suaves y zonas de zigzag en la ladera
  (curvas de 180° numeradas, como los "lacets" del Alpe o las 40 curvas de
  Farellones). Se generan lat/lon alrededor de un punto real de partida para
  que el minimapa y el TCX tengan sentido.
- Detalles (`landmarks`): pueblos, curvas famosas, cumbre; y `theme`, que
  elige el paisaje 3D (alpes, provenza, andes, lagos, costa).

Las descripciones dicen "recreación aproximada" — no son el trazado exacto.
"""

from __future__ import annotations

import math
import random

from rodillo.trainer.ride import RouteProfile, build_profile

STEP = 10.0
TURN_R = 13.0                  # radio de las curvas de herradura (m)
TRAVERSE = math.radians(70)    # los tramos cruzan la ladera a ±70° de la pendiente
TURN_ANGLE = 2 * TRAVERSE      # cada herradura pasa de +70° a −70° (por el lado de arriba)

EPICS: dict[str, dict] = {
    "alpe": {
        "name": "Alpe d'Huez",
        "region": "Alpes · Francia",
        "theme": "alpine",
        "anchor": (45.0553, 6.0306),
        "start_ele": 740,
        "km_grades": [10.4, 9.4, 8.6, 7.9, 8.6, 7.8, 8.3, 8.1, 7.6, 8.8, 7.0, 7.5, 6.9, 5.6],
        "hairpins": {"from_km": 0.9, "to_km": 13.2, "count": 21, "descending": True, "label": "Virage {n}"},
        "landmarks": [(0.0, "village", "Bourg-d'Oisans"), (9.4, "village", "Huez"),
                      (14.0, "summit", "Meta · Alpe d'Huez")],
        "named_hairpins": {7: "Virage 7 · Dutch Corner"},
        "description": "Los 21 virajes numerados desde Bourg-d'Oisans; la curva 7 es la Dutch Corner. "
                       "Recreación aproximada (13,8 km al 8,1%).",
    },
    "ventoux": {
        "name": "Mont Ventoux",
        "region": "Provenza · Francia",
        "theme": "provence",
        "treeless_from_km": 15.7,
        "anchor": (44.1240, 5.1770),
        "start_ele": 300,
        "km_grades": [4.3, 4.5, 4.4, 4.8, 5.6, 7.4, 9.4, 9.0, 9.2, 10.0, 9.6, 9.5, 8.9,
                      8.6, 8.4, 6.9, 5.5, 6.6, 7.6, 8.2, 9.8],
        "hairpins": {"from_km": 19.6, "to_km": 21.0, "count": 2, "descending": False, "label": "Curva"},
        "landmarks": [(0.0, "village", "Bédoin"), (5.8, "sign", "Saint-Estève · empieza el bosque"),
                      (15.7, "village", "Chalet Reynard · se acaba el bosque"),
                      (20.3, "sign", "Memorial Tom Simpson"), (21.0, "summit", "Cumbre · Observatorio")],
        "description": "El Gigante de Provenza desde Bédoin: 10 km de bosque al 9% y después el paisaje lunar "
                       "de piedra blanca hasta el observatorio. Recreación aproximada.",
    },
    "stelvio": {
        "name": "Passo dello Stelvio",
        "region": "Dolomitas · Italia",
        "theme": "alpine_high",
        "anchor": (46.6180, 10.5900),
        "start_ele": 915,
        "km_grades": [5.0, 5.5, 6.0, 6.5, 7.0, 7.2, 7.5, 7.0, 7.5, 7.8, 8.0, 8.2, 8.0, 7.6,
                      8.0, 8.4, 8.0, 7.8, 8.2, 8.0, 7.9, 8.0, 7.6, 7.2],
        "hairpins": {"from_km": 9.5, "to_km": 23.8, "count": 48, "descending": True, "label": "Tornante {n}"},
        "landmarks": [(0.0, "village", "Prato allo Stelvio"), (9.0, "village", "Trafoi"),
                      (24.0, "summit", "Passo dello Stelvio · 2758 m")],
        "description": "48 tornantes numerados hasta la Cima Coppi, entre paredes de nieve. Recreación aproximada.",
    },
    "tourmalet": {
        "name": "Col du Tourmalet",
        "region": "Pirineos · Francia",
        "theme": "alpine",
        "anchor": (42.9750, 0.1950),
        "start_ele": 857,
        "km_grades": [5.0, 5.5, 6.0, 7.0, 7.5, 8.0, 7.5, 8.5, 8.0, 7.5, 8.0, 8.5, 7.0, 8.5, 9.5, 9.0, 8.5],
        "hairpins": {"from_km": 13.4, "to_km": 16.8, "count": 6, "descending": False, "label": "Curva"},
        "landmarks": [(0.0, "village", "Sainte-Marie-de-Campan"), (12.8, "village", "La Mongie"),
                      (17.0, "summit", "Cumbre · Le Géant du Tourmalet")],
        "description": "El puerto más subido del Tour, por La Mongie y sus curvas finales hasta la estatua del Géant. "
                       "Recreación aproximada.",
    },
    "farellones": {
        "name": "Las 40 Curvas · Farellones",
        "region": "Cordillera · Santiago",
        "theme": "andes",
        "anchor": (-33.3530, -70.4100),
        "start_ele": 1050,
        "km_grades": [6.5, 7.0, 7.5, 8.0, 8.0, 8.5, 8.0, 8.5, 8.0, 7.5, 8.0, 8.5, 8.0, 7.5, 7.0, 6.5],
        "hairpins": {"from_km": 1.0, "to_km": 15.5, "count": 40, "descending": False, "label": "Curva {n}"},
        "landmarks": [(0.0, "village", "Corral Quemado"), (16.0, "summit", "Farellones")],
        "description": "La subida mítica de Santiago: 40 curvas numeradas hacia los centros de esquí, "
                       "con la cordillera nevada de fondo. Recreación aproximada.",
    },
    "caracoles": {
        "name": "Los Caracoles · Portillo",
        "region": "Paso Los Libertadores · Chile",
        "theme": "andes_high",
        "anchor": (-32.8600, -70.1500),
        "start_ele": 2200,
        "km_grades": [5.5, 6.5, 7.0, 7.5, 7.5, 8.0, 7.5, 8.0, 7.5, 6.5],
        "hairpins": {"from_km": 1.2, "to_km": 9.0, "count": 29, "descending": False, "label": "Caracol {n}"},
        "landmarks": [(0.0, "village", "Juncal"), (10.0, "summit", "Portillo · Laguna del Inca")],
        "description": "Los 29 caracoles camino a Portillo, en plena alta cordillera. Recreación aproximada.",
    },
    "sacalobra": {
        "name": "Sa Calobra",
        "region": "Mallorca · España",
        "theme": "coast",
        "anchor": (39.8510, 2.8060),
        "start_ele": 5,
        "km_grades": [6.5, 7.0, 7.5, 7.0, 7.5, 8.0, 7.0, 6.5, 6.0],
        "hairpins": {"from_km": 0.6, "to_km": 8.4, "count": 26, "descending": False, "label": "Curva {n}"},
        "landmarks": [(0.0, "village", "Port de Sa Calobra"), (8.6, "sign", "Nus de Sa Corbata"),
                      (9.0, "summit", "Coll dels Reis")],
        "description": "La serpiente de Mallorca: 26 curvas desde el mar hasta el Coll dels Reis, con el famoso "
                       "nudo de corbata al final. Recreación aproximada.",
    },
    "angliru": {
        "name": "L'Angliru",
        "region": "Asturias · España",
        "theme": "alpine",
        "anchor": (43.2290, -5.9300),
        "start_ele": 330,
        "km_grades": [6.5, 7.0, 7.5, 7.8, 6.0, 2.5, 12.0, 14.0, 13.5, 17.5, 14.0, 11.0, 9.0],
        "hairpins": {"from_km": 6.8, "to_km": 12.6, "count": 9, "descending": False, "label": "Curva"},
        "landmarks": [(0.0, "village", "Riosa"), (6.0, "sign", "Respiro antes del muro"),
                      (9.3, "sign", "Cueña les Cabres · 23%"), (13.0, "summit", "Alto de L'Angliru")],
        "description": "La subida más brutal de la Vuelta: 6 km tranquilos, un respiro y después 6 km por encima "
                       "del 13% con la Cueña les Cabres. Recreación aproximada.",
    },
    "galibier": {
        "name": "Col du Galibier",
        "region": "Alpes · Francia",
        "theme": "alpine_high",
        "anchor": (45.1600, 6.4300),
        "start_ele": 1430,
        "km_grades": [3.0, 4.0, 5.0, 6.0, 5.0, 6.0, 7.0, 6.0, 5.0, 7.0, 7.0, 8.0, 8.0, 7.0, 8.0, 9.0, 10.0, 9.0],
        "hairpins": {"from_km": 8.8, "to_km": 17.6, "count": 8, "descending": False, "label": "Lacet {n}"},
        "landmarks": [(0.0, "village", "Valloire"), (8.5, "village", "Plan Lachat"),
                      (18.0, "summit", "Col du Galibier · 2642 m")],
        "description": "Desde Valloire por el valle hasta Plan Lachat y después los lacets de alta montaña "
                       "sobre los 2600 m. Recreación aproximada.",
    },
    "osorno": {
        "name": "Volcán Osorno",
        "region": "Lagos · sur de Chile",
        "theme": "lakes",
        "anchor": (-41.1300, -72.5300),
        "start_ele": 60,
        "km_grades": [3.0, 4.5, 6.0, 7.5, 8.0, 8.5, 9.0, 9.5, 9.0, 10.0, 9.5, 10.5, 9.0, 8.5],
        "hairpins": {"from_km": 7.5, "to_km": 13.6, "count": 12, "descending": False, "label": "Curva {n}"},
        "landmarks": [(0.0, "village", "Ensenada"), (6.0, "sign", "Bosque nativo"),
                      (14.0, "summit", "Centro de ski · Volcán Osorno")],
        "description": "Desde el lago hasta el centro de ski por las laderas del volcán, con el Llanquihue abajo. "
                       "Recreación aproximada.",
    },
    "volcanes": {
        "name": "Ruta de los Volcanes",
        "region": "Lagos · sur de Chile",
        "theme": "lakes",
        "anchor": (-41.2500, -72.7500),
        "start_ele": 70,
        "km_grades": [0.5, 1.5, -1.0, 2.5, 3.0, -2.0, -1.5, 1.0, 2.0, 0.5, -2.5, 1.5, 3.5, 2.0,
                      -3.0, -1.0, 1.0, 0.0, 2.0, -1.5, -2.0, 1.5, 2.5, -1.0, -2.5, 0.5, 1.0, -1.5, -0.5, 0.0],
        "landmarks": [(0.0, "village", "Costanera"), (8.0, "sign", "Mirador del volcán"),
                      (15.0, "village", "Caleta"), (30.0, "summit", "Meta · muelle")],
        "description": "Inventada: 30 km ondulados bordeando el lago, con el volcán nevado siempre a la vista.",
    },
    "pacifico": {
        "name": "Costanera del Pacífico",
        "region": "Costa central · Chile",
        "theme": "coast",
        "anchor": (-33.0300, -71.6300),
        "start_ele": 15,
        "km_grades": [0.2, -0.3, 0.8, 1.5, -1.2, 0.3, -0.5, 0.6, 1.8, -1.6, 0.2, 0.0,
                      0.5, -0.4, 1.2, -1.0, 0.3, -0.2, 0.8, -0.9, 0.4, 0.0, 0.6, -0.6, 0.0],
        "landmarks": [(0.0, "village", "Muelle"), (12.5, "sign", "Faro"), (25.0, "summit", "Meta · caleta")],
        "description": "Inventada: 25 km casi planos frente al mar. Perfecta para Z2 largo o un workout.",
    },
}


def _hairpin_numbers(spec: dict) -> list[int]:
    hp = spec["hairpins"]
    n = hp["count"]
    return list(range(n, 0, -1)) if hp.get("descending") else list(range(1, n + 1))


def _geometry(spec: dict, total_m: float) -> tuple[list[tuple[float, float]], list[dict]]:
    """Recorre la ruta cada STEP m y devuelve posiciones (x este, y norte) + landmarks.

    Variación determinística por ruta (semilla = nombre): patas del zigzag de
    largo distinto, ángulo de travesía variable y una ladera que gira de a poco,
    para que no quede una escalera perfecta.
    """
    rnd = random.Random(spec["name"])
    hp = spec.get("hairpins")
    hp_from = hp["from_km"] * 1000 if hp else math.inf
    hp_to = hp["to_km"] * 1000 if hp else math.inf
    n_hp = hp["count"] if hp else 0
    numbers = _hairpin_numbers(spec) if n_hp else []
    named = spec.get("named_hairpins", {})
    # largos de pata variables que suman lo que da la zona
    traverses = [math.radians(rnd.uniform(55, 80)) for _ in range(n_hp + 1)]
    turn_lens = [(traverses[i] + traverses[i + 1]) * TURN_R for i in range(n_hp)]
    weights = [rnd.uniform(0.6, 1.4) for _ in range(n_hp + 1)]
    avail = max(60.0 * (n_hp + 1), (hp_to - hp_from) - sum(turn_lens)) * 0.97
    legs = [avail * w / sum(weights) for w in weights] if n_hp else []
    phase = rnd.uniform(0, 6.28)

    x = y = 0.0
    heading = 0.0                # 0 = norte (subiendo la ladera)
    side = 1                     # en zigzag: +1 cruza hacia el este, -1 al oeste
    marks: list[dict] = []
    pts: list[tuple[float, float]] = []
    d = 0.0
    seg_start = hp_from
    turning_until = -1.0
    turn_rate = 0.0
    hp_i = 0
    while d <= total_m + 1e-6:
        pts.append((x, y))
        slope_dir = 0.55 * math.sin(d / 2600.0 + phase)        # la ladera gira de a poco
        if hp_from <= d < hp_to and n_hp:
            if d < turning_until:
                heading += turn_rate * STEP
            elif hp_i < n_hp and d - seg_start >= legs[hp_i]:
                turn_len = turn_lens[hp_i]
                turning_until = d + turn_len
                turn_rate = -side * (traverses[hp_i] + traverses[hp_i + 1]) / turn_len
                num = numbers[hp_i]
                label = named.get(num) or hp["label"].format(n=num)
                marks.append({"d": round(d + turn_len / 2), "kind": "hairpin", "label": label, "n": num})
                hp_i += 1
                side = -side
                seg_start = d + turn_len
                heading += turn_rate * STEP
            else:
                target = slope_dir + side * traverses[hp_i]
                heading += (target - heading) * 0.25
        else:
            target = slope_dir + 0.5 * math.sin(d / 380.0 + phase) + 0.25 * math.sin(d / 137.0 + 1.1)
            heading += (target - heading) * 0.08
        x += math.sin(heading) * STEP
        y += math.cos(heading) * STEP
        d += STEP
    for km, kind, label in spec.get("landmarks", []):
        marks.append({"d": round(min(km * 1000, total_m)), "kind": kind, "label": label})
    marks.sort(key=lambda m: m["d"])
    return pts, marks


def build_epic(key: str) -> RouteProfile:
    spec = EPICS[key]
    grades = spec["km_grades"]
    total = len(grades) * 1000.0
    pts, marks = _geometry(spec, total)
    lat0, lon0 = spec["anchor"]
    kx = 111320.0 * math.cos(math.radians(lat0))
    dist, points = [], []
    for i, (x, y) in enumerate(pts):
        d = min(i * STEP, total)
        km = min(int(d // 1000), len(grades) - 1)
        base = spec["start_ele"] + sum(grades[:km]) * 10
        ele = base + grades[km] * (d - km * 1000) / 100
        dist.append(d)
        points.append((lat0 + y / 110540.0, lon0 + x / kx, ele))
    gain = sum(max(0.0, g) * 10 for g in grades)
    meta = {
        "group": "Épicas",
        "theme": spec["theme"],
        "region": spec["region"],
        "landmarks": marks,
        "treeless_from_m": spec["treeless_from_km"] * 1000 if spec.get("treeless_from_km") else None,
        "subtitle": f"{spec['region']} · {len(grades)} km · +{gain:.0f} m",
    }
    return build_profile(id=f"climb:{key}", name=spec["name"], source="climb",
                         points=points, distances=dist, description=spec["description"], meta=meta)
