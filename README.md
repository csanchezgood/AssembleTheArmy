# AssembleTheArmy

Sistema de convocatoria automática de equipos N2/N3 por alertas. Ante una
alerta de New Relic en cualquiera de los sistemas productivos configurados,
el sistema decide el equipo según la severidad, resuelve disponibilidad y
backups, y **llama en paralelo** a cada miembro en Microsoft Teams hasta que
se una a la sala de acción del equipo. Las alertas eco se suprimen mientras
haya gente conectada, y la sala se libera cuando queda vacía.

Es un sistema **determinístico y auditable** (webhook + máquina de estados +
integraciones), no un agente de IA. Especificación funcional completa en
[docs/ESPECIFICACION.md](docs/ESPECIFICACION.md); contrato técnico en
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Cómo funciona

```
New Relic ─▶ POST /webhook/newrelic ─▶ Lambda webhook (secreto, dedupe, lock por sistema)
                                            │
                                            ▼
                     Step Functions "convocation" (Standard)
   ResolveRoster ─▶ JoinRoom ─▶ Map por miembro: Invite ─▶ Wait ─▶ CheckJoined ─▶ reintento / backup
                                            │
                                            ▼
                     EvaluateOutcome: connected | escalate (N2 ─▶ N3) | unanswered (SNS)
Graph ─▶ POST /graph/callback (roster de la sala) ─▶ incidents.participants
EventBridge cada minuto ─▶ presence-monitor ─▶ cierra incidentes con 0 participantes
Panel admin (React + SSO Entra) ─▶ /admin/* ─▶ configuración e historial de incidentes
```

- **Llamar** = el bot se une a la sala fija del equipo (reunión persistente
  de Teams) e **invita** al usuario. Teams hace timbrar todos sus dispositivos
  como llamada entrante de reunión. Al aceptar, ya está dentro de la sala.
- **Conectado** = el usuario aparece en el roster de participantes de la
  sala. Contestar sin unirse no cuenta.
- **Reintentos**: en paralelo a todos los miembros elegibles, 5 intentos por
  miembro; si no se une, se pasa a su backup. Si el titular figura no
  disponible se llama directamente al backup.
- **Eco**: mientras exista un incidente activo del mismo sistema con
  participantes, cualquier alerta adicional se registra y no convoca.
- **Cierre**: cuando la sala llega a 0 participantes el incidente se cierra y
  el sistema queda listo para una nueva convocatoria.

## Estructura del repositorio

| Ruta | Contenido |
| --- | --- |
| `packages/backend` | Lambdas (TypeScript, Node 22), lógica de negocio, cliente de Microsoft Graph, definición de la máquina de estados, tests |
| `packages/admin-web` | Panel de administración (Vite + React + MSAL) |
| `infra/terraform` | Infraestructura AWS (API Gateway, Lambda, Step Functions, DynamoDB, Secrets Manager, EventBridge, SNS, CloudWatch, S3 + CloudFront) |
| `infra/scripts` | Scripts de despliegue del panel y carga de secretos |
| `docs` | Especificación y arquitectura |

## Requisitos

- Node.js ≥ 22 y npm ≥ 10
- Terraform ≥ 1.6 y AWS CLI v2 con credenciales de la cuenta destino
- Un tenant de Microsoft 365 con permisos para registrar aplicaciones y un
  administrador que conceda consentimiento (ruta crítica del proyecto, ver
  abajo)
- Una cuenta de New Relic con permisos para crear Workflows y canales

## Puesta en marcha rápida (desarrollo local)

```bash
npm install
npm run typecheck
npm test
npm run build

# Panel admin con datos simulados, sin Azure ni AWS
cd packages/admin-web && VITE_MOCK_API=1 npm run dev
```

## Despliegue

### 1. Registro en Microsoft Entra ID y Azure Bot (ruta crítica)

Hazlo en paralelo al resto: el consentimiento de administrador puede tardar
días.

1. **App registration del bot** (Entra ID → App registrations → New, single
   tenant). Anota *Tenant ID* y *Application (client) ID*. Crea un client
   secret. Este es `graph_client_id` en Terraform.
2. **Permisos de aplicación** de Microsoft Graph (Application, no
   Delegated) y *Grant admin consent*:
   `Calls.JoinGroupCall.All`, `Calls.InitiateGroupCall.All`,
   `Calls.Initiate.All`, `User.Read.All`.
