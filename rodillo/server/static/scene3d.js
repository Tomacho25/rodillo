// rodillo · escena 3D (three.js r169, sin build).
//
// Técnicas:
// - Camino = cinta que sigue la ruta (rumbo + altura cada 5 m), con el terreno
//   aplanado debajo (técnica del foro de three.js "road following spline").
// - Terreno por "chunks" alrededor del ciclista: la altura base es la del camino
//   cercano (promedio ponderado) + montañas de ruido fractal que crecen con la
//   distancia al camino, coloreadas por altura/pendiente según el paisaje.
// - Cielo físico (Sky.js, modelo de Preetham) con el sol según la hora real.
// - Bosque, rocas, casas y público con InstancedMesh (miles de objetos baratos).
// - Origen flotante: todo se re-centra en cada chunk para no perder precisión.
//
// rig.js llama a Scene3D.frame(params) en cada cuadro; si WebGL no está, sigue
// usando la escena 2D.

import * as THREE from "three";
import { Sky } from "./vendor/Sky.js";

const STEP = 5;                 // m entre muestras del camino
const ROAD_W = 3.6;             // medio ancho del asfalto
const CHUNK_BACK = 450, CHUNK_AHEAD = 2300, REBUILD_EVERY = 260;
const TERRAIN_SIZE = 2800, TERRAIN_SEG = 220;

// ------------------------------------------------------------------ paisajes
const THEMES = {
    alpine:      { grass: 0x4f7d39, grass2: 0x6b8f45, rock: 0x7b746a, snow: 0xf3f6f9, snowline: 2350, treeline: 2050, trees: 1.0, amp: 520, wall: 700, water: null, house: 0xe9e2d0, roof: 0x7a3b2e },
    alpine_high: { grass: 0x5f7f45, grass2: 0x7d8f55, rock: 0x7f786f, snow: 0xf3f6f9, snowline: 2250, treeline: 1950, trees: 0.8, amp: 650, wall: 850, water: null, house: 0xe9e2d0, roof: 0x5a4a3e },
    provence:    { grass: 0x5d7d3a, grass2: 0x7f8f4a, rock: 0xd8d2c4, snow: 0xf1efe9, snowline: 99999, treeline: 1500, trees: 1.2, amp: 260, wall: 300, water: null, house: 0xe6d3b3, roof: 0xb0573a, bare: 0xd9d3c5 },
    andes:       { grass: 0x8a7350, grass2: 0x9c845c, rock: 0x6f5f4f, snow: 0xf5f7fa, snowline: 2900, treeline: 1400, trees: 0.12, amp: 700, wall: 1100, water: null, house: 0xd8d0c0, roof: 0x8a3d2c, shrub: true },
    andes_high:  { grass: 0x857057, grass2: 0x977f60, rock: 0x6a5c50, snow: 0xf5f7fa, snowline: 2800, treeline: 0, trees: 0.0, amp: 800, wall: 1300, water: null, house: 0xd8d0c0, roof: 0x8a3d2c },
    lakes:       { grass: 0x3f7d36, grass2: 0x5b9440, rock: 0x6f6a62, snow: 0xf5f7fa, snowline: 1900, treeline: 1200, trees: 1.3, amp: 160, wall: 140, water: "left", volcano: true, house: 0xf0e6d8, roof: 0xc0392b },
    coast:       { grass: 0x6f8f3f, grass2: 0x8ea24f, rock: 0x8a8070, snow: 0xffffff, snowline: 99999, treeline: 600, trees: 0.35, amp: 90, wall: 80, water: "right", sand: 0xdccb9c, house: 0xf4f1ea, roof: 0x2f6fb0 },
};

const PAL = {
    dawn:  { sunElev: 5, sunAz: 100, sun: 0xffc59a, sunI: 1.6, hemi: 0.55, fog: 0xe8c9b4, exposure: 0.42, turb: 8, ray: 2.6 },
    day:   { sunElev: 48, sunAz: 150, sun: 0xfff4e0, sunI: 2.6, hemi: 0.8, fog: 0xbfd7e8, exposure: 0.5, turb: 6, ray: 1.4 },
    dusk:  { sunElev: 3, sunAz: 260, sun: 0xffa36b, sunI: 1.5, hemi: 0.5, fog: 0xd9a58f, exposure: 0.4, turb: 9, ray: 3.2 },
    night: { sunElev: -8, sunAz: 260, sun: 0xa9bcff, sunI: 0.7, hemi: 0.5, fog: 0x1d2847, exposure: 0.8, turb: 2, ray: 0.3 },
};

