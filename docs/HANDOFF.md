# Handoff — estado al 2026-09-25

Punto de retorno para retomar el proyecto. Contexto completo en
[README.md](../README.md), [ARCHITECTURE.md](./ARCHITECTURE.md) y
[ESPECIFICACION.md](./ESPECIFICACION.md).

## Estado

| Bloque | Estado |
| --- | --- |
| Backend (`packages/backend`) | Completo. 9 Lambdas, máquina de estados, 89 tests en verde. |
| Panel (`packages/admin-web`) | Completo. 29 tests en verde. Modo simulado con `VITE_MOCK_API=1`. |
| Terraform (`infra/terraform`) | Completo. 96 recursos aplicados en `dev`. |
| CI (`.github/workflows/ci.yml`) | Activo en cada push a `main`. |
| Entorno `dev` en AWS | Desplegado en la cuenta 826990194949, región us-east-2, con **valores provisionales de Entra**. |
| Integración real con Teams | **Pendiente**: requiere registro en Entra, Azure Bot y consentimiento de administrador. |

Último commit en `main`: "Sistema de convocatoria automática N2/N3 por alertas".

## Entorno dev desplegado

| Recurso | Valor |
| --- | --- |
| Webhook New Relic | `https://9f01s99kc5.execute-api.us-east-2.amazonaws.com/webhook/newrelic` |
| Callback Azure Bot | `https://9f01s99kc5.execute-api.us-east-2.amazonaws.com/graph/callback` |
| Panel | `https://d3ov8uiq258qsf.cloudfront.net` |
| Máquina de estados | `arn:aws:states:us-east-2:826990194949:stateMachine:ata-dev-convocation` |
| Secreto webhook | `ata-dev-webhook-secret` (valor real aleatorio ya cargado) |
| Secreto Graph | `ata-dev-graph-client-secret` (placeholder, hay que cargar el real) |

Prueba de humo realizada: alerta simulada a `demo-api` → incidente abierto →
segunda alerta tratada como eco → ejecución completa → incidente `unanswered`
(Graph rechazó el token, esperado con credenciales provisionales).

Datos de demostración en DynamoDB que hay que borrar antes del uso real:
regla `critical → N3` en `ata-dev-severity-rules` y la fila `demo-api` /
`N3#001#33333333-…` en `ata-dev-roster`.

## Riesgo a resolver primero al retomar

**El estado de Terraform es local** (`infra/terraform/terraform.tfstate`,
ignorado por git, solo existe en la máquina donde se desplegó). Si se pierde,
Terraform no podrá gestionar los recursos ya creados. Al retomar, migrar el
estado a S3 antes de cualquier otro `apply`:

1. Crear un bucket S3 con versionado y una tabla DynamoDB de bloqueo (o
   usar `use_lockfile`).
2. Copiar `backend.tf.example` a `backend.tf` con esos nombres.
3. `terraform init -migrate-state`.

## Cómo retomar

```bash
cd war_room/AssembleTheArmy
export PATH=$HOME/.local/share/mise/installs/node/lts/bin:/opt/homebrew/bin:$PATH
npm install && npm run typecheck && npm test && npm run build

aws login                          # perfil default (sesión de consola)
cd infra/terraform
# Terraform no entiende las sesiones de `aws login`; usar el perfil envoltorio:
AWS_PROFILE=harness-tf terraform plan
```

`terraform.tfvars` no está en git. Contenido actual (todo provisional):

```hcl
project             = "ata"
env                 = "dev"
aws_region          = "us-east-2"
entra_tenant_id     = "common"
graph_client_id     = "00000000-0000-0000-0000-000000000001"
admin_spa_client_id = "00000000-0000-0000-0000-000000000002"
admin_api_audience  = "api://00000000-0000-0000-0000-000000000002"
admin_api_scope     = "api://00000000-0000-0000-0000-000000000002/access_as_user"
admin_group_id      = ""
alert_email         = ""
```

## Pendientes, en orden

1. **Registro en Microsoft Entra y Azure Bot** (ruta crítica, ver README
   sección "Despliegue → 1"): app del bot con permisos de aplicación
   `Calls.JoinGroupCall.All`, `Calls.InitiateGroupCall.All`,
   `Calls.Initiate.All`, `User.Read.All` y consentimiento de administrador;
   Azure Bot con canal Teams y llamadas habilitadas apuntando al callback de
   arriba; app del panel (SPA) con scope `access_as_user`; salas fijas por
   equipo con lobby abierto.
2. **Piloto técnico**: una llamada de prueba a un usuario interno y confirmar
   que timbra en el móvil, antes de configurar los 20 sistemas.
3. **Valores reales en `terraform.tfvars`** (`entra_tenant_id`,
   `graph_client_id`, `admin_spa_client_id`, audience/scope, `alert_email`,
   opcional `admin_group_id`) → `AWS_PROFILE=harness-tf terraform apply` →
   `infra/scripts/set-secrets.sh` (client secret real) →
   `infra/scripts/deploy-admin.sh`. Confirmar la suscripción de correo de SNS.
4. **Workflow en New Relic** con el payload de la sección "Despliegue → 4" del
   README y el header `X-Webhook-Secret`. Acordar con el equipo de monitoreo el
   tag `system` de cada uno de los 20 sistemas.
5. **Cargar configuración real** en el panel (reglas de severidad, guardias
   por sistema, disponibilidad) y borrar los datos de demostración.
6. **Definiciones abiertas de la spec**: escalamiento humano cuando se agota
   la lista completa (hoy: aviso por SNS); valores definitivos de la tabla
   severidad → equipo.

## Decisiones tomadas durante la implementación

- Mecanismo de llamada: el bot se une a la sala fija del equipo e **invita**
  al usuario (`participants/invite`), lo que hace timbrar sus dispositivos.
  "Conectado" se comprueba en el roster de participantes de la sala.
- Deduplicación: lock `LOCK#<sistema>` en la tabla de incidentes con
  escritura condicional; una alerta durante `convoking` es eco; durante
  `connected` se consulta a Graph y, si la sala está vacía, se reabre.
- Backup de un titular disponible: se toma de un registro de disponibilidad
  con `status = available` y `backup_id` (la spec no lo definía).
- Auditoría inmutable por IAM: las Lambdas solo tienen `PutItem` y `Query`
  sobre la tabla `audit`.
- Correo de alertas opcional y sin concurrencia reservada en el monitor de
  presencia (la cuenta no tiene cuota para reservarla; el cierre es
  idempotente).
- El estado por incidente (participantes, ejecución) vive en DynamoDB; no hay
  estado en memoria entre invocaciones.
