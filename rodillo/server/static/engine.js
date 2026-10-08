// rodillo · motor web: todo corre en el navegador, sin servidor.
//
// - Rodillo y banda de FC por Web Bluetooth (FTMS 0x1826 / Heart Rate 0x180D).
// - Workouts, modo Ruta (física de velocidad virtual) y sesiones, portados del
//   backend Python (rodillo/trainer/*.py) con la misma lógica.
// - Imita el protocolo del servidor: un WebSocket "falso" que emite los mismos
//   mensajes (state, sample, workout_event, ride_event, session_saved) y un
//   interceptor de fetch para /api/*. Así rig.js funciona igual en los dos modos.
// - Datos: ajustes en localStorage; sesiones y GPX en IndexedDB.
//
// Se activa solo si la página trae <meta name="rodillo-mode" content="web">
// (lo pone scripts/build_web.py para GitHub Pages).
(() => {
"use strict";
if (document.querySelector('meta[name="rodillo-mode"]')?.content !== "web") return;

const DATA = "./data/";
const STEP = 10;                    // m entre puntos de perfil (igual que ride.py)
const MIN_PERSIST_S = 120;

// ====================================================================== util
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const now = () => performance.now() / 1000;

// ================================================================= IndexedDB
const DB = {
    _db: null,
    open() {
        if (this._db) return Promise.resolve(this._db);
        return new Promise((res, rej) => {
            const req = indexedDB.open("rodillo", 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                db.createObjectStore("sessions", { keyPath: "id" });
                db.createObjectStore("routes", { keyPath: "id" });
            };
            req.onsuccess = () => { this._db = req.result; res(this._db); };
            req.onerror = () => rej(req.error);
        });
    },
    async op(store, mode, fn) {
        const db = await this.open();
        return new Promise((res, rej) => {
            const tx = db.transaction(store, mode);
            const r = fn(tx.objectStore(store));
            tx.oncomplete = () => res(r?.result);
            tx.onerror = () => rej(tx.error);
        });
    },
    put(store, v) { return this.op(store, "readwrite", s => s.put(v)); },
    get(store, k) { return this.op(store, "readonly", s => s.get(k)); },
    all(store) { return this.op(store, "readonly", s => s.getAll()); },
};

// ================================================================== ajustes
const DEFAULTS = { name: "Ciclista", ftp_w: 200, weight_kg: 72, max_hr: 190 };
function loadSettings() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem("rodillo.settings") || "{}"); } catch { raw = {}; }
    return {
        name: String(raw.name || DEFAULTS.name).slice(0, 40),
        ftp_w: clamp(parseInt(raw.ftp_w) || DEFAULTS.ftp_w, 50, 600),
        weight_kg: clamp(parseFloat(raw.weight_kg) || DEFAULTS.weight_kg, 30, 200),
        max_hr: clamp(parseInt(raw.max_hr) || DEFAULTS.max_hr, 120, 230),
    };
}
function saveSettings(data) {
    const cur = { ...loadSettings() };
    for (const k of Object.keys(DEFAULTS)) if (data[k] !== undefined && data[k] !== "") cur[k] = data[k];
    try { localStorage.setItem("rodillo.settings", JSON.stringify(cur)); } catch { /* modo privado */ }
    return loadSettings();
}
const POWER_ZONES = [["Z1", "Recuperación", 0, .55], ["Z2", "Resistencia", .55, .75], ["Z3", "Tempo", .75, .90],
    ["Z4", "Umbral", .90, 1.05], ["Z5", "VO2máx", 1.05, 1.20], ["Z6", "Anaeróbico", 1.20, 2.5]];
function athleteInfo() {
    const s = loadSettings();
    const cuts = [0, .68, .78, .86, .93, 1];
    return {
        name: s.name, ftp_w: s.ftp_w, ftp_day: null, weight_kg: s.weight_kg, max_hr: s.max_hr,
        power_zones: POWER_ZONES.map(([k, n, lo, hi]) => ({ key: k, name: n, min_w: Math.round(lo * s.ftp_w), max_w: Math.round(hi * s.ftp_w) })),
        hr_zones: [0, 1, 2, 3, 4].map(i => ({ key: `Z${i + 1}`, min: Math.round(s.max_hr * cuts[i]), max: Math.round(s.max_hr * cuts[i + 1]) })),
    };
}

// ============================================================= Bluetooth FTMS
const FTMS = 0x1826, IBD = 0x2ad2, CONTROL = 0x2ad9;