// ------------------------------------------------------------------ ruido
function hash2(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
    let s = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; }
    return s;
}
function ridged(x, y) {   // crestas de montaña
    let s = 0, amp = 0.55, f = 1;
    for (let i = 0; i < 5; i++) { const n = 1 - Math.abs(vnoise(x * f, y * f) * 2 - 1); s += amp * n * n; f *= 2.1; amp *= 0.5; }
    return s;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rnd = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ------------------------------------------------------------------ camino
// Integra rumbo/altura cada STEP m → posiciones absolutas (x este, z sur).
class Path {
    constructor(headingAt, eleAt, length) {
        this.headingAt = headingAt; this.eleAt = eleAt; this.length = length;
        this.x = [0]; this.z = [0]; this.h = [headingAt(0)];
    }
    ensure(dMax) {
        const n = Math.ceil(dMax / STEP) + 2;
        while (this.x.length < n) {
            const i = this.x.length - 1, d = i * STEP;
            // después de la meta el camino sigue recto (zona de llegada)
            const h = d < this.length ? this.headingAt(d + STEP / 2) : this.h[i];
            this.x.push(this.x[i] + Math.sin(h) * STEP);
            this.z.push(this.z[i] - Math.cos(h) * STEP);
            this.h.push(h);
        }
    }
    at(d) {
        d = Math.max(0, d);
        this.ensure(d + STEP * 2);
        const f = d / STEP, i = Math.floor(f), t = f - i;
        let dh = this.h[i + 1] - this.h[i];
        return {
            x: this.x[i] + (this.x[i + 1] - this.x[i]) * t,
            z: this.z[i] + (this.z[i + 1] - this.z[i]) * t,
            y: this.eleAt(Math.min(d, this.length)),
            h: this.h[i] + dh * t,
        };
    }
}

// ------------------------------------------------------------------ texturas
function asphaltTexture() {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 512;
    const g = c.getContext("2d");
    g.fillStyle = "#4a4d52"; g.fillRect(0, 0, 256, 512);
    const r = rnd(7);
    for (let i = 0; i < 9000; i++) {           // grano del asfalto
        const v = 60 + r() * 50 | 0;
        g.fillStyle = `rgba(${v},${v},${v + 4},${0.35 + r() * 0.4})`;
        g.fillRect(r() * 256, r() * 512, 1 + r() * 2, 1 + r() * 2);
    }
    g.fillStyle = "rgba(30,30,32,0.35)";       // huella de las ruedas
    g.fillRect(52, 0, 30, 512); g.fillRect(174, 0, 30, 512);
    g.fillStyle = "#eeeae0";                    // bordes
    g.fillRect(8, 0, 7, 512); g.fillRect(241, 0, 7, 512);
    g.fillRect(124, 0, 8, 230);                 // línea central discontinua
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
}

function textSprite(text, { bg = "#ffffff", fg = "#1e2b45", w = 4, h = 1.1, font = 700, border = null } = {}) {
    const c = document.createElement("canvas");
    c.width = 512; c.height = Math.round(512 * h / w);
    const g = c.getContext("2d");
    g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
    if (border) { g.strokeStyle = border; g.lineWidth = 14; g.strokeRect(7, 7, c.width - 14, c.height - 14); }
    g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "middle";
    let size = c.height * 0.55;
    g.font = `${font} ${size}px system-ui, sans-serif`;
    while (g.measureText(text).width > c.width * 0.9 && size > 10) { size -= 2; g.font = `${font} ${size}px system-ui, sans-serif`; }
    g.fillText(text, c.width / 2, c.height / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: true }));
    return m;
}

