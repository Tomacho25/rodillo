// rodillo · subir sesiones a Strava directo desde el navegador (versión web).
//
// Strava acepta llamadas desde el navegador (CORS) pero exige el client_secret
// para entregar tokens: no hay PKCE. Para no publicar el secreto en el repo, se
// activa con un "link de activación" privado que comparte el dueño de la app:
//
//     https://<sitio>/#strava=<client_id>.<client_secret>
//
// El fragmento (#…) nunca viaja al servidor: queda en localStorage y se borra
// de la barra de direcciones. Después cada persona autoriza con su cuenta.
(() => {
"use strict";
if (!window.RodilloEngine) return;

const K_APP = "rodillo.strava.app", K_TOK = "rodillo.strava.tokens", K_UP = "rodillo.strava.uploaded";
const AUTH = "https://www.strava.com/oauth/authorize", TOKEN = "https://www.strava.com/oauth/token", API = "https://www.strava.com/api/v3";
const read = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin storage */ } };
const say = (m, kind) => window.toast?.(m, kind);
const redirectUri = () => location.origin + location.pathname;

const Strava = window.RodilloStrava = {
    get app() { return read(K_APP); },
    get tokens() { return read(K_TOK); },
    get connected() { return !!this.tokens?.refresh_token; },
    uploaded(id) { return (read(K_UP) || {})[id] || null; },
    pending: new Set(),      // sesiones subiéndose ahora

};

// 1) link de activación: #strava=<id>.<secret> (al cargar o pegándolo en una pestaña ya abierta)
function checkActivation() {
    const m = location.hash.match(/strava=(\d+)\.([0-9a-f]{20,64})/i);
    if (!m) return;
    write(K_APP, { id: m[1], secret: m[2] });
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(() => { say("✓ Strava activado en este navegador. Ahora apretá “Conectar Strava”.", "good"); Strava.render?.(); }, 600);
}
checkActivation();
window.addEventListener("hashchange", checkActivation);

// 2) vuelta del login de Strava: ?code=…&state=rodillo
const q = new URLSearchParams(location.search);
if (q.get("state") === "rodillo-strava") {
    history.replaceState(null, "", location.pathname);
    if (q.get("error")) setTimeout(() => say("No se conectó Strava (cancelaste el permiso)", "warn"), 600);
    else if (q.get("code")) exchange({ grant_type: "authorization_code", code: q.get("code") }, q.get("scope") || "")
        .then(t => say(`✓ Strava conectado${t.athlete ? " · " + t.athlete : ""}. Tus sesiones se van a subir solas.`, "good"))
        .catch(e => say("Strava: " + e.message, "bad"))
        .finally(render);
}

async function exchange(params, scope) {
    const app = Strava.app;
    if (!app) throw new Error("Falta el link de activación de Strava");
    const r = await fetch(TOKEN, { method: "POST", body: new URLSearchParams({ client_id: app.id, client_secret: app.secret, ...params }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message === "Bad Request" ? "el link de activación ya no es válido (¿se cambió el secreto?)" : (d.message || r.statusText));
    if (params.grant_type === "authorization_code" && scope && !scope.includes("activity:write")) {
        throw new Error("hay que aceptar el permiso de “subir actividades”");
    }
    const prev = Strava.tokens || {};
    const t = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at,
        athlete: d.athlete ? `${d.athlete.firstname || ""} ${d.athlete.lastname || ""}`.trim() : prev.athlete };
    write(K_TOK, t);
    return t;
}

async function accessToken() {
    const t = Strava.tokens;
    if (!t) throw new Error("Strava no está conectado");
    if (t.expires_at && t.expires_at - 120 > Date.now() / 1000) return t.access_token;
    return (await exchange({ grant_type: "refresh_token", refresh_token: t.refresh_token })).access_token;
}

Strava.connect = () => {
    const app = Strava.app;
    if (!app) return say("Para Strava necesitás el link de activación de quien administra la app", "warn");
    location.href = `${AUTH}?${new URLSearchParams({ client_id: app.id, redirect_uri: redirectUri(), response_type: "code",
        approval_prompt: "auto", scope: "read,activity:write", state: "rodillo-strava" })}`;
};
Strava.disconnect = () => { write(K_TOK, null); render(); say("Strava desconectado en este navegador"); };

// 3) subir una sesión guardada (TCX) y esperar a que Strava la procese
Strava.upload = async (sessionId, opts) => {
    Strava.pending.add(sessionId);
    window.loadTrainerSessions?.();
    try { return await uploadNow(sessionId, opts); }
    finally { Strava.pending.delete(sessionId); window.loadTrainerSessions?.(); }
};
async function uploadNow(sessionId, { quiet = false } = {}) {
    const s = await window.RodilloEngine.getSession(sessionId);
    if (!s) throw new Error("No encontré la sesión");
    const fd = new FormData();
    fd.append("file", new Blob([s.tcx], { type: "application/xml" }), `${sessionId}.tcx`);
    fd.append("data_type", "tcx");
    fd.append("name", s.name);
    fd.append("description", "Entrenado con rodillo · https://github.com/Tomacho25/rodillo");
    fd.append("trainer", "1");
    fd.append("external_id", `rodillo-${sessionId}`);
    if (!quiet) say("Subiendo a Strava…");
    const tok = await accessToken();
    const r = await fetch(`${API}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: fd });
    let up = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(up.message || r.statusText);
    for (let i = 0; i < 20 && !up.activity_id && !up.error; i++) {
        await new Promise(res => setTimeout(res, 1500));
        up = await (await fetch(`${API}/uploads/${up.id}`, { headers: { Authorization: `Bearer ${tok}` } })).json();
    }
    if (up.error) {
        const dup = /duplicate/i.test(up.error);
        if (!dup) throw new Error(up.error);
        const link = up.error.match(/activities\/(\d+)/)?.[1];
        mark(sessionId, link || "dup");
        return link;
    }
    if (!up.activity_id) throw new Error("Strava sigue procesando la actividad; revisá en unos minutos");
    mark(sessionId, up.activity_id);
    say(`✓ Subida a Strava`, "good");
    return up.activity_id;
}
function mark(id, activity) {
    const all = read(K_UP) || {};
    all[id] = String(activity);
    write(K_UP, all);
    window.loadTrainerSessions?.();
}

// subida automática al guardar una sesión
Strava.onSessionSaved = id => {
    if (!Strava.connected || !id) return;
    Strava.upload(id).catch(e => say("No pude subir a Strava: " + e.message + " — probá desde “Tus sesiones”", "bad"));
};

// 4) botón en la cabecera
function render() {
    const b = document.getElementById("btn-strava");
    if (!b) return;
    b.hidden = !Strava.app;
    if (Strava.connected) {
        b.textContent = `🟧 Strava${Strava.tokens.athlete ? " · " + Strava.tokens.athlete.split(" ")[0] : ""} ✓`;
        b.title = "Las sesiones se suben solas. Clic para desconectar.";
    } else {
        b.textContent = "🟧 Conectar Strava";
        b.title = "Subir tus sesiones a Strava automáticamente";
    }
}
document.addEventListener("click", e => {
    if (e.target.id === "btn-strava") {
        if (Strava.connected) { if (confirm("¿Desconectar Strava en este navegador?")) Strava.disconnect(); }
        else Strava.connect();
    }
});
document.addEventListener("DOMContentLoaded", render);
if (document.readyState !== "loading") render();
Strava.render = render;
})();
