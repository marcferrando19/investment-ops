-- Command Center: estado vivo de los agentes, cola de aprobación y avisos.
--
-- Añade cuatro tablas sobre el esquema it_* existente. No modifica ni borra nada
-- de lo que ya hay (it_runs, it_reports, it_briefings, it_opportunities,
-- it_score_events, it_positions, it_snapshots).
--
-- Igual que el resto del esquema: RLS activado y sin políticas, de modo que solo
-- la service role (es decir, las edge functions it-panel e it-ops) puede leer y
-- escribir. Las claves anon/publishable no ven nada.

-- ─────────────────────────────────────────────────────────────────────────────
-- it_agents · una fila por agente, con su estado en tiempo real
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.it_agents (
  key           text primary key
                check (key in ('acciones','etfs','renta_fija','private_markets','crypto','datos','jefe')),
  name          text not null,
  role          text not null,
  status        text not null default 'idle'
                check (status in ('idle','active','error','offline')),
  current_task  text,
  last_ping_at  timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.it_agents enable row level security;

insert into public.it_agents (key, name, role) values
  ('acciones',        'Aegis',  'Especialista en Acciones'),
  ('etfs',            'Vector', 'Especialista en ETFs'),
  ('renta_fija',      'Atlas',  'Renta Fija · Bonos'),
  ('private_markets', 'Umbra',  'Private Markets'),
  ('crypto',          'Cipher', 'Especialista en Crypto'),
  ('datos',           'Ledger', 'Datos de Cartera (solo lectura)'),
  ('jefe',            'Nexus',  'Jefe de Equipo · CIO')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- it_tasks · unidad de trabajo individual dentro de una ronda
-- Alimenta el contador "tareas hoy" y el feed de completadas del panel.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.it_tasks (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.it_runs(id) on delete set null,
  agent       text not null
              check (agent in ('acciones','etfs','renta_fija','private_markets','crypto','datos','jefe')),
  title       text not null,
  status      text not null default 'running'
              check (status in ('running','completed','failed')),
  detail      text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.it_tasks enable row level security;

create index if not exists it_tasks_started_idx on public.it_tasks (started_at desc);
create index if not exists it_tasks_agent_idx   on public.it_tasks (agent, started_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- it_approvals · cola de "esperando tu visto bueno"
-- El agente propone, tú apruebas o rechazas (desde el panel o desde WhatsApp).
-- payload guarda lo que el agente necesita para ejecutar si lo apruebas.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.it_approvals (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references public.it_runs(id) on delete set null,
  agent           text not null
                  check (agent in ('acciones','etfs','renta_fija','private_markets','crypto','datos','jefe')),
  kind            text not null default 'propuesta',
  priority        text not null default 'media'
                  check (priority in ('alta','media','baja')),
  title           text not null,
  detail_md       text,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pendiente'
                  check (status in ('pendiente','aprobada','rechazada','caducada')),
  resolution_note text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  resolved_at     timestamptz
);

alter table public.it_approvals enable row level security;

create index if not exists it_approvals_status_idx on public.it_approvals (status, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- it_alerts · banner de incidencias (fuente caída, credencial caducada…)
-- key es única: reabrir la misma incidencia actualiza la fila en vez de duplicar.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.it_alerts (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  level       text not null default 'aviso'
              check (level in ('info','aviso','critica')),
  message     text not null,
  action_hint text,
  status      text not null default 'activa'
              check (status in ('activa','resuelta')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.it_alerts enable row level security;

create index if not exists it_alerts_status_idx on public.it_alerts (status, created_at desc);
