// rodillo · app del rodillo inteligente (vanilla JS, sin frameworks)
//
// Este archivo maneja todo lo del rodillo: WebSocket de samples/comandos,
// HUD, escena 3D (pseudo-3D por proyección de segmentos), perfil de altimetría,
// minimapa, modos Ruta / Workout / Libre y el resumen de sesión.
// app.js (home, análisis, chat) usa de acá: $, toast, connectWs, loadRoutes,
// rigOnShow.
"use strict";

const $ = id => document.getElementById(id);

const R = {
    ws: null,
    wsUp: false,
    everConnected: false,
    athlete: null,            // {ftp_w, weight_kg, power_zones, hr_zones, max_hr}
    zonesKey: "",
    mode: "free",             // free | workout | ride  (lo que está corriendo)
    tab: "ride",              // tab elegido en el panel
    trainerConnected: false,
    sessionActive: false,
    workout: null,            // progress del WorkoutPlayer
    workoutLoaded: null,      // workout.to_dict()
    ride: null,               // progress del RidePlayer
    rideRoute: null,          // summary de la ruta cargada
    profile: null,            // perfil completo de la ruta cargada (para escena/strip)
    profileId: null,
    track: null,              // geometría para la escena (ruta o procedural)
    routes: [],
    preview: null,            // perfil de la ruta seleccionada en la lista
    previewId: null,
    samples: [],              // {t, power, cadence, hr, at}
    lastSample: null,
    lastSampleAt: 0,
    rideAt: 0,                // performance.now() del último progress de ruta
    localDist: 0,             // distancia visual en modo libre/workout (m)
    displayDist: 0,           // distancia que usa la cámara
    sessionElapsed: 0,
    lastStats: null,
    sound: true,
    lastBeep: "",
    pedalPhase: 0,
    sections: [],             // catálogo destacado del modo Ruta
    timeMin: null,            // filtro "¿cuánto tiempo tenés?" (min)
    pace: 0.75,               // ritmo para estimar tiempos (fracción de FTP)
    wkTrace: [],              // potencia real sobre los bloques del workout
    powerShown: null,         // número animado de la tarjeta de potencia
    powerTarget: null,
};

const SAMPLE_WINDOW_S = 600;   // 10 min en memoria para el gráfico
const target = $("target");   // slider ERG manual

// ---------------------------------------------------------------- utils ----

function formatDuration(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
        : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function fmtKm(m, dec = 1) { return (m / 1000).toFixed(dec); }

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const ZONE_COLORS = ["#7f8ea3", "#4ea1ff", "#36c585", "#f0c948", "#f0a948", "#e0566a"];

function powerZoneIdx(w) {
    const zs = R.athlete?.power_zones;
    if (!zs || w == null) return -1;
    for (let i = zs.length - 1; i >= 0; i--) if (w >= zs[i].min_w) return i;
    return 0;
}
function powerZoneColor(w) { const i = powerZoneIdx(w); return i < 0 ? "var(--accent)" : ZONE_COLORS[i]; }

function hrZoneIdx(hr) {
    const zs = R.athlete?.hr_zones;
    if (!zs || hr == null) return -1;
    for (let i = zs.length - 1; i >= 0; i--) if (hr >= zs[i].min) return i;
    return 0;
}

function gradeColor(g) {
    if (g < -2) return "#4ea1ff";
    if (g < 2) return "#36c585";
    if (g < 5) return "#f0c948";
    if (g < 8) return "#f0a948";
    if (g < 11) return "#e0566a";
    return "#a23b8f";
}

// Canvas con devicePixelRatio: el tamaño lo define el CSS, acá ajustamos el buffer.
function fitCanvas(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, dpr };
}

// ---------------------------------------------------------------- toast ----

let toastTimer = null;
function toast(msg, kind = "") {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

// ------------------------------------------------------------ websocket ----

function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Versión web (GitHub Pages): el "servidor" es engine.js dentro del navegador
    const ws = window.RodilloEngine?.socket ? window.RodilloEngine.socket() : new WebSocket(`${proto}//${location.host}/ws`);
    R.ws = ws;
    ws.onopen = () => {
        if (R.everConnected && !R.wsUp) toast("Reconectado al servidor");
        R.wsUp = true;
        R.everConnected = true;
        renderStatus();
    };
    ws.onclose = () => {
        if (R.wsUp) toast("Sin conexión con el servidor — reintentando…", "warn");
        R.wsUp = false;
        renderStatus();
        setTimeout(connectWs, 1500);
    };
    ws.onerror = () => {};
    ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.type) {
            case "sample": onSample(msg.data, msg.ride, msg.workout); break;
            case "state": onState(msg.data); break;
            case "workout_event": onWorkoutEvent(msg.data); break;
            case "ride_event": onRideEvent(msg.data); break;
            case "session_saved":
                if (msg.data?.skipped === "short") { toast("No se guardó: duró menos de 2 min", "warn"); break; }
                R.lastSaved = { ...msg.data, stats: R.lastStats };
                if (typeof loadTrainerSessions === "function") loadTrainerSessions();
                // después del banner/confeti de llegada
                setTimeout(() => window.showSessionDone?.(R.lastSaved), 1200);
                renderSteps();
                break;
            case "saved": toast("CSV exportado"); break;
            case "error": toast("⚠ " + msg.message, "bad"); break;
        }
    };
}

function send(action, payload = {}) {
    if (!R.ws || R.ws.readyState !== WebSocket.OPEN) {
        toast("Sin conexión con el servidor", "bad");
        return false;
    }
    R.ws.send(JSON.stringify({ action, ...payload }));
    return true;
}

function renderStatus() {
    const st = $("status");
    if (!st) return;
    if (!R.wsUp) {
        st.textContent = window.RodilloEngine ? "Cargando…" : "Sin servidor";
        st.className = "conn-pill disconnected";
    } else if (R.trainerConnected && R.simulated) {
        st.textContent = "Simulador";
        st.className = "conn-pill neutral";
    } else if (R.trainerConnected) {
        st.textContent = "Rodillo conectado";
        st.className = "conn-pill connected";
    } else {
        st.textContent = "Rodillo desconectado";
        st.className = "conn-pill disconnected";
    }
}

// --------------------------------------------------------------- samples ---

function onSample(s, ride, wk) {
    const now = performance.now();
    s.at = now;
    R.samples.push(s);
    while (R.samples.length && now - R.samples[0].at > SAMPLE_WINDOW_S * 1000) R.samples.shift();
    R.lastSample = s;
    R.lastSampleAt = now;
    if (ride) { R.ride = ride; R.rideAt = now; }
    if (wk) {
        trackFtpTest(wk, s);
        R.workout = wk;
        if (wk.state === "running") {
            const p3 = avgLast("power", 3);
            const last = R.wkTrace[R.wkTrace.length - 1];
            if (p3 != null && (!last || wk.total_elapsed_s - last.e >= 1)) R.wkTrace.push({ e: wk.total_elapsed_s, p: p3 });
        }
    }
    renderHud();
    if (wk) renderInterval();
    if (ride) renderRideHud();
}

// El rodillo manda ~4 datos/s y la potencia oscila dentro de cada pedaleo
// (la fuerza no es pareja en la vuelta). Mostrarla cruda hace imposible
// sostener un objetivo: por defecto se promedia 3 s, como el campo
// "Potencia 3s" de Garmin. Tocando la tarjeta se elige 1 s / 3 s / 10 s.
const SMOOTH_OPTIONS = [1, 3, 10];
R.smoothS = (() => {
    try { const v = parseInt(localStorage.getItem("rodillo.smoothS")); return SMOOTH_OPTIONS.includes(v) ? v : 3; }
    catch { return 3; }
})();

function avgLast(key, seconds) {
    const now = performance.now();
    let sum = 0, n = 0;
    for (let i = R.samples.length - 1; i >= 0; i--) {
        const s = R.samples[i];
        if (now - s.at > seconds * 1000) break;
        if (s[key] != null) { sum += s[key]; n++; }
    }
    return n ? Math.round(sum / n) : null;
}

function power3s() { return avgLast("power", R.smoothS); }

// Test de FTP: el bloque libre de 20' del workout "FTP Test". Al terminarlo se
// calcula FTP = 95% de la potencia media y se ofrece guardarlo en los ajustes.
const FTP_TEST = { seg: -1, sum: 0, n: 0, done: false };
function trackFtpTest(wk, s) {
    const w = R.workoutLoaded;
    const seg = w?.segments?.[wk.segment_idx];
    const isTestBlock = /ftp/i.test(w?.name || "") && seg && seg.grade_pct != null && seg.duration_s >= 1140;
    if (wk.state === "running" && isTestBlock) {
        if (FTP_TEST.seg !== wk.segment_idx) Object.assign(FTP_TEST, { seg: wk.segment_idx, sum: 0, n: 0, done: false });
        if (s.power != null) { FTP_TEST.sum += s.power; FTP_TEST.n++; }
    } else if (FTP_TEST.seg >= 0 && !FTP_TEST.done && wk.segment_idx !== FTP_TEST.seg) {
        FTP_TEST.done = true;
        const blockS = w?.segments?.[FTP_TEST.seg]?.duration_s || 1200;
        if (FTP_TEST.n >= blockS * 4 * 0.85) offerFtp(Math.round(FTP_TEST.sum / FTP_TEST.n));   // ≥85% del bloque registrado
    }
}
async function offerFtp(avg) {
    const ftp = Math.round(avg * 0.95);
    showBanner("Test de FTP", `${ftp} W`, `95% de tus ${avg} W de promedio en los 20′`);
    beep(880, 0.3);
    setTimeout(async () => {
        if (!confirm(`Tu FTP estimado es ${ftp} W (95% de ${avg} W en 20 minutos).\n\n¿Lo guardo en tus ajustes? Las zonas y los workouts se recalculan.`)) return;
        const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ftp_w: ftp }) });
        if (r.ok) { toast(`FTP actualizado a ${ftp} W`, "good"); loadRoutes(); }
    }, 1500);
}

function setSmoothing(sec) {
    R.smoothS = sec;
    try { localStorage.setItem("rodillo.smoothS", String(sec)); } catch { /* sin storage */ }
    const lbl = document.querySelector("#hud-power-tile .hud-l");
    if (lbl) lbl.textContent = sec === 1 ? "Potencia 1s" : `Potencia ${sec}s`;
    renderHud();
}
$("hud-power-tile").addEventListener("click", () => {
    const i = SMOOTH_OPTIONS.indexOf(R.smoothS);
    setSmoothing(SMOOTH_OPTIONS[(i + 1) % SMOOTH_OPTIONS.length]);
    toast(`Potencia promediada a ${R.smoothS} s`);
});
$("hud-power-tile").title = "Tocá para cambiar el promedio: 1 s / 3 s / 10 s";

function samplesFresh() { return performance.now() - R.lastSampleAt < 2500; }

function renderHud() {
    const s = R.lastSample;
    const fresh = samplesFresh();
    const p3 = fresh ? power3s() : null;
    R.powerTarget = p3;
    if (p3 == null) { R.powerShown = null; $("hud-power").textContent = "—"; }
    else if (R.powerShown == null) R.powerShown = p3;
    const kg = R.athlete?.weight_kg;
    $("hud-wkg").textContent = p3 != null && kg ? `${(p3 / kg).toFixed(1)} W/kg` : "— W/kg";
    const zi = powerZoneIdx(p3);
    const tile = $("hud-power-tile");
    tile.style.setProperty("--zc", zi >= 0 && p3 != null ? ZONE_COLORS[zi] : "transparent");
    tile.dataset.zone = zi >= 0 && p3 != null ? R.athlete.power_zones[zi].key : "";

    const hr = fresh ? s?.hr : null;
    $("hud-hr").textContent = hr ?? "—";
    const hz = hrZoneIdx(hr);
    $("hud-hr-zone").textContent = hz >= 0 ? `Z${hz + 1} FC` : " ";
    $("hud-hr-tile").style.setProperty("--zc", hz >= 0 ? ZONE_COLORS[Math.min(5, hz + 1)] : "transparent");

    const cad3 = fresh ? avgLast("cadence", 3) : null;
    $("hud-cad").textContent = cad3 ?? "—";

    const rideOn = R.mode === "ride" || R.mode === "combo";
    const spd = rideOn ? R.ride?.speed_kmh : (fresh ? s?.speed : null);
    $("hud-speed").textContent = spd != null ? Math.max(0, spd).toFixed(1) : "—";
    $("hud-speed-src").textContent = rideOn ? "virtual" : " ";

    // marcador de la barra de zonas
    const marker = $("zone-marker");
    if (marker && R.athlete && p3 != null) {
        const max = R.athlete.ftp_w * 1.5;
        marker.style.left = `${Math.min(100, (p3 / max) * 100)}%`;
        marker.hidden = false;
    } else if (marker) marker.hidden = true;
}

