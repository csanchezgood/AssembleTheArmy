# Arquitectura técnica — AssembleTheArmy

Contrato de implementación derivado de [ESPECIFICACION.md](./ESPECIFICACION.md).
Todo lo que está aquí es vinculante para los tres bloques del repo
(`packages/backend`, `packages/admin-web`, `infra/terraform`): nombres de
tablas, claves, variables de entorno, rutas HTTP, placeholders de la máquina
de estados y contratos de entrada/salida de cada Lambda.

Stack: TypeScript (Node 22 en Lambda), AWS serverless (API Gateway HTTP API,
Lambda, Step Functions Standard, DynamoDB, Secrets Manager, EventBridge
Scheduler, SNS, CloudWatch), Terraform ≥ 1.6, Microsoft Graph cloud
communications API, panel React + MSAL (SSO Entra ID).

Prefijo de todos los recursos AWS: `${project}-${env}-` (por defecto `ata-dev-`).

---

## 1. Vista general

```
New Relic ──POST /webhook/newrelic──▶ Lambda webhook
                                         │ (dedupe + lock por sistema)
                                         ▼
                              Step Functions "convocation"
   ResolveRoster ─▶ JoinRoom ─▶ Map(por slot: Invite ─▶ Wait ─▶ CheckJoined ─▶ ...) ─▶ EvaluateOutcome ─▶ (escalar → ResolveRoster | fin)
                                         │
Microsoft Graph ◀── invitaciones / roster ──┘
      │
      └──POST /graph/callback──▶ Lambda graph-callback ──▶ incidents.participants
EventBridge (cada 1 min) ──▶ Lambda presence-monitor ──▶ cierra incidentes con 0 participantes
Panel admin (S3+CloudFront, MSAL) ──▶ /admin/* (JWT authorizer Entra) ──▶ Lambda admin-api
```

Mecanismo de "llamar": el bot **se une a la sala fija del equipo** (reunión de
Teams persistente) y **invita** a cada miembro con
`POST /communications/calls/{id}/participants/invite`. Teams hace timbrar
todos los dispositivos del usuario como llamada entrante de reunión; al
aceptar, el usuario ya está dentro de la sala. "Conectado" se comprueba en el
roster de participantes de esa llamada (notificaciones de Graph + consulta
directa), no en el hecho de contestar.

---

## 2. Tablas DynamoDB

Todas: `PAY_PER_REQUEST`, cifrado con clave administrada por AWS, PITR
activado. Nombres inyectados por variables de entorno (sección 4).

### 2.1 `roster` — equipos_guardia (env `ROSTER_TABLE`)

| Clave | Tipo | Ejemplo |
| --- | --- | --- |
| PK `system_id` | S | `payments-api` (= `system_tag` de New Relic, minúsculas) |
| SK `roster_key` | S | `N2#003#7f1c…` = `${team_id}#${priority_order zero-pad 3}#${member_id}` |

Atributos: `team_id` (`N2`|`N3`), `priority_order` (N), `member_id` (Entra
object id), `member_upn`, `member_name`, `room_join_url` (URL "Join" de la
reunión persistente del equipo — la `sala_teams_id` de la spec),
`updated_at`, `updated_by`.

GSI `by_member`: PK `member_id`, SK `system_id`.

### 2.2 `availability` — disponibilidad (env `AVAILABILITY_TABLE`)

| Clave | Tipo |
| --- | --- |
| PK `member_id` | S |
| SK `valid_from` | S (ISO 8601 UTC) |

Atributos: `status` (`available`|`vacation`|`unavailable`), `valid_until`
(ISO 8601 UTC), `backup_id`, `backup_upn`, `backup_name`, `note`,
`updated_at`, `updated_by`.

Regla: un miembro está **no disponible** en el instante `t` si existe un
registro con `status != available` y `valid_from <= t < valid_until`. Si está
no disponible se llama **directamente al backup** (sin intentar al titular).
Si el backup también está no disponible en `t`, el slot se descarta y se pasa
al siguiente del roster (cascada). No se resuelve backup del backup.

### 2.3 `severity_rules` — severidad_equipo (env `SEVERITY_TABLE`)