// ------------------------------------------------------------------ ciclista
function makeRider(ghost) {
    const mat = c => ghost
        ? new THREE.MeshBasicMaterial({ color: 0xc9d3e3, transparent: true, opacity: 0.38, depthWrite: false })
        : new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.05 });
    const M = {
        frame: mat(0x1d2128), accent: mat(0xe0566a), tire: mat(0x111111), jersey: mat(0x2f6fe0),
        stripe: mat(0xf0c948), shorts: mat(0x15171c), skin: mat(0xd9a37f), helmet: mat(0xf5f7fa), shoe: mat(0xf2f2f2),
    };
    const g = new THREE.Group();
    const cyl = (r, m) => { const x = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10), m); x.castShadow = !ghost; g.add(x); return x; };
    const place = (mesh, a, b) => {   // cilindro de a → b
        const dir = new THREE.Vector3().subVectors(b, a);
        mesh.position.copy(a).addScaledVector(dir, 0.5);
        mesh.scale.set(1, dir.length(), 1);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    // bici (local: -z adelante, +y arriba)
    const wheelGeo = new THREE.TorusGeometry(0.335, 0.022, 8, 28);
    for (const z of [-0.52, 0.5]) {
        const w = new THREE.Mesh(wheelGeo, M.tire); w.rotation.y = Math.PI / 2; w.position.set(0, 0.34, z); w.castShadow = !ghost; g.add(w);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 8), M.frame); hub.rotation.z = Math.PI / 2; hub.position.set(0, 0.34, z); g.add(hub);
    }
    const BB = V(0, 0.3, 0), SEAT = V(0, 0.86, 0.13), HEAD = V(0, 0.84, -0.42), RA = V(0, 0.34, 0.5), FA = V(0, 0.34, -0.52);
    place(cyl(0.022, M.frame), BB, SEAT); place(cyl(0.024, M.frame), BB, HEAD); place(cyl(0.02, M.accent), SEAT, HEAD);
    place(cyl(0.014, M.frame), BB, RA); place(cyl(0.014, M.frame), SEAT, RA); place(cyl(0.02, M.frame), HEAD, FA);
    place(cyl(0.017, M.frame), V(0, 0.84, -0.42), V(0, 0.96, -0.47));
    const bar = cyl(0.016, M.frame); place(bar, V(-0.21, 0.96, -0.5), V(0.21, 0.96, -0.5));
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.26), M.shorts); saddle.position.set(0, 0.89, 0.12); g.add(saddle);
    // ciclista
    const torso = cyl(0.13, M.jersey), stripe = cyl(0.135, M.stripe);
    const armL = cyl(0.045, M.jersey), armR = cyl(0.045, M.jersey);
    const thighL = cyl(0.07, M.shorts), thighR = cyl(0.07, M.shorts), shinL = cyl(0.05, M.skin), shinR = cyl(0.05, M.skin);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10), M.skin); g.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI / 1.8), M.helmet);
    helmet.scale.set(1, 0.9, 1.25); g.add(helmet);
    const footL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.24), M.shoe), footR = footL.clone();
    g.add(footL, footR);
    [head, helmet, footL, footR].forEach(m => { m.castShadow = !ghost; });
    const tmp = new THREE.Vector3();
    // 2 huesos (muslo + canilla) con la rodilla hacia adelante
    function leg(hip, foot, thigh, shin, footMesh) {
        const L1 = 0.46, L2 = 0.44;
        const d = Math.min(L1 + L2 - 0.01, hip.distanceTo(foot));
        const a = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d));
        const dir = tmp.subVectors(foot, hip).normalize();
        const fwd = new THREE.Vector3(0, 0, -1);
        const side = new THREE.Vector3().crossVectors(dir, fwd).normalize();
        const knee = hip.clone().add(dir.clone().applyAxisAngle(side, a).multiplyScalar(L1));   // rodilla hacia adelante
        place(thigh, hip, knee); place(shin, knee, foot);
        footMesh.position.copy(foot); footMesh.position.y += 0.02;
    }
    g.userData.pose = (phase, standing) => {
        const up = standing ? 0.13 : 0, fw = standing ? -0.12 : 0;
        const hipY = 0.93 + up, hipZ = 0.1 + fw;
        const sh = V(0, 1.33 + up * 0.7, -0.27 + fw * 0.6);
        place(torso, V(0, hipY, hipZ), sh);
        place(stripe, V(0, hipY + 0.17, hipZ - 0.1), V(0, hipY + 0.21, hipZ - 0.15));
        head.position.set(0, sh.y + 0.13, sh.z - 0.1);
        helmet.position.set(0, sh.y + 0.17, sh.z - 0.1);
        for (const [s, arm] of [[-1, armL], [1, armR]]) place(arm, V(0.18 * s, sh.y - 0.02, sh.z + 0.02), V(0.2 * s, 0.97, -0.49));
        const crank = 0.17;
        for (const [s, ph, th, sn, ft] of [[-1, phase, thighL, shinL, footL], [1, phase + Math.PI, thighR, shinR, footR]]) {
            const foot = V(0.11 * s, 0.3 + Math.cos(ph) * crank, -Math.sin(ph) * crank);
            leg(V(0.1 * s, hipY, hipZ), foot, th, sn, ft);
        }
    };
    g.userData.pose(0, false);
    return g;
}

// ------------------------------------------------------------------ escena
const S = { ready: false };

function init() {
    const rig = document.getElementById("rig");
    if (!rig) return;
    let renderer;
    try {
        const canvas = document.createElement("canvas");
        canvas.id = "scene3d";
        canvas.className = "scene3d";
        rig.insertBefore(canvas, rig.firstChild);
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    } catch (e) {
        console.warn("WebGL no disponible, uso la escena 2D", e);
        document.getElementById("scene3d")?.remove();
        return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xbfd7e8, 0.00017);   // montañas lejanas azuladas
    const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 30000);

    const sky = new Sky();
    sky.scale.setScalar(25000);
    scene.add(sky);

    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a3a, 0.8);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 400 });
    sun.shadow.bias = -0.0008;
    scene.add(sun, sun.target);
    const headlight = new THREE.SpotLight(0xfff2d6, 0, 90, 0.5, 0.6, 1.2);
    scene.add(headlight, headlight.target);

    // estrellas (de noche)
    const starGeo = new THREE.BufferGeometry();
    const sp = [], r0 = rnd(11);
    for (let i = 0; i < 1500; i++) {
        const th = r0() * Math.PI * 2, ph = Math.acos(r0() * 0.9);
        sp.push(Math.sin(ph) * Math.cos(th) * 20000, Math.cos(ph) * 20000, Math.sin(ph) * Math.sin(th) * 20000);
    }
    starGeo.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false }));
    scene.add(stars);

    const world = new THREE.Group();          // todo lo del chunk (re-centrado)
    scene.add(world);
    const rider = makeRider(false), ghost = makeRider(true);
    scene.add(rider, ghost);

    Object.assign(S, {
        rig, renderer, scene, camera, sky, hemi, sun, headlight, stars, world, rider, ghost,
        asphalt: asphaltTexture(), path: null, pathKey: null, chunk: null, palKey: null, themeKey: null,
        camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), camInit: false,
        ready: true,
    });
    const resize = () => {
        const w = rig.clientWidth, h = rig.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(rig);
    resize();
    S.resize = resize;
}

