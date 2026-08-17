// it-ops · API de escritura del Command Center.
//
// Es la única puerta por la que OpenClaw escribe en Supabase. A propósito NO
// expone SQL ni la service role key: solo estas rutas, con el cuerpo validado.
// Si el agente se descarrilla, el daño máximo es insertar una fila fea.
//
// Auth: cabecera  x-ops-token: <IT_OPS_TOKEN>
// (token distinto del `k` de lectura del panel — ver openclaw/README.md)
//
// Desplegar:
//   supabase secrets set IT_OPS_TOKEN=<token largo aleatorio>
//   supabase functions deploy it-ops --no-verify-jwt

const TOKEN = Deno.env.get("IT_OPS_TOKEN") ?? "";
const SB = Deno.env.get("SUPABASE_URL") ?? "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BASE = SB + "/rest/v1/";
const AUTH = { apikey: SRK, Authorization: `Bearer ${SRK}` };

const AGENTS = ["acciones", "etfs", "renta_fija", "private_markets", "crypto", "datos", "jefe"];
const ASSET_CLASSES = ["acciones", "etfs", "renta_fija", "private_markets", "crypto", "cash", "otros"];

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, x-ops-token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "cache-control": "no-store",
    },
  });
}

/** Comparación en tiempo constante: no filtra el token carácter a carácter. */
function tokenOk(given: string): boolean {
  if (!TOKEN || given.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= given.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

class BadRequest extends Error {}

async function rest(path: string, init?: RequestInit) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { ...AUTH, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Inserta y devuelve la fila creada. */
async function insert(table: string, row: Record<string, unknown>) {
  const rows = await rest(table, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return rows?.[0] ?? null;
}

async function patch(table: string, filter: string, row: Record<string, unknown>) {
  const rows = await rest(`${table}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!rows?.length) throw new BadRequest(`No existe ninguna fila en ${table} que cumpla ${filter}`);
  return rows[0];
}

// ── validación de entrada ────────────────────────────────────────────────────
function str(body: Record<string, unknown>, field: string, required = true): string | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequest(`Falta el campo obligatorio "${field}"`);
    return undefined;
  }
  if (typeof v !== "string") throw new BadRequest(`"${field}" debe ser texto`);
  return v;
}

function num(body: Record<string, unknown>, field: string, required = false): number | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequest(`Falta el campo obligatorio "${field}"`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequest(`"${field}" debe ser un número`);
  return n;
}

function oneOf(value: string | undefined, allowed: string[], field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new BadRequest(`"${field}" debe ser uno de: ${allowed.join(", ")} (recibido: "${value}")`);
  }
  return value;
}

function agentOf(body: Record<string, unknown>): string {
  return oneOf(str(body, "agent"), AGENTS, "agent")!;
}

// ── rutas ────────────────────────────────────────────────────────────────────
type Handler = (body: Record<string, unknown>, url: URL) => Promise<unknown>;

const POST_ROUTES: Record<string, Handler> = {
  // Ronda ────────────────────────────────────────────────────────────────────
  "/run/start": async (b) => {
    const run = await insert("it_runs", {
      status: "running",
      trigger_type: str(b, "trigger_type", false) ?? "openclaw",
      summary: str(b, "summary", false) ?? null,
    });
    return { run_id: run.id, started_at: run.started_at };
  },

  "/run/finish": async (b) => {
    const run = await patch("it_runs", `id=eq.${str(b, "run_id")}`, {
      status: oneOf(str(b, "status", false), ["running", "completed", "failed"], "status") ?? "completed",
      summary: str(b, "summary", false) ?? null,
      finished_at: new Date().toISOString(),
    });
    return { run_id: run.id, status: run.status };
  },

  // Latido de agente ─────────────────────────────────────────────────────────
  "/ping": async (b) => {
    const agent = agentOf(b);
    const row = await patch("it_agents", `key=eq.${agent}`, {
      status: oneOf(str(b, "status", false), ["idle", "active", "error", "offline"], "status") ?? "active",
      current_task: str(b, "current_task", false) ?? null,
      last_ping_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { agent: row.key, status: row.status };
  },

  // Tareas ───────────────────────────────────────────────────────────────────
  "/task/start": async (b) => {
    const agent = agentOf(b);
    const title = str(b, "title")!;
    const task = await insert("it_tasks", {
      agent,
      title,
      run_id: str(b, "run_id", false) ?? null,
      status: "running",
    });
    // Un task/start implica que el agente está trabajando: ahorra un /ping.
    await patch("it_agents", `key=eq.${agent}`, {
      status: "active",
      current_task: title,
      last_ping_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { task_id: task.id };
  },

  "/task/finish": async (b) => {
    const task = await patch("it_tasks", `id=eq.${str(b, "task_id")}`, {
      status: oneOf(str(b, "status", false), ["running", "completed", "failed"], "status") ?? "completed",
      detail: str(b, "detail", false) ?? null,
      finished_at: new Date().toISOString(),
    });
    await patch("it_agents", `key=eq.${task.agent}`, {
      status: task.status === "failed" ? "error" : "idle",
      current_task: null,
      last_ping_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { task_id: task.id, status: task.status };
  },

  // Contenido ────────────────────────────────────────────────────────────────
  "/report": async (b) => {
    const row = await insert("it_reports", {
      agent: agentOf(b),
      title: str(b, "title"),
      content_md: str(b, "content_md"),
      run_id: str(b, "run_id", false) ?? null,
    });
    return { report_id: row.id };
  },

  "/briefing": async (b) => {
    const highlights = b.highlights ?? [];
    if (!Array.isArray(highlights)) throw new BadRequest('"highlights" debe ser una lista de textos');
    const row = await insert("it_briefings", {
      title: str(b, "title"),
      content_md: str(b, "content_md"),
      highlights,
      run_id: str(b, "run_id", false) ?? null,
    });
    return { briefing_id: row.id };
  },

  "/opportunity": async (b) => {
    const conviction = num(b, "conviction", false);
    if (conviction !== undefined && (conviction < 1 || conviction > 5)) {
      throw new BadRequest('"conviction" debe estar entre 1 y 5');
    }
    const row = await insert("it_opportunities", {
      agent: agentOf(b),
      asset_class: oneOf(str(b, "asset_class"), ASSET_CLASSES, "asset_class"),
      symbol: str(b, "symbol", false) ?? null,
      name: str(b, "name"),
      thesis: str(b, "thesis"),
      risks: str(b, "risks", false) ?? null,
      conviction: conviction ?? null,
      horizon: str(b, "horizon", false) ?? null,
      entry_ref_price: num(b, "entry_ref_price", false) ?? null,
      ref_currency: str(b, "ref_currency", false) ?? "USD",
      run_id: str(b, "run_id", false) ?? null,
      status: "abierta",
    });
    return { opportunity_id: row.id };
  },

  "/opportunity/resolve": async (b) => {
    const status = oneOf(str(b, "status"), ["abierta", "acierto", "error", "caducada"], "status")!;
    const row = await patch("it_opportunities", `id=eq.${str(b, "id")}`, {
      status,
      outcome_note: str(b, "outcome_note", false) ?? null,
      closed_at: status === "abierta" ? null : new Date().toISOString(),
    });
    return { opportunity_id: row.id, status: row.status };
  },

  "/score": async (b) => {
    const row = await insert("it_score_events", {
      agent: agentOf(b),
      delta: Math.trunc(num(b, "delta", true)!),
      reason: str(b, "reason"),
      run_id: str(b, "run_id", false) ?? null,
    });
    return { score_event_id: row.id };
  },

  "/snapshot": async (b) => {
    const by_class = b.by_class ?? {};
    if (typeof by_class !== "object" || Array.isArray(by_class)) {
      throw new BadRequest('"by_class" debe ser un objeto {clase: valor}');
    }
    const row = await insert("it_snapshots", {
      total_value: num(b, "total_value", true),
      by_class,
      currency: str(b, "currency", false) ?? "EUR",
      run_id: str(b, "run_id", false) ?? null,
    });
    return { snapshot_id: row.id };
  },

  // Cola de aprobación ───────────────────────────────────────────────────────
  "/approval": async (b) => {
    const row = await insert("it_approvals", {
      agent: agentOf(b),
      kind: str(b, "kind", false) ?? "propuesta",
      priority: oneOf(str(b, "priority", false), ["alta", "media", "baja"], "priority") ?? "media",
      title: str(b, "title"),
      detail_md: str(b, "detail_md", false) ?? null,
      payload: b.payload ?? {},
      expires_at: str(b, "expires_at", false) ?? null,
      run_id: str(b, "run_id", false) ?? null,
      status: "pendiente",
    });
    return { approval_id: row.id };
  },

  "/approval/resolve": async (b) => {
    const status = oneOf(str(b, "status"), ["aprobada", "rechazada", "caducada"], "status")!;
    const row = await patch("it_approvals", `id=eq.${str(b, "id")}&status=eq.pendiente`, {
      status,
      resolution_note: str(b, "note", false) ?? null,
      resolved_at: new Date().toISOString(),
    });
    return { approval_id: row.id, status: row.status };
  },

  // Avisos ───────────────────────────────────────────────────────────────────
  "/alert": async (b) => {
    const row = await rest("it_alerts?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify({
        key: str(b, "key"),
        level: oneOf(str(b, "level", false), ["info", "aviso", "critica"], "level") ?? "aviso",
        message: str(b, "message"),
        action_hint: str(b, "action_hint", false) ?? null,
        status: "activa",
        updated_at: new Date().toISOString(),
        resolved_at: null,
      }),
    });
    return { alert_id: row?.[0]?.id };
  },

  "/alert/resolve": async (b) => {
    const row = await patch("it_alerts", `key=eq.${str(b, "key")}`, {
      status: "resuelta",
      updated_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    });
    return { alert_id: row.id, status: row.status };
  },
};

const GET_ROUTES: Record<string, Handler> = {
  // Lo que OpenClaw necesita leer para decidir. El panel completo sigue en it-panel.
  "/approvals": async (_b, url) => {
    const status = oneOf(url.searchParams.get("status") ?? "pendiente",
      ["pendiente", "aprobada", "rechazada", "caducada"], "status");
    return await rest(`it_approvals?select=*&status=eq.${status}&order=created_at.desc&limit=50`);
  },

  "/agents": async () => await rest("it_agents?select=*&order=key"),

  "/alerts": async () => await rest("it_alerts?select=*&status=eq.activa&order=created_at.desc"),

  "/health": async () => ({ ok: true, now: new Date().toISOString() }),
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  if (!TOKEN) {
    return json({ error: "IT_OPS_TOKEN no está configurado en la función" }, 500);
  }
  const given = req.headers.get("x-ops-token") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tokenOk(given)) return json({ error: "No autorizado" }, 401);

  const url = new URL(req.url);
  // La ruta llega como /it-ops/<algo>; nos quedamos con lo que va detrás.
  const path = url.pathname.replace(/^\/it-ops/, "").replace(/\/+$/, "") || "/health";

  try {
    if (req.method === "GET") {
      const handler = GET_ROUTES[path];
      if (!handler) return json({ error: `Ruta GET desconocida: ${path}`, rutas: Object.keys(GET_ROUTES) }, 404);
      return json(await handler({}, url));
    }

    if (req.method === "POST") {
      const handler = POST_ROUTES[path];
      if (!handler) return json({ error: `Ruta POST desconocida: ${path}`, rutas: Object.keys(POST_ROUTES) }, 404);
      let body: Record<string, unknown> = {};
      const raw = await req.text();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new BadRequest("El cuerpo debe ser JSON válido");
        }
      }
      return json(await handler(body, url));
    }

    return json({ error: `Método no permitido: ${req.method}` }, 405);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: String(e.message) }, 400);
    return json({ error: String(e) }, 500);
  }
});