| Clave | Tipo |
| --- | --- |
| PK `severity` | S (minúsculas: `critical`, `high`, `warning`) |

Atributos: `team_id` (equipo convocado), `escalate_to_team_id` (opcional),
`escalate_after_minutes` (N, opcional; tope de tiempo del ciclo del primer
equipo antes de escalar), `notify_webhook_urls` (lista de URLs de Workflows /
Incoming Webhook de Teams a las que se envía una tarjeta informativa, p. ej.
"Critical → N3 + notificación a N2"), `enabled` (BOOL; si `false` la alerta
solo se audita), `updated_at`, `updated_by`.

### 2.4 `incidents` — registro de incidentes (env `INCIDENTS_TABLE`)

| Clave | Tipo |
| --- | --- |
| PK `pk` | S: `INC#${incident_id}` o `LOCK#${system_id}` |
| SK `sk` | S: `META` |

Item `INC#…/META` (incidente):
`incident_id` (ULID), `system_id`, `severity`, `team_id` (equipo actual),
`initial_team_id`, `status` (`convoking`|`connected`|`unanswered`|`closed`),
`monitor_name`, `condition_name`, `opened_at`, `closed_at`, `room_join_url`,
`room_call_id` (id de la llamada del bot en Graph), `bot_participant_id`,
`participants` (lista `{ id, display_name, joined_at }` de humanos
actualmente en la sala, sin el bot), `participant_count` (N),
`ever_connected` (BOOL), `execution_arn`, `escalation_count` (N),
`last_alert_at`, `echo_count` (N), `close_reason`.

Item `LOCK#${system_id}/META` (lock de deduplicación): `incident_id`,
`created_at`, `ttl` (epoch s, 24 h de seguridad). Se crea con
`ConditionExpression attribute_not_exists(pk)` al abrir el incidente y se
borra al cerrarlo. Es lo que hace idempotente al webhook ante reintentos de
New Relic y alertas eco.

GSI `by_system`: PK `system_id`, SK `opened_at` (solo items `INC#`).
GSI `by_status`: PK `status`, SK `opened_at` (para el monitor de presencia y
el panel).

### 2.5 `audit` — auditoría inmutable (env `AUDIT_TABLE`)

| Clave | Tipo |
| --- | --- |
| PK `incident_id` | S (`INC` id, o `SYSTEM#${system_id}` para eventos sin incidente, o `ADMIN`) |
| SK `event_key` | S: `${ts ISO}#${ulid}` |

Atributos: `ts`, `event_type`, `actor` (`system`|`graph`|`sfn`|
`admin:${upn}`), `system_id`, `details` (map libre), `ttl` (opcional,
retención 400 días).

Tipos de evento mínimos: `alert_received`, `alert_ignored` (estado ≠ open o
severidad deshabilitada), `alert_echo`, `incident_opened`,
`roster_resolved`, `backup_substituted`, `member_skipped_unavailable`,
`room_joined`, `invite_sent`, `invite_failed`, `member_joined`,
`member_left`, `slot_exhausted`, `team_escalated`, `notification_sent`,
`convocation_connected`, `convocation_unanswered`, `incident_closed`,
`graph_error`, `config_changed`.

La política IAM de las Lambdas solo permite `dynamodb:PutItem` y `Query` sobre
esta tabla (nunca `UpdateItem`/`DeleteItem`): inmutabilidad por permisos.

---

## 3. Lambdas (`packages/backend`)

Runtime `nodejs22.x`, arquitectura `arm64`, `handler = index.handler`, ESM.
Cada handler se bundlea con esbuild a `packages/backend/dist/<nombre>/index.mjs`
(Terraform lo empaqueta con `archive_file`). Nombres de función:
`${prefix}<nombre>`.

