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

## 1. La parte de Supabase · YA DESPLEGADA

Aplicado el 17/08/2026 en el proyecto `yukrbehehvjzacazckpl`:

- migración `command_center` → `it_agents` (con los 7 sembrados), `it_tasks`,
  `it_approvals`, `it_alerts`;
- `it-ops` v1 desplegada (nueva);
- `it-panel` v10 desplegada (sirve las tablas nuevas y añade `/publish`).

**De dónde salen los tokens.** No hay acceso a `supabase secrets` desde el entorno donde
se desplegó, así que ambos se leen de `it_settings`, que solo la service role puede tocar
— cerrado igual que un secreto. Si algún día prefieres variables de entorno, fíjalas y
mandan sobre la tabla, sin cambiar código:

```bash
supabase secrets set IT_PANEL_TOKEN=<token de lectura>
supabase secrets set IT_OPS_TOKEN=<token de escritura>
```

Por qué dos tokens distintos: el de lectura viaja en la URL del panel y acaba en el
historial del navegador y en cualquier sitio donde pegues el enlace. El de escritura solo
vive en la configuración de OpenClaw. Si el primero se filtra, alguien ve tu cartera; si
fueran el mismo, además podría escribir en ella.

Para volver a desplegar desde este repo:

```bash
supabase link --project-ref yukrbehehvjzacazckpl
supabase db push
supabase functions deploy it-panel --no-verify-jwt
supabase functions deploy it-ops   --no-verify-jwt
```

## 2. Publicar el panel

El panel se sirve desde Storage. La ruta `/publish` lo descarga del repo y lo deja
publicado, así que **git es la fuente de la verdad**: haces push y abres esta URL en el
navegador (es un GET, no hace falta terminal):

```
https://yukrbehehvjzacazckpl.supabase.co/functions/v1/it-panel/publish?k=<token_lectura>&ref=<rama>
```

`ref` es opcional y por defecto vale `main`. Mientras el Command Center viva en su rama,
usa `&ref=claude/openclaw-connection-m0flvs`.

Responde con el número de bytes publicados; si algo va mal, dice qué. La ruta `/setup`
antigua sigue existiendo y publica lo que haya guardado en `it_settings.panel_html`.

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

## Aviso: este repositorio es público

`marcferrando19/investment-ops` es público. No hay ningún token en el código —los dos
viven en `it_settings`— pero cualquiera puede leer el panel, el esquema y la skill. No
pegues aquí claves, ni el enlace `?k=…`, ni datos de la cartera. Si prefieres que no se
vea nada, ponlo en privado; lo único que dejaría de funcionar es `/publish`, que necesita
que `raw.githubusercontent.com` sirva el `index.html` sin autenticación.

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