// ----------------------------------------------------------------- state ---

function onState(st) {
    R.trainerConnected = !!st.connected;
    R.simulated = !!st.simulated;
    R.sessionActive = !!st.session_active;
    renderStatus();

    const hrPill = $("rig-hr-pill");
    if (hrPill) {
        hrPill.textContent = st.hr_connected ? `♥ ${st.hr_device_name || "banda"}` : "♥ sin banda";
        hrPill.className = "conn-pill " + (st.hr_connected ? "connected" : "neutral");
        hrPill.title = st.hr_connected ? "Banda de FC conectada" : "Sin banda: la FC no llega al dashboard (usá la del reloj)";
    }

    if (st.athlete) {
        R.athlete = st.athlete;
        const key = JSON.stringify(st.athlete.power_zones);
        if (key !== R.zonesKey) { R.zonesKey = key; buildZoneStrip(); buildErgButtons(); }
    }

    const prevMode = R.mode;
    R.mode = st.mode || "free";
    R.workout = st.workout;
    R.workoutLoaded = st.workout_loaded;
    R.ride = st.ride;
    R.rideAt = performance.now();
    R.rideRoute = st.ride_route;

    if (R.rideRoute && R.rideRoute.id !== R.profileId) ensureRideProfile(R.rideRoute.id);
    if (!R.rideRoute) R.loadedKey = null;
    if (!R.rideRoute && R.profileId) { R.profile = null; R.profileId = null; R.track = null; }

    // Si algo arrancó, mostrar su tab
    if (R.mode !== prevMode && R.mode !== "free") setTab(R.mode === "combo" ? "workout" : R.mode);
    if (st.workout_loaded?.name !== R._lastWkName) { R._lastWkName = st.workout_loaded?.name; renderWorkoutLibrary(); }

    if (st.target_power != null && R.mode === "free") {
        $("target").value = st.target_power;
        $("target-display").textContent = st.target_power;
    }

    renderWorkoutPanel();
    renderRidePanel();
    renderInterval();
    renderRideHud();
    renderStats(st.stats);
    renderModeChrome();
}

function renderStats(st) {
    if (!st) return;
    if (R.lastStats && st.samples < R.lastStats.samples) R.sessionElapsed = st.duration_s;
    R.lastStats = st;
    R.sessionElapsed = Math.max(R.sessionElapsed, st.duration_s || 0);
    const has = st.samples > 0;
    $("st-duration").textContent = formatDuration(st.duration_s);
    $("st-avg-power").textContent = has ? `${Math.round(st.avg_power_w)} W` : "—";
    $("st-np").textContent = has && st.normalized_power_w ? `${Math.round(st.normalized_power_w)} W` : "—";
    $("st-max-power").textContent = has ? `${st.max_power_w} W` : "—";
    $("st-avg-cadence").textContent = has ? `${Math.round(st.avg_cadence_rpm)} rpm` : "—";
    $("st-avg-speed").textContent = has ? `${st.avg_speed_kmh.toFixed(1)} km/h` : "—";
    $("st-distance").textContent = has ? `${fmtKm(st.distance_m, 2)} km` : "—";
    $("st-hr").textContent = has && st.avg_hr_bpm ? `${Math.round(st.avg_hr_bpm)} / ${st.max_hr_bpm}` : "—";
    $("hud-np").textContent = has && st.normalized_power_w ? `NP ${Math.round(st.normalized_power_w)} W` : " ";
}

// Qué overlays se ven según el modo activo
function renderModeChrome() {
    const combo = R.mode === "combo";
    const ride = combo || R.mode === "ride" || (R.tab === "ride" && R.rideRoute && R.mode === "free");
    const wk = combo || R.mode === "workout" || (R.tab === "workout" && R.workoutLoaded && R.mode === "free");
    $("hud-grade").hidden = !ride;
    $("hud-grade").classList.toggle("erg", combo);
    $("hud-interval").hidden = !wk;
    $("minimap").hidden = !(ride && R.profile?.lat);
    $("hud-ghost").hidden = !(R.profile?.time && R.mode === "ride");
    const title = $("hud-title");
    const t = combo ? `${R.workoutLoaded?.name || "Workout"} · en ${R.rideRoute?.name || "ruta"}`
        : R.mode === "ride" ? R.rideRoute?.name
        : R.mode === "workout" ? R.workoutLoaded?.name : "";
    title.hidden = true;   // el nombre va en la cabecera del perfil (no tapa la escena)
    R.activeTitle = t || "";

    let msg = "";
    if (!R.wsUp) msg = "Conectando con el servidor…";
    else if (!R.trainerConnected) msg = "El rodillo no está conectado";
    else if (R.mode === "free" && !samplesFresh()) {
        msg = R.tab === "ride" ? (R.rideRoute ? "Ruta cargada — apretá ▶ Rodar y pedaleá" : "Elegí una ruta abajo")
            : R.tab === "workout" ? (R.workoutLoaded ? "Workout cargado — apretá ▶ Empezar" : "Cargá un workout abajo")
            : "Pedaleá para empezar";
    } else if (((R.mode === "ride" || R.mode === "combo") && R.ride?.state === "paused") || (R.mode === "workout" && R.workout?.state === "paused")) {
        msg = "⏸ En pausa";
    }
    const m = $("hud-msg");
    m.textContent = msg;
    m.hidden = !msg;

    renderRigControls();
    renderSteps();

    const titles = { ride: "Perfil de la ruta", workout: "Bloques del workout", free: "Potencia" };
    const stripMode = wk ? "workout" : ride ? "ride" : "free";
    $("strip-title").textContent = R.activeTitle ? `▶ ${R.activeTitle}` : titles[stripMode];
    R.stripMode = stripMode;
}

// Qué está corriendo ahora (para Pausar/Terminar sobre la escena)
function activeKind() {
    const run = st => st === "running" || st === "paused";
    if ((R.mode === "workout" || R.mode === "combo") && run(R.workout?.state)) return "workout";
    if (R.mode === "ride" && run(R.ride?.state)) return "ride";
    if (R.mode === "free" && R.sessionActive && R.freeRecording) return "free";
    return null;
}

function renderRigControls() {
    const kind = activeKind();
    $("rig-controls").hidden = !kind;
    if (!kind) return;
    const paused = kind === "workout" ? R.workout?.state === "paused" : kind === "ride" ? R.ride?.state === "paused" : false;
    const pb = $("rig-pause");
    pb.hidden = kind === "free";
    pb.textContent = paused ? "▶ Seguir" : "⏸ Pausar";
    pb.classList.toggle("resume", paused);
}

function stopActivity() {
    const kind = activeKind();
    if (!kind) return;
    const dur = R.lastStats?.duration_s || 0;
    const msg = R.simulated ? "¿Terminar? (modo demo: la sesión no se guarda)"
        : dur < 120 ? "Llevás menos de 2 minutos: si terminás ahora la sesión NO se guarda. ¿Terminar igual?"
        : "¿Terminar? La sesión se guarda y después la podés subir a Strava o Garmin.";
    if (!confirm(msg)) return;
    R.freeRecording = false;
    send(kind === "workout" ? "workout_stop" : kind === "ride" ? "ride_stop" : "session_stop");
}

function togglePause() {
    const kind = activeKind();
    if (kind === "workout") send(R.workout?.state === "paused" ? "workout_resume" : "workout_pause");
    else if (kind === "ride") send(R.ride?.state === "paused" ? "ride_resume" : "ride_pause");
}
$("rig-pause").addEventListener("click", togglePause);
$("rig-stop").addEventListener("click", stopActivity);

// Guía de pasos: 1 conectar · 2 elegir · 3 pedalear · 4 terminar y subir
function renderSteps() {
    const active = !!activeKind();
    const done = {
        connect: R.trainerConnected,
        pick: !!(R.rideRoute || R.workoutLoaded || active),
        ride: !!R.lastSaved && !active,
        done: false,
    };
    const current = active ? "ride" : R.lastSaved ? "done" : ["connect", "pick", "ride"].find(k => !done[k]) || "ride";
    document.querySelectorAll("#steps .step").forEach(b => {
        b.classList.toggle("done", !!done[b.dataset.step] && b.dataset.step !== current);
        b.classList.toggle("current", b.dataset.step === current);
    });
}
function goTo(id) { $(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }
document.querySelectorAll("#steps .step").forEach(b => b.addEventListener("click", () => goTo(b.dataset.go)));

// ---------------------------------------------------------- zone strip -----

function buildZoneStrip() {
    const el = $("zone-strip");
    const a = R.athlete;
    if (!el || !a) return;
    const max = a.ftp_w * 1.5;
    el.innerHTML = a.power_zones.map((z, i) => {
        const lo = z.min_w, hi = Math.min(z.max_w, max);
        if (lo >= max) return "";
        const w = ((hi - lo) / max) * 100;
        const label = i === a.power_zones.length - 1 ? `${lo}+` : `${lo}–${z.max_w}`;
        return `<div class="zs" style="width:${w}%;background:${ZONE_COLORS[i]}" title="${z.key} ${esc(z.name)} · ${label} W">
                    <b>${z.key}</b><span>${label}</span></div>`;
    }).join("") + `<div id="zone-marker" class="zone-marker" hidden></div>`;
    $("strip-meta").textContent = `FTP ${a.ftp_w} W${a.ftp_day ? " · " + a.ftp_day : ""}`;
}

function buildErgButtons() {
    const el = $("erg-buttons");
    const a = R.athlete;
    if (!el || !a) return;
    const f = a.ftp_w;
    const opts = [
        ["Z1", Math.round(f * 0.50)], ["Z2", Math.round(f * 0.68)], ["Z3", Math.round(f * 0.83)],
        ["FTP", f], ["Z5", Math.round(f * 1.12)],
    ];
    el.innerHTML = opts.map(([k, w]) => `<button data-watts="${w}"><b>${k}</b> ${w}</button>`).join("");
    el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
        const w = parseInt(b.dataset.watts);
        target.value = w;
        $("target-display").textContent = w;
        send("set_target_power", { watts: w });
    }));
}

// ---------------------------------------------------------------- tabs -----