| Nombre | Trigger | Descripción |
| --- | --- | --- |
| `webhook` | HTTP API `POST /webhook/newrelic` | Valida secreto, parsea payload, dedupe, abre incidente, arranca la máquina de estados. |
| `graph-callback` | HTTP API `POST /graph/callback` | Valida JWT de Bot Framework, actualiza roster/estado del incidente según notificaciones de Graph. Responde 202 siempre que el token sea válido. |
| `resolve-roster` | Step Functions | Resuelve equipo, sala, miembros, disponibilidad y backups. |
| `join-room` | Step Functions | El bot se une a la sala del equipo (o reutiliza `room_call_id` si ya está dentro). |
| `invite-member` | Step Functions | Invita a un usuario a la llamada de la sala (un intento de timbre). |
| `check-joined` | Step Functions | Comprueba si el usuario está en el roster del incidente; consulta Graph si el roster está viejo (> 20 s). |
| `evaluate-outcome` | Step Functions | Cierra el ciclo del equipo: decide `connected` / `escalate` / `unanswered`, envía notificaciones (webhooks de Teams, SNS). |
| `presence-monitor` | EventBridge Scheduler `rate(1 minute)` | Para cada incidente `convoking`/`connected`: consulta participantes en Graph; si `ever_connected` y 0 humanos → cierra incidente, bot abandona la sala, borra lock. También cierra incidentes `unanswered` con más de `UNANSWERED_TTL_MINUTES` y `convoking` huérfanos (ejecución SFN terminada). |
| `admin-api` | HTTP API `ANY /admin/{proxy+}` (JWT authorizer) | CRUD de configuración + consulta de incidentes/auditoría + búsqueda de usuarios en Graph. |

### 3.1 Payload del webhook de New Relic

Plantilla custom del Workflow de New Relic (documentar en README):

```json
{
  "system_tag": "payments-api",
  "severity": "critical",
  "monitor_name": "Payments API - error rate",
  "condition_name": "Error rate > 5% for 5 min",
  "current_state": "open",
  "timestamp": "2026-09-24T18:03:11Z",
  "issue_id": "opcional",
  "issue_url": "opcional"
}
```

Reglas del handler `webhook`:

1. Header `X-Webhook-Secret` debe coincidir (comparación en tiempo constante)
   con el secreto en `WEBHOOK_SECRET_ARN` (JSON `{ "secret": "…" }`). Si no →
   401 sin cuerpo. Sin body válido → 400.
2. `system_tag` se normaliza a minúsculas/trim → `system_id`. `severity` en
   minúsculas.
3. `current_state != "open"` → audita `alert_ignored` (`SYSTEM#…`), 200.
4. Sin regla en `severity_rules` o `enabled=false` → `alert_ignored`, 200.
5. Sin filas en `roster` para `system_id` + `team_id` → `alert_ignored` con
   motivo `no_roster`, 200 (y métrica/alarma: es un error de configuración).
6. Lock `LOCK#system_id` existe → cargar incidente:
   - `convoking` → eco (`alert_echo`, `echo_count++`, `last_alert_at`), 200.
   - `connected` → consulta participantes en Graph; si ≥ 1 humano → eco;
     si 0 → cierra el incidente anterior (`close_reason = empty_on_new_alert`),
     borra lock y continúa como nueva convocatoria.
   - `unanswered` / `closed` (lock huérfano) → borra lock y continúa.
7. Nueva convocatoria: `PutItem` del lock con condición; si falla la
   condición (carrera con otro reintento) → tratar como eco. Crear item de
   incidente (`status=convoking`), auditar `incident_opened`, `StartExecution`
   de `STATE_MACHINE_ARN` con `name = incident_id` (idempotente) e input:

```json
{
  "incident_id": "01J…",
  "system_id": "payments-api",
  "severity": "critical",
  "team_id": "N3",
  "escalation_count": 0,
  "policy": { "max_attempts": 5, "ring_timeout_seconds": 45, "max_escalations": 1 }
}
```

Respuesta 200 JSON: `{ "result": "convoked"|"echo"|"ignored", "incident_id"?: "…", "reason"?: "…" }`.

### 3.2 Contratos de las tareas de Step Functions

**resolve-roster** — input: el input de la máquina (+ `room_call_id` si es
una escalación). Output:

```json
{
  "incident_id": "…", "system_id": "…", "severity": "…", "team_id": "N3",
  "room_join_url": "https://teams.microsoft.com/l/meetup-join/…",
  "targets": [
    { "slot": 1, "member": { "id": "oid", "upn": "a@x.com", "name": "Ana" },
      "backup": { "id": "oid2", "upn": "b@x.com", "name": "Beto" } | null,
      "substituted": false }
  ],
  "escalate_to_team_id": "N3" | null,
  "escalate_after_minutes": 10 | null,
  "notify_webhook_urls": ["…"],
  "cycle_started_at": "ISO"
}
```

