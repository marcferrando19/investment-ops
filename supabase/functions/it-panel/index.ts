// it-panel · API de lectura del panel (y servidor del propio HTML).
//
// Versión desplegada anteriormente + las cuatro tablas del Command Center
// (it_agents, it_tasks, it_approvals, it_alerts).
//
// El token de lectura ya no va incrustado en el código. Se busca, por orden:
//   1. la variable de entorno IT_PANEL_TOKEN (si algún día la fijas con
//      `supabase secrets set`, manda sobre todo lo demás);
//   2. la fila `panel_token` de it_settings, que solo la service role puede leer.
// El valor sembrado es el mismo de siempre, así que los enlaces ?k=… no cambian.

const SB = Deno.env.get("SUPABASE_URL") ?? "";
const BASE = SB + "/rest/v1/";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const AUTH = { apikey: SRK, Authorization: `Bearer ${SRK}` };

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

async function q(path: string) {
  const r = await fetch(BASE + path, { headers: AUTH });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Token de lectura, cacheado un minuto para no consultar en cada petición. */
let cached: { value: string; at: number } | null = null;
async function panelToken(): Promise<string> {
  const fromEnv = Deno.env.get("IT_PANEL_TOKEN");
  if (fromEnv) return fromEnv;
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const rows = await q("it_settings?select=value&key=eq.panel_token&limit=1");
  const value = rows?.[0]?.value?.token ?? "";
  cached = { value, at: Date.now() };
  return value;
}

const storageUrl = (token: string) => `${SB}/storage/v1/object/public/panel/${token}/index.html`;

const svgShell = (token: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 800 600">\n<title>Investment Ops</title>\n<rect width="100%" height="100%" fill="#0d0d0d"/>\n<text id="m" x="400" y="300" text-anchor="middle" fill="#898781" font-family="system-ui, sans-serif" font-size="14" letter-spacing="3">CARGANDO INVESTMENT OPS…</text>\n<script>//<![CDATA[\nfetch("${storageUrl(token)}",{cache:"no-store"}).then(function(r){\n  if(!r.ok){throw new Error("HTTP "+r.status);}\n  return r.text();\n}).then(function(t){\n  var b=new Blob([t],{type:"text/html"});\n  location.replace(URL.createObjectURL(b));\n}).catch(function(e){\n  var m=document.getElementById("m");\n  if(m){m.textContent="ERROR CARGANDO EL PANEL: "+e.message;}\n});\n//]]></script>\n</svg>`;

const REPO = "marcferrando19/investment-ops";

/**
 * Descarga el index.html del repo probando varias fuentes.
 * Las funciones edge salen por IPs compartidas, así que raw.githubusercontent
 * devuelve 429 con facilidad; jsDelivr y la API de GitHub tienen otros límites.
 * Una rama con "/" en el nombre solo viaja limpia por la API (va en query).
 */
async function descargarPanel(
  ref: string,
): Promise<{ html: string; src: string } | { error: string; intentos: string[] }> {
  const fuentes = [
    { url: `https://raw.githubusercontent.com/${REPO}/${ref}/index.html`, headers: {} as Record<string, string> },
    {
      url: `https://api.github.com/repos/${REPO}/contents/index.html?ref=${encodeURIComponent(ref)}`,
      headers: { accept: "application/vnd.github.raw" },
    },
    { url: `https://cdn.jsdelivr.net/gh/${REPO}@${ref}/index.html`, headers: {} as Record<string, string> },
  ];

  const intentos: string[] = [];
  for (const f of fuentes) {
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      if (vuelta) await new Promise((r) => setTimeout(r, 700));
      try {
        const res = await fetch(f.url, {
          headers: { "user-agent": "investment-ops-panel", "cache-control": "no-cache", ...f.headers },
        });
        if (!res.ok) {
          intentos.push(`${f.url} → HTTP ${res.status}`);
          // 4xx que no sea 429 no mejora reintentando.
          if (res.status !== 429 && res.status < 500) break;
          continue;
        }
        const html = await res.text();
        if (!html.includes("</html>")) {
          intentos.push(`${f.url} → no parece el panel (falta </html>)`);
          break;
        }
        return { html, src: f.url };
      } catch (e) {
        intentos.push(`${f.url} → ${e}`);
      }
    }
  }
  return { error: "Ninguna fuente devolvió el panel. Reintenta en un minuto.", intentos };
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return withHeaders("ok", "text/plain");

    const TOKEN = await panelToken();
    if (!TOKEN) return json({ error: "No hay token de panel configurado (it_settings.panel_token)" }, 500);

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

    // /publish · trae el panel del repo (público) y lo deja publicado.
    // Así el HTML de git es la fuente de la verdad: git push + abrir esta URL.
    if (path.endsWith("/publish")) {
      const ref = (url.searchParams.get("ref") ?? "main").trim();
      if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(ref)) {
        return json({ error: "El parámetro ref tiene caracteres no permitidos" }, 400);
      }
      const fuente = await descargarPanel(ref);
      if ("error" in fuente) return json({ error: fuente.error, intentos: fuente.intentos }, 502);
      const { html, src } = fuente;

      await fetch(`${BASE}it_settings?on_conflict=key`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: "panel_html", value: { html }, updated_at: new Date().toISOString() }),
      });

      await fetch(`${SB}/storage/v1/bucket`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ id: "panel", name: "panel", public: true }),
      });
      const ures = await fetch(`${SB}/storage/v1/object/panel/${TOKEN}/index.html`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "text/html; charset=utf-8", "x-upsert": "true" },
        body: html,
      });
      return json({
        publicado: ures.ok,
        desde: src,
        bytes: html.length,
        upload: { status: ures.status, msg: await ures.text() },
      }, ures.ok ? 200 : 500);
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
      return json({
        bucket: { status: bres.status, msg: bmsg },
        upload: { status: ures.status, msg: umsg },
        public_url: storageUrl(TOKEN),
        bytes: html.length,
      });
    }

    return withHeaders(svgShell(TOKEN), "image/svg+xml; charset=utf-8");
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
