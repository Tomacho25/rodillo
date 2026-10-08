// rodillo · arranque, ajustes del ciclista y lista de sesiones (TCX descargable).
"use strict";

// Sin conexión automática: descargar el TCX y abrir la página de importación
const IMPORT_PAGES = {
    garmin: "https://connect.garmin.com/modern/import-data",
    strava: "https://www.strava.com/upload/select",
};
function manualCell(id, where) {
    const label = where === "garmin" ? "⤴ Garmin" : "⤴ Strava";
    return `<button class="link-btn ${where}-link" data-manual="${where}" data-id="${esc(id)}"
        title="Descarga el TCX y abre ${where === "garmin" ? "Garmin Connect" : "Strava"} para importarlo">${label}</button>`;
}

function stravaCell(id) {
    const S = window.RodilloStrava;
    if (!S?.connected) return manualCell(id, "strava");
    const act = S.uploaded(id);
    if (act && act !== "dup") return `<a class="link-btn strava-link" href="https://www.strava.com/activities/${encodeURIComponent(act)}" target="_blank" rel="noopener">✓ Ver en Strava</a>`;
    if (act === "dup") return `<span class="muted small">✓ ya estaba en Strava</span>`;
    if (S.pending?.has(id)) return `<span class="muted small">⏳ subiendo a Strava…</span>`;
    return `<button class="link-btn strava-link" data-strava="${esc(id)}">⤴ Strava</button>`;
}

// Botones de una sesión guardada (lista y ventana de "terminada")
function sessionActions(id) {
    const tcx = window.RodilloEngine
        ? `<button class="link-btn" data-tcx="${esc(id)}">⤓ TCX</button>`
        : `<a class="link-btn" href="/api/sessions/${encodeURIComponent(id)}/tcx" download>⤓ TCX</a>`;
    return `<span class="ts-actions">${stravaCell(id)}${manualCell(id, "garmin")}${tcx}</span>`;
}

function downloadTcx(id) {
    if (window.RodilloEngine) return window.RodilloEngine.downloadTcx(id);
    const a = document.createElement("a");
    a.href = `/api/sessions/${encodeURIComponent(id)}/tcx`;
    a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
}

// delegación: sirve para la lista y para la ventana aunque se re-dibujen
document.addEventListener("click", async e => {
    const b = e.target.closest("[data-tcx],[data-manual],[data-strava]");
    if (!b) return;
    if (b.dataset.tcx) return downloadTcx(b.dataset.tcx);
    if (b.dataset.manual) {
        const where = b.dataset.manual;
        const tab = window.open(IMPORT_PAGES[where], "_blank");   // abrir antes del await (bloqueador de popups)
        if (tab) tab.opener = null;
        await downloadTcx(b.dataset.id);
        toast(`TCX descargado: arrastralo a la página de ${where === "garmin" ? "Garmin Connect (Importar datos)" : "Strava (Subir archivo)"} que se abrió`, "good");
        if (!tab) toast("El navegador bloqueó la pestaña nueva: abrí " + IMPORT_PAGES[where], "warn");
        return;
    }
    b.disabled = true; b.textContent = "Subiendo…";
    try { await window.RodilloStrava.upload(b.dataset.strava); }
    catch (err) { toast("Strava: " + err.message, "bad"); b.disabled = false; b.textContent = "⤴ Strava"; }
});

async function loadTrainerSessions() {
    const list = $("trainer-sessions-list");
    try {
        const { sessions = [] } = await (await fetch("/api/sessions")).json();
        if (!sessions.length) {
            list.innerHTML = '<div class="loading-empty">Todavía no hay sesiones. Al terminar una ruta o workout se guarda sola acá.</div>';
            return;
        }
        list.innerHTML = sessions.map(s => `
            <div class="trainer-session-row">
                <div class="ts-head">
                    <div><strong>${esc(s.name)}</strong>
                        <span class="muted">${esc((s.start || "").replace("T", " ").slice(0, 16))} · ${Math.round((s.duration_s || 0) / 60)} min</span></div>
                    ${sessionActions(s.id)}
                </div>
                <div class="ts-stats muted">
                    ${s.avg_power_w ?? "—"} W medios · NP ${s.np_w ?? "—"} W · FC ${s.avg_hr ?? "—"}/${s.max_hr ?? "—"} ·
                    ${s.avg_cadence ?? "—"} rpm · ${s.distance_m ? (s.distance_m / 1000).toFixed(1) + " km" : "—"}
                </div>
            </div>`).join("");
        renderSessionDone();
    } catch (e) {
        list.innerHTML = `<div class="loading-empty err">No pude leer las sesiones: ${esc(e.message)}</div>`;
    }
}
$("btn-refresh-sessions").addEventListener("click", loadTrainerSessions);
window.loadTrainerSessions = loadTrainerSessions;

