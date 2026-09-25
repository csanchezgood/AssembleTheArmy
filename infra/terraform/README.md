# Infraestructura AWS — AssembleTheArmy

Root module de Terraform que despliega todo el sistema de convocatoria
(API HTTP, Lambdas, Step Functions, DynamoDB, Secrets Manager, EventBridge
Scheduler, SNS + alarmas y el sitio estático del panel). Es la implementación
de la sección 6 de [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

Prefijo de todos los recursos: `${project}-${env}-` (por defecto `ata-dev-`).

## Prerrequisitos

- Terraform >= 1.6 y AWS CLI v2 con credenciales de la cuenta destino.
- `jq` (lo usan los scripts de `infra/scripts/`).
- Node 22: los bundles de las Lambdas deben existir antes de `plan`/`apply`
  (`packages/backend/dist/<función>/index.mjs`) y la definición de la máquina
  de estados (`packages/backend/statemachine/convocation.asl.json`).
- En Entra ID: registro del bot (Graph, permisos `Calls.JoinGroupCall.All`,
  `Calls.InitiateGroupCall.All`, `Calls.Initiate.All`, `User.Read.All`),
  registro del panel (SPA) y registro/expuesto del API de administración con
  el scope `access_as_user`. El API debe emitir tokens **v2.0**
  (`accessTokenAcceptedVersion = 2`) porque el authorizer valida el issuer
  `https://login.microsoftonline.com/<tenant>/v2.0`.

## Despliegue

```bash
# 1. Build de los bundles (desde la raíz del repo)
npm install && npm run build

# 2. Variables
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # editar valores
# (opcional) estado remoto: cp backend.tf.example backend.tf y editar

# 3. Terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Tras el primer `apply`:

1. Confirmar la suscripción de correo que envía SNS a `alert_email`.
2. Cargar los secretos (ver abajo).
3. Publicar el panel (ver abajo).
4. Registrar en Entra el `admin_url` como redirect URI del SPA y en Azure Bot
   la `graph_callback_url` como *Calling webhook*.
5. Configurar en New Relic un destino webhook con la `webhook_url` y el header
   `X-Webhook-Secret`.

## Secretos

Terraform crea los contenedores vacíos; los valores nunca pasan por el estado.

```bash
infra/scripts/set-secrets.sh        # interactivo (read -s)
```

o manualmente:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw graph_secret_arn)" \
  --secret-string '{"clientSecret":"<client secret del bot>"}'

aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw webhook_secret_arn)" \
  --secret-string '{"secret":"<valor del header X-Webhook-Secret>"}'
```

## Publicar el panel de administración

```bash
npm run build -w packages/admin-web
infra/scripts/deploy-admin.sh
```

El script genera `packages/admin-web/dist/config.json`
(`{ tenantId, clientId, apiBaseUrl, apiScope }`) a partir de los outputs y de
`terraform.tfvars` (o `TF_VAR_entra_tenant_id`, `TF_VAR_admin_spa_client_id`,
`TF_VAR_admin_api_scope`), sincroniza `dist/` al bucket `admin_bucket` y crea
una invalidación de CloudFront.

## Outputs útiles

`terraform output` muestra `webhook_url`, `graph_callback_url`, `admin_url`,
`admin_api_url`, `state_machine_arn`, `graph_secret_arn`,
`webhook_secret_arn`, `alerts_topic_arn`, `admin_bucket` y
`cloudfront_distribution_id`.

## Destruir

Las tablas DynamoDB tienen `prevent_destroy = true` para proteger la
configuración y el histórico de incidentes. Para un borrado completo:

```bash
# 1. Vaciar el bucket del panel (tiene versionado)
aws s3 rm "s3://$(terraform output -raw admin_bucket)" --recursive
# 2. Quitar (temporalmente) los bloques lifecycle { prevent_destroy = true }
#    de modules/dynamodb/main.tf
# 3. Destruir
terraform destroy
```

Los secretos quedan en periodo de recuperación de 7 días; el sitio con
versionado puede requerir borrar también las versiones de objetos
(`aws s3api delete-objects` sobre `list-object-versions`).

## Estructura

```
infra/terraform/
├── main.tf              # wiring de módulos
├── variables.tf         # variables de la sección 6
├── locals.tf            # prefijo, handlers, variables de entorno, bloques IAM
├── outputs.tf
├── modules/
│   ├── dynamodb/        # 5 tablas + GSIs
│   ├── secrets/         # contenedores de secretos
│   ├── lambda/          # genérico: zip + rol + log group + función
│   ├── api/             # HTTP API + stage + JWT authorizer
│   ├── api_routes/      # integraciones, rutas y permisos
│   ├── stepfunctions/   # máquina "convocation"
│   ├── scheduler/       # tick de presence-monitor
│   ├── notifications/   # SNS + KMS + alarmas
│   └── admin_site/      # S3 + CloudFront (OAC)
└── build/               # zips generados (ignorado por git)
```