// ------------------------------------------------------------------ chunk
// Malla del camino + terreno + vegetación + detalles entre dA y dB.
function buildChunk(p) {
    const { path, theme: T, landmarks, treelessFrom, finishD, kind } = p;
    const dA = Math.max(0, p.riderD - CHUNK_BACK), dB = p.riderD + CHUNK_AHEAD;
    path.ensure(dB + 50);
    const o = path.at(p.riderD);                        // origen flotante
    const OX = o.x, OZ = o.z;
    const group = new THREE.Group();
    const disposables = [];
    const keep = x => { disposables.push(x); return x; };

    // --- muestras del camino en coords locales
    const pts = [];
    for (let d = dA; d <= dB; d += STEP) {
        const q = path.at(d);
        pts.push({ d, x: q.x - OX, z: q.z - OZ, y: q.y, h: q.h });
    }
    // grilla espacial para buscar el camino cercano
    const CELL = 40, grid = new Map();
    const key = (i, j) => i * 100003 + j;
    pts.forEach((q, idx) => {
        const k = key(Math.floor(q.x / CELL), Math.floor(q.z / CELL));
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(idx);
    });
    function near(x, z) {           // distancia al camino, altura ponderada, lado
        const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
        let best = 1e9, bi = -1, wsum = 0, ysum = 0;
        for (let r = 1; r <= 4 && (bi < 0 || r <= 2); r++) {
            for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
                if (r > 1 && Math.abs(i - ci) < r && Math.abs(j - cj) < r) continue;
                const lst = grid.get(key(i, j));
                if (!lst) continue;
                for (const idx of lst) {
                    const q = pts[idx], dx = x - q.x, dz = z - q.z, dd = dx * dx + dz * dz;
                    if (dd < best) { best = dd; bi = idx; }
                    const w = 1 / (dd + 400);
                    wsum += w; ysum += w * q.y;
                }
            }
            if (bi >= 0 && r >= 2) break;
        }
        if (bi < 0) {
            // lejos del camino (>160 m): búsqueda gruesa cada 50 m. Antes devolvía
            // "distancia infinita" y la montaña saltaba de golpe → muros verticales.
            for (let k = 0; k < pts.length; k += 10) {
                const q = pts[k], dx = x - q.x, dz = z - q.z, dd = dx * dx + dz * dz;
                if (dd < best) { best = dd; bi = k; }
                const w = 1 / (dd + 400); wsum += w; ysum += w * q.y;
            }
        }
        const q = pts[bi];
        const side = Math.sign((x - q.x) * Math.cos(q.h) + (z - q.z) * Math.sin(q.h)) || 1;   // + = derecha
        // proyección sobre el tramo vecino → altura exacta del asfalto
        const fx = Math.sin(q.h), fz = -Math.cos(q.h);
        const along = (x - q.x) * fx + (z - q.z) * fz;
        const nb = pts[Math.max(0, Math.min(pts.length - 1, bi + (along >= 0 ? 1 : -1)))];
        const roadY = q.y + (nb.y - q.y) * Math.min(1, Math.abs(along) / STEP);
        const dist = Math.sqrt(best);
        const y = roadY + (ysum / wsum - roadY) * smooth(15, 160, dist);
        return { dist, y, roadY, side, idx: bi };
    }

    // --- terreno
    const center = path.at(p.riderD + 800);
    const CX = center.x - OX, CZ = center.z - OZ;
    const tg = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
    tg.rotateX(-Math.PI / 2);
    const pos = tg.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cGrass = new THREE.Color(T.grass), cGrass2 = new THREE.Color(T.grass2), cRock = new THREE.Color(T.rock),
        cSnow = new THREE.Color(T.snow), cBare = new THREE.Color(T.bare || T.rock), cSand = new THREE.Color(T.sand || T.grass2), tmpC = new THREE.Color();
    let waterLevel = Infinity;
    if (T.water) waterLevel = Math.min(...pts.map(q => q.y)) - 4;
    const heightAt = (x, z) => {
        const n = near(x, z);
        const wx = x + OX, wz = z + OZ;
        const away = smooth(ROAD_W + 3, 60, n.dist);
        let hgt = n.roadY - 0.45;
        // laderas suaves cerca, montañas grandes recién a ~1 km (y el anillo lejano)
        const mount = T.amp * 0.55 * ridged(wx / 1700, wz / 1700) * smooth(40, 1100, n.dist)
            + T.wall * 0.45 * smooth(350, 1700, n.dist) * (0.6 + 0.4 * fbm(wx / 900, wz / 900));
        const bumps = 6 * (fbm(wx / 120, wz / 120) - 0.5) * smooth(10, 60, n.dist);
        let nat = n.y + mount + bumps;
        if (T.water && ((T.water === "left" && n.side < 0) || (T.water === "right" && n.side > 0))) {
            nat = n.y - 3 - 40 * smooth(25, 260, n.dist) + bumps * 0.3;       // orilla que baja al agua
        }
        hgt = hgt + (nat - hgt) * away;
        return { hgt, n };
    };
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + CX, z = pos.getZ(i) + CZ;
        const { hgt, n } = heightAt(x, z);
        pos.setXYZ(i, x, hgt, z);
        // color por altura, ruido y paisaje
        const wx = x + OX, wz = z + OZ;
        const nn = fbm(wx / 60, wz / 60);
        tmpC.copy(cGrass).lerp(cGrass2, nn);
        const routeD = pts[n.idx].d;
        if (treelessFrom != null && routeD > treelessFrom && n.dist < 1500) tmpC.lerp(cBare, 0.85);
        const rockiness = smooth(T.treeline - 150, T.treeline + 350, hgt) * 0.8 + smooth(60, 300, hgt - n.y) * 0.35;
        tmpC.lerp(cRock, Math.min(1, rockiness));
        if (hgt > T.snowline + (nn - 0.5) * 220) tmpC.lerp(cSnow, smooth(T.snowline - 50, T.snowline + 250, hgt));
        if (T.water && hgt < waterLevel + 2.5) tmpC.lerp(cSand, 0.8);
        if (n.dist < ROAD_W + 2.2) tmpC.lerp(cRock, 0.5);                    // banquina de ripio
        colors[i * 3] = tmpC.r; colors[i * 3 + 1] = tmpC.g; colors[i * 3 + 2] = tmpC.b;
    }
    tg.computeVertexNormals();
    const nrm = tg.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
        const steep = smooth(0.9, 0.62, nrm.getY(i));          // 0 = plano, 1 = acantilado
        if (steep <= 0) continue;
        tmpC.setRGB(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]).lerp(cRock, steep * 0.85);
        colors[i * 3] = tmpC.r; colors[i * 3 + 1] = tmpC.g; colors[i * 3 + 2] = tmpC.b;
    }
    tg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const terrain = new THREE.Mesh(keep(tg), keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: false })));
    terrain.receiveShadow = true;
    terrain.name = "terrain";
    group.add(terrain);

    // --- anillo lejano de montañas (fondo, sin detalle)
    const rg = new THREE.PlaneGeometry(26000, 26000, 90, 90);
    rg.rotateX(-Math.PI / 2);
    const rp = rg.attributes.position, rc = new Float32Array(rp.count * 3);
    const baseY = pts[pts.length >> 1].y;
    for (let i = 0; i < rp.count; i++) {
        const x = rp.getX(i) + CX, z = rp.getZ(i) + CZ, r = Math.hypot(x - CX, z - CZ);
        const wx = x + OX, wz = z + OZ;
        let y = baseY - 80 + (T.wall * 1.6 + T.amp * 2.0 * ridged(wx / 4200, wz / 4200)) * smooth(1500, 7000, r);
        if (T.water && T.water === "left" && ((x - CX) * Math.cos(center.h) + (z - CZ) * Math.sin(center.h)) < 0) y = Math.min(y, waterLevel - 30) + 0 * r;
        rp.setXYZ(i, x, y, z);
        tmpC.copy(cRock).lerp(cGrass, 0.35);
        if (y > T.snowline - 200) tmpC.lerp(cSnow, smooth(T.snowline - 200, T.snowline + 300, y));
        rc[i * 3] = tmpC.r; rc[i * 3 + 1] = tmpC.g; rc[i * 3 + 2] = tmpC.b;
    }
    rg.setAttribute("color", new THREE.BufferAttribute(rc, 3));
    rg.computeVertexNormals();
    const ring = new THREE.Mesh(keep(rg), keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
    ring.position.y = -1.5;
    ring.name = "ring";
    group.add(ring);

    // volcán de los lagos (siempre a la vista)
    if (T.volcano) {
        const vg = new THREE.ConeGeometry(4200, 2400, 48, 6, true);
        const vp = vg.attributes.position, vc = new Float32Array(vp.count * 3);
        for (let i = 0; i < vp.count; i++) {
            const y = vp.getY(i);
            vp.setX(i, vp.getX(i) * (1 + 0.05 * Math.sin(i)));
            tmpC.copy(cRock);
            if (y > 200) tmpC.lerp(cSnow, smooth(200, 700, y));
            vc[i * 3] = tmpC.r; vc[i * 3 + 1] = tmpC.g; vc[i * 3 + 2] = tmpC.b;
        }
        vg.setAttribute("color", new THREE.BufferAttribute(vc, 3));
        vg.computeVertexNormals();
        const volcano = new THREE.Mesh(keep(vg), keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })));
        volcano.position.set(-12000 - OX, baseY + 1100, -9000 - OZ);
        group.add(volcano);
    }

    // agua
    if (T.water) {
        const wg = new THREE.PlaneGeometry(30000, 30000);
        wg.rotateX(-Math.PI / 2);
        const water = new THREE.Mesh(keep(wg), keep(new THREE.MeshStandardMaterial({ color: T.water === "right" ? 0x1f6f99 : 0x2b6f8f, roughness: 0.15, metalness: 0.35, transparent: true, opacity: 0.93 })));
        water.position.set(CX, waterLevel, CZ);
        water.receiveShadow = true;
        group.add(water);
        group.userData.water = water;
    }

    // --- camino (cinta) + banquinas + línea de detención en la meta
    const roadGeo = new THREE.BufferGeometry();
    const rv = [], ruv = [], ri = [];
    pts.forEach((q, k) => {
        const rx = Math.cos(q.h), rz = Math.sin(q.h);
        rv.push(q.x - rx * ROAD_W, q.y + 0.12, q.z - rz * ROAD_W, q.x + rx * ROAD_W, q.y + 0.12, q.z + rz * ROAD_W);
        ruv.push(0, q.d / 9, 1, q.d / 9);
        if (k > 0) { const a = (k - 1) * 2; ri.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }   // antihorario visto desde arriba
    });
    roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(rv, 3));
    roadGeo.setAttribute("uv", new THREE.Float32BufferAttribute(ruv, 2));
    roadGeo.setIndex(ri);
    roadGeo.computeVertexNormals();
    const road = new THREE.Mesh(keep(roadGeo), keep(new THREE.MeshStandardMaterial({ map: S.asphalt, roughness: 0.85, metalness: 0.02 })));
    road.receiveShadow = true;
    road.renderOrder = 1;
    road.material.polygonOffset = true;           // gana contra el terreno en empates (z-fighting)
    road.material.polygonOffsetFactor = -2;
    road.material.polygonOffsetUnits = -2;
    group.add(road);

    // --- instancias: árboles, arbustos, rocas, postes
    const r = rnd(Math.floor(dA / 100) + 17);
    const dummy = new THREE.Object3D();
    const crowns = [], trunks = [], rocks = [], posts = [];
    const nTrees = Math.round(2600 * T.trees);
    for (let t = 0, tries = 0; t < nTrees && tries < nTrees * 4; tries++) {
        const x = CX + (r() - 0.5) * TERRAIN_SIZE * 0.95, z = CZ + (r() - 0.5) * TERRAIN_SIZE * 0.95;
        const { hgt, n } = heightAt(x, z);
        if (n.dist < ROAD_W + 6 || hgt > T.treeline + (r() - 0.5) * 120) continue;
        if (T.water && hgt < waterLevel + 1.5) continue;
        const routeD = pts[n.idx].d;
        if (treelessFrom != null && routeD > treelessFrom) continue;
        if (fbm((x + OX) / 300, (z + OZ) / 300) < 0.42 && n.dist > 40) continue;       // claros en el bosque
        const s = 0.7 + r() * 0.8;
        crowns.push([x, hgt, z, s]);
        t++;
    }
    for (let k = 0; k < 500; k++) {
        const x = CX + (r() - 0.5) * TERRAIN_SIZE * 0.9, z = CZ + (r() - 0.5) * TERRAIN_SIZE * 0.9;
        const { hgt, n } = heightAt(x, z);
        if (n.dist < ROAD_W + 4 || (T.water && hgt < waterLevel)) continue;
        rocks.push([x, hgt, z, 0.5 + r() * (T.shrub ? 1.4 : 2.2)]);
    }
    for (let k = 0; k < pts.length; k += 4) {           // postes reflectantes cada 20 m
        const q = pts[k];
        for (const s of [-1, 1]) posts.push([q.x + Math.cos(q.h) * (ROAD_W + 1.3) * s, q.y, q.z + Math.sin(q.h) * (ROAD_W + 1.3) * s]);
    }
    const pineMat = keep(new THREE.MeshStandardMaterial({ color: T.shrub ? 0x6f7d3e : 0x2f5a35, roughness: 0.9 }));
    const crownGeo = keep(new THREE.ConeGeometry(2.2, 8, 7));
    crownGeo.translate(0, 6, 0);
    const trunkGeo = keep(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 6));
    trunkGeo.translate(0, 1.2, 0);
    const im = (geo, mat, list, place, shadow = false) => {
        if (!list.length) return;
        const m = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((it, i) => { place(it); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); });
        m.castShadow = shadow;
        m.receiveShadow = true;
        group.add(m);
    };
    const crownScale = T.shrub ? 0.35 : 1;
    im(crownGeo, pineMat, crowns, ([x, y, z, s]) => { dummy.position.set(x, y, z); dummy.rotation.set(0, s * 9, 0); dummy.scale.set(s * crownScale, s * (0.8 + s * 0.3) * crownScale, s * crownScale); });
    im(trunkGeo, keep(new THREE.MeshStandardMaterial({ color: 0x5b4231 })), crowns, ([x, y, z, s]) => { dummy.position.set(x, y - 0.3, z); dummy.scale.set(s, s * crownScale * 1.4, s); });
    im(keep(new THREE.DodecahedronGeometry(1, 0)), keep(new THREE.MeshStandardMaterial({ color: T.rock, roughness: 1, flatShading: true })), rocks,
        ([x, y, z, s]) => { dummy.position.set(x, y + s * 0.2, z); dummy.rotation.set(s, s * 3, s * 2); dummy.scale.set(s * 1.3, s * 0.7, s); });
    const postGeo = keep(new THREE.BoxGeometry(0.12, 1.0, 0.12)); postGeo.translate(0, 0.5, 0);
    im(postGeo, keep(new THREE.MeshStandardMaterial({ color: 0xf3f3f3 })), posts, ([x, y, z]) => { dummy.position.set(x, y, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); });

    // --- detalles de la ruta
    const addSign = (d, text, opts, side = 1, height = 2.2) => {
        const q = path.at(d);
        const lx = q.x - OX + Math.cos(q.h) * (ROAD_W + 2.2) * side, lz = q.z - OZ + Math.sin(q.h) * (ROAD_W + 2.2) * side;
        const pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.06, 0.06, height, 6)), keep(new THREE.MeshStandardMaterial({ color: 0x9aa3ad })));
        pole.position.set(lx, q.y + height / 2, lz);
        const plate = textSprite(text, opts);
        keep(plate.geometry); keep(plate.material); keep(plate.material.map);
        plate.position.set(lx, q.y + height + (opts.h || 1.1) / 2, lz);
        plate.rotation.y = -q.h;                            // mirando al ciclista que llega
        group.add(pole, plate);
    };
    const climbEnd = finishD;
    for (const lm of landmarks || []) {
        if (lm.d < dA || lm.d > dB) continue;
        if (lm.kind === "hairpin") addSign(lm.d - 40, lm.label, { bg: "#ffffff", fg: "#b3261e", w: 3.6, h: 1.0, border: "#b3261e" }, 1, 1.6);
        else if (lm.kind === "village") {
            addSign(lm.d + 15, lm.label, { bg: "#ffffff", fg: "#1a1a1a", w: 5.5, h: 1.2, border: "#c0392b" }, 1, 1.8);
            // casitas
            const houseMat = keep(new THREE.MeshStandardMaterial({ color: T.house })), roofMat = keep(new THREE.MeshStandardMaterial({ color: T.roof }));
            const hb = keep(new THREE.BoxGeometry(7, 5, 8)), rf = keep(new THREE.ConeGeometry(6.2, 3, 4)); rf.rotateY(Math.PI / 4);
            for (let k = 0; k < 14; k++) {
                const d = lm.d + (k - 4) * 28 + r() * 10;
                const q = path.at(Math.max(0, d)), side = k % 2 ? 1 : -1, off = ROAD_W + 9 + r() * 14;
                const x = q.x - OX + Math.cos(q.h) * off * side, z = q.z - OZ + Math.sin(q.h) * off * side;
                const y = heightAt(x, z).hgt;
                if (T.water && y < waterLevel + 1) continue;
                const hm = new THREE.Mesh(hb, houseMat); hm.position.set(x, y + 2.5, z); hm.rotation.y = -q.h; hm.castShadow = true; hm.receiveShadow = true;
                const rm = new THREE.Mesh(rf, roofMat); rm.position.set(x, y + 6.5, z); rm.rotation.y = -q.h;
                group.add(hm, rm);
            }
        } else if (lm.kind === "summit") {
            // arco de meta/cumbre
            const q = path.at(lm.d);
            const archMat = keep(new THREE.MeshStandardMaterial({ color: 0xe0566a }));
            for (const s of [-1, 1]) {
                const col = new THREE.Mesh(keep(new THREE.BoxGeometry(0.6, 6, 0.6)), archMat);
                col.position.set(q.x - OX + Math.cos(q.h) * (ROAD_W + 0.8) * s, q.y + 3, q.z - OZ + Math.sin(q.h) * (ROAD_W + 0.8) * s);
                col.rotation.y = -q.h; group.add(col);
            }
            const banner = textSprite(lm.label, { bg: "#e0566a", fg: "#ffffff", w: ROAD_W * 2 + 2.2, h: 1.4 });
            keep(banner.geometry); keep(banner.material); keep(banner.material.map);
            banner.position.set(q.x - OX, q.y + 6.2, q.z - OZ); banner.rotation.y = -q.h;
            group.add(banner);
            // público en los últimos 700 m
            const fans = [];
            for (let k = 0; k < 260; k++) {
                const d = lm.d - 700 + r() * 700, qq = path.at(Math.max(0, d)), side = r() < 0.5 ? -1 : 1, off = ROAD_W + 1.6 + r() * 3.5;
                fans.push([qq.x - OX + Math.cos(qq.h) * off * side, qq.y, qq.z - OZ + Math.sin(qq.h) * off * side, r()]);
            }
            const fanGeo = keep(new THREE.CapsuleGeometry(0.22, 1.0, 3, 6)); fanGeo.translate(0, 0.75, 0);
            const fanMesh = new THREE.InstancedMesh(fanGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.7 })), fans.length);
            const palette = [0xe0566a, 0xf0c948, 0x2f6fe0, 0xffffff, 0x36c585, 0xf0a948, 0x111111];
            fans.forEach(([x, y, z, c], i) => {
                dummy.position.set(x, y, z); dummy.rotation.set(0, c * 6, 0); dummy.scale.set(1, 0.85 + c * 0.35, 1); dummy.updateMatrix();
                fanMesh.setMatrixAt(i, dummy.matrix);
                fanMesh.setColorAt(i, new THREE.Color(palette[i % palette.length]));
            });
            fanMesh.castShadow = true;
            group.add(fanMesh);
            group.userData.fans = fanMesh;
        } else {
            addSign(lm.d, lm.label, { bg: "#1e3a5f", fg: "#ffffff", w: 6, h: 1.1 }, -1, 2.0);
        }
    }
    // hitos de km estilo "borne" de los puertos franceses: km a la cumbre + pendiente
    if (kind === "route" && climbEnd) {
        for (let km = Math.ceil(dA / 1000) * 1000; km < Math.min(dB, climbEnd); km += 1000) {
            if (km <= 0) continue;
            const left = Math.round((climbEnd - km) / 1000);
            const g = ((path.eleAt(Math.min(km + 1000, climbEnd)) - path.eleAt(km)) / Math.min(1000, climbEnd - km)) * 100;
            addSign(km, `Meta ${left} km · ${g.toFixed(1)}%`, { bg: "#ffffff", fg: "#1a1a1a", w: 3.4, h: 0.9, border: "#f0c948" }, 1, 1.1);
        }
    }

    return { group, dispose: () => disposables.forEach(x => x.dispose?.()), riderD: p.riderD, OX, OZ };
}