function setTab(mode) {
    R.tab = mode;
    document.querySelectorAll(".mode-tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    document.querySelectorAll(".mode-pane").forEach(p => p.classList.toggle("active", p.id === "pane-" + mode));
    if (mode === "ride" && !R.routes.length) loadRideRoutes();
    if (mode === "ride") requestAnimationFrame(drawPreview);
    renderModeChrome();
}
document.querySelectorAll(".mode-tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.mode)));

// ------------------------------------------------------------- workout -----

let availableRoutes = [];

async function loadRoutes() {
    try {
        const data = await (await fetch("/api/routes")).json();
        availableRoutes = data.routes || [];
        renderWorkoutLibrary();
    } catch (e) {
        $("wk-library").innerHTML = `<div class="loading-empty err">No pude cargar workouts: ${esc(e.message)}</div>`;
    }
}

const WK_CATEGORY_ORDER = ["Base", "Umbral", "VO2máx", "Sprint", "Recuperación", "Test", "Pendiente"];

function fitsTime(minutes) {
    const T = R.timeMin;
    if (!T) return true;
    if (T >= 120) return minutes >= 100;
    return minutes >= T * 0.7 && minutes <= T * 1.3;
}

function fmtMin(sec) {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(m % 60).padStart(2, "0") : ""}` : `${m}′`;
}

function miniBars(segments) {
    const total = segments.reduce((a, x) => a + x.duration_s, 0) || 1;
    const ftp = R.athlete?.ftp_w || 200;
    return segments.map(sg => {
        const h = sg.target_w != null ? Math.max(14, Math.min(100, sg.target_w / (ftp * 1.5) * 100)) : 30 + (sg.grade_pct || 0) * 6;
        const c = sg.target_w != null ? ZONE_COLORS[Math.max(0, powerZoneIdx(sg.target_w))] : gradeColor(sg.grade_pct ?? 0);
        return `<i style="width:${sg.duration_s / total * 100}%;height:${Math.max(10, Math.min(100, h))}%;background:${c}"></i>`;
    }).join("");
}

function renderWorkoutLibrary() {
    const el = $("wk-library");
    if (!el) return;
    const items = availableRoutes.filter(w => fitsTime(w.total_duration_s / 60));
    if (!items.length) {
        el.innerHTML = `<div class="loading-empty">Ningún workout de ~${R.timeMin}′ — probá otra duración o “Todo”.</div>`;
        return;
    }
    const groups = {};
    items.forEach(w => (groups[w.category || "Otros"] ||= []).push(w));
    const order = [...WK_CATEGORY_ORDER, ...Object.keys(groups).filter(g => !WK_CATEGORY_ORDER.includes(g))];
    const loadedName = R.workoutLoaded?.name;
    el.innerHTML = order.filter(g => groups[g]).map(g => `
        <div class="ride-group">${esc(g)}</div>
        <div class="card-grid">${groups[g].map(w => `
            <button class="wk-card${w.name === loadedName ? " selected" : ""}" data-name="${esc(w.name)}" title="${esc(w.description || "")}">
                <span class="wkc-top"><b>${esc(w.name)}</b><span class="wkc-dur">⏱ ${fmtMin(w.total_duration_s)}</span></span>
                <span class="wkc-bars">${miniBars(w.segments)}</span>
                <span class="wkc-desc">${esc(w.description || "")}</span>
            </button>`).join("")}
        </div>`).join("");
    el.querySelectorAll(".wk-card").forEach(b => b.addEventListener("click", () => send("workout_load_route", { name: b.dataset.name })));
}

function renderWorkoutPanel() {
    const p = R.workout || {};
    const state = p.state || "idle";
    const lbl = $("wk-state");
    lbl.textContent = ({ idle: "Sin cargar", loaded: "Listo", running: "En curso", paused: "En pausa", finished: "Terminado" })[state] || state;
    lbl.className = "workout-state " + state;
    const active = state === "running" || state === "paused";
    const wk = R.workoutLoaded;

    $("wk-loader").hidden = active;
    $("wk-loaded").hidden = !wk;
    if (wk) {
        $("wk-name").textContent = wk.name;
        $("wk-meta").textContent = `${wk.segments.length} bloques · ${formatDuration(wk.total_duration_s)}`;
        renderTimeline(wk.segments, active ? p.segment_idx : -1);
    }
    const rideBusy = R.mode === "ride";
    $("wk-scenario").disabled = active;
    $("btn-workout-start").disabled = !wk || state === "running" || rideBusy;
    $("btn-workout-start").textContent = state === "paused" ? "▶ Seguir" : "▶ Empezar";
    $("btn-workout-pause").disabled = state !== "running";
    $("btn-workout-skip").disabled = !active;
    $("btn-workout-stop").disabled = !active;
    $("btn-workout-clear").hidden = !wk || active;

    const ergLocked = R.mode !== "free";
    $("erg-panel").classList.toggle("disabled", ergLocked);
    $("manual-hint").hidden = !ergLocked;
}

function renderTimeline(segments, currentIdx) {
    const tl = $("segment-timeline");
    const total = segments.reduce((a, s) => a + s.duration_s, 0);
    if (total <= 0) { tl.innerHTML = ""; return; }
    const ftp = R.athlete?.ftp_w || 200;
    tl.innerHTML = segments.map((s, i) => {
        const h = s.target_w != null ? Math.max(18, Math.min(100, (s.target_w / (ftp * 1.3)) * 100)) : 30;
        const color = s.target_w != null ? powerZoneColor(s.target_w) : gradeColor(s.grade_pct ?? 0);
        const t = s.target_w != null ? `${s.target_w} W` : s.grade_pct != null ? `${s.grade_pct}%` : "libre";
        return `<div class="timeline-seg${i === currentIdx ? " current" : ""}" style="width:${(s.duration_s / total) * 100}%;height:${h}%;background:${color}"
                     title="${esc(s.label || "")} · ${formatDuration(s.duration_s)} · ${t}"></div>`;
    }).join("");
}

function renderInterval() {
    const p = R.workout;
    const wk = R.workoutLoaded;
    if (!wk) return;
    const active = p && (p.state === "running" || p.state === "paused");
    const idx = active ? p.segment_idx : 0;
    const seg = wk.segments[idx];
    if (!seg) return;
    $("iv-label").textContent = seg.label || `Bloque ${idx + 1}`;
    $("iv-count").textContent = `${idx + 1}/${wk.segments.length}`;
    const tgt = seg.target_w != null ? `${seg.target_w}<small>W</small>` : seg.grade_pct != null ? `${seg.grade_pct}<small>%</small>` : "Libre";
    $("iv-target").innerHTML = tgt;
    $("iv-target").style.color = seg.target_w != null ? powerZoneColor(seg.target_w) : "";
    const remaining = active ? p.segment_remaining_s : seg.duration_s;
    $("iv-time").textContent = formatDuration(remaining);
    const pct = active && p.segment_total_s ? (p.segment_elapsed_s / p.segment_total_s) * 100 : 0;
    $("iv-bar-fill").style.width = `${Math.min(100, pct)}%`;
    const next = wk.segments[idx + 1];
    $("iv-next").textContent = next
        ? `Siguiente: ${formatDuration(next.duration_s)} @ ${next.target_w != null ? next.target_w + " W" : (next.grade_pct ?? 0) + "%"}`
        : "Último bloque";
    const p3 = power3s();
    const d = $("iv-delta");
    if (active && seg.target_w && p3 != null && samplesFresh()) {
        const diff = p3 - seg.target_w;
        const ok = Math.abs(diff) <= Math.max(8, seg.target_w * 0.05);
        d.textContent = ok ? "✓ en objetivo" : diff > 0 ? `▲ ${diff} W arriba` : `▼ ${-diff} W abajo`;
        d.className = "iv-delta " + (ok ? "ok" : "off");
    } else {
        d.textContent = " ";
        d.className = "iv-delta";
    }
    if (active && p.state === "running") beepCountdown(p);
}

function onWorkoutEvent(e) {
    const k = e?.kind;
    if (k === "started") { R.wkTrace = []; showBanner("¡Arrancamos!", e.workout_name || "Workout", ""); }
    else if (k === "finished") { toast("Workout terminado 🎉", "good"); beep(880, 0.35); confetti(); showBanner("¡Terminado!", e.workout_name || "", "Buen trabajo 💪"); }
    else if (k === "segment_change" && e.segment_idx > 0) {
        const t = e.segment_mode === "power" ? `${e.segment_target_w} W`
            : e.segment_mode === "grade" ? `${e.segment_grade_pct.toFixed(1)}%` : "libre";
        const zi = e.segment_mode === "power" ? powerZoneIdx(e.segment_target_w) : -1;
        showBanner(e.segment_label || "Siguiente bloque", t, formatDuration(e.segment_total_s),
            zi >= 0 ? ZONE_COLORS[zi] : null);
    } else if (k === "error") toast("El workout se cortó (¿se desconectó el rodillo?)", "bad");
}

document.querySelectorAll(".tab-btn").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
}));
$("btn-load-json").addEventListener("click", () => {
    const text = $("json-input").value.trim();
    if (!text) return toast("Pegá un JSON primero");
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return toast("JSON inválido: " + e.message, "bad"); }
    send("workout_load_json", { workout: parsed });
});
$("btn-load-fit").addEventListener("click", async () => {
    const f = $("fit-input").files[0];
    if (!f) return toast("Elegí un .fit primero");
    const fd = new FormData();
    fd.append("file", f);
    try {
        const r = await fetch("/api/upload/fit", { method: "POST", body: fd });
        const data = await r.json();
        toast(r.ok ? `Cargado: ${data.workout.name}` : "⚠ " + (data.error || r.statusText), r.ok ? "good" : "bad");
    } catch (e) {
        toast("Error subiendo .fit: " + e.message, "bad");
    }
});
$("btn-workout-start").addEventListener("click", () => {
    unlockAudio();
    if (R.workout?.state === "paused") return send("workout_resume");
    R.lastSaved = null;
    goTo("rig");
    const scen = $("wk-scenario").value;
    if (!scen) return send("workout_start");
    const { base, from, to } = parseRouteId(scen);
    const label = $("wk-scenario").selectedOptions[0]?.textContent.split(" · ").slice(0, -1).join(" · ");
    const payload = { route_id: base, name: label || undefined };
    if (from != null) { payload.from_m = from; payload.to_m = to; }
    R.loadedKey = null;      // la ruta cargada pasa a ser el escenario del workout
    if (send("ride_load", payload)) send("combo_start");
});

function parseRouteId(id) {
    const m = String(id).match(/^(.*)@(\d+)-(\d+)$/);
    return m ? { base: m[1], from: +m[2], to: +m[3] } : { base: id, from: null, to: null };
}

function renderScenarioSelect() {
    const sel = $("wk-scenario");
    if (!sel) return;
    const cur = sel.value;
    const groups = R.sections.filter(sc => ["life", "climbs", "classics", "gpx"].includes(sc.key));
    sel.innerHTML = `<option value="">Camino genérico</option>` + groups.map(sc =>
        `<optgroup label="${esc(sc.title)}">${sc.routes.map(r =>
            `<option value="${esc(r.id)}">${esc(r.name)} · ${fmtKm(r.distance_m)} km</option>`).join("")}</optgroup>`).join("");
    sel.value = cur;
}

// ---------- ¿cuánto tiempo tenés?
document.querySelectorAll("#tp-chips button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("#tp-chips button").forEach(x => x.classList.toggle("active", x === b));
    R.timeMin = b.dataset.min ? parseInt(b.dataset.min) : null;
    renderWorkoutLibrary();
    renderRideList();
}));
$("tp-pace").addEventListener("change", e => { R.pace = parseFloat(e.target.value); renderRideList(); updatePreviewMeta(); });

// Tiempo estimado de una ruta a partir de su histograma de pendientes
function estimateFromBins(gbins) {
    if (!gbins) return null;
    const ftp = R.athlete?.ftp_w || 200, kg = (R.athlete?.weight_kg || 70) + 8.5;
    const P = ftp * R.pace;
    let t = 0;
    for (const [g, m] of Object.entries(gbins)) t += m / steadySpeed(P, parseFloat(g), kg);
    return t || null;
}
$("btn-workout-pause").addEventListener("click", () => send("workout_pause"));
$("btn-workout-skip").addEventListener("click", () => send("workout_skip"));
$("btn-workout-stop").addEventListener("click", stopActivity);
$("btn-workout-clear").addEventListener("click", () => send("workout_stop"));

// ----------------------------------------------------------------- libre ---

target.addEventListener("input", e => { $("target-display").textContent = e.target.value; });
target.addEventListener("change", e => send("set_target_power", { watts: parseInt(e.target.value) }));
document.querySelectorAll("[data-grade]").forEach(b => b.addEventListener("click", () =>
    send("set_grade", { percent: parseFloat(b.dataset.grade) })));
$("btn-session-start").addEventListener("click", () => {
    if (send("session_start")) { R.freeRecording = true; R.lastSaved = null; toast("Grabando rodaje libre — terminalo con ⏹ sobre la escena"); goTo("rig"); }
});
$("btn-session-stop").addEventListener("click", () => {
    if (activeKind() === "free") stopActivity(); else send("session_stop");
});
$("btn-session-save").addEventListener("click", () => send("session_save"));
$("btn-request").addEventListener("click", () => send("request_control"));
$("btn-trainer-start").addEventListener("click", () => send("trainer_start"));
$("btn-trainer-stop").addEventListener("click", () => send("trainer_stop"));
$("btn-trainer-reset").addEventListener("click", () => send("trainer_reset"));

// ------------------------------------------------------------------ ruta ---

const GROUP_ORDER = ["Tus salidas en bici", "Subidas clásicas", "GPX subidos", "Tus trotes y esquí"];

async function loadRideRoutes() {
    try {
        const data = await (await fetch("/api/ride/routes")).json();
        R.routes = data.routes || [];
        R.sections = data.sections || [];
        renderRideList();
        renderScenarioSelect();
    } catch (e) {
        $("ride-list").innerHTML = `<div class="loading-empty err">No pude cargar rutas: ${esc(e.message)}</div>`;
    }
}

function routeCard(r) {
    const est = estimateFromBins(r.gbins);
    return `<button class="ride-item${r.id === R.previewId ? " selected" : ""}" data-id="${esc(r.id)}">
        <span class="ri-name">${esc(r.name)}</span>
        <span class="ri-sub">${esc(r.subtitle || "")}</span>
        <span class="ri-stats"><b>${fmtKm(r.distance_m)} km</b> · +${r.climb_m} m${est ? `<br><span class="ri-est">⏱ ${fmtMin(est)}</span>` : ""}</span>
    </button>`;
}

function renderRideList() {
    const q = ($("ride-search").value || "").trim().toLowerCase();
    const list = $("ride-list");
    if (!list) return;
    const match = r => (!q || `${r.name} ${r.subtitle || ""} ${r.location || ""}`.toLowerCase().includes(q))
        && fitsTime((estimateFromBins(r.gbins) || 0) / 60);
    // Tramos: las rutas de tu vida más largas que tu tiempo, recortadas desde el inicio
    let sections = R.sections;
    if (R.timeMin && R.timeMin < 120) {
        const fits = [];
        for (const sc of R.sections.filter(x => x.key === "life")) {
            for (const r of sc.routes) {
                const est = estimateFromBins(r.gbins);
                if (!est || est / 60 <= R.timeMin * 1.3) continue;
                const frac = (R.timeMin * 60) / est;
                const toM = Math.round(r.distance_m * frac / 100) * 100;
                const gb = Object.fromEntries(Object.entries(r.gbins).map(([g, m]) => [g, m * frac]));
                fits.push({ ...r, id: `${r.id}@0-${toM}`, name: `${r.name.split(" · ")[0]} · primeros ${fmtKm(toM, 0)} km`,
                            subtitle: r.subtitle, distance_m: toM, climb_m: Math.round(r.climb_m * frac), gbins: gb });
            }
        }
        if (fits.length) sections = [{ key: "fits", title: `Tramos que te calzan en ${fmtMin(R.timeMin * 60)}`, routes: fits }, ...R.sections];
    }
    const html = sections.map(sc => {
        const rs = sc.routes.filter(match);
        if (!rs.length) return "";
        if (sc.key === "all") {
            const open = q ? " open" : "";
            return `<details class="ride-all"${open}><summary class="ride-group">${esc(sc.title)} (${rs.length})</summary>${rs.map(routeCard).join("")}</details>`;
        }
        return `<div class="ride-group">${esc(sc.title)}</div>${rs.map(routeCard).join("")}`;
    }).join("");
    list.innerHTML = html || `<div class="loading-empty">Nada para ${R.timeMin ? "~" + fmtMin(R.timeMin * 60) : ""} ${q ? "“" + esc(q) + "”" : ""} — probá otra duración.</div>`;
    R._lastCards = sections.flatMap(sc => sc.routes);
    list.querySelectorAll(".ride-item").forEach(b => b.addEventListener("click", () => selectRoute(b.dataset.id)));
}
$("ride-search").addEventListener("input", renderRideList);

async function fetchProfile(routeId, fromM, toM) {
    const qs = new URLSearchParams({ id: routeId });
    if (fromM != null) qs.set("from_m", fromM);
    if (toM != null) qs.set("to_m", toM);
    const r = await fetch("/api/ride/route?" + qs);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
}

async function selectRoute(id) {
    R.previewId = id;
    renderRideList();
    $("rp-name").textContent = "Cargando…";
    const { base, from, to } = parseRouteId(id);
    R.previewBase = base;
    try {
        R.preview = await fetchProfile(base);
    } catch (e) {
        R.preview = null;
        $("rp-name").textContent = "No pude leer la ruta";
        $("rp-meta").textContent = e.message;
        renderRidePanel();
        return;
    }
    const p = R.preview;
    const card = R.sections.flatMap(sc => sc.routes).find(r => r.id === id)
        || (R._lastCards || []).find(r => r.id === id);
    $("rp-name").textContent = card?.name || p.name;
    $("rp-from").value = from != null ? (from / 1000).toFixed(1) : 0;
    $("rp-to").value = to != null ? (to / 1000).toFixed(1) : fmtKm(p.distance_m);
    $("rp-to").max = $("rp-from").max = fmtKm(p.distance_m);
    updatePreviewMeta();
    renderRidePanel();
    drawPreview();
}

function previewRange() {
    const p = R.preview;
    if (!p) return null;
    let a = Math.max(0, parseFloat($("rp-from").value || 0) * 1000);
    let b = Math.min(p.distance_m, parseFloat($("rp-to").value || 0) * 1000 || p.distance_m);
    if (b - a < 200) b = Math.min(p.distance_m, a + 200);
    const full = a <= 1 && b >= p.distance_m - 1;
    return { a, b, full };
}

function profileStats(p, a, b) {
    let climb = 0, maxG = -99, upDist = 0;
    for (let i = 1; i < p.dist.length; i++) {
        if (p.dist[i] < a || p.dist[i - 1] > b) continue;
        const dz = p.ele[i] - p.ele[i - 1], dd = p.dist[i] - p.dist[i - 1];
        if (dz > 0 && dd > 0 && dz / dd > 0.01) { climb += dz; upDist += dd; }
        maxG = Math.max(maxG, p.grade[i]);
    }
    return { climb, maxG, avgUp: upDist ? (climb / upDist) * 100 : 0, upDist };
}

function updatePreviewMeta() {
    const p = R.preview, rg = previewRange();
    if (!p || !rg) return;
    const st = profileStats(p, rg.a, rg.b);
    const dur = estimateDuration(p, rg.a, rg.b);
    $("rp-meta").innerHTML = `${fmtKm(rg.b - rg.a)} km · +${Math.round(st.climb)} m`
        + (st.upDist > 300 ? ` · subidas al ${st.avgUp.toFixed(1)}% (${fmtKm(st.upDist)} km)` : "")
        + ` · máx ${st.maxG.toFixed(0)}%`
        + (dur ? ` · ⏱ ~${fmtMin(dur)} a ${Math.round((R.athlete?.ftp_w || 200) * R.pace)} W` : "")
        + (p.description ? `<br><span class="small">${esc(p.description)}</span>` : "");
}

// Estimación grosera: velocidad estacionaria a ~70% FTP en cada tramo
function estimateDuration(p, a, b) {
    const ftp = R.athlete?.ftp_w || 200, kg = (R.athlete?.weight_kg || 70) + 8.5;
    const P = ftp * R.pace;
    let t = 0;
    for (let i = 1; i < p.dist.length; i++) {
        const d0 = Math.max(a, p.dist[i - 1]), d1 = Math.min(b, p.dist[i]);
        if (d1 <= d0) continue;
        t += (d1 - d0) / steadySpeed(P, p.grade[i], kg);
    }
    return t;
}

function steadySpeed(P, g, m) {
    // bisección de P·η = (m·g·(sinθ + Crr·cosθ) + ½ρCdA·v²)·v
    const th = Math.atan(g / 100), F = m * 9.81 * (Math.sin(th) + 0.004 * Math.cos(th));
    let lo = 0.3, hi = 30;
    for (let k = 0; k < 40; k++) {
        const v = (lo + hi) / 2;
        if ((F + 0.5 * 1.2 * 0.32 * v * v) * v > P * 0.976) hi = v; else lo = v;
    }
    return Math.max(lo, 1.5);
}

["rp-from", "rp-to"].forEach(id => $(id).addEventListener("input", () => { updatePreviewMeta(); drawPreview(); renderRidePanel(); }));
$("rp-full").addEventListener("click", () => {
    if (!R.preview) return;
    $("rp-from").value = 0;
    $("rp-to").value = fmtKm(R.preview.distance_m);
    updatePreviewMeta(); drawPreview();
});
$("rp-diff").addEventListener("input", e => { $("rp-diff-v").textContent = e.target.value + "%"; });
$("rp-diff").addEventListener("change", e => send("ride_difficulty", { pct: parseInt(e.target.value) }));

// la ruta + tramo que muestra la vista previa ("act:1" o "act:1@500-3000")
function previewKey() {
    const rg = previewRange();
    if (!R.previewId || !rg) return null;
    const base = R.previewBase || R.previewId;
    return rg.full ? base : `${base}@${Math.round(rg.a)}-${Math.round(rg.b)}`;
}
function previewIsLoaded() { return !!R.rideRoute && R.loadedKey === previewKey(); }

$("ride-start").addEventListener("click", () => {
    unlockAudio();
    if (R.ride?.state === "paused") return send("ride_resume");
    const key = previewKey();
    if (key && !previewIsLoaded()) {
        const rg = previewRange();
        const payload = { route_id: R.previewBase || R.previewId, name: $("rp-name").textContent };
        if (!rg.full) { payload.from_m = Math.round(rg.a); payload.to_m = Math.round(rg.b); }
        if (!send("ride_load", payload)) return;
        send("ride_difficulty", { pct: parseInt($("rp-diff").value) });
        R.loadedKey = key;
    } else if (!R.rideRoute) return toast("Elegí una ruta de la lista");
    R.lastSaved = null;
    if (send("ride_start")) goTo("rig");
});
$("ride-pause").addEventListener("click", () => send("ride_pause"));
$("ride-stop").addEventListener("click", stopActivity);

$("gpx-input").addEventListener("change", async e => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
        const r = await fetch("/api/ride/upload-gpx", { method: "POST", body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || r.statusText);
        toast(`✓ GPX “${data.route.name}” agregado`, "good");
        await loadRideRoutes();
        selectRoute(data.route.id);
    } catch (err) {
        toast("⚠ " + err.message, "bad");
    } finally {
        e.target.value = "";
    }
});

function renderRidePanel() {
    const st = R.ride?.state || "idle";
    const active = st === "running" || st === "paused";
    const wkBusy = R.mode === "workout" || R.mode === "combo";
    const same = !R.preview || previewIsLoaded();
    $("ride-start").disabled = (!R.preview && !R.rideRoute) || st === "running" || wkBusy;
    $("ride-start").textContent = st === "running" ? "Rodando…" : st === "paused" ? "▶ Seguir"
        : st === "finished" && same ? "↻ Otra vez" : "▶ Rodar esta ruta";
    $("ride-pause").disabled = st !== "running" || wkBusy;
    $("ride-stop").disabled = !active || wkBusy;
    const hint = $("rp-hint");
    if (R.rideRoute) {
        hint.innerHTML = `Cargada: <b>${esc(R.rideRoute.name)}</b> · ${fmtKm(R.rideRoute.distance_m)} km · +${R.rideRoute.climb_m} m`;
    } else {
        hint.textContent = "El rodillo simula la pendiente: los watts los ponés vos con cambios y cadencia. Al terminar, la sesión se guarda y la subís a Strava o Garmin.";
    }
    if (R.ride?.difficulty_pct != null && document.activeElement !== $("rp-diff")) {
        $("rp-diff").value = R.ride.difficulty_pct;
        $("rp-diff-v").textContent = R.ride.difficulty_pct + "%";
    }
}

function onRideEvent(e) {
    const k = e?.kind;
    if (k === "started" && e.grade_control !== false) showBanner("¡A rodar!", e.route_name, `${fmtKm(e.total_m)} km`);
    else if (k === "finished") { beep(660, 0.2); setTimeout(() => beep(990, 0.4), 220); confetti(); showBanner("🏁 ¡Llegaste!", e.route_name, formatDuration(e.elapsed_s)); }
    else if (k === "error") toast("La ruta se cortó (¿se desconectó el rodillo?)", "bad");
}

// Perfil completo de la ruta cargada (id puede venir recortado: "act:1@500-3000")
async function ensureRideProfile(id) {
    R.profileId = id;
    const m = id.match(/^(.*)@(\d+)-(\d+)$/);
    try {
        const p = m ? await fetchProfile(m[1], m[2], m[3]) : await fetchProfile(id);
        if (R.profileId !== id) return;
        R.profile = p;
        R.track = buildRouteTrack(p);
        R.displayDist = R.ride?.distance_m || 0;
        renderModeChrome();
    } catch (e) {
        console.error("perfil de ruta", e);
    }
}

function interpArr(p, arr, d) {
    const n = p.dist.length;
    if (d <= 0) return arr[0];
    if (d >= p.dist[n - 1]) return arr[n - 1];
    const step = p.step_m;
    let i = Math.min(n - 2, Math.floor(d / step));
    while (i > 0 && p.dist[i] > d) i--;
    while (i < n - 2 && p.dist[i + 1] < d) i++;
    const f = (d - p.dist[i]) / ((p.dist[i + 1] - p.dist[i]) || 1);
    return arr[i] + (arr[i + 1] - arr[i]) * f;
}

function renderRideHud() {
    const r = R.ride;
    if (!r || !r.route_name) return;
    const g = r.grade_pct ?? 0;
    $("hud-grade-v").innerHTML = `${g > 0 ? "+" : ""}${g.toFixed(1)}<small>%</small>`;
    $("hud-grade").style.setProperty("--gc", gradeColor(g));
    $("hud-grade-ahead").textContent = `próx. 500 m: ${r.grade_ahead_500m_pct > 0 ? "+" : ""}${r.grade_ahead_500m_pct}%`;
    if (R.mode === "combo") {
        $("hud-dist").textContent = fmtKm(r.distance_m + (r.laps || 0) * (r.total_m || 0), 2);
        $("hud-dist-rem").textContent = r.laps ? `vuelta ${r.laps + 1}` : `ruta ${fmtKm(r.total_m)} km`;
        $("hud-time").textContent = formatDuration(R.workout?.total_elapsed_s);
    }
    if (R.mode === "ride") {
        $("hud-dist").textContent = fmtKm(r.distance_m, 2);
        $("hud-dist-rem").textContent = `faltan ${fmtKm(r.remaining_m)} · +${r.remaining_climb_m} m`;
        $("hud-time").textContent = formatDuration(r.elapsed_s);
    }
    // Fantasma: cuánto tardaste en llegar acá en tu salida original
    const p = R.profile;
    if (p?.time && R.mode === "ride" && r.distance_m > 30) {
        const ghostT = interpArr(p, p.time, r.distance_m);
        const gap = Math.round(r.elapsed_s - ghostT);
        const el = $("hud-ghost-gap");
        el.textContent = gap === 0 ? "parejos" : gap > 0 ? `+${formatDuration(gap)}` : `−${formatDuration(-gap)}`;
        el.className = "gh-v " + (gap > 0 ? "behind" : "ahead");
        const day = R.rideRoute?.date;
        $("hud-ghost-name").textContent = day ? `Vos el ${day.slice(8, 10)}/${day.slice(5, 7)}` : "Tu salida original";
    }
}

// ------------------------------------------------------------- animaciones --

function showBanner(kicker, main, sub, color) {
    const b = $("hud-banner");
    $("bn-kicker").textContent = kicker || "";
    $("bn-main").textContent = main || "";
    $("bn-main").style.color = color || "";
    $("bn-sub").textContent = sub || "";
    b.hidden = false;
    b.classList.remove("show"); void b.offsetWidth; b.classList.add("show");
    clearTimeout(R._bnTimer);
    R._bnTimer = setTimeout(() => { b.classList.remove("show"); setTimeout(() => { b.hidden = true; }, 400); }, 3200);
}

const FX = { parts: [], until: 0 };
function confetti() {
    const c = $("fx");
    fitCanvas(c);
    const colors = ["#4f8cff", "#36c585", "#f0c948", "#f0a948", "#e0566a", "#ffffff"];
    for (let i = 0; i < 180; i++) {
        FX.parts.push({
            x: c.width * (0.2 + Math.random() * 0.6), y: c.height * 0.35,
            vx: (Math.random() - 0.5) * c.width * 0.9, vy: -(0.4 + Math.random() * 0.8) * c.height,
            r: (4 + Math.random() * 6) * Math.min(2, window.devicePixelRatio || 1),
            a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 12, c: colors[i % colors.length],
        });
    }
    FX.until = performance.now() + 4000;
}
function drawFx(dt) {
    const c = $("fx");
    if (!FX.parts.length) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    const g = c.height * 1.4;
    FX.parts = FX.parts.filter(p => p.y < c.height + 40 && performance.now() < FX.until);
    for (const p of FX.parts) {
        p.vy += g * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.va * dt;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
        ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r * 0.4, p.r * 2, p.r * 0.8);
        ctx.restore();
    }
    if (!FX.parts.length) ctx.clearRect(0, 0, c.width, c.height);
}

// ------------------------------------------------------------------ audio --

let audioCtx = null;
function unlockAudio() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
    }
    audioCtx?.resume?.();
}
function beep(freq = 880, dur = 0.12) {
    if (!R.sound || !audioCtx) return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq;
    o.type = "sine";
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur + 0.02);
}
function beepCountdown(p) {
    const rem = Math.ceil(p.segment_remaining_s);
    if (rem >= 1 && rem <= 3) {
        const key = `${p.segment_idx}:${rem}`;
        if (key !== R.lastBeep) {
            R.lastBeep = key;
            beep(rem === 1 ? 990 : 660, rem === 1 ? 0.25 : 0.1);
            const cd = $("hud-countdown");
            cd.textContent = rem;
            cd.hidden = false;
            cd.classList.remove("pop"); void cd.offsetWidth; cd.classList.add("pop");
            clearTimeout(R._cdTimer);
            R._cdTimer = setTimeout(() => { cd.hidden = true; }, 950);
        }
    }
}
$("rig-sound").addEventListener("click", () => {
    R.sound = !R.sound;
    unlockAudio();
    $("rig-sound").textContent = R.sound ? "🔔" : "🔕";
    $("rig-sound").title = R.sound ? "Pitidos activados" : "Pitidos apagados";
});

$("rig-fs").addEventListener("click", () => {
    const rig = $("rig");
    if (document.fullscreenElement) document.exitFullscreen();
    else rig.requestFullscreen?.().catch(() => toast("El navegador no permitió pantalla completa"));
});

// ================================================================ escena ====
//
// Pseudo-3D "de verdad": a partir de la distancia de la cámara caminamos la
// ruta hacia adelante cada SEG metros acumulando el rumbo relativo (curvas
// reales del GPS) y la altura (cerros reales), y proyectamos cada borde del
// camino con perspectiva. Se dibuja de lejos a cerca (painter's algorithm),
// así un cerro cercano tapa lo que hay detrás.

const SEG = 8;              // m por tramo dibujado
const DRAW_N = 240;         // ~1.9 km de horizonte
const CAM_BACK = 6.5;       // cámara detrás del ciclista (m)
const CAM_H = 2.0;          // altura de cámara (m)
const ROAD_W = 3.3;         // medio ancho del camino (m)
const FOV = 68 * Math.PI / 180;

function procHeading(d) { return 0.55 * Math.sin(d / 260) + 0.35 * Math.sin(d / 610 + 1.3) + 0.2 * Math.sin(d / 140 + 0.4); }
function procEle(d) { return 7 * Math.sin(d / 420) + 4 * Math.sin(d / 170 + 2) + 12 * Math.sin(d / 1300 + 0.7); }
const FREE_TRACK = { kind: "proc", length: Infinity };

function buildRouteTrack(p) {
    const n = p.dist.length;
    const heading = new Float64Array(n);
    if (p.lat && p.lon) {
        for (let i = 0; i < n - 1; i++) {
            const k = Math.min(n - 1, i + 2);
            const dx = (p.lon[k] - p.lon[i]) * Math.cos(p.lat[i] * Math.PI / 180) * 111320;
            const dy = (p.lat[k] - p.lat[i]) * 110540;
            heading[i] = Math.atan2(dx, dy);
        }
        heading[n - 1] = heading[n - 2] || 0;
        for (let i = 1; i < n; i++) {           // unwrap para que no salte ±π
            let d = heading[i] - heading[i - 1];
            while (d > Math.PI) { heading[i] -= 2 * Math.PI; d -= 2 * Math.PI; }
            while (d < -Math.PI) { heading[i] += 2 * Math.PI; d += 2 * Math.PI; }
        }
        const sm = new Float64Array(n), W = 3;   // suavizado ±3 puntos
        for (let i = 0; i < n; i++) {
            let s = 0, c = 0;
            for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { s += heading[j]; c++; }
            sm[i] = s / c;
        }
        heading.set(sm);
    } else {
        for (let i = 0; i < n; i++) heading[i] = procHeading(p.dist[i]);
    }
    return { kind: "route", length: p.dist[n - 1], step: p.step_m, dist: p.dist, ele: p.ele, heading };
}

function trackAt(tr, arr, d) {
    const n = arr.length;
    const x = Math.max(0, Math.min(d, tr.length)) / tr.step;
    const i = Math.min(n - 2, Math.floor(x));
    const f = Math.min(1, x - i);
    return arr[i] + (arr[i + 1] - arr[i]) * f;
}
function trackHeading(tr, d) { return tr.kind === "route" ? trackAt(tr, tr.heading, d) : procHeading(d); }
function trackEle(tr, d) { return tr.kind === "route" ? trackAt(tr, tr.ele, d) : procEle(d); }

function hash(k) { let x = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }

// Montañas de fondo: 2 capas con parallax según el rumbo
const MOUNTAINS = [0, 1].map(layer => {
    const pts = [];
    for (let i = 0; i <= 48; i++) pts.push(0.25 + 0.75 * hash(i * 7 + layer * 101) * (layer ? 0.7 : 1));
    return pts;
});

// Mezcla dos colores "#rrggbb" y devuelve "#rrggbb" (encadenable: mix(shade(c), …))
function mix(c1, c2, t) {
    const a = parseInt(c1.slice(1, 7), 16), b = parseInt(c2.slice(1, 7), 16);
    const ch = sh => { const x = (a >> sh) & 255, y = (b >> sh) & 255; return Math.round(x + (y - x) * t); };
    return "#" + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

// Paleta según la hora real: amanecer, día, atardecer, noche
const PALETTES = {
    dawn:  { top: "#3b4f8c", hz: "#f4b98c", fog: "#e2c3b0", sun: "#ffd29a", light: 0.85, mtn: ["#8b86a8", "#6a6a8f"] },
    day:   { top: "#2a62a8", hz: "#bfdcf0", fog: "#b9d3e3", sun: "#fffbe6", light: 1.0, mtn: ["#7f9db3", "#5d7f98"] },
    dusk:  { top: "#2b2f63", hz: "#f39a6b", fog: "#d9a58f", sun: "#ffb27a", light: 0.8, mtn: ["#7a6a8e", "#57507a"] },
    night: { top: "#0a1024", hz: "#2a3760", fog: "#2c3755", sun: "#e8ecff", light: 0.55, mtn: ["#33406a", "#232d50"] },
};
function skyPalette() {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if (h >= 6 && h < 8.5) return PALETTES.dawn;
    if (h >= 8.5 && h < 18) return PALETTES.day;
    if (h >= 18 && h < 20.5) return PALETTES.dusk;
    return PALETTES.night;
}
let PAL = skyPalette();
setInterval(() => { PAL = skyPalette(); }, 60000);
let SKY_TOP = PAL.top, SKY_HZ = PAL.hz, FOG = PAL.fog;
const GRASS = ["#4f8f3f", "#47843a"], RUMBLE = ["#e8e8e8", "#c8414b"], ROAD = ["#5d6470", "#596069"];
const STARS = Array.from({ length: 90 }, (_, i) => [hash(i * 13 + 1), hash(i * 29 + 7) * 0.9, 0.5 + hash(i * 3 + 5)]);
const CLOUDS = Array.from({ length: 7 }, (_, i) => ({ x: hash(i * 17 + 3), y: 0.08 + hash(i * 5 + 11) * 0.28, s: 0.6 + hash(i * 7 + 2) * 0.9 }));
const shade = (c, k) => mix(c, "#000000", 1 - k);

function drawScene(dt) {
    const c = $("scene"), ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    if (w < 10 || h < 10) return;
    const useRoute = R.track && (R.mode === "ride" || R.mode === "combo" || (R.tab === "ride" && R.mode === "free"));
    const tr = useRoute ? R.track : FREE_TRACK;
    const riderD = R.displayDist;
    const camD = riderD - CAM_BACK;

    let h0 = 0;
    for (let k = -2; k <= 4; k++) h0 += trackHeading(tr, riderD + k * 6);
    h0 /= 7;
    SKY_TOP = PAL.top; SKY_HZ = PAL.hz; FOG = PAL.fog;
    const speedKmh = (R.mode === "ride" || R.mode === "combo") ? (R.ride?.speed_kmh || 0) : Math.max(0, R.lastSample?.speed || 0);
    const bob = Math.sin(R.pedalPhase * 2) * 0.015 * Math.min(1, speedKmh / 20);
    const camY = trackEle(tr, camD) + CAM_H + bob;
    // El FOV se abre con la velocidad: sensación de velocidad en bajadas
    const fov = FOV + Math.min(14, speedKmh * 0.22) * Math.PI / 180;
    const F = (w / 2) / Math.tan(fov / 2);
    // la cámara se inclina un poco con la pendiente (como Zwift)
    const slope = (trackEle(tr, riderD + 15) - trackEle(tr, riderD - 5)) / 20;
    const horizon = h * 0.40 + Math.max(-0.12, Math.min(0.12, slope)) * F * 0.6;

    // cielo
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, SKY_TOP); sky.addColorStop(1, SKY_HZ);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, Math.max(0, horizon) + 2);
    // sol
    if (PAL === PALETTES.night) {
        ctx.fillStyle = "#ffffff";
        for (const [sx, sy, sz] of STARS) {
            const x = ((sx * w * 2 - h0 * w * 0.2) % (w * 2) + w * 2) % (w * 2) - w * 0.5;
            ctx.globalAlpha = 0.35 + 0.5 * Math.abs(Math.sin(performance.now() / 900 + sx * 40));
            ctx.fillRect(x, sy * horizon, sz * 1.6, sz * 1.6);
        }
        ctx.globalAlpha = 1;
    }
    const sunY = PAL === PALETTES.day ? horizon * 0.3 : PAL === PALETTES.night ? horizon * 0.25 : horizon * 0.72;
    const sunX = ((w * 0.75 - h0 * w * 0.5) % (w * 2) + w * 2) % (w * 2) - w * 0.25;
    const sg = ctx.createRadialGradient(sunX, sunY, 2, sunX, sunY, h * (PAL === PALETTES.night ? 0.09 : 0.2));
    sg.addColorStop(0, PAL.sun); sg.addColorStop(0.12, PAL.sun + "99"); sg.addColorStop(1, PAL.sun + "00");
    ctx.fillStyle = sg; ctx.fillRect(0, 0, w, horizon);
    // nubes que se mueven solas + parallax con el rumbo
    const tNow = performance.now() / 1000;
    ctx.fillStyle = PAL === PALETTES.night ? "rgba(120,130,160,0.25)" : "rgba(255,255,255,0.78)";
    for (const cl of CLOUDS) {
        const span = w * 1.6;
        const x = ((cl.x * span + tNow * 6 * cl.s - h0 * w * 0.3) % span + span) % span - w * 0.3;
        const y = cl.y * horizon, r = h * 0.035 * cl.s;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 2.4, r, 0, 0, Math.PI * 2);
        ctx.ellipse(x + r * 1.5, y - r * 0.5, r * 1.5, r * 0.9, 0, 0, Math.PI * 2);
        ctx.ellipse(x - r * 1.4, y - r * 0.2, r * 1.2, r * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    // montañas
    MOUNTAINS.forEach((pts, layer) => {
        const amp = h * (layer ? 0.10 : 0.17), par = layer ? 0.9 : 0.45;
        const off = ((-h0 * w * par) % w + w) % w;
        ctx.fillStyle = PAL.mtn[layer];
        ctx.beginPath();
        ctx.moveTo(-w, horizon + 2);
        for (let rep = -1; rep <= 1; rep++) {
            pts.forEach((v, i) => ctx.lineTo(off + rep * w + (i / (pts.length - 1)) * w, horizon - v * amp));
        }
        ctx.lineTo(2 * w, horizon + 2);
        ctx.fill();
        if (!layer) {   // nieve en las cumbres del fondo
            ctx.fillStyle = "rgba(255,255,255,0.55)";
            for (let rep = -1; rep <= 1; rep++) pts.forEach((v, i) => {
                if (v < 0.78) return;
                const x = off + rep * w + (i / (pts.length - 1)) * w, y = horizon - v * amp;
                ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - amp * 0.12, y + amp * 0.14); ctx.lineTo(x + amp * 0.12, y + amp * 0.14); ctx.fill();
            });
        }
    });
    ctx.fillStyle = mix(shade(GRASS[0], PAL.light), FOG, 0.55);
    ctx.fillRect(0, horizon, w, h - horizon);

    // puntos del camino
    const d0 = Math.floor(camD / SEG) * SEG;
    const pts = [];
    let x = 0, z = d0 - camD;
    for (let n = 0; n <= DRAW_N; n++) {
        const d = d0 + n * SEG;
        const th = trackHeading(tr, d) - h0;
        pts.push({ d, x, z, y: trackEle(tr, d) - camY, th });
        x += Math.sin(th) * SEG;
        z += Math.cos(th) * SEG;
    }

    const proj = (p, lat, yo = 0) => {
        const wx = p.x + Math.cos(p.th) * lat;
        let wz = p.z - Math.sin(p.th) * lat;
        // Bordes laterales del tramo más cercano pueden quedar "detrás" de la
        // cámara en curva: se aplastan al plano cercano en vez de descartar el
        // tramo entero (eso dejaba una franja sin camino abajo).
        if (wz < 0.4) { if (lat === 0) return null; wz = 0.4; }
        const s = F / wz;
        return [w / 2 + wx * s, horizon - (p.y + yo) * s, s];
    };
    const quad = (a, b, la, lb, color) => {
        const p1 = proj(a, la[0]), p2 = proj(a, la[1]), p3 = proj(b, lb[1]), p4 = proj(b, lb[0]);
        if (!p1 || !p2 || !p3 || !p4) return;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]); ctx.fill();
    };

    // sprites por tramo: ciclista, fantasma, árboles, carteles, meta
    const sprites = [];
    sprites.push({ d: riderD, kind: "rider" });
    const ghostD = ghostDistance();
    if (ghostD != null) sprites.push({ d: ghostD, kind: "ghost" });
    const finishD = tr.kind === "route" ? tr.length : null;

    const maxZ = DRAW_N * SEG;
    for (let n = DRAW_N; n >= 1; n--) {
        let a = pts[n - 1];
        const b = pts[n];
        if (b.z < 0.7) continue;
        if (a.z < 0.7) {   // recortar el tramo que cruza el plano de la cámara
            const t = (0.7 - a.z) / ((b.z - a.z) || 1);
            a = { d: a.d + (b.d - a.d) * t, x: a.x + (b.x - a.x) * t, z: 0.7, y: a.y + (b.y - a.y) * t, th: a.th + (b.th - a.th) * t };
        }
        const k = Math.round(a.d / SEG);
        const fog = Math.min(1, Math.pow(Math.max(0, b.z) / maxZ, 1.15));
        const band = Math.floor(a.d / (SEG * 2)) & 1;
        const after = finishD != null && a.d >= finishD;
        // Foco: de noche lo cercano se ilumina (si no, el camino era negro)
        const lamp = PAL === PALETTES.night ? 0.85 : PAL === PALETTES.dusk ? 0.4 : 0;
        const L = Math.min(1, PAL.light + (1 - PAL.light) * lamp * Math.max(0, 1 - b.z / 90));
        quad(a, b, [-ROAD_W * 30, ROAD_W * 30], [-ROAD_W * 30, ROAD_W * 30], mix(shade(GRASS[band], L), FOG, fog));
        quad(a, b, [-ROAD_W * 1.14, ROAD_W * 1.14], [-ROAD_W * 1.14, ROAD_W * 1.14], mix(shade(RUMBLE[band], L), FOG, fog));
        quad(a, b, [-ROAD_W, ROAD_W], [-ROAD_W, ROAD_W], mix(shade(after ? "#6b7280" : ROAD[band], L), FOG, fog));
        // bordes blancos continuos + línea central discontinua
        quad(a, b, [-ROAD_W * 0.97, -ROAD_W * 0.93], [-ROAD_W * 0.97, -ROAD_W * 0.93], mix(shade("#e9e6d8", L), FOG, fog));
        quad(a, b, [ROAD_W * 0.93, ROAD_W * 0.97], [ROAD_W * 0.93, ROAD_W * 0.97], mix(shade("#e9e6d8", L), FOG, fog));
        if (k % 3 === 0) quad(a, b, [-0.09, 0.09], [-0.09, 0.09], mix(shade("#f4f1de", L), FOG, fog));
        // borde de la línea de meta (damero)
        if (finishD != null && a.d <= finishD && b.d > finishD) {
            for (let s = -6; s < 6; s++) quad(a, b, [s * ROAD_W / 6, (s + 1) * ROAD_W / 6], [s * ROAD_W / 6, (s + 1) * ROAD_W / 6], mix((s & 1) ? "#111" : "#fafafa", FOG, fog));
        }

        // vegetación determinística por tramo
        const r1 = hash(k), r2 = hash(k + 1e5);
        if (r1 < 0.32) drawTree(ctx, proj(a, -(ROAD_W * 2.2 + r2 * 14)), fog, r2, k);
        if (r2 < 0.28) drawTree(ctx, proj(a, ROAD_W * 2.2 + r1 * 14), fog, r1, k + 3);
        const r3 = hash(k + 7e5);
        if (r3 < 0.22) drawBush(ctx, proj(a, (r3 < 0.11 ? -1 : 1) * (ROAD_W * 1.5 + r1 * 3)), fog, r3);
        if (r3 > 0.93) drawRock(ctx, proj(a, (r2 < 0.5 ? -1 : 1) * (ROAD_W * 1.7 + r3 * 4)), fog, r1);
        if (k % 4 === 0) drawPost(ctx, proj(a, ROAD_W * 1.32), fog);
        // carteles de km
        const kmA = Math.floor(a.d / 1000), kmB = Math.floor(b.d / 1000);
        if (kmB > kmA && b.d > 0) drawKmSign(ctx, proj(b, ROAD_W * 1.6), kmB, fog);
        if (finishD != null && a.d <= finishD && b.d > finishD) drawFinish(ctx, proj(b, -ROAD_W * 1.2), proj(b, ROAD_W * 1.2), fog);

        for (const sp of sprites) {
            if (sp.d >= a.d && sp.d < b.d) {
                const f = (sp.d - a.d) / SEG;
                const p = { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, y: a.y + (b.y - a.y) * f, th: a.th + (b.th - a.th) * f };
                const lat = sp.kind === "ghost" ? 0.9 : 0;
                const pr = proj(p, lat);
                if (pr) {
                    // inclinación real en curva: tan(θ) = v²·κ / g  (κ = Δrumbo / distancia)
                    const kappa = (trackHeading(tr, sp.d + 12) - trackHeading(tr, sp.d - 12)) / 24;
                    const v = speedKmh / 3.6;
                    const lean = Math.max(-0.4, Math.min(0.4, Math.atan(v * v * kappa / 9.81)));
                    const g = (trackEle(tr, sp.d + 10) - trackEle(tr, sp.d - 10)) / 20 * 100;
                    const ftp = R.athlete?.ftp_w || 200, p3 = R.powerTarget || 0;
                    const cadNow = samplesFresh() ? (R.lastSample?.cadence || 90) : 90;
                    const standing = sp.kind !== "ghost" && ((g > 6 && cadNow < 72) || p3 > ftp * 1.15);
                    drawRider(ctx, pr, sp.kind === "ghost", { lean, standing });
                }
            }
        }
    }
}

function drawTree(ctx, pr, fog, r, k) {
    if (!pr) return;
    const [sx, sy, s] = pr;
    const hgt = (5 + r * 6) * s, wid = (2 + r * 1.6) * s;
    if (hgt < 2) return;
    ctx.fillStyle = mix("#5b4231", FOG, fog);
    ctx.fillRect(sx - wid * 0.08, sy - hgt * 0.3, wid * 0.16, hgt * 0.3);
    const pine = (k & 1) === 0;
    ctx.fillStyle = mix(shade(pine ? "#24563a" : "#3c7a3a", PAL.light), FOG, fog);
    if (pine) {
        for (let i = 0; i < 3; i++) {
            const top = sy - hgt * (1 - i * 0.22), base = sy - hgt * (0.22 + i * 0.05);
            ctx.beginPath(); ctx.moveTo(sx, top); ctx.lineTo(sx - wid * (0.35 + i * 0.12), base); ctx.lineTo(sx + wid * (0.35 + i * 0.12), base); ctx.fill();
        }
    } else {
        ctx.beginPath(); ctx.ellipse(sx, sy - hgt * 0.62, wid * 0.55, hgt * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    }
}

function drawBush(ctx, pr, fog, r) {
    if (!pr) return;
    const [sx, sy, s] = pr;
    const rw = (0.7 + r * 2) * s;
    if (rw < 1.5) return;
    ctx.fillStyle = mix(shade(r < 0.08 ? "#5e8f3a" : "#3f7a35", PAL.light), FOG, fog);
    ctx.beginPath();
    ctx.ellipse(sx, sy - rw * 0.35, rw, rw * 0.55, 0, 0, Math.PI * 2);
    ctx.ellipse(sx + rw * 0.6, sy - rw * 0.25, rw * 0.6, rw * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
}

function drawRock(ctx, pr, fog, r) {
    if (!pr) return;
    const [sx, sy, s] = pr;
    const rw = (0.6 + r * 1.2) * s;
    if (rw < 1.5) return;
    ctx.fillStyle = mix(shade("#8a8d93", PAL.light), FOG, fog);
    ctx.beginPath();
    ctx.moveTo(sx - rw, sy); ctx.lineTo(sx - rw * 0.6, sy - rw * 0.7); ctx.lineTo(sx + rw * 0.2, sy - rw * 0.9);
    ctx.lineTo(sx + rw, sy - rw * 0.3); ctx.lineTo(sx + rw * 0.9, sy); ctx.fill();
}

function drawPost(ctx, pr, fog) {
    if (!pr) return;
    const [sx, sy, s] = pr;
    if (s < 2) return;
    ctx.fillStyle = mix(shade("#f2f2f2", PAL.light), FOG, fog);
    ctx.fillRect(sx - 0.06 * s, sy - 1.0 * s, 0.12 * s, 1.0 * s);
    ctx.fillStyle = mix("#e0566a", FOG, fog);
    ctx.fillRect(sx - 0.06 * s, sy - 0.95 * s, 0.12 * s, 0.12 * s);
}

function drawKmSign(ctx, pr, km, fog) {
    if (!pr) return;
    const [sx, sy, s] = pr;
    const ph = 2.2 * s, bw = 1.3 * s, bh = 0.75 * s;
    if (bh < 4) return;
    ctx.fillStyle = mix("#9aa3ad", FOG, fog);
    ctx.fillRect(sx - 0.05 * s, sy - ph, 0.1 * s, ph);
    ctx.fillStyle = mix("#ffffff", FOG, fog * 0.8);
    ctx.fillRect(sx - bw / 2, sy - ph - bh * 0.6, bw, bh);
    ctx.fillStyle = mix("#1e3a5f", FOG, fog * 0.8);
    ctx.font = `700 ${Math.max(6, bh * 0.55)}px system-ui`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`KM ${km}`, sx, sy - ph - bh * 0.1);
}

function drawFinish(ctx, l, r, fog) {
    if (!l || !r) return;
    const s = l[2], ph = 4.8 * s;
    ctx.fillStyle = mix("#d0d4da", FOG, fog);
    ctx.fillRect(l[0] - 0.12 * s, l[1] - ph, 0.24 * s, ph);
    ctx.fillRect(r[0] - 0.12 * s, r[1] - ph, 0.24 * s, ph);
    const bh = 0.9 * s;
    ctx.fillStyle = mix("#e0566a", FOG, fog);
    ctx.fillRect(l[0], l[1] - ph, r[0] - l[0], bh);
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.max(7, bh * 0.6)}px system-ui`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("META", (l[0] + r[0]) / 2, l[1] - ph + bh / 2);
}

// Ciclista visto desde atrás. Unidades en metros sobre el camino.
function drawRider(ctx, pr, ghost, opts = {}) {
    const [sx, sy, s] = pr;
    if (s < 3) return;
    const ph = R.pedalPhase;
    const standing = !!opts.standing;
    // de pie: la bici "baila" de lado a lado y el torso sube
    const sway = Math.sin(ph) * (standing ? 0.07 : 0.022);
    const up = standing ? 0.12 : 0;
    const X = m => sx + (m + sway) * s, Y = m => sy - m * s;
    ctx.save();
    ctx.globalAlpha = ghost ? 0.45 : 1;
    // sombra
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath(); ctx.ellipse(sx, sy, 0.55 * s, 0.09 * s, 0, 0, Math.PI * 2); ctx.fill();
    // inclinación en curva (+ balanceo de pie) alrededor del contacto de la rueda
    ctx.translate(sx, sy);
    ctx.rotate((opts.lean || 0) + (standing ? Math.sin(ph) * 0.06 : 0));
    ctx.translate(-sx, -sy);
    // rueda trasera
    ctx.fillStyle = "#15171c";
    ctx.beginPath(); ctx.ellipse(X(0), Y(0.34), 0.045 * s, 0.34 * s, 0, 0, Math.PI * 2); ctx.fill();
    // piernas (pedaleo)
    const legs = [[-0.11, ph], [0.11, ph + Math.PI]];
    ctx.lineCap = "round";
    for (const [lx, a] of legs) {
        const knee = [lx * 1.25, 0.66 + up * 0.8 + 0.13 * Math.sin(a)], foot = [lx * 0.75, 0.27 + 0.16 * Math.sin(a)];
        ctx.strokeStyle = ghost ? "#c7cfdb" : "#d9a37f";
        ctx.lineWidth = 0.1 * s;
        ctx.beginPath(); ctx.moveTo(X(knee[0]), Y(knee[1])); ctx.lineTo(X(foot[0]), Y(foot[1])); ctx.stroke();
        ctx.strokeStyle = "#16181d";
        ctx.lineWidth = 0.13 * s;
        ctx.beginPath(); ctx.moveTo(X(lx), Y(0.97 + up)); ctx.lineTo(X(knee[0]), Y(knee[1])); ctx.stroke();
        ctx.fillStyle = "#f2f2f2";
        ctx.beginPath(); ctx.ellipse(X(foot[0]), Y(foot[1] - 0.03), 0.05 * s, 0.035 * s, 0, 0, Math.PI * 2); ctx.fill();
    }
    // manillar (asoma a los costados del torso)
    ctx.strokeStyle = "#22252b"; ctx.lineWidth = 0.035 * s; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(X(-0.24), Y(1.06)); ctx.lineTo(X(0.24), Y(1.06)); ctx.stroke();
    // culotte
    ctx.fillStyle = "#16181d";
    ctx.beginPath(); ctx.roundRect?.(X(-0.19), Y(1.08 + up), 0.38 * s, 0.2 * s, 0.06 * s); ctx.fill();
    // torso
    const jersey = ghost ? "#b8c4d6" : "#2f6fe0";
    ctx.fillStyle = jersey;
    ctx.beginPath();
    ctx.moveTo(X(-0.18), Y(1.02 + up)); ctx.lineTo(X(0.18), Y(1.02 + up));
    ctx.lineTo(X(0.23), Y(1.36 + up)); ctx.lineTo(X(-0.23), Y(1.36 + up)); ctx.closePath(); ctx.fill();
    if (!ghost) {
        ctx.fillStyle = "#f0c948";
        ctx.fillRect(X(-0.205), Y(1.2 + up), 0.41 * s, 0.045 * s);
        ctx.fillStyle = "rgba(255,255,255,0.18)";          // brillo lateral
        ctx.fillRect(X(-0.21), Y(1.34 + up), 0.06 * s, 0.3 * s);
    }
    // brazos hacia el manillar
    ctx.strokeStyle = jersey; ctx.lineWidth = 0.08 * s;
    ctx.beginPath(); ctx.moveTo(X(-0.22), Y(1.33 + up)); ctx.lineTo(X(-0.23), Y(1.08)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0.22), Y(1.33 + up)); ctx.lineTo(X(0.23), Y(1.08)); ctx.stroke();
    // cuello + casco
    ctx.fillStyle = ghost ? "#c7cfdb" : "#d9a37f";
    ctx.fillRect(X(-0.045), Y(1.43 + up), 0.09 * s, 0.08 * s);
    ctx.fillStyle = ghost ? "#e5e9ef" : "#f5f7fa";
    ctx.beginPath(); ctx.ellipse(X(0), Y(1.49 + up), 0.12 * s, 0.1 * s, 0, 0, Math.PI * 2); ctx.fill();
    if (!ghost) {
        ctx.fillStyle = "#2f6fe0";
        ctx.fillRect(X(-0.02), Y(1.585 + up), 0.04 * s, 0.19 * s);
        ctx.fillStyle = "#e0566a";                          // luz trasera
        ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(performance.now() / 300));
        ctx.fillRect(X(-0.03), Y(0.78), 0.06 * s, 0.04 * s);
    }
    ctx.restore();
}