class BleTrainer {
    constructor() { this.dev = null; this.cp = null; this.cb = null; this._target = null; this._grade = null; this._q = Promise.resolve(); this.last = {}; this.lastPowerAt = 0; }
    get isConnected() { return !!this.dev?.gatt?.connected; }
    get targetPower() { return this._target; }
    get gradePct() { return this._grade; }
    get name() { return this.dev?.name || "rodillo"; }
    async connect() {
        this.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [FTMS] }], optionalServices: [FTMS] });
        this.dev.addEventListener("gattserverdisconnected", () => Engine.onDisconnect("trainer"));
        const server = await this.dev.gatt.connect();
        const svc = await server.getPrimaryService(FTMS);
        const ibd = await svc.getCharacteristic(IBD);
        ibd.addEventListener("characteristicvaluechanged", e => this._onData(e.target.value));
        await ibd.startNotifications();
        this.cp = await svc.getCharacteristic(CONTROL);
        await this.cp.startNotifications();          // las respuestas llegan por indicación
        await sleep(300);                             // dejar propagar el CCCD (gotcha del Flux S)
        for (let i = 0; i < 5; i++) {
            try { await this.requestControl(); await this.start(); return; }
            catch (e) { await sleep(1000 * 2 ** i); }
        }
        Engine.toast("El rodillo no dio el control — pedaleá unas vueltas y apretá “Tomar control”", "warn");
    }
    _write(bytes) {
        // GATT no acepta dos escrituras a la vez: cola
        this._q = this._q.then(() => this.cp.writeValueWithResponse(new Uint8Array(bytes))).catch(e => { throw e; });
        const p = this._q;
        this._q = this._q.catch(() => {});
        return p;
    }
    requestControl() { return this._write([0x00]); }
    start() { return this._write([0x07]); }
    stop() { return this._write([0x08, 0x02]); }
    reset() { return this._write([0x01]); }
    async setTargetPower(w) {
        w = Math.max(0, Math.round(w));
        await this._write([0x05, w & 0xff, (w >> 8) & 0xff]);
        this._target = w; this._grade = null;
    }
    async setGrade(pct) {
        const g = clamp(Math.round(pct * 100), -32768, 32767) & 0xffff;
        await this._write([0x11, 0, 0, g & 0xff, (g >> 8) & 0xff, 40, 51]);   // viento 0, Crr 0.004, Cw 0.51
        this._grade = pct; this._target = null;
    }
    _onData(dv) {
        // Indoor Bike Data: campos según flags (algunos rodillos lo parten en 2 avisos)
        let o = 2;
        const f = dv.getUint16(0, true), L = this.last;
        let hasPower = false;
        if (!(f & 1)) { L.speed = dv.getUint16(o, true) / 100; o += 2; }
        if (f & 2) o += 2;
        if (f & 4) { L.cadence = dv.getUint16(o, true) / 2; o += 2; }
        if (f & 8) o += 2;
        if (f & 16) { L.distance = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); o += 3; }
        if (f & 32) o += 2;
        if (f & 64) { L.power = dv.getInt16(o, true); o += 2; hasPower = true; }
        if (f & 128) o += 2;
        if (f & 256) o += 5;
        if (f & 512 && o < dv.byteLength) { L.hr = dv.getUint8(o) || null; o += 1; }
        const t = now();
        if (hasPower) this.lastPowerAt = t;
        if (hasPower || t - this.lastPowerAt > 2) {
            this.cb?.({ t, power: L.power ?? null, cadence: L.cadence ?? null, speed: L.speed ?? null, hr: L.hr ?? null, distance: L.distance ?? null });
        }
    }
}

class BleHeart {
    constructor() { this.dev = null; this.bpm = null; }
    get isConnected() { return !!this.dev?.gatt?.connected; }
    get name() { return this.dev?.name || "banda"; }
    async connect() {
        this.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ["heart_rate"] }] });
        this.dev.addEventListener("gattserverdisconnected", () => Engine.onDisconnect("hr"));
        const svc = await (await this.dev.gatt.connect()).getPrimaryService("heart_rate");
        const ch = await svc.getCharacteristic("heart_rate_measurement");
        ch.addEventListener("characteristicvaluechanged", e => {
            const v = e.target.value, fl = v.getUint8(0);
            this.bpm = (fl & 1) ? v.getUint16(1, true) : v.getUint8(1);
        });
        await ch.startNotifications();
    }
}

// Simulador (modo demo): mismo comportamiento que trainer/simulator.py
class SimTrainer {
    constructor() { this.cb = null; this.mode = "power"; this._target = 150; this._grade = 0; this.p = 0; this.hr = 95; this.running = false; this.dist = 0; this.timer = null; }
    get isConnected() { return true; }
    get targetPower() { return this.mode === "power" ? this._target : null; }
    get gradePct() { return this.mode === "grade" ? this._grade : null; }
    get name() { return "Simulador"; }
    async connect() {
        this.timer = setInterval(() => this._tick(), 250);
    }
    async requestControl() {}
    async start() { this.running = true; this.p = this.mode === "power" ? this._target : 130; }
    async stop() { this.running = false; }
    async reset() { this.running = false; this.dist = 0; }
    async setTargetPower(w) { this.mode = "power"; this._target = Math.max(0, Math.round(w)); }
    async setGrade(g) { this.mode = "grade"; this._grade = g; }
    _tick() {
        if (!this.running) return;
        const target = this.mode === "grade" ? Math.max(40, 130 + this._grade * 22) : this._target;
        this.p += (target - this.p) * 0.25;
        const t = now();
        const power = Math.max(0, Math.round(this.p + Math.sin(t * 6) * 8 + (Math.random() - 0.5) * 10));
        this.hr += ((70 + power * 0.42) - this.hr) * 0.02;
        const speed = Math.max(0, power * 0.1 + (Math.random() - 0.5) * 0.8);
        this.dist += speed / 3.6 * 0.25;
        this.cb?.({ t, power, cadence: 85 + Math.round((Math.random() - 0.5) * 6), speed, hr: Math.round(this.hr), distance: Math.round(this.dist) });
    }
}