// ------------------------------------------------------------------ frame
function setPalette(name) {
    const P = PAL[name] || PAL.day;
    const u = S.sky.material.uniforms;
    u.turbidity.value = P.turb; u.rayleigh.value = P.ray; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
    const phi = THREE.MathUtils.degToRad(90 - P.sunElev), theta = THREE.MathUtils.degToRad(P.sunAz);
    S.sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(S.sunDir);
    S.sky.visible = name !== "night";
    S.scene.background = name === "night" ? new THREE.Color(0x070b1a) : null;
    S.stars.visible = name === "night";
    S.sun.color.set(P.sun); S.sun.intensity = P.sunI;
    S.hemi.intensity = P.hemi;
    S.scene.fog.color.set(P.fog);
    S.renderer.toneMappingExposure = P.exposure;
    S.headlight.intensity = name === "night" ? 120 : name === "dusk" ? 25 : 0;
}

function frame(p) {
    if (!S.ready) return false;
    const { dt } = p;
    // ruta nueva → camino nuevo
    if (p.trackKey !== S.pathKey) {
        S.path = new Path(p.headingAt, p.eleAt, p.length);
        S.pathKey = p.trackKey;
        if (S.chunk) { S.world.remove(S.chunk.group); S.chunk.dispose(); S.chunk = null; }
        S.camInit = false;
    }
    if (p.palette !== S.palKey) { setPalette(p.palette); S.palKey = p.palette; }
    const theme = THEMES[p.theme] || THEMES.lakes;
    if (p.theme !== S.themeKey && S.chunk) { S.world.remove(S.chunk.group); S.chunk.dispose(); S.chunk = null; }
    S.themeKey = p.theme;
    if (!S.chunk || Math.abs(p.riderD - S.chunk.riderD) > REBUILD_EVERY) {
        const ch = buildChunk({ ...p, path: S.path, theme });
        if (S.chunk) { S.world.remove(S.chunk.group); S.chunk.dispose(); }
        S.chunk = ch;
        S.world.add(ch.group);
    }
    const { OX, OZ } = S.chunk;
    const q = S.path.at(p.riderD);
    const ahead = S.path.at(p.riderD + 4), behind = S.path.at(Math.max(0, p.riderD - 4));
    const pitch = Math.atan2(ahead.y - behind.y, 8);

    // ciclista
    const placeRider = (obj, d, lateral, lean, standing) => {
        const r = S.path.at(d);
        obj.position.set(r.x - OX + Math.cos(r.h) * lateral, r.y + 0.12, r.z - OZ + Math.sin(r.h) * lateral);
        obj.rotation.order = "YXZ";
        obj.rotation.set(pitch, -r.h, lean);
        obj.userData.pose(p.pedalPhase, standing);
    };
    const sway = p.standing ? Math.sin(p.pedalPhase) * 0.09 : Math.sin(p.pedalPhase) * 0.015;
    placeRider(S.rider, p.riderD, 0.6, -p.lean + sway, p.standing);
    S.ghost.visible = p.ghostD != null;
    if (p.ghostD != null) placeRider(S.ghost, p.ghostD, -1.0, 0, false);

    // cámara de persecución suavizada
    const fwd = new THREE.Vector3(Math.sin(q.h), 0, -Math.cos(q.h));
    const camTarget = new THREE.Vector3(q.x - OX, q.y, q.z - OZ).addScaledVector(fwd, -6.8).add(new THREE.Vector3(0, 2.6 + Math.max(0, pitch) * 3, 0));
    const lookAhead = S.path.at(p.riderD + 14);
    const look = new THREE.Vector3(lookAhead.x - OX, lookAhead.y + 1.1, lookAhead.z - OZ);
    const k = S.camInit ? 1 - Math.exp(-dt * 3.5) : 1;
    S.camPos.lerp(camTarget, k);
    S.camLook.lerp(look, S.camInit ? 1 - Math.exp(-dt * 5) : 1);
    S.camInit = true;
    // que la cámara nunca quede bajo el terreno/camino
    S.camPos.y = Math.max(S.camPos.y, q.y + 1.8);
    S.camera.position.copy(S.camPos);
    S.camera.lookAt(S.camLook);
    S.camera.fov = 60 + Math.min(14, p.speedKmh * 0.2);
    S.camera.updateProjectionMatrix();

    // sol + sombra siguiendo al ciclista
    const rp = S.rider.position;
    S.sun.position.copy(rp).addScaledVector(S.sunDir.clone().setY(Math.max(0.35, S.sunDir.y)).normalize(), 150);
    S.sun.target.position.copy(rp);
    S.headlight.position.copy(rp).add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(fwd, 0.6);
    S.headlight.target.position.copy(rp).addScaledVector(fwd, 30);
    S.stars.position.copy(S.camera.position);
    if (S.chunk.group.userData.water) {
        S.chunk.group.userData.water.material.color.offsetHSL(0, 0, Math.sin(performance.now() / 1400) * 0.0006);
    }
    if (S.chunk.group.userData.fans) S.chunk.group.userData.fans.position.y = Math.abs(Math.sin(performance.now() / 160)) * 0.08;
    S.renderer.render(S.scene, S.camera);
    return true;
}

window.Scene3D = { get ready() { return S.ready; }, frame, resize: () => S.resize?.(), _S: S };   // _S: depuración
init();