// ---- ventana "Sesión terminada": resumen + dónde subirla
const doneModal = $("done-modal");
let doneData = null;
window.showSessionDone = data => {
    doneData = data;
    renderSessionDone();
    doneModal.hidden = false;
};
function renderSessionDone() {
    if (!doneData) return;
    const d = doneData, st = d.stats || {};
    const item = (l, v) => v ? `<div><span>${l}</span><strong>${v}</strong></div>` : "";
    $("done-name").textContent = d.name || "";
    $("done-stats").innerHTML =
        item("Duración", st.duration_s ? formatDuration(st.duration_s) : "")
        + item("Distancia", st.distance_m ? `${(st.distance_m / 1000).toFixed(1)} km` : "")
        + item("Potencia media", st.avg_power_w ? `${Math.round(st.avg_power_w)} W` : "")
        + item("NP", st.normalized_power_w ? `${Math.round(st.normalized_power_w)} W` : "")
        + item("FC media", st.avg_hr_bpm ? `${Math.round(st.avg_hr_bpm)} ppm` : "");
    const S = window.RodilloStrava;
    if (d.simulated) {
        $("done-note").textContent = "Modo demo: los watts son simulados, así que esta sesión no se guarda. Con el rodillo conectado, acá vas a poder subirla.";
        $("done-actions").innerHTML = "";
    } else {
        $("done-note").innerHTML = "✓ Guardada en <b>Tus sesiones</b>. "
            + (S?.connected ? "Se sube sola a Strava; para Garmin, el botón descarga el archivo y abre la página de importación."
                : "Para subirla: el botón descarga el archivo (TCX) y abre la página de importación, donde lo arrastrás.");
        $("done-actions").innerHTML = sessionActions(d.id);
    }
}
const closeDone = () => { doneModal.hidden = true; };
$("done-close").addEventListener("click", closeDone);
$("done-ok").addEventListener("click", closeDone);
$("done-list").addEventListener("click", () => { closeDone(); goTo("trainer-recent"); });
doneModal.addEventListener("click", e => { if (e.target === doneModal) closeDone(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDone(); settingsModal.hidden = true; } });

// ---- ajustes
const settingsModal = $("settings-modal"), settingsForm = $("settings-form");
async function openSettings() {
    const s = await (await fetch("/api/settings")).json();
    for (const k of ["name", "ftp_w", "weight_kg", "max_hr"]) settingsForm.elements[k].value = s[k];
    settingsModal.hidden = false;
}
$("btn-settings").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => { settingsModal.hidden = true; });
settingsModal.addEventListener("click", e => { if (e.target === settingsModal) settingsModal.hidden = true; });
settingsForm.addEventListener("submit", async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(settingsForm));
    const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) return toast("No pude guardar los ajustes", "bad");
    const s = await r.json();
    settingsModal.hidden = true;
    $("rig-greeting").textContent = s.name && s.name !== "Ciclista" ? `Hola, ${s.name}` : "Rodillo";
    toast(`Guardado · FTP ${s.ftp_w} W · ${s.weight_kg} kg`, "good");
    loadRoutes();              // los workouts se re-escalan con el FTP nuevo
    renderRideList();
});

// ---- ayudas para FTP y FC máxima
$("ftp-estimate").addEventListener("click", () => {
    const kg = parseFloat(settingsForm.elements.weight_kg.value) || 72;
    settingsForm.elements.ftp_w.value = Math.round(kg * 2.5 / 5) * 5;      // ~2,5 W/kg: ciclista recreativo en forma
    toast("Estimado con 2,5 W/kg — hacé el test de FTP para afinarlo");
});
$("hr-estimate").addEventListener("click", () => {
    const age = parseInt($("age-input").value);
    if (!age) return toast("Poné tu edad primero");
    settingsForm.elements.max_hr.value = Math.round(208 - 0.7 * age);       // fórmula de Tanaka
});

// ---- versión web: conectar por Bluetooth o probar con el simulador
if (window.RodilloEngine) {
    document.querySelectorAll(".web-only").forEach(el => { el.hidden = false; });
    window.RodilloStrava?.render();          // "Conectar Strava" solo si hay link de activación
    const E = window.RodilloEngine;
    const busy = (btn, label) => { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = label; };
    const free = btn => { btn.disabled = false; btn.textContent = btn.dataset.label; };
    $("btn-connect").addEventListener("click", async e => {
        const b = e.currentTarget;
        busy(b, "Buscando…");
        try { const name = await E.connectTrainer(); toast(`✓ Conectado: ${name}`, "good"); b.textContent = "✓ " + name; b.disabled = true; $("btn-demo").hidden = true; }
        catch (err) { free(b); if (err.name !== "NotFoundError") toast(err.message, "bad"); }
    });
    $("btn-connect-hr").addEventListener("click", async e => {
        const b = e.currentTarget;
        busy(b, "Buscando…");
        try { const name = await E.connectHr(); toast(`✓ Banda: ${name}`, "good"); b.hidden = true; }
        catch (err) { free(b); if (err.name !== "NotFoundError") toast(err.message, "bad"); }
    });
    $("btn-demo").addEventListener("click", async e => {
        await E.startDemo();
        e.currentTarget.hidden = true;
        toast("Modo demo: los watts son simulados y la sesión no se guarda");
    });
    if (!E.supported) {
        $("btn-connect").title = "Tu navegador no tiene Bluetooth web: usá Chrome o Edge (en iPhone, la app Bluefy)";
        $("btn-connect-hr").hidden = true;
    }
}

// ---- arranque
(async () => {
    connectWs();
    loadRoutes();
    rigOnShow();
    loadTrainerSessions();
    try {
        const s = await (await fetch("/api/settings")).json();
        if (s.name && s.name !== "Ciclista") $("rig-greeting").textContent = `Hola, ${s.name}`;
        if (!localStorage.getItem("rodillo.welcomed")) { localStorage.setItem("rodillo.welcomed", "1"); openSettings(); }
    } catch { /* sin storage: no pasa nada */ }
})();