`targets` ya viene con la sustitución aplicada: si el titular no está
disponible, `member` es el backup y `substituted=true`, `backup=null`. Si
ambos no disponibles el slot no aparece (auditado). Si `targets` queda vacío
la tarea lanza el error `NoEligibleMembers` (la máquina lo captura y pasa a
`EvaluateOutcome`).

**join-room** — input: `{ incident_id, room_join_url }`. Output:
`{ room_call_id, bot_participant_id }`. Guarda ambos en el incidente. Si el
incidente ya tiene `room_call_id` y la llamada sigue viva en Graph, lo
reutiliza. Reintentos: 3 con backoff (configurados en la ASL). Error final →
`RoomJoinFailed`.

**invite-member** — input:
`{ incident_id, room_call_id, member: {id, upn, name}, slot, attempt, using_backup }`.
Output: `{ invited: true|false, error?: "…" }`. Nunca lanza por fallo de Graph
(lo audita como `invite_failed` y devuelve `invited=false`) salvo si la
llamada de la sala ya no existe → error `RoomCallGone`.

**check-joined** — input:
`{ incident_id, room_call_id, member: {…}, slot, attempt, cycle_started_at, escalate_after_minutes }`.
Output: `{ joined: bool, elapsed_minutes: number, time_exceeded: bool }`.

**evaluate-outcome** — input: output del Map (`slot_results: [{slot, member, outcome: "joined"|"exhausted"|"timed_out"|"error"}]`)
más `incident_id`, `team_id`, `escalation_count`, `policy`,
`escalate_to_team_id`, `notify_webhook_urls`, `severity`, `system_id`.
Output: `{ outcome: "connected"|"escalate"|"unanswered", next_team_id?: "…", escalation_count: n }`.
Reglas: ≥ 1 `joined` → `connected` (status `connected`, `ever_connected=true`).
0 `joined` y `escalate_to_team_id` y `escalation_count < policy.max_escalations`
→ `escalate` (audita `team_escalated`, actualiza `team_id` del incidente).
Si no → `unanswered` (status `unanswered`, publica en SNS `ALERTS_TOPIC_ARN`
con resumen; pendiente de escalamiento humano según spec). Siempre envía las
tarjetas a `notify_webhook_urls` (una sola vez por incidente, con
`notification_sent`).

### 3.3 Máquina de estados `convocation`

Definición en `packages/backend/statemachine/convocation.asl.json`, tipo
Standard, JSONPath + funciones intrínsecas. Terraform la carga con
`templatefile()`; **placeholders obligatorios**:
`${resolve_roster_arn}`, `${join_room_arn}`, `${invite_member_arn}`,
`${check_joined_arn}`, `${evaluate_outcome_arn}`. No usar ningún otro `${…}`
(escapar con `$${` si hace falta un literal).

Estados:

1. `ResolveRoster` (Task, Retry 2× en errores de servicio, Catch
   `NoEligibleMembers` → `EvaluateOutcome` con `slot_results=[]`).
2. `JoinRoom` (Task, Retry 3× backoff 2, Catch → `EvaluateOutcome` como
   `unanswered` con `error`).
3. `ConvokeTeam` (Map sobre `$.targets`, `MaxConcurrency: 0`, ItemSelector con
   `incident_id`, `room_call_id`, `policy`, `cycle_started_at`,
   `escalate_after_minutes`). Iterador:
   - `InitSlot` (Pass): `current = member`, `attempt = 1`, `using_backup = substituted`.
   - `Invite` (Task) → `WaitRing` (Wait `SecondsPath $.policy.ring_timeout_seconds`)
     → `CheckJoined` (Task) → `Decide` (Choice):
     - `joined == true` → `SlotJoined` (Pass, outcome `joined`).
     - `time_exceeded == true` → `SlotTimedOut` (outcome `timed_out`).
     - `attempt < policy.max_attempts` → `NextAttempt` (Pass, `attempt+1` con
       `States.MathAdd`) → `Invite`.
     - `backup != null && using_backup == false` → `SwitchToBackup` (Pass:
       `current = backup`, `using_backup = true`, `attempt = 1`) → `Invite`.
     - si no → `SlotExhausted` (outcome `exhausted`).
   - Catch genérico del iterador → outcome `error`.
   ResultPath `$.slot_results`.