// ================================================================= perfiles
function interp(p, arr, d) {
    const n = p.dist.length;
    if (d <= 0) return arr[0];
    if (d >= p.dist[n - 1]) return arr[n - 1];
    let i = Math.min(n - 2, Math.floor(d / (p.step_m || STEP)));
    while (i > 0 && p.dist[i] > d) i--;
    while (i < n - 2 && p.dist[i + 1] < d) i++;
    const f = (d - p.dist[i]) / ((p.dist[i + 1] - p.dist[i]) || 1);
    return arr[i] + (arr[i + 1] - arr[i]) * f;
}
const P = {
    total: p => p.dist[p.dist.length - 1],
    ele: (p, d) => interp(p, p.ele, d),
    grade: (p, d) => interp(p, p.grade, d),
    latlon: (p, d) => (p.lat ? [interp(p, p.lat, d), interp(p, p.lon, d)] : null),
    climbBetween(p, a, b) {
        let c = 0;
        for (let i = 1; i < p.dist.length; i++) {
            if (p.dist[i] < a || p.dist[i - 1] > b) continue;
            c += Math.max(0, p.ele[i] - p.ele[i - 1]);
        }
        return c;
    },
    summary(p) {
        const out = { ...p };
        for (const k of ["dist", "ele", "grade", "lat", "lon", "time"]) delete out[k];
        out.distance_m = Math.round(P.total(p));
        out.climb_m = Math.round(P.climbBetween(p, 0, P.total(p)));
        out.max_grade_pct = Math.round(Math.max(...p.grade) * 10) / 10;
        return out;
    },
    slice(p, a, b) {
        const tot = P.total(p);
        a = clamp(a, 0, tot); b = clamp(b, a + 20, tot);
        let i0 = 0; while (i0 < p.dist.length - 1 && p.dist[i0 + 1] <= a) i0++;
        let i1 = p.dist.length; while (i1 > i0 + 2 && p.dist[i1 - 2] >= b) i1--;
        const base = p.dist[i0], cut = arr => arr && arr.slice(i0, i1);
        const out = { ...p, id: `${p.id}@${Math.round(a)}-${Math.round(b)}`, name: `${p.name} (km ${(a / 1000).toFixed(1)}–${(b / 1000).toFixed(1)})`,
            dist: cut(p.dist).map(d => d - base), ele: cut(p.ele), grade: cut(p.grade), lat: cut(p.lat), lon: cut(p.lon) };
        const end = out.dist[out.dist.length - 1];
        if (p.landmarks) out.landmarks = p.landmarks.map(m => ({ ...m, d: m.d - base })).filter(m => m.d >= 0 && m.d <= end);
        if (p.treeless_from_m != null) out.treeless_from_m = p.treeless_from_m - base;
        return Object.assign(out, P.summary(out));
    },
    gbins(p) {
        const b = {};
        for (let i = 1; i < p.dist.length; i++) { const g = Math.round(p.grade[i]); b[g] = (b[g] || 0) + p.dist[i] - p.dist[i - 1]; }
        return b;
    },
};

function haversine(a, b, c, d) {
    const R = 6371000, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = p2 - p1, dl = (d - b) * Math.PI / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

// GPX → perfil (mismo algoritmo que ride.py: remuestreo 10 m, alturas ±20 m, pendiente ±30 m)
function profileFromGpx(text, id, fallbackName) {
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("GPX inválido");
    let pts = [...xml.getElementsByTagName("trkpt")];
    if (!pts.length) pts = [...xml.getElementsByTagName("rtept")];
    const raw = pts.map(el => [parseFloat(el.getAttribute("lat")), parseFloat(el.getAttribute("lon")),
        parseFloat(el.getElementsByTagName("ele")[0]?.textContent)]).filter(p => isFinite(p[2]));
    if (raw.length < 2) throw new Error("El GPX no tiene puntos con altura (<ele>)");
    const d = [0], keep = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
        const nd = d[d.length - 1] + haversine(keep[keep.length - 1][0], keep[keep.length - 1][1], raw[i][0], raw[i][1]);
        if (nd > d[d.length - 1] + 0.5) { d.push(nd); keep.push(raw[i]); }
    }
    if (d[d.length - 1] < 30) throw new Error("La ruta es demasiado corta");
    const total = d[d.length - 1], dist = [], ele = [], lat = [], lon = [];
    let j = 0;
    for (let g = 0; g <= total + 1e-6; g = Math.min(total, g + STEP)) {
        while (j < d.length - 2 && d[j + 1] < g) j++;
        const f = clamp((g - d[j]) / ((d[j + 1] - d[j]) || 1), 0, 1);
        dist.push(g);
        for (const [k, arr] of [[2, ele], [0, lat], [1, lon]]) arr.push(keep[j][k] + (keep[j + 1][k] - keep[j][k]) * f);
        if (g >= total) break;
    }
    const sm = ele.map((_, i) => { const h = Math.min(2, i, ele.length - 1 - i); let s = 0; for (let k = i - h; k <= i + h; k++) s += ele[k]; return s / (2 * h + 1); });
    const grade = sm.map((_, i) => { const a = Math.max(0, i - 3), b = Math.min(sm.length - 1, i + 3); const sp = dist[b] - dist[a]; return clamp(sp > 0 ? (sm[b] - sm[a]) / sp * 100 : 0, -20, 20); });
    const name = xml.getElementsByTagName("name")[0]?.textContent?.trim() || fallbackName || "Ruta GPX";
    const p = { id, name, source: "gpx", step_m: STEP, dist, ele: sm, grade, lat, lon, has_gps: true, group: "Tus GPX", subtitle: "GPX", description: "" };
    return Object.assign(p, P.summary(p));
}

// ==================================================================== física
const BIKE_KG = 8.5;
function speedStep(v, power, grade, mass, dt) {
    const th = Math.atan(grade / 100), fg = mass * 9.81 * Math.sin(th), fr = 0.004 * mass * 9.81 * Math.cos(th);
    const meff = mass + 1.5, steps = Math.max(1, Math.ceil(dt / 0.05)), h = dt / steps;
    for (let i = 0; i < steps; i++) {
        const a = ((power * 0.976) / Math.max(v, 1) - fg - fr - 0.5 * 1.2 * 0.32 * v * v) / meff;
        v = Math.max(0, v + a * h);
        if (power <= 0 && v < 0.3 && grade >= 0) v = 0;
    }
    return v;
}

window.__RodilloParts = { DB, loadSettings, saveSettings, athleteInfo, BleTrainer, BleHeart, SimTrainer, P, interp, profileFromGpx, speedStep, BIKE_KG, sleep, clamp, now, DATA, MIN_PERSIST_S };
const Engine = window.RodilloEngine = { toast: (m, k) => window.toast?.(m, k), onDisconnect: () => {} };
})();

