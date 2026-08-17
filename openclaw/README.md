# Conectar OpenClaw con Investment Ops

Montaje completo del command center: OpenClaw ejecuta las rondas y escribe en Supabase,
el panel las pinta, y tú apruebas desde el navegador o desde WhatsApp.

```
   OpenClaw (tu máquina / VPS)                  Supabase                    Tú
   ┌───────────────────────┐         ┌──────────────────────┐      ┌──────────────┐
   │  cron 08:00           │         │  it-ops   (escritura)│      │  panel web   │
   │  skill investment-ops ├────────►│  it-panel (lectura)  │◄─────┤  índex.html  │
   │  WhatsApp / Telegram  │◄────────┤  tablas it_*         │      │  WhatsApp    │
   └───────────────────────┘         └──────────────────────┘      └──────────────┘
```

Nada de esto está desplegado todavía: este directorio y `supabase/` son el código listo
para aplicar cuando quieras.

## 1. Desplegar la parte de Supabase

```bash
supabase link --project-ref yukrbehehvjzacazckpl

# Token de LECTURA: el mismo que ya usan tus enlaces ?k=… (si lo cambias, dejan de abrir)
supabase secrets set IT_PANEL_TOKEN=<el token que ya usas hoy>

# Token de ESCRITURA: nuevo, largo y distinto del anterior
supabase secrets set IT_OPS_TOKEN=$(openssl rand -hex 32)

supabase db push                                     # crea it_agents, it_tasks, it_approvals, it_alerts
supabase functions deploy it-panel --no-verify-jwt   # ahora también sirve las tablas nuevas
supabase functions deploy it-ops   --no-verify-jwt   # API de escritura
```

Comprueba que responde:

```bash
curl -sS "$IT_OPS_URL/health" -H "x-ops-token: $IT_OPS_TOKEN"
# {"ok":true,"now":"…"}
```

Por qué dos tokens: el de lectura viaja en la URL del panel y acaba en el historial del
navegador y en cualquier sitio donde pegues el enlace. El de escritura solo vive en la
configuración de OpenClaw. Si el primero se filtra, alguien ve tu cartera; si fueran el
mismo, además podría escribir en ella.

## 2. Publicar el panel actualizado

El panel se sirve desde Storage a través de `it-panel`. La función `/setup` lo lee de la
tabla `it_settings` (clave `panel_html`), así que sube ahí el `index.html` nuevo y llama:

```bash
curl -sS "$IT_PANEL_URL/setup?k=$IT_PANEL_TOKEN"
```

Para poder **aprobar desde el navegador**, abre el panel una vez con las dos claves:

```
https://…/it-panel?k=<token_lectura>&w=<token_escritura>
```

Queda guardado en ese dispositivo. Sin `w=` el panel funciona igual pero la cola de
aprobaciones sale en modo solo lectura — que es exactamente lo que quieres en el móvil
si prefieres aprobar por WhatsApp.

## 3. Instalar la skill en OpenClaw

```bash
cp -r openclaw/skills/investment-ops ~/.openclaw/workspace/skills/
```

OpenClaw descubre las skills del workspace en `<workspace>/skills` (y con menor prioridad
en `~/.agents/skills` y el directorio gestionado). La skill declara en su frontmatter que
necesita `IT_OPS_URL` e `IT_OPS_TOKEN`: si no están, no se carga — es la comprobación que
evita que el agente lo intente a ciegas.

Variables de entorno del gateway:

```bash
export IT_OPS_URL="https://yukrbehehvjzacazckpl.supabase.co/functions/v1/it-ops"
export IT_OPS_TOKEN="<token de escritura>"
export IT_PANEL_URL="https://yukrbehehvjzacazckpl.supabase.co/functions/v1/it-panel"
export IT_PANEL_TOKEN="<token de lectura>"
```

Verifica que la ve:

```bash
openclaw skills list | grep investment-ops
```

## 4. Programar la ronda diaria

Con las Automations de OpenClaw, en lenguaje natural desde el propio chat:

> Todos los días laborables a las 08:00, ejecuta la ronda diaria de Investment Ops y
> mándame el briefing por aquí cuando termine.

OpenClaw crea la automatización y te confirma. Si prefieres cron explícito, la expresión
es `0 8 * * 1-5` (ojo: las automatizaciones se evalúan en UTC, así que en horario de
verano peninsular son las 06:00 UTC → `0 6 * * 1-5`).

Una segunda automatización útil, a media tarde:

> A las 18:00 de lunes a viernes, revisa si hay aprobaciones pendientes de más de 6 horas
> y recuérdamelas si las hay.

## 5. (Opcional) MCP de Supabase

La skill no lo necesita: escribe por HTTP contra `it-ops`, que es una superficie mínima y
validada. Si además quieres que el agente pueda consultar la base a pelo:

```bash
openclaw mcp add supabase \
  --command npx --arg -y --arg @supabase/mcp-server-supabase@latest \
  --arg --read-only --arg --project-ref=yukrbehehvjzacazckpl \
  --env SUPABASE_ACCESS_TOKEN=<tu_access_token>
openclaw mcp doctor --probe
```

Mantén el `--read-only`. Un access token personal sin esa bandera le da a un agente que
responde a mensajes de WhatsApp permisos para alterar el esquema de tu base de datos.

## Comprobación de extremo a extremo

Sin esperar a mañana, desde el chat de OpenClaw:

> Ejecuta una ronda de prueba de Investment Ops: solo Ledger, sin oportunidades.

Deberías ver, en menos de un minuto: Ledger en **Trabajando** con su tarea en curso, el
contador de tareas de hoy subiendo, y al acabar la ronda en el Registro con su informe.

## Qué hace cada endpoint

| Ruta | Para qué |
|---|---|
| `POST /run/start` · `/run/finish` | Abre y cierra la ronda |
| `POST /ping` | Latido de un agente (estado + tarea actual) |
| `POST /task/start` · `/task/finish` | Tarea individual; mueve el estado del agente solo |
| `POST /report` | Informe de un agente |
| `POST /briefing` | Briefing del jefe |
| `POST /opportunity` · `/opportunity/resolve` | Alta y cierre de oportunidades |
| `POST /score` | Puntos del marcador |
| `POST /snapshot` | Foto del valor de la cartera |
| `POST /approval` · `/approval/resolve` | Cola de aprobación |
| `POST /alert` · `/alert/resolve` | Banner de incidencias |
| `GET /agents` · `/approvals` · `/alerts` · `/health` | Lecturas rápidas para el chat |

Detalle de cada cuerpo: `supabase/functions/it-ops/index.ts` y la propia SKILL.md.