4. `EvaluateOutcome` (Task).
5. `Escalate?` (Choice): `outcome == "escalate"` → `PrepareEscalation` (Pass:
   `team_id = next_team_id`, `escalation_count = escalation_count`) →
   `ResolveRoster`; si no → `Done` (Succeed).

Timeout global de la ejecución: 2 horas.

### 3.4 Integración con Microsoft Graph (`src/graph/`)

- Token: `POST https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`,
  client credentials en el body, scope `https://graph.microsoft.com/.default`.
  Secreto en `GRAPH_SECRET_ARN` (JSON `{ "clientSecret": "…" }`). Cachear el
  token en memoria del contenedor hasta 5 min antes de expirar.
- Parseo del `room_join_url`: extraer `threadId`
  (`19:meeting_…@thread.v2`, URL-decodificado), `organizerId` (`Oid`) y
  `tenantId` (`Tid`) del parámetro `context`.
- Unirse a la sala: `POST /communications/calls` con `@odata.type
  #microsoft.graph.call`, `callbackUri = ${GRAPH_CALLBACK_URL}?incident_id=…`,
  `requestedModalities: ["audio"]`, `mediaConfig serviceHostedMediaConfig`,
  `chatInfo { threadId, messageId: "0" }`, `meetingInfo organizerMeetingInfo
  { organizer.user { id, tenantId } }`, `tenantId`. Esperar hasta 30 s
  (polling `GET /communications/calls/{id}` cada 2 s) a `state == established`.
- Invitar: `POST /communications/calls/{id}/participants/invite` con un
  `invitationParticipantInfo` cuyo `identity.user.id` es el oid y
  `clientContext` = uuid.
- Participantes: `GET /communications/calls/{id}/participants`. Un humano
  cuenta si `info.identity.user` existe, `isInLobby == false` y su id ≠ el
  del bot (`info.identity.application`).
- Salir: `DELETE /communications/calls/{id}` (404 = ya no existe, no es error).
- Errores 429/5xx: reintento con backoff exponencial (3 intentos) en el
  cliente. 4xx restantes: error permanente.
- Notificaciones (`graph-callback`): body `{ value: [ { changeType, resource,
  resourceUrl, resourceData } ] }`. `incident_id` llega en la query string del
  `callbackUri`. Validar `Authorization: Bearer` con JWKS de
  `https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration`, issuer
  `https://api.botframework.com`, audience `GRAPH_CLIENT_ID` (lib `jose`).
  Manejar: `…/participants` (roster completo → recalcular `participants`,
  auditar `member_joined`/`member_left` por diferencia) y `…/calls/{id}` con
  `state == terminated` (bot expulsado o reunión terminada →
  `room_call_id = null`; si `ever_connected` cerrar incidente).
- Permisos de aplicación necesarios: `Calls.JoinGroupCall.All`,
  `Calls.InitiateGroupCall.All`, `Calls.Initiate.All`, `User.Read.All`.

### 3.5 Variables de entorno

Comunes: `PROJECT`, `ENV`, `ROSTER_TABLE`, `AVAILABILITY_TABLE`,
`SEVERITY_TABLE`, `INCIDENTS_TABLE`, `AUDIT_TABLE`, `LOG_LEVEL`.
Graph (todas las que lo usan): `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_SECRET_ARN`, `GRAPH_CALLBACK_URL`, `GRAPH_BASE_URL`
(default `https://graph.microsoft.com/v1.0`), `GRAPH_LOGIN_BASE_URL` (default
`https://login.microsoftonline.com`).
`webhook`: `WEBHOOK_SECRET_ARN`, `STATE_MACHINE_ARN`, `MAX_ATTEMPTS` (5),
`RING_TIMEOUT_SECONDS` (45), `MAX_ESCALATIONS` (1).
`evaluate-outcome`, `presence-monitor`: `ALERTS_TOPIC_ARN`.
`presence-monitor`: `UNANSWERED_TTL_MINUTES` (60).
`admin-api`: `ADMIN_GROUP_ID` (grupo de Entra autorizado; vacío = cualquier
usuario autenticado), `ADMIN_ALLOWED_ORIGIN` (CORS).