// ============================================================================
// Parte 2: players, sesión, comandos, socket falso y API local
// ============================================================================
(() => {
"use strict";
const X = window.__RodilloParts;
if (!X) return;
const { DB, loadSettings, saveSettings, athleteInfo, BleTrainer, BleHeart, SimTrainer, P, profileFromGpx, speedStep, BIKE_KG, sleep, clamp, now, DATA, MIN_PERSIST_S } = X;
const Engine = window.RodilloEngine;

// ------------------------------------------------------------- workout player
class WorkoutPlayer {
    constructor(onEvent) { this.onEvent = onEvent; this.workout = null; this.state = "idle"; this.idx = 0; this.done = 0; this.segStart = null; this.pausedAt = null; this.timer = null; this._skip = false; }
    load(w) {
        if (["running", "paused"].includes(this.state)) throw new Error("Hay un workout en curso, terminalo antes de cargar otro");
        this.workout = w; this.state = "loaded"; this.idx = 0; this.done = 0; this.segStart = null; this.pausedAt = null;
    }
    seg() { return this.workout?.segments[this.idx] || null; }
    segElapsed() {
        if (this.segStart == null) return 0;
        return (this.state === "paused" && this.pausedAt != null ? this.pausedAt : now()) - this.segStart;
    }
    async apply(s) {
        const t = Engine.trainer;
        if (!t) return;
        try {
            if (s.target_w != null) await t.setTargetPower(s.target_w);
            else if (s.grade_pct != null) await t.setGrade(s.grade_pct);
            else await t.setTargetPower(0);
        } catch (e) { console.warn("target", e); }
    }
    async start() {
        if (!this.workout) throw new Error("No hay workout cargado");
        if (this.state === "running") return;
        if (this.state === "paused") return this.resume();
        this.state = "running"; this.idx = 0; this.done = 0;
        await this.emit("started");
        await this.enter(0);
        this.timer = setInterval(() => this.loop(), 250);
    }
    async enter(i) {
        this.idx = i; this.segStart = now(); this._skip = false;
        await this.apply(this.seg());
        await this.emit("segment_change");
    }
    async loop() {
        if (this.state !== "running") return;
        const s = this.seg();
        // el deadline se recalcula siempre: resume() corre segStart por lo pausado
        if (this._skip || now() >= this.segStart + s.duration_s) {
            this.done += s.duration_s;
            if (this.idx + 1 < this.workout.segments.length) return this.enter(this.idx + 1);
            clearInterval(this.timer);
            this.state = "finished"; this.idx = this.workout.segments.length;
            await Engine.trainer?.setTargetPower(0).catch(() => {});
            await this.emit("finished");
        }
    }
    async pause() {
        if (this.state !== "running") return;
        this.state = "paused"; this.pausedAt = now();
        await Engine.trainer?.setTargetPower(0).catch(() => {});
    }
    async resume() {
        if (this.state !== "paused") return;
        if (this.pausedAt != null && this.segStart != null) this.segStart += now() - this.pausedAt;
        this.pausedAt = null; this.state = "running";
        await this.apply(this.seg());
    }
    skip() { if (this.state === "running") this._skip = true; }
    async stop() {
        clearInterval(this.timer);
        this.state = this.workout ? "loaded" : "idle";
        await Engine.trainer?.setTargetPower(0).catch(() => {});
    }
    progress() {
        const w = this.workout;
        if (!w) return { state: this.state };
        const s = this.seg(), segTot = s ? s.duration_s : 0, el = this.segElapsed(), tot = w.total_duration_s;
        const tEl = this.done + el;
        return {
            state: this.state, workout_name: w.name, workout_source: w.source, total_duration_s: tot,
            total_elapsed_s: Math.min(tEl, tot), total_remaining_s: Math.max(0, tot - tEl),
            segment_idx: this.idx, segment_count: w.segments.length, segment_label: s?.label ?? null,
            segment_mode: s ? s.mode : null, segment_target_w: s?.target_w ?? null, segment_grade_pct: s?.grade_pct ?? null,
            segment_total_s: segTot, segment_elapsed_s: Math.min(el, segTot), segment_remaining_s: Math.max(0, segTot - el),
        };
    }
    async emit(kind) { await this.onEvent({ kind, ...this.progress() }); }
}

function makeWorkout(name, segments, extra = {}) {
    const segs = segments.map(s => ({
        duration_s: +s.duration_s || +s.duration, target_w: s.target_w ?? s.watts ?? s.power ?? null,
        grade_pct: s.grade_pct ?? s.grade ?? s.slope ?? null, label: s.label || s.notes || null,
    }));
    if (!segs.length || segs.some(s => !(s.duration_s > 0))) throw new Error("Workout inválido: cada bloque necesita duration_s > 0");
    segs.forEach(s => { s.target_w = s.target_w != null ? Math.round(s.target_w) : null; s.mode = s.target_w != null ? "power" : s.grade_pct != null ? "grade" : "free"; });
    return { name: name || "Workout", description: extra.description || null, source: extra.source || "json", category: extra.category || null,
        segments: segs, total_duration_s: segs.reduce((a, s) => a + s.duration_s, 0) };
}

// --------------------------------------------------------------- ride player
class RidePlayer {
    constructor(onEvent) { this.onEvent = onEvent; this.route = null; this.state = "idle"; this.difficulty = 0.5; this.gradeControl = true; this.laps = 0; this.d = 0; this.v = 0; this.el = 0; this.lastP = 0; this.lastPAt = 0; this.sent = null; this.sentAt = 0; this.timer = null; this.kg = 72; }
    load(r) {
        if (["running", "paused"].includes(this.state)) throw new Error("Hay una ruta en curso, terminala antes");
        this.route = r; this.state = "loaded"; this.d = this.v = this.el = 0; this.laps = 0; this.sent = null;
    }
    unload() { if (["running", "paused"].includes(this.state)) throw new Error("Terminá la ruta antes"); this.route = null; this.state = "idle"; }
    tgrade(g) { return Math.round(clamp(g * this.difficulty, -5, 10) * 10) / 10; }
    async grade(pct) { try { await Engine.trainer?.setGrade(pct); return true; } catch (e) { console.warn("grade", e); return false; } }
    async apply(force = false) {
        if (!this.gradeControl) return;
        const t = this.tgrade(P.grade(this.route, this.d)), n = now();
        const changed = this.sent == null || Math.abs(t - this.sent) >= 0.2;
        if (force || (changed && n - this.sentAt >= 1) || n - this.sentAt >= 10) {
            if (await this.grade(t)) { this.sent = t; this.sentAt = n; }
        }
    }
    async start() {
        if (!this.route) throw new Error("No hay ruta cargada");
        if (this.state === "running") return;
        if (this.state === "paused") return this.resume();
        if (this.state === "finished") { this.d = this.v = this.el = 0; this.laps = 0; }
        this.state = "running"; this.sent = null;
        await this.apply(true);
        let last = now();
        this.timer = setInterval(async () => {
            const n = now(), dt = Math.min(1, n - last); last = n;
            if (this.state !== "running") return;
            if (this.tick(dt)) {
                clearInterval(this.timer);
                this.state = "finished"; this.v = 0;
                if (this.gradeControl) await this.grade(0);
                await this.emit("finished");
                return;
            }
            await this.apply();
        }, 250);
        await this.emit("started");
    }
    feed(power) { if (power != null) { this.lastP = power; this.lastPAt = now(); } }
    tick(dt) {
        const power = now() - this.lastPAt <= 2.5 ? this.lastP : 0;
        const tot = P.total(this.route);
        this.v = speedStep(this.v, power, P.grade(this.route, this.d), this.kg + BIKE_KG, dt);
        if (this.v > 0 || power > 0) this.el += dt;
        const d = this.d + this.v * dt;
        if (d >= tot && !this.gradeControl) { this.laps++; this.d = d - tot; return false; }
        this.d = Math.min(tot, d);
        return this.d >= tot;
    }
    async pause() { if (this.state !== "running") return; this.state = "paused"; this.v = 0; if (this.gradeControl) await this.grade(0); await this.emit("paused"); }
    async resume() { if (this.state !== "paused") return; this.state = "running"; this.sent = null; await this.apply(true); await this.emit("resumed"); }
    async stop() {
        const was = ["running", "paused"].includes(this.state);
        clearInterval(this.timer);
        this.state = this.route ? "loaded" : "idle";
        if (this.gradeControl) await this.grade(0);
        if (was) await this.emit("stopped");
    }
    annotate(s) {
        if (!this.route || !["running", "paused"].includes(this.state)) return;
        s.distance = Math.round(this.d); s.speed = Math.round(this.v * 3.6 * 100) / 100;
        s.alt = Math.round(P.ele(this.route, this.d) * 10) / 10;
        const ll = P.latlon(this.route, this.d);
        if (ll) [s.lat, s.lon] = ll;
    }
    progress() {
        const r = this.route;
        if (!r) return { state: this.state };
        const d = this.d, tot = P.total(r), ahead = Math.min(tot, d + 500), ll = P.latlon(r, d);
        return {
            state: this.state, route_id: r.id, route_name: r.name, distance_m: d, total_m: tot, remaining_m: Math.max(0, tot - d),
            pct: tot ? d / tot * 100 : 0, ele_m: P.ele(r, d), grade_pct: Math.round(P.grade(r, d) * 10) / 10,
            grade_ahead_500m_pct: ahead - d > 20 ? Math.round((P.ele(r, ahead) - P.ele(r, d)) / (ahead - d) * 1000) / 10 : 0,
            trainer_grade_pct: this.sent, difficulty_pct: Math.round(this.difficulty * 100), speed_kmh: Math.round(this.v * 36) / 10,
            elapsed_s: this.el, avg_speed_kmh: this.el > 1 ? Math.round(d / this.el * 36) / 10 : 0,
            climbed_m: Math.round(P.climbBetween(r, 0, d)), remaining_climb_m: Math.round(P.climbBetween(r, d, tot)),
            lat: ll ? ll[0] : null, lon: ll ? ll[1] : null, grade_control: this.gradeControl, laps: this.laps,
        };
    }
    async emit(kind) { await this.onEvent({ kind, ...this.progress() }); }
}

// ------------------------------------------------------------------- sesión
class Session {
    constructor() { this.startedAt = null; this.paused = true; this.samples = []; this.startDate = null; }
    start() { this.startedAt = now(); this.startDate = new Date(); this.paused = false; this.samples = []; }
    stop() { this.paused = true; }
    add(s) { if (!this.paused && this.startedAt != null) this.samples.push(s); }
    stats() {
        const S = this.samples;
        if (!S.length) return { duration_s: 0, samples: 0, avg_power_w: 0, max_power_w: 0, avg_cadence_rpm: 0, avg_speed_kmh: 0, distance_m: 0, avg_hr_bpm: 0, max_hr_bpm: 0, normalized_power_w: 0 };
        const vals = k => S.map(s => s[k]).filter(v => v != null);
        const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
        const pw = vals("power"), hr = vals("hr").filter(v => v > 0);
        let np = 0;
        if (pw.length >= 120) {      // NP: media móvil de 30 s (120 muestras a 4 Hz), media de la 4ª potencia
            let sum = 0, acc = 0, n = 0;
            for (let i = 0; i < pw.length; i++) {
                sum += pw[i]; if (i >= 120) sum -= pw[i - 120];
                if (i >= 119) { acc += (sum / 120) ** 4; n++; }
            }
            np = (acc / n) ** 0.25;
        }
        const dist = [...S].reverse().find(s => s.distance != null)?.distance || 0;
        return { duration_s: S[S.length - 1].t - S[0].t, samples: S.length, avg_power_w: avg(pw), max_power_w: pw.length ? Math.max(...pw) : 0,
            avg_cadence_rpm: avg(vals("cadence")), avg_speed_kmh: avg(vals("speed")), distance_m: dist,
            avg_hr_bpm: avg(hr), max_hr_bpm: hr.length ? Math.max(...hr) : 0, normalized_power_w: np };
    }
}

// TCX (1 punto por segundo: más liviano y Garmin/Strava lo aceptan igual)
function toTcx(name, start, samples) {
    const iso = d => d.toISOString().replace(/\.\d+Z$/, "Z");
    const t0 = samples[0].t, pts = [];
    let lastSec = -1, lastD = 0;
    for (const s of samples) {
        const sec = Math.floor(s.t - t0);
        if (s.distance != null) lastD = s.distance;
        if (sec === lastSec) continue;
        lastSec = sec;
        let x = `      <Trackpoint>\n        <Time>${iso(new Date(start.getTime() + (s.t - t0) * 1000))}</Time>\n`;
        if (s.lat != null) x += `        <Position><LatitudeDegrees>${s.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${s.lon.toFixed(7)}</LongitudeDegrees></Position>\n`;
        if (s.alt != null) x += `        <AltitudeMeters>${s.alt.toFixed(1)}</AltitudeMeters>\n`;
        x += `        <DistanceMeters>${lastD.toFixed(1)}</DistanceMeters>\n`;
        if (s.hr > 0 && s.hr < 256) x += `        <HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>\n`;
        if (s.cadence != null) x += `        <Cadence>${Math.min(254, Math.round(s.cadence))}</Cadence>\n`;
        x += `        <Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">`;
        if (s.speed != null) x += `<Speed>${(Math.max(0, s.speed) / 3.6).toFixed(3)}</Speed>`;
        if (s.power != null) x += `<Watts>${Math.max(0, Math.round(s.power))}</Watts>`;
        x += `</TPX></Extensions>\n      </Trackpoint>`;
        pts.push(x);
    }
    const dur = samples[samples.length - 1].t - t0;
    const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${iso(start)}</Id>
      <Lap StartTime="${iso(start)}">
        <TotalTimeSeconds>${dur.toFixed(1)}</TotalTimeSeconds>
        <DistanceMeters>${lastD.toFixed(1)}</DistanceMeters>
        <Calories>0</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${pts.join("\n")}
        </Track>
        <Notes>${esc(name)}</Notes>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

// ------------------------------------------------------------------ estado
const S = {
    trainer: null, hr: null, demo: false, sockets: new Set(),
    session: new Session(), persistedAt: null, lastSample: null,
};
Object.defineProperty(Engine, "trainer", { get: () => S.trainer });

const workout = new WorkoutPlayer(async e => {
    emit({ type: "workout_event", data: e });
    broadcast();
    if (e.kind === "finished" || e.kind === "error") {
        let name = workout.workout?.name || "Workout";
        if (["running", "paused"].includes(ride.state) && !ride.gradeControl) { name = comboName(); await ride.stop(); }
        await persist(name, e.kind === "finished");
    }
});
const ride = new RidePlayer(async e => {
    emit({ type: "ride_event", data: e });
    broadcast();
    if (e.kind === "finished") await persist(`Ruta · ${e.route_name || "libre"}`, true);
});

const isCombo = () => ["running", "paused"].includes(workout.state) && ["running", "paused"].includes(ride.state) && !ride.gradeControl;
const comboName = () => `${workout.workout?.name || "Workout"}${ride.route ? " · en " + ride.route.name : ""}`;
function mode() {
    if (isCombo()) return "combo";
    if (["running", "paused"].includes(ride.state)) return "ride";
    if (["running", "paused"].includes(workout.state)) return "workout";
    return "free";
}

function emit(msg) {
    const data = JSON.stringify(msg);
    for (const s of S.sockets) s.onmessage?.({ data });
}
function stateMsg() {
    const st = S.session.stats();
    ride.kg = loadSettings().weight_kg;
    return {
        connected: !!S.trainer?.isConnected, simulated: S.demo,
        target_power: S.trainer?.targetPower ?? null, grade_pct: S.trainer?.gradePct ?? null,
        hr_connected: !!S.hr?.isConnected, hr_device_name: S.hr?.name || null,
        session_active: !S.session.paused && S.session.startedAt != null,
        mode: mode(), combo: isCombo(),
        workout: workout.progress(), workout_loaded: workout.workout,
        ride: ride.progress(), ride_route: ride.route ? P.summary(ride.route) : null,
        athlete: athleteInfo(),
        stats: { ...st, normalized_power_w: Math.round(st.normalized_power_w * 10) / 10 },
        device_name: S.trainer?.name || null,
    };
}
function broadcast() { emit({ type: "state", data: stateMsg() }); }

function onSample(s) {
    if (s.hr == null && S.hr?.bpm) s.hr = S.hr.bpm;
    const rideOn = ["running", "paused"].includes(ride.state);
    if (rideOn) { ride.feed(s.power); ride.annotate(s); }
    S.lastSample = s;
    S.session.add(s);
    const msg = { type: "sample", data: { t: s.t, power: s.power, cadence: s.cadence, speed: s.speed, hr: s.hr, distance: s.distance } };
    if (rideOn) msg.ride = ride.progress();
    if (["running", "paused"].includes(workout.state)) msg.workout = workout.progress();
    emit(msg);
}

async function persist(name, finished) {
    const se = S.session;
    if (se.startedAt == null || se.startedAt === S.persistedAt || !se.samples.length) return null;
    const st = se.stats();
    if (S.demo) { S.persistedAt = se.startedAt; se.stop(); emit({ type: "session_saved", data: { id: null, name, simulated: true } }); return null; }
    if (!finished && st.duration_s < MIN_PERSIST_S) {
        emit({ type: "session_saved", data: { id: null, name, skipped: "short" } });
        return null;
    }
    S.persistedAt = se.startedAt;
    se.stop();
    const start = se.startDate || new Date(Date.now() - st.duration_s * 1000);
    const id = `${start.toISOString().slice(0, 16).replace(/[-:T]/g, "")}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
    const meta = { id, name, start: start.toISOString(), duration_s: Math.round(st.duration_s),
        avg_power_w: Math.round(st.avg_power_w) || null, np_w: Math.round(st.normalized_power_w) || null,
        avg_hr: Math.round(st.avg_hr_bpm) || null, max_hr: st.max_hr_bpm || null,
        avg_cadence: Math.round(st.avg_cadence_rpm) || null, distance_m: st.distance_m || null, finished };
    try {
        await DB.put("sessions", { ...meta, tcx: toTcx(name, start, se.samples) });
        emit({ type: "session_saved", data: { id, name } });
        window.RodilloStrava?.onSessionSaved(id);
    } catch (e) {
        Engine.toast("No pude guardar la sesión en el navegador: " + e.message, "bad");
    }
    return id;
}

// ---------------------------------------------------------------- comandos
const wsErr = msg => emit({ type: "error", message: msg });
function needTrainer() {
    if (S.trainer?.isConnected) return true;
    wsErr("Conectá el rodillo (o usá el modo demo) primero.");
    return false;
}
async function startTrainer() { try { await S.trainer?.start(); } catch (e) { console.warn(e); } }

let LIB = null, ROUTES = null;
async function library() {
    if (!LIB) LIB = await (await fetch(DATA + "workouts.json")).json();
    const ftp = loadSettings().ftp_w;
    return LIB.map(w => makeWorkout(w.name, w.steps.map(([k, dur, v, label]) => k === "pct"
        ? { duration_s: dur, target_w: Math.round(v * ftp), label } : { duration_s: dur, grade_pct: v, label }),
        { description: w.description, category: w.category, source: "library" }));
}
async function routeIndex() {
    if (!ROUTES) ROUTES = await (await fetch(DATA + "routes/index.json")).json();
    const mine = await DB.all("routes").catch(() => []);
    return { epics: ROUTES, mine: mine.map(r => ({ ...P.summary(r), gbins: P.gbins(r) })) };
}
const profileCache = new Map();
async function getRoute(id) {
    if (profileCache.has(id)) return profileCache.get(id);
    let p;
    if (id.startsWith("climb:")) {
        const r = await fetch(DATA + "routes/" + id.replace(":", "_") + ".json");
        if (!r.ok) throw new Error(`Ruta '${id}' no encontrada`);
        p = await r.json();
    } else {
        p = await DB.get("routes", id);
        if (!p) throw new Error(`Ruta '${id}' no encontrada`);
    }
    profileCache.set(id, p);
    return p;
}

async function handle(cmd) {
    const a = cmd.action;
    try {
        switch (a) {
            case "set_target_power":
                if (mode() !== "free") return wsErr("Hay un workout o ruta en curso.");
                if (!needTrainer()) return;
                await S.trainer.setTargetPower(+cmd.watts || 0); break;
            case "set_grade":
                if (mode() !== "free" || !needTrainer()) return;
                await S.trainer.setGrade(+cmd.percent || 0); break;
            case "request_control": if (needTrainer()) await S.trainer.requestControl(); break;
            case "trainer_start": if (needTrainer()) await S.trainer.start(); break;
            case "trainer_stop": if (needTrainer()) await S.trainer.stop(); break;
            case "trainer_reset": if (needTrainer()) await S.trainer.reset(); break;
            case "session_start": if (!needTrainer()) return; await startTrainer(); S.session.start(); break;
            case "session_stop": if (mode() === "free") await persist("Rodaje libre", false); S.session.stop(); break;
            case "session_save": await persist("Rodaje libre", true); break;
            case "workout_load_route": {
                const w = (await library()).find(x => x.name === cmd.name);
                if (!w) return wsErr(`Workout '${cmd.name}' no encontrado`);
                workout.load(w); break;
            }
            case "workout_load_json": {
                const d = typeof cmd.workout === "string" ? JSON.parse(cmd.workout) : cmd.workout;
                workout.load(makeWorkout(d.name, d.segments || d.steps || [], { description: d.description })); break;
            }
            case "workout_start": {
                if (["ride", "combo"].includes(mode())) return wsErr("Hay una ruta en curso — terminala antes.");
                if (!needTrainer()) return;
                await startTrainer();
                const fresh = workout.state !== "paused";
                await workout.start();
                if (fresh && (S.session.startedAt == null || S.session.paused)) S.session.start();
                break;
            }
            case "workout_pause": { const c = isCombo(); await workout.pause(); if (c) await ride.pause(); break; }
            case "workout_resume": await workout.resume(); if (ride.state === "paused" && !ride.gradeControl) await ride.resume(); break;
            case "workout_skip": workout.skip(); break;
            case "workout_stop": {
                const was = ["running", "paused"].includes(workout.state), c = isCombo(), name = c ? comboName() : null;
                await workout.stop();
                if (c) await ride.stop();
                if (was) await persist(name || workout.workout?.name || "Workout", false);
                break;
            }
            case "combo_start":
                if (mode() !== "free") return wsErr("Ya hay algo en curso.");
                if (!workout.workout || !ride.route) return wsErr("Cargá un workout y una ruta.");
                if (!needTrainer()) return;
                await startTrainer();
                ride.gradeControl = false;
                await ride.start(); await workout.start(); S.session.start(); break;
            case "ride_load": {
                let r = await getRoute(String(cmd.route_id || ""));
                if (cmd.from_m != null || cmd.to_m != null) r = P.slice(r, +cmd.from_m || 0, cmd.to_m != null ? +cmd.to_m : P.total(r));
                if (cmd.name) r = { ...r, name: String(cmd.name).slice(0, 120) };
                ride.load(r); break;
            }
            case "ride_unload": ride.unload(); break;
            case "ride_start": {
                if (["workout", "combo"].includes(mode())) return wsErr("Hay un workout en curso — terminalo antes.");
                if (!needTrainer()) return;
                await startTrainer();
                const fresh = ride.state !== "paused";
                if (fresh) ride.gradeControl = true;
                await ride.start();
                if (fresh) S.session.start();
                break;
            }
            case "ride_pause": await ride.pause(); break;
            case "ride_resume": await ride.resume(); break;
            case "ride_stop":
                if (isCombo()) return handle({ action: "workout_stop" });
                { const was = ["running", "paused"].includes(ride.state), name = ride.route?.name || "libre";
                  await ride.stop(); if (was) await persist(`Ruta · ${name}`, false); }
                break;
            case "ride_difficulty":
                ride.difficulty = clamp((+cmd.pct || 50) / 100, 0, 1);
                if (ride.state === "running") await ride.apply(true); break;
            default: return;
        }
        broadcast();
    } catch (e) {
        console.error(a, e);
        wsErr(e.message || String(e));
    }
}

// ------------------------------------------------------------ socket falso
class FakeSocket {
    constructor() {
        this.readyState = 0;
        setTimeout(() => { this.readyState = 1; S.sockets.add(this); this.onopen?.(); broadcast(); }, 0);
    }
    // en orden, como un WebSocket real: ride_load lee la ruta (async) y el ride_start que sigue debe esperarlo
    send(data) { let c; try { c = JSON.parse(data); } catch { return; } this._q = (this._q || Promise.resolve()).then(() => handle(c)); }
    close() { S.sockets.delete(this); this.readyState = 3; }
}
Engine.socket = () => new FakeSocket();

// --------------------------------------------------------------- API local
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    const u = new URL(url, location.href), path = u.pathname, method = (init.method || "GET").toUpperCase();
    try {
        if (path === "/api/routes") return json({ routes: await library() });
        if (path === "/api/ride/routes") {
            const { epics, mine } = await routeIndex();
            const sections = [{ key: "classics", title: "Épicas", routes: epics }];
            if (mine.length) sections.push({ key: "gpx", title: "Tus GPX", routes: mine });
            return json({ routes: [...epics, ...mine], sections });
        }
        if (path === "/api/ride/route") {
            let p = await getRoute(u.searchParams.get("id") || "");
            const f = u.searchParams.get("from_m"), t = u.searchParams.get("to_m");
            if (f != null || t != null) p = P.slice(p, +f || 0, t != null ? +t : P.total(p));
            return json(p);
        }
        if (path === "/api/ride/upload-gpx" && method === "POST") {
            const file = init.body.get("file");
            const slug = (file.name || "ruta").toLowerCase().replace(/\.gpx$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "ruta";
            const p = profileFromGpx(await file.text(), `gpx:${slug}`, slug);
            await DB.put("routes", p);
            profileCache.delete(p.id);
            return json({ route: P.summary(p) });
        }
        if (path === "/api/upload/fit") return json({ error: "Los .fit solo se pueden cargar en la versión con Python. Usá JSON o la biblioteca." }, 400);
        if (path === "/api/settings") {
            if (method === "POST") { const s = saveSettings(JSON.parse(init.body || "{}")); broadcast(); return json(s); }
            return json(loadSettings());
        }
        if (path === "/api/sessions") {
            const all = (await DB.all("sessions").catch(() => [])).map(({ tcx, ...m }) => m);
            all.sort((a, b) => b.start.localeCompare(a.start));
            return json({ sessions: all.slice(0, 30) });
        }
        return json({ error: "no encontrado" }, 404);
    } catch (e) {
        return json({ error: e.message || String(e) }, 400);
    }
};

// --------------------------------------------------------- conexión (botones)
Engine.supported = !!navigator.bluetooth;
Engine.connectTrainer = async () => {
    if (!navigator.bluetooth) throw new Error("Tu navegador no tiene Bluetooth web. Usá Chrome o Edge (en iPhone, la app Bluefy).");
    if (S.demo) await Engine.stopDemo();
    const t = new BleTrainer();
    t.cb = onSample;
    await t.connect();
    S.trainer = t; S.demo = false;
    broadcast();
    return t.name;
};
Engine.connectHr = async () => {
    if (!navigator.bluetooth) throw new Error("Tu navegador no tiene Bluetooth web.");
    const h = new BleHeart();
    await h.connect();
    S.hr = h;
    broadcast();
    return h.name;
};
Engine.startDemo = async () => {
    const t = new SimTrainer();
    t.cb = onSample;
    await t.connect();
    S.trainer = t; S.demo = true;
    broadcast();
};
Engine.stopDemo = async () => { clearInterval(S.trainer?.timer); S.trainer = null; S.demo = false; broadcast(); };
Engine.onDisconnect = what => {
    Engine.toast(what === "hr" ? "Se desconectó la banda de FC" : "Se desconectó el rodillo", "warn");
    if (what !== "hr" && ["running"].includes(workout.state)) workout.pause();
    broadcast();
};
Engine.downloadTcx = async id => {
    const s = await DB.get("sessions", id);
    if (!s) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([s.tcx], { type: "application/vnd.garmin.tcx+xml" }));
    a.download = `${id}.tcx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
Engine.state = () => stateMsg();
Engine.getSession = id => DB.get("sessions", id);
Engine._debug = { S, persist, toTcx };   // para los tests e2e
})();
