// it-panel · API de lectura del panel (y servidor del propio HTML).
//
// Versión desplegada actualmente + las cuatro tablas del Command Center
// (it_agents, it_tasks, it_approvals, it_alerts).
//
// El token de lectura ya no va incrustado en el código: se lee de IT_PANEL_TOKEN.
// Antes de desplegar hay que fijarlo con el MISMO valor que usan tus enlaces
// `?k=…` actuales, o dejarán de funcionar:
//
//   supabase secrets set IT_PANEL_TOKEN=<el token que ya usas>
//   supabase functions deploy it-panel --no-verify-jwt

const TOKEN = Deno.env.get("IT_PANEL_TOKEN") ?? "";
const SB = Deno.env.get("SUPABASE_URL") ?? "";
const BASE = SB + "/rest/v1/";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STORAGE_PUBLIC = `${SB}/storage/v1/object/public/panel/${TOKEN}/index.html`;

function withHeaders(body: BodyInit | null, contentType: string, status = 200, extra?: Record<string, string>): Response {
  const h = new Headers();
  h.set("content-type", contentType);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "authorization, x-client-info, apikey, content-type");
  h.set("cache-control", "no-store");
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(body, { status, headers: h });
}

function json(obj: unknown, status = 200): Response {
  return withHeaders(JSON.stringify(obj), "application/json; charset=utf-8", status);
}

const AUTH = { apikey: SRK, Authorization: `Bearer ${SRK}` };

async function q(path: string) {
  const r = await fetch(BASE + path, { headers: AUTH });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const SVG_SHELL = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 800 600">\n<title>Investment Ops</title>\n<rect width="100%" height="100%" fill="#0d0d0d"/>\n<text id="m" x="400" y="300" text-anchor="middle" fill="#898781" font-family="system-ui, sans-serif" font-size="14" letter-spacing="3">CARGANDO INVESTMENT OPS…</text>\n<script>//<![CDATA[\nfetch("${STORAGE_PUBLIC}",{cache:"no-store"}).then(function(r){\n  if(!r.ok){throw new Error("HTTP "+r.status);}\n  return r.text();\n}).then(function(t){\n  var b=new Blob([t],{type:"text/html"});\n  location.replace(URL.createObjectURL(b));\n}).catch(function(e){\n  var m=document.getElementById("m");\n  if(m){m.textContent="ERROR CARGANDO EL PANEL: "+e.message;}\n});\n//]]></script>\n</svg>`;

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return withHeaders("ok", "text/plain");
    if (!TOKEN) return json({ error: "IT_PANEL_TOKEN no está configurado en la función" }, 500);

    const url = new URL(req.url);
    if (url.searchParams.get("k") !== TOKEN) {
      return withHeaders("No autorizado", "text/plain; charset=utf-8", 401);
    }
    const path = url.pathname.replace(/\/+$/, "");

    if (path.endsWith("/data")) {
      const [
        positions, runs, reports, briefings, opportunities, score_events, snapshots,
        agents, tasks, approvals, alerts,
      ] = await Promise.all([
        q("it_positions?select=*&order=asset_class,name"),
        q("it_runs?select=*&order=started_at.desc&limit=30"),
        q("it_reports?select=*&order=created_at.desc&limit=200"),
        q("it_briefings?select=*&order=created_at.desc&limit=15"),
        q("it_opportunities?select=*&order=opened_at.desc&limit=200"),
        q("it_score_events?select=*&order=created_at.desc&limit=300"),
        q("it_snapshots?select=*&order=created_at.desc&limit=120"),
        q("it_agents?select=*&order=key"),
        q("it_tasks?select=*&order=started_at.desc&limit=150"),
        q("it_approvals?select=*&order=created_at.desc&limit=100"),
        q("it_alerts?select=*&status=eq.activa&order=created_at.desc"),
      ]);
      return json({
        positions, runs, reports, briefings, opportunities, score_events, snapshots,
        agents, tasks, approvals, alerts,
        generated_at: new Date().toISOString(),
      });
    }

    if (path.endsWith("/setup")) {
      const bres = await fetch(`${SB}/storage/v1/bucket`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ id: "panel", name: "panel", public: true }),
      });
      const bmsg = await bres.text();
      const rows = await q("it_settings?select=value&key=eq.panel_html&limit=1");
      const html = rows?.[0]?.value?.html;
      if (!html) return json({ error: "panel_html no encontrado" }, 500);
      const ures = await fetch(`${SB}/storage/v1/object/panel/${TOKEN}/index.html`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "text/html; charset=utf-8", "x-upsert": "true" },
        body: html,
      });
      const umsg = await ures.text();
      return json({ bucket: { status: bres.status, msg: bmsg }, upload: { status: ures.status, msg: umsg }, public_url: STORAGE_PUBLIC });
    }

    return withHeaders(SVG_SHELL, "image/svg+xml; charset=utf-8");
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