---

## 4. API HTTP (API Gateway HTTP API, un solo API)

| Ruta | Auth | Lambda |
| --- | --- | --- |
| `POST /webhook/newrelic` | header `X-Webhook-Secret` (en Lambda) | `webhook` |
| `POST /graph/callback` | JWT Bot Framework (en Lambda) | `graph-callback` |
| `ANY /admin/{proxy+}` | JWT authorizer de API Gateway: issuer `https://login.microsoftonline.com/${entra_tenant_id}/v2.0`, audience `[admin_api_audience]` | `admin-api` |

Throttling por defecto del stage: 20 rps / burst 50. CORS del API:
origin = URL del panel (CloudFront) + `http://localhost:5173` en dev, headers
`authorization, content-type`, métodos `GET,PUT,POST,DELETE,OPTIONS`.

### 4.1 Contrato del admin-api

Todas las respuestas JSON. Errores: `{ "error": "mensaje" }` con 400/403/404.
El Lambda verifica además que el claim `groups` (o `roles`) del JWT contenga
`ADMIN_GROUP_ID` si está definido; si no → 403. Todas las escrituras auditan
`config_changed` en `audit` (`incident_id = "ADMIN"`, `actor = admin:<upn>`).

| Método y ruta | Cuerpo / query | Respuesta |
| --- | --- | --- |
| `GET /admin/me` | — | `{ upn, name, is_admin }` |
| `GET /admin/systems` | — | `{ systems: [{ system_id, teams: ["N2","N3"], member_count }] }` |
| `GET /admin/roster?system_id=` | — | `{ items: RosterItem[] }` (ordenados por team, priority) |
| `PUT /admin/roster` | `RosterItem` sin `roster_key`/`updated_*` | `{ item }` (upsert) |
| `DELETE /admin/roster?system_id=&roster_key=` | — | `{ ok: true }` |
| `GET /admin/availability?member_id=` (opcional; sin él lista todo con `Scan`) | — | `{ items: AvailabilityItem[] }` |
| `PUT /admin/availability` | `AvailabilityItem` | `{ item }` |
| `DELETE /admin/availability?member_id=&valid_from=` | — | `{ ok: true }` |
| `GET /admin/severity-rules` | — | `{ items: SeverityRule[] }` |
| `PUT /admin/severity-rules` | `SeverityRule` | `{ item }` |
| `DELETE /admin/severity-rules?severity=` | — | `{ ok: true }` |
| `GET /admin/incidents?system_id=&status=&limit=50&cursor=` | — | `{ items: Incident[], cursor? }` (más recientes primero) |
| `GET /admin/incidents/{incident_id}` | — | `{ incident, events: AuditEvent[] }` |
| `GET /admin/users?search=ana` | — | `{ users: [{ id, upn, name }] }` (Graph `/users?$search`) |
| `GET /admin/audit?incident_id=ADMIN&limit=` | — | `{ items: AuditEvent[] }` |

Tipos (los define `packages/backend/src/domain/types.ts` y el panel los
replica en `packages/admin-web/src/api/types.ts`):

```ts
type TeamId = 'N2' | 'N3';
interface Member { id: string; upn: string; name: string }
interface RosterItem { system_id: string; roster_key: string; team_id: TeamId; priority_order: number;
  member_id: string; member_upn: string; member_name: string; room_join_url: string;
  updated_at: string; updated_by: string }
interface AvailabilityItem { member_id: string; valid_from: string; valid_until: string;
  status: 'available' | 'vacation' | 'unavailable'; backup_id?: string; backup_upn?: string;
  backup_name?: string; note?: string; updated_at: string; updated_by: string }
interface SeverityRule { severity: string; team_id: TeamId; escalate_to_team_id?: TeamId;
  escalate_after_minutes?: number; notify_webhook_urls: string[]; enabled: boolean;
  updated_at: string; updated_by: string }
interface Incident { incident_id: string; system_id: string; severity: string; team_id: TeamId;
  initial_team_id: TeamId; status: 'convoking' | 'connected' | 'unanswered' | 'closed';
  monitor_name?: string; condition_name?: string; opened_at: string; closed_at?: string;
  room_join_url: string; room_call_id?: string; participants: { id: string; display_name: string; joined_at: string }[];
  participant_count: number; ever_connected: boolean; execution_arn?: string;
  escalation_count: number; last_alert_at: string; echo_count: number; close_reason?: string }
interface AuditEvent { incident_id: string; event_key: string; ts: string; event_type: string;
  actor: string; system_id?: string; details: Record<string, unknown> }
```

