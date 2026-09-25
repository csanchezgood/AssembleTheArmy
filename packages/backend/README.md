# @ata/backend

Lambdas de AssembleTheArmy (Node 22, ESM, TypeScript estricto). Contrato: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## Handlers (`src/handlers/<nombre>.ts` → `dist/<nombre>/index.mjs`, export `handler`)

| Handler | Trigger | Qué hace |
| --- | --- | --- |
| `webhook` | `POST /webhook/newrelic` | Valida `X-Webhook-Secret` (tiempo constante), normaliza el payload, deduplica con el lock `LOCK#system_id`, abre el incidente y arranca la máquina de estados. Publica la métrica EMF `AssembleTheArmy/ConfigErrors` / `ConfigErrors` (dimensión `Reason=no_roster`). |
| `graph-callback` | `POST /graph/callback?incident_id=` | Verifica el JWT de Bot Framework (JWKS remoto, `jose`), sincroniza participantes (`member_joined`/`member_left`) y maneja `state == terminated`. Responde 202 siempre que el token sea válido. |
| `resolve-roster` | Step Functions | Roster del equipo + disponibilidad + backups → `targets`. Lanza `NoEligibleMembers` si no queda nadie. |
| `join-room` | Step Functions | El bot se une a la sala (o reutiliza `room_call_id`). Error final `RoomJoinFailed`. |
| `invite-member` | Step Functions | Un timbre a un miembro. Nunca lanza salvo `RoomCallGone`. |
| `check-joined` | Step Functions | ¿Está el miembro en el roster del incidente? Refresca desde Graph si el roster tiene > 20 s. |
| `evaluate-outcome` | Step Functions | `connected` / `escalate` / `unanswered`; tarjetas a Teams (una vez por incidente) y SNS en `unanswered`. |
| `presence-monitor` | EventBridge Scheduler (1 min) | Cierra incidentes con sala vacía, `unanswered` vencidos y `convoking` huérfanos. |
| `admin-api` | `ANY /admin/{proxy+}` | CRUD de configuración, incidentes, auditoría y búsqueda de usuarios (ver 4.1 del contrato). |

Máquina de estados: `statemachine/convocation.asl.json` (placeholders Terraform: `${resolve_roster_arn}`, `${join_room_arn}`, `${invite_member_arn}`, `${check_joined_arn}`, `${evaluate_outcome_arn}`). `node scripts/validate-asl.mjs` la valida (también corre dentro de `npm test`).

## Estructura

- `src/domain/` — tipos y reglas puras (severidad → equipo, disponibilidad/backup/cascada, dedupe, outcome, auditoría, diff de participantes).
- `src/infra/` — DynamoDB (repositorios de las 5 tablas), Secrets Manager (caché 5 min), logger JSON (redacta secretos), env, métricas EMF, helpers HTTP.
- `src/graph/` — cliente de Microsoft Graph (token client-credentials cacheado, reintentos 429/5xx), verificación de notificaciones, tarjetas adaptativas.
- `src/services/` — wiring compartido entre handlers (contexto, sincronización de roster, cierre de incidentes).

## Comandos

```bash
npm run typecheck -w @ata/backend   # tsc --noEmit (src + tests)
npm test -w @ata/backend            # vitest (DynamoDB/SFN/SNS/Secrets con aws-sdk-client-mock, fetch mockeado)
npm run build -w @ata/backend       # esbuild → dist/<handler>/index.mjs (bundles autocontenidos, arm64/x86 indistinto)
```

## Notas de comportamiento

- Backup "de guardia" para un titular disponible: registro en `availability` con `status = available` y `backup_id` vigente en el instante de la alerta. Si el titular está `vacation`/`unavailable` se llama directamente al `backup_id` de ese registro.
- Atributos internos del incidente además de los del contrato: `participants_updated_at` (frescura del roster) y `notification_sent_at` (tarjetas enviadas una sola vez).
- `presence-monitor` usa `states:DescribeExecution` para detectar convocatorias huérfanas.
