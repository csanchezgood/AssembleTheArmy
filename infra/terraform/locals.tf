locals {
  prefix = "${var.project}-${var.env}-"

  # Bundles produced by `npm run build` in packages/backend.
  backend_dist_dir = "${path.root}/../../packages/backend/dist"
  asl_file         = "${path.root}/../../packages/backend/statemachine/convocation.asl.json"

  # Handler names (ARCHITECTURE.md section 3) and their timeouts in seconds.
  handlers = {
    "webhook"          = { timeout = 20 }
    "graph-callback"   = { timeout = 15 }
    "resolve-roster"   = { timeout = 30 }
    "join-room"        = { timeout = 60 }
    "invite-member"    = { timeout = 30 }
    "check-joined"     = { timeout = 30 }
    "evaluate-outcome" = { timeout = 60 }
    "presence-monitor" = { timeout = 120 }
    "admin-api"        = { timeout = 30 }
  }

  lambda_memory_size = 512

  # ---- Environment variables (ARCHITECTURE.md section 3.5) ----------------

  common_env = {
    PROJECT            = var.project
    ENV                = var.env
    ROSTER_TABLE       = module.dynamodb.roster_table_name
    AVAILABILITY_TABLE = module.dynamodb.availability_table_name
    SEVERITY_TABLE     = module.dynamodb.severity_table_name
    INCIDENTS_TABLE    = module.dynamodb.incidents_table_name
    AUDIT_TABLE        = module.dynamodb.audit_table_name
    LOG_LEVEL          = "info"
  }

  # Built from the API id (not from the endpoint output) so that the Lambdas
  # can be created before the routes that point back at them.
  api_endpoint       = "https://${module.api.api_id}.execute-api.${var.aws_region}.amazonaws.com"
  graph_callback_url = "${local.api_endpoint}/graph/callback"
  admin_url          = "https://${module.admin_site.distribution_domain_name}"

  graph_env = {
    GRAPH_TENANT_ID      = var.entra_tenant_id
    GRAPH_CLIENT_ID      = var.graph_client_id
    GRAPH_SECRET_ARN     = module.secrets.graph_secret_arn
    GRAPH_CALLBACK_URL   = local.graph_callback_url
    GRAPH_BASE_URL       = "https://graph.microsoft.com/v1.0"
    GRAPH_LOGIN_BASE_URL = "https://login.microsoftonline.com"
  }

  # ---- IAM building blocks ------------------------------------------------

  audit_write = {
    sid       = "AuditAppendOnly"
    actions   = ["dynamodb:PutItem", "dynamodb:Query"]
    resources = [module.dynamodb.audit_table_arn]
  }

  graph_secret_read = {
    sid       = "ReadGraphSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets.graph_secret_arn]
  }

  sns_publish = {
    sid       = "PublishAlerts"
    actions   = ["sns:Publish"]
    resources = [module.notifications.topic_arn]
  }

  # The alerts topic is KMS-encrypted; publishers need the data key.
  sns_kms = {
    sid       = "AlertsTopicKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [module.notifications.kms_key_arn]
  }
}