---

## 5. Panel de administración (`packages/admin-web`)

Vite + React 18 + TypeScript + `@azure/msal-react`. Idioma de la UI: español.
Sin librería de componentes pesada (CSS propio, accesible, responsive).

- Configuración en runtime desde `/config.json` (lo genera Terraform y lo sube
  a S3): `{ "tenantId", "clientId", "apiBaseUrl", "apiScope" }`.
  `apiScope` = `api://<admin_api_client_id>/access_as_user` (o el client id
  del SPA si el API usa el mismo registro).
- Login con redirect; token de acceso para `apiScope` en cada llamada
  (`Authorization: Bearer`).
- Páginas: **Sistemas y guardias** (roster por sistema, alta/edición con
  selector de usuario que busca en `/admin/users`), **Disponibilidad**
  (marcar vacaciones con rango y backup), **Reglas de severidad**,
  **Incidentes** (lista con filtros; detalle con línea de tiempo de
  auditoría y participantes).
- Hosting: S3 privado + CloudFront (OAC), SPA fallback 403/404 → `index.html`.

---

## 6. Terraform (`infra/terraform`)

Un root module con submódulos locales: `dynamodb`, `secrets`, `lambda`
(genérico, uno por función), `api`, `stepfunctions`, `scheduler`,
`notifications` (SNS + alarmas), `admin_site`.

Variables (con `terraform.tfvars.example`): `project` (`ata`), `env`
(`dev`), `aws_region`, `entra_tenant_id`, `graph_client_id`,
`admin_spa_client_id`, `admin_api_audience`, `admin_api_scope`,
`admin_group_id` (opcional), `alert_email`, `max_attempts` (5),
`ring_timeout_seconds` (45), `max_escalations` (1),
`unanswered_ttl_minutes` (60), `log_retention_days` (90), `extra_cors_origins`
(lista, default `["http://localhost:5173"]`).

Los **valores** de los secretos no se gestionan con Terraform: se crean los
recursos `aws_secretsmanager_secret` vacíos (`${prefix}graph-client-secret`,
`${prefix}webhook-secret`) y el README explica cómo cargar el valor con
`aws secretsmanager put-secret-value`.

Outputs: `webhook_url`, `graph_callback_url`, `admin_url`, `admin_api_url`,
`state_machine_arn`, `graph_secret_arn`, `webhook_secret_arn`,
`alerts_topic_arn`, `admin_bucket`, `cloudfront_distribution_id`.

Alarmas CloudWatch (acción: `alerts_topic`): errores > 0 en 5 min de cada
Lambda, ejecuciones fallidas/timeout de la máquina de estados, 5xx del API,
y `no_roster` (métrica custom `AssembleTheArmy/ConfigErrors` publicada por
`webhook` vía EMF).

IAM: un rol por Lambda con exactamente las acciones que usa (tabla por tabla;
`audit` solo `PutItem`+`Query`; secreto por secreto; `states:StartExecution`
solo para `webhook`; `sns:Publish` solo para `evaluate-outcome` y
`presence-monitor`).

---

## 7. Flujo de build y despliegue

```
npm install
npm run build          # backend → packages/backend/dist/<fn>/index.mjs ; admin-web → packages/admin-web/dist
npm test
cd infra/terraform && terraform init && terraform apply
# cargar secretos, subir config.json del panel (script infra/scripts/deploy-admin.sh)
```

Ver README.md para los pasos de Entra ID / Azure Bot / New Relic.
