// it-ops · API de escritura del Command Center.
//
// Es la única puerta por la que OpenClaw escribe en Supabase. A propósito NO
// expone SQL ni la service role key: solo estas rutas, con el cuerpo validado.
// Si el agente se descarrilla, el daño máximo es insertar una fila fea.
//
// Auth: cabecera  x-ops-token: <token de escritura>
// (token distinto del `k` de lectura del panel — ver openclaw/README.md)
//
// El token se busca, por orden: la variable de entorno IT_OPS_TOKEN, y si no,
// la fila `ops_token` de it_settings, que solo la service role puede leer.

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

/** Token de escritura, cacheado un minuto para no consultar en cada petición. */
let cached: { value: string; at: number } | null = null;
async function opsToken(): Promise<string> {
  const fromEnv = Deno.env.get("IT_OPS_TOKEN");
  if (fromEnv) return fromEnv;
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const rows = await rest("it_settings?select=value&key=eq.ops_token&limit=1");
  const value = rows?.[0]?.value?.token ?? "";
  cached = { value, at: Date.now() };
  return value;
}

/** Comparación en tiempo constante: no filtra el token carácter a carácter. */
function tokenOk(given: string, expected: string): boolean {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(body: Record<string, unknown>, field: string, required = true): string | undefined {
  const v = str(body, field, required);
  if (v === undefined) return undefined;
  if (!UUID_RE.test(v)) throw new BadRequest(`"${field}" no es un identificador válido`);
  return v;
}

/** Filtro PostgREST con el valor escapado: un "&" en el valor no puede añadir parámetros. */
const eq = (col: string, val: string) => `${col}=eq.${encodeURIComponent(val)}`;

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
    const run = await patch("it_runs", eq("id", uuid(b, "run_id")!), {
      status: oneOf(str(b, "status", false), ["running", "completed", "failed"], "status") ?? "completed",
      summary: str(b, "summary", false) ?? null,
      finished_at: new Date().toISOString(),
    });
    return { run_id: run.id, status: run.status };
  },

  // Latido de agente ─────────────────────────────────────────────────────────
  "/ping": async (b) => {
    const agent = agentOf(b);
    const row = await patch("it_agents", eq("key", agent), {
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
      run_id: uuid(b, "run_id", false) ?? null,
      status: "running",
    });
    // Un task/start implica que el agente está trabajando: ahorra un /ping.
    await patch("it_agents", eq("key", agent), {
      status: "active",
      current_task: title,
      last_ping_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { task_id: task.id };
  },

  "/task/finish": async (b) => {
    const task = await patch("it_tasks", eq("id", uuid(b, "task_id")!), {
      status: oneOf(str(b, "status", false), ["running", "completed", "failed"], "status") ?? "completed",
      detail: str(b, "detail", false) ?? null,
      finished_at: new Date().toISOString(),
    });
    await patch("it_agents", eq("key", task.agent), {
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
      run_id: uuid(b, "run_id", false) ?? null,
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
      run_id: uuid(b, "run_id", false) ?? null,
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
      target_price: num(b, "target_price", false) ?? null,
      target_pct: num(b, "target_pct", false) ?? null,
      deadline: str(b, "deadline", false) ?? null,
      run_id: uuid(b, "run_id", false) ?? null,
      status: "abierta",
    });
    return { opportunity_id: row.id };
  },

  // Registra el precio actual de una oportunidad abierta (y, si hace falta, completa
  // objetivo/plazo de las heredadas). Así el panel pinta "precio actual" y el avance
  // hacia el objetivo sin esperar a que se resuelva. Por símbolo, actualiza todas las
  // abiertas de ese símbolo (el precio de mercado es el mismo para todas).
  "/opportunity/track": async (b) => {
    const id = str(b, "id", false);
    const symbol = str(b, "symbol", false);
    if (!id && !symbol) throw new BadRequest('Indica "id" o "symbol" de la oportunidad');
    const fila: Record<string, unknown> = {};
    const lp = num(b, "last_price", false);
    if (lp !== undefined) { fila.last_price = lp; fila.last_price_at = new Date().toISOString(); }
    const tp = num(b, "target_price", false);
    if (tp !== undefined) fila.target_price = tp;
    const tpct = num(b, "target_pct", false);
    if (tpct !== undefined) fila.target_pct = tpct;
    const dl = str(b, "deadline", false);
    if (dl !== undefined) fila.deadline = dl;
    if (Object.keys(fila).length === 0) {
      throw new BadRequest('Nada que actualizar: indica "last_price", "target_price", "target_pct" o "deadline"');
    }
    const filtro = id ? eq("id", uuid(b, "id")!) : eq("symbol", symbol!) + "&status=eq.abierta";
    const row = await patch("it_opportunities", filtro, fila);
    return { opportunity_id: row.id, last_price: row.last_price, target_price: row.target_price, deadline: row.deadline };
  },

  "/opportunity/resolve": async (b) => {
    const status = oneOf(str(b, "status"), ["abierta", "acierto", "error", "caducada"], "status")!;
    const row = await patch("it_opportunities", eq("id", uuid(b, "id")!), {
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
      run_id: uuid(b, "run_id", false) ?? null,
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
      run_id: uuid(b, "run_id", false) ?? null,
    });
    return { snapshot_id: row.id };
  },

  // Cartera ──────────────────────────────────────────────────────────────────
  // Solo precio y valor. Cantidad, precio de compra, nombre y clase NO se tocan
  // desde aquí a propósito: un agente no debe poder reescribir la cartera.
  "/position/price": async (b) => {
    const id = str(b, "id", false);
    const symbol = str(b, "symbol", false);
    if (!id && !symbol) throw new BadRequest('Indica "id" o "symbol" de la posición');
    const filtro = id ? eq("id", uuid(b, "id")!) : eq("symbol", symbol!);
    const precio = num(b, "current_price", false);
    const valor = num(b, "current_value", false);
    if (precio === undefined && valor === undefined) {
      throw new BadRequest('Indica al menos "current_price" o "current_value"');
    }
    const fila: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (precio !== undefined) fila.current_price = precio;
    if (valor !== undefined) fila.current_value = valor;
    const row = await patch("it_positions", filtro, fila);
    return { position_id: row.id, name: row.name, current_price: row.current_price, current_value: row.current_value };
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
      run_id: uuid(b, "run_id", false) ?? null,
      status: "pendiente",
    });
    return { approval_id: row.id };
  },

  "/approval/resolve": async (b) => {
    const status = oneOf(str(b, "status"), ["aprobada", "rechazada", "caducada"], "status")!;
    const row = await patch("it_approvals", eq("id", uuid(b, "id")!) + "&status=eq.pendiente", {
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
    const row = await patch("it_alerts", eq("key", str(b, "key")!), {
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
    return await rest(`it_approvals?select=*&status=eq.${encodeURIComponent(status!)}&order=created_at.desc&limit=50`);
  },

  "/agents": async () => await rest("it_agents?select=*&order=key"),

  // Lo que necesita Ledger para valorar la cartera sin tocar SQL.
  "/positions": async () => await rest("it_positions?select=*&order=asset_class,name"),

  // Plan de aportación mensual (it_settings.plan_mensual).
  "/plan": async () => {
    const rows = await rest("it_settings?select=value&key=eq.plan_mensual&limit=1");
    return rows?.[0]?.value ?? {};
  },

  // Oportunidades vivas: para no duplicar ideas y para que Nexus las resuelva.
  "/opportunities": async (_b, url) => {
    const status = oneOf(url.searchParams.get("status") ?? "abierta",
      ["abierta", "acierto", "error", "caducada"], "status");
    return await rest(
      `it_opportunities?select=id,agent,asset_class,symbol,name,thesis,conviction,horizon,entry_ref_price,ref_currency,opened_at` +
      `&status=eq.${encodeURIComponent(status!)}&order=opened_at.desc&limit=100`,
    );
  },

  "/alerts": async () => await rest("it_alerts?select=*&status=eq.activa&order=created_at.desc"),

  "/health": async () => ({ ok: true, now: new Date().toISOString() }),
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  let expected: string;
  try {
    expected = await opsToken();
  } catch (e) {
    return json({ error: `No se pudo leer el token de escritura: ${e}` }, 500);
  }
  if (!expected) {
    return json({ error: "No hay token de escritura configurado (it_settings.ops_token)" }, 500);
  }
  const given = req.headers.get("x-ops-token") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tokenOk(given, expected)) return json({ error: "No autorizado" }, 401);

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