function ghostDistance() {
    const p = R.profile, r = R.ride;
    if (!p?.time || R.mode !== "ride" || !r || r.elapsed_s < 1) return null;
    // distancia donde la salida original tenía elapsed == tu elapsed
    const t = r.elapsed_s, arr = p.time;
    if (t >= arr[arr.length - 1]) return p.dist[p.dist.length - 1];
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m; else hi = m; }
    const f = (t - arr[lo]) / ((arr[hi] - arr[lo]) || 1);
    return p.dist[lo] + (p.dist[hi] - p.dist[lo]) * f;
}

// ============================================================ strip/perfil ==

function drawProfile(c, p, opts = {}) {
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    if (!p) return;
    const n = p.dist.length, total = p.dist[n - 1] || 1;
    let lo = Infinity, hi = -Infinity;
    for (const e of p.ele) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
    const span = Math.max(30, hi - lo);
    const padT = h * 0.12, padB = h * 0.16;
    const X = d => (d / total) * w;
    const Y = e => h - padB - ((e - lo) / span) * (h - padT - padB);
    const stepPx = Math.max(1, Math.floor(n / w));
    const half = Math.max(1, Math.round(250 / (p.step_m || 10)));   // ±250 m
    for (let i = 0; i < n - 1; i += stepPx) {
        const j = Math.min(n - 1, i + stepPx);
        const a = Math.max(0, i - half), b = Math.min(n - 1, j + half);
        const g = p.dist[b] > p.dist[a] ? ((p.ele[b] - p.ele[a]) / (p.dist[b] - p.dist[a])) * 100 : 0;
        ctx.fillStyle = gradeColor(g);
        ctx.beginPath();
        ctx.moveTo(X(p.dist[i]), h - padB + 1); ctx.lineTo(X(p.dist[i]), Y(p.ele[i]));
        ctx.lineTo(X(p.dist[j]), Y(p.ele[j])); ctx.lineTo(X(p.dist[j]), h - padB + 1);
        ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = Math.max(1, h / 90);
    ctx.beginPath();
    for (let i = 0; i < n; i += stepPx) { const x = X(p.dist[i]), y = Y(p.ele[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    // fuera de rango (preview) o ya recorrido (en ruta)
    ctx.fillStyle = "rgba(10,13,18,0.62)";
    if (opts.range) {
        ctx.fillRect(0, 0, X(opts.range.a), h);
        ctx.fillRect(X(opts.range.b), 0, w - X(opts.range.b), h);
    }
    if (opts.done != null) {
        ctx.fillStyle = "rgba(10,13,18,0.45)";
        ctx.fillRect(0, 0, X(opts.done), h);
    }
    // ticks de km
    const fs = Math.max(9, h * 0.11);
    ctx.font = `${fs}px system-ui`; ctx.fillStyle = "rgba(230,232,238,0.75)"; ctx.textBaseline = "bottom";
    const kmStep = total > 60000 ? 10 : total > 25000 ? 5 : total > 8000 ? 2 : 1;
    ctx.textAlign = "center";
    for (let km = kmStep; km * 1000 < total; km += kmStep) ctx.fillText(`${km}`, X(km * 1000), h - 1);
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${Math.round(hi)} m`, 4, 2);
    ctx.textBaseline = "bottom";
    ctx.fillText(`${Math.round(lo)} m`, 4, h - padB - 2);
    // marcadores
    const mark = (d, color, r) => {
        const x = X(d), y = Y(interpArr(p, p.ele, d));
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, h / 70);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, h - padB); ctx.stroke();
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    };
    if (opts.ghost != null) mark(opts.ghost, "rgba(184,196,214,0.9)", Math.max(3, h / 22));
    if (opts.done != null) mark(opts.done, "#ffffff", Math.max(4, h / 16));
}

function drawWorkoutStrip(c) {
    const ctx = c.getContext("2d"), w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const wk = R.workoutLoaded;
    if (!wk) return;
    const total = wk.total_duration_s || 1, ftp = R.athlete?.ftp_w || 200;
    const top = ftp * 1.4;
    let t = 0;
    const p = R.workout || {};
    const active = p.state === "running" || p.state === "paused";
    wk.segments.forEach((sg, i) => {
        const x0 = (t / total) * w, x1 = ((t + sg.duration_s) / total) * w;
        const val = sg.target_w ?? (ftp * 0.5);
        const bh = Math.max(h * 0.12, Math.min(1, val / top) * (h - 6));
        ctx.fillStyle = sg.target_w != null ? ZONE_COLORS[Math.max(0, powerZoneIdx(sg.target_w))] : gradeColor(sg.grade_pct ?? 0);
        ctx.globalAlpha = active && i < p.segment_idx ? 0.35 : 0.92;
        ctx.fillRect(x0 + 0.5, h - bh, Math.max(1, x1 - x0 - 1), bh);
        if (active && i === p.segment_idx) {
            ctx.globalAlpha = 1; ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(1, h / 60);
            ctx.strokeRect(x0 + 1, h - bh + 1, Math.max(1, x1 - x0 - 2), bh - 2);
        }
        t += sg.duration_s;
    });
    ctx.globalAlpha = 1;
    // FTP
    const yF = h - (ftp / top) * (h - 6);
    ctx.setLineDash([6, 5]); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yF); ctx.lineTo(w, yF); ctx.stroke(); ctx.setLineDash([]);
    if (R.wkTrace.length > 1) {
        ctx.lineJoin = "round";
        const path = () => {
            ctx.beginPath();
            R.wkTrace.forEach((pt, i) => {
                const x = (pt.e / total) * w, y = h - Math.min(1, pt.p / top) * (h - 6);
                i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
        };
        ctx.strokeStyle = "rgba(10,13,18,0.85)"; ctx.lineWidth = Math.max(3, h / 18); path(); ctx.stroke();
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(1.5, h / 40); path(); ctx.stroke();
    }
    if (active) {
        const x = (p.total_elapsed_s / total) * w;
        ctx.fillStyle = "#fff"; ctx.fillRect(x - 1.5, 0, 3, h);
    }
}

function drawFreeStrip(c) {
    const ctx = c.getContext("2d"), w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const ftp = R.athlete?.ftp_w || 200, top = ftp * 1.5;
    const now = performance.now(), win = 300 * 1000, bucket = 5000;
    const nb = win / bucket, sums = new Array(nb).fill(0), cnt = new Array(nb).fill(0);
    for (const s of R.samples) {
        const age = now - s.at;
        if (age > win || s.power == null) continue;
        const b = nb - 1 - Math.floor(age / bucket);
        sums[b] += s.power; cnt[b]++;
    }
    const bw = w / nb;
    for (let i = 0; i < nb; i++) {
        if (!cnt[i]) continue;
        const v = sums[i] / cnt[i], bh = Math.min(1, v / top) * (h - 4);
        ctx.fillStyle = ZONE_COLORS[Math.max(0, powerZoneIdx(v))];
        ctx.fillRect(i * bw + 0.5, h - bh, bw - 1, bh);
    }
    const yF = h - (ftp / top) * (h - 4);
    ctx.setLineDash([6, 5]); ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath(); ctx.moveTo(0, yF); ctx.lineTo(w, yF); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(230,232,238,0.7)"; ctx.font = `${Math.max(9, h * 0.11)}px system-ui`; ctx.textBaseline = "bottom";
    ctx.fillText("FTP", 4, yF - 2);
}

function drawMinimap() {
    const c = $("minimap"), p = R.profile;
    if (c.hidden || !p?.lat) return;
    fitCanvas(c);
    const ctx = c.getContext("2d"), w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    for (let i = 0; i < p.lat.length; i++) {
        la0 = Math.min(la0, p.lat[i]); la1 = Math.max(la1, p.lat[i]);
        lo0 = Math.min(lo0, p.lon[i]); lo1 = Math.max(lo1, p.lon[i]);
    }
    const kx = Math.cos(((la0 + la1) / 2) * Math.PI / 180);
    const sx = (lo1 - lo0) * kx || 1e-6, sy = (la1 - la0) || 1e-6;
    const pad = w * 0.1, sc = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
    const ox = (w - sx * sc) / 2, oy = (h - sy * sc) / 2;
    const P = (la, lo) => [ox + (lo - lo0) * kx * sc, h - oy - (la - la0) * sc];
    const done = R.ride?.distance_m ?? 0;
    const line = (from, to, color, lw) => {
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.beginPath();
        let started = false;
        for (let i = 0; i < p.lat.length; i++) {
            if (p.dist[i] < from || p.dist[i] > to) continue;
            const [x, y] = P(p.lat[i], p.lon[i]);
            started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
        }
        ctx.stroke();
    };
    line(0, Infinity, "rgba(255,255,255,0.35)", Math.max(2, w / 60));
    line(0, done, "#4f8cff", Math.max(2.5, w / 45));
    const dot = (d, color, r) => {
        const [x, y] = P(interpArr(p, p.lat, d), interpArr(p, p.lon, d));
        ctx.fillStyle = color; ctx.strokeStyle = "#0a0d12"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    const g = ghostDistance();
    if (g != null) dot(g, "#b8c4d6", w / 30);
    dot(done, "#ffffff", w / 24);
}

function drawPreview() {
    const c = $("rp-profile");
    if (!c || !c.clientWidth) return;
    fitCanvas(c);
    drawProfile(c, R.preview, { range: previewRange() });
}

function drawChart() {
    const c = $("chart");
    if (!c.clientWidth) return;
    fitCanvas(c);
    const ctx = c.getContext("2d"), w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const ftp = R.athlete?.ftp_w || 200, top = ftp * 1.6;
    const zs = R.athlete?.power_zones || [];
    zs.forEach((z, i) => {   // bandas de zona tenues
        const y0 = h - Math.min(1, z.max_w / top) * h, y1 = h - Math.min(1, z.min_w / top) * h;
        ctx.fillStyle = ZONE_COLORS[i] + "14";
        ctx.fillRect(0, y0, w, y1 - y0);
    });
    const now = performance.now(), win = SAMPLE_WINDOW_S * 1000;
    const X = s => w - ((now - s.at) / win) * w;
    // Media móvil de `smooth` segundos sobre la serie (ventana deslizante O(n))
    const series = (key, scale, color, lw, smooth) => {
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.beginPath();
        let started = false, sum = 0, n = 0, j = 0;
        const S = R.samples;
        for (let i = 0; i < S.length; i++) {
            const s = S[i];
            if (s[key] != null) { sum += s[key]; n++; }
            while (j < i && s.at - S[j].at > smooth * 1000) {
                if (S[j][key] != null) { sum -= S[j][key]; n--; }
                j++;
            }
            if (!n) { started = false; continue; }
            const x = X(s), y = h - Math.min(1, (sum / n) / scale) * h;
            started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
        }
        ctx.stroke();
    };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    series("power", top, "#4f8cff", 1.8 * dpr, Math.max(3, R.smoothS));
    series("hr", (R.athlete?.max_hr || 200) * 1.05, "#e0566a", 1.6 * dpr, 1);
    const yF = h - (ftp / top) * h;
    ctx.setLineDash([6, 5]); ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yF); ctx.lineTo(w, yF); ctx.stroke(); ctx.setLineDash([]);
    $("chart-legend").innerHTML = `<span style="color:#4f8cff">● potencia ${Math.max(3, R.smoothS)}s</span> · <span style="color:#e0566a">● FC</span> · FTP ${ftp} W`;
}

// ================================================================== loop ====

let lastFrame = performance.now(), lastSlow = 0, lastChart = 0;

function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const visible = $("view-trainer")?.classList.contains("active");

    // distancia de la cámara
    const fresh = samplesFresh();
    const cad = fresh ? (R.lastSample?.cadence || 0) : 0;
    R.pedalPhase += (cad / 60) * 2 * Math.PI * dt;
    if (R.powerShown != null && R.powerTarget != null) {
        R.powerShown += (R.powerTarget - R.powerShown) * Math.min(1, dt * 7);
        $("hud-power").textContent = Math.round(R.powerShown);
    }
    if ((R.mode === "ride" || R.mode === "combo") && R.ride?.distance_m != null) {
        const ext = R.ride.state === "running" ? (R.ride.speed_kmh / 3.6) * Math.min(1, (now - R.rideAt) / 1000) : 0;
        const est = R.mode === "combo" ? R.ride.distance_m + ext : Math.min(R.ride.distance_m + ext, R.ride.total_m ?? Infinity);
        if (Math.abs(est - R.displayDist) > 150) R.displayDist = est;
        else R.displayDist += (est - R.displayDist) * Math.min(1, dt * 6);
    } else if (R.tab === "ride" && R.track && R.mode === "free") {
        R.displayDist = R.ride?.distance_m || 0;
    } else {
        const v = fresh ? Math.max(0, R.lastSample?.speed || 0) / 3.6 : 0;
        R.localDist += v * dt;
        R.displayDist = R.localDist;
        if (R.sessionActive && fresh) R.sessionElapsed += dt;
        if (R.mode !== "ride") {
            $("hud-dist").textContent = fmtKm(R.localDist, 2);
            $("hud-time").textContent = formatDuration(R.mode === "workout" ? R.workout?.total_elapsed_s : R.sessionElapsed);
            $("hud-dist-rem").textContent = R.mode === "workout" && R.workout?.total_remaining_s != null
                ? `faltan ${formatDuration(R.workout.total_remaining_s)}` : " ";
        }
    }

    if (visible) {
        if (!draw3D(dt)) drawScene(dt);
        drawFx(dt);
        if (now - lastSlow > 120) {
            lastSlow = now;
            const strip = $("strip");
            fitCanvas(strip);
            if (R.stripMode === "ride") drawProfile(strip, R.profile, { done: R.displayDist, ghost: ghostDistance() });
            else if (R.stripMode === "workout") drawWorkoutStrip(strip);
            else drawFreeStrip(strip);
            drawMinimap();
            if (!fresh) renderHud();
            renderModeChrome();
        }
        if (now - lastChart > 1000) { lastChart = now; drawChart(); }
    }
    setSmoothing(R.smoothS);
setSmoothing(R.smoothS);
requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 3D ------

function palName() {
    return PAL === PALETTES.night ? "night" : PAL === PALETTES.dusk ? "dusk" : PAL === PALETTES.dawn ? "dawn" : "day";
}

function sceneTheme() {
    const p = R.profile;
    if (!p || !(R.mode === "ride" || R.mode === "combo" || (R.tab === "ride" && R.mode === "free"))) return "lakes";
    if (p.theme) return p.theme;
    // tus actividades: sur de Chile → lagos; cordillera central → andes
    const lat = p.lat ? p.lat[0] : null;
    if (lat != null && lat < -38) return "lakes";
    return "andes";
}

// Pose del ciclista compartida por las escenas 2D y 3D
function riderPose(tr, d, speedKmh) {
    const kappa = (trackHeading(tr, d + 12) - trackHeading(tr, d - 12)) / 24;
    const v = speedKmh / 3.6;
    const lean = Math.max(-0.4, Math.min(0.4, Math.atan(v * v * kappa / 9.81)));
    const g = (trackEle(tr, d + 10) - trackEle(tr, d - 10)) / 20 * 100;
    const ftp = R.athlete?.ftp_w || 200, p3 = R.powerTarget || 0;
    const cadNow = samplesFresh() ? (R.lastSample?.cadence || 90) : 90;
    return { lean, standing: (g > 6 && cadNow < 72) || p3 > ftp * 1.15 };
}

let scene3dHidden2D = false;
function draw3D(dt) {
    const S3 = window.Scene3D;
    if (!S3?.ready) return false;
    if (!scene3dHidden2D) { $("scene").style.display = "none"; scene3dHidden2D = true; }
    const useRoute = R.track && (R.mode === "ride" || R.mode === "combo" || (R.tab === "ride" && R.mode === "free"));
    const tr = useRoute ? R.track : FREE_TRACK;
    const speedKmh = (R.mode === "ride" || R.mode === "combo") ? (R.ride?.speed_kmh || 0) : Math.max(0, R.lastSample?.speed || 0);
    const pose = riderPose(tr, R.displayDist, speedKmh);
    let landmarks = useRoute ? (R.profile?.landmarks || []) : [];
    if (useRoute && !landmarks.some(l => l.kind === "summit")) landmarks = [...landmarks, { d: tr.length, kind: "summit", label: "Meta" }];
    return S3.frame({
        dt,
        trackKey: useRoute ? R.profileId : "proc",
        headingAt: d => trackHeading(tr, d),
        eleAt: d => trackEle(tr, d),
        length: tr.kind === "route" ? tr.length : Infinity,
        kind: tr.kind,
        finishD: tr.kind === "route" ? tr.length : null,
        landmarks,
        treelessFrom: useRoute ? (R.profile?.treeless_from_m ?? null) : null,
        theme: sceneTheme(),
        palette: palName(),
        riderD: R.displayDist,
        ghostD: ghostDistance(),
        speedKmh,
        pedalPhase: R.pedalPhase,
        standing: pose.standing,
        lean: pose.lean,
    });
}

function rigOnShow() {
    fitCanvas($("scene"));
    if (!R.routes.length) loadRideRoutes();
    requestAnimationFrame(() => { fitCanvas($("scene")); drawPreview(); drawChart(); });
}

if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { fitCanvas($("scene")); drawPreview(); });
    ro.observe($("rig"));
    ro.observe($("rp-profile"));
}
document.addEventListener("fullscreenchange", () => requestAnimationFrame(() => fitCanvas($("scene"))));
setSmoothing(R.smoothS);
requestAnimationFrame(frame);