3. **Azure Bot**: crea un recurso *Azure Bot* usando ese app id. En
   *Channels* agrega *Microsoft Teams*, pestaña *Calling*: habilita llamadas y
   pon como webhook la salida `graph_callback_url` de Terraform
   (`https://<api>/graph/callback`).
4. **Salas fijas por equipo**: con una cuenta de servicio, crea una reunión
   de Teams persistente por equipo (por ejemplo "Sala N3 - Pagos") sin fecha
   de fin cercana, con la opción de lobby *Everyone bypasses the lobby*.
   Copia el enlace "Join" (`https://teams.microsoft.com/l/meetup-join/...`);
   es el `room_join_url` que se configura en el panel.
5. **App registration del panel** (SPA): plataforma *Single-page
   application*, redirect URIs `https://<cloudfront>/` y
   `http://localhost:5173/`. En *Expose an API* define el scope
   `access_as_user`; el identificador `api://<client id>` es
   `admin_api_audience`, y `api://<client id>/access_as_user` es
   `admin_api_scope`. Opcionalmente restringe con un grupo de seguridad
   (`admin_group_id`) y habilita el claim `groups` en *Token configuration*.
6. **Piloto técnico** antes de todo lo demás: con el bot registrado, ejecuta
   una llamada de prueba a un usuario interno y confirma que timbra en su
   móvil. La spec lo marca como el mayor riesgo del proyecto.

### 2. Infraestructura en AWS

```bash
npm run build                                  # genera los bundles de las Lambdas y el panel
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # completa tenant, client ids, correo de alertas
terraform init
terraform apply

../scripts/set-secrets.sh                      # carga el client secret de Graph y el secreto del webhook
../scripts/deploy-admin.sh                     # sube el panel a S3 y publica config.json
terraform output                               # webhook_url, graph_callback_url, admin_url
```

Confirma la suscripción de correo de SNS que llega a `alert_email`.

### 3. Configuración inicial en el panel

Entra a `admin_url` con tu cuenta corporativa y carga:

- **Reglas de severidad**: `critical → N3` (con URL de notificación a N2 si
  aplica), `high → N2` con escalamiento a N3 tras X minutos, `warning → N2`.
- **Sistemas y guardias**: por cada uno de los sistemas, los miembros N2 y N3
  con su orden de prioridad y la sala del equipo.
- **Disponibilidad**: vacaciones y backups con rango de fechas.

### 4. Workflow en New Relic

1. Crea un canal de tipo **Webhook** con la URL `webhook_url` y el header
   `X-Webhook-Secret: <secreto del webhook>`.
2. Crea un **Workflow** que use ese canal y define esta plantilla de payload
   (Handlebars):

```json
{
  "system_tag": "{{ accumulations.tag.system.[0] }}",
  "severity": "{{ priority }}",
  "monitor_name": "{{ accumulations.conditionName.[0] }}",
  "condition_name": "{{ issueTitle }}",
  "current_state": "{{ state }}",
  "timestamp": "{{ createdAt }}",
  "issue_id": "{{ id }}",
  "issue_url": "{{ issuePageUrl }}"
}
```

3. Cada entidad monitoreada debe llevar el tag `system` con el mismo valor
   que `system_id` en el panel (en minúsculas). Solo `current_state = open`
   convoca; los cierres y acuses se auditan pero no llaman a nadie.

## Operación

- Toda decisión queda en la tabla `audit` (inmutable por IAM) y es visible
  en el detalle del incidente en el panel.
- Si se agota la lista completa de guardia + backups sin respuesta, el
  incidente queda en `unanswered` y se publica un aviso en el tópico SNS
  (correo). El escalamiento humano posterior está pendiente de definición,
  como indica la spec.
- Alarmas de CloudWatch (errores de Lambdas, fallos de la máquina de
  estados, 5xx del API, sistemas sin roster) también notifican al tópico.
- Para forzar el cierre de un incidente, basta con que la sala quede vacía;
  el monitor de presencia lo cierra en el siguiente minuto.

## Fuera de alcance en v1

Integración con talento humano para disponibilidad, escalamiento fuera de
N2/N3, más canales de alertas, dashboards de métricas. Ver la especificación.
