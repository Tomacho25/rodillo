// rodillo · arranque, ajustes del ciclista y lista de sesiones (TCX descargable).
"use strict";

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
                    <a class="link-btn" href="/api/sessions/${encodeURIComponent(s.id)}/tcx" download>⤓ TCX</a>
                </div>
                <div class="ts-stats muted">
                    ${s.avg_power_w ?? "—"} W medios · NP ${s.np_w ?? "—"} W · FC ${s.avg_hr ?? "—"}/${s.max_hr ?? "—"} ·
                    ${s.avg_cadence ?? "—"} rpm · ${s.distance_m ? (s.distance_m / 1000).toFixed(1) + " km" : "—"}
                </div>
            </div>`).join("");
    } catch (e) {
        list.innerHTML = `<div class="loading-empty err">No pude leer las sesiones: ${esc(e.message)}</div>`;
    }
}
$("btn-refresh-sessions").addEventListener("click", loadTrainerSessions);

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
