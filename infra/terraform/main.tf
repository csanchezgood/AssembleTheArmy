# Root wiring. Dependency order (no cycles):
#   dynamodb, secrets, admin_site  ->  api (id known)  ->  lambdas  ->
#   stepfunctions (needs task ARNs; webhook needs its ARN)  ->  api_routes,
#   scheduler, notifications alarms (topic is referenced by two lambdas but
#   the alarms only reference function names, so the graph stays acyclic).

data "aws_caller_identity" "current" {}

# ---- Data stores -----------------------------------------------------------

module "dynamodb" {
  source = "./modules/dynamodb"
  prefix = local.prefix
}

module "secrets" {
  source = "./modules/secrets"
  prefix = local.prefix
}

# ---- Admin site (needed first: its URL is the CORS origin) ----------------

module "admin_site" {
  source = "./modules/admin_site"
  prefix = local.prefix
}

# ---- HTTP API (API + stage + JWT authorizer; routes come later) -----------

module "api" {
  source             = "./modules/api"
  name               = "${local.prefix}api"
  cors_allow_origins = concat([local.admin_url], var.extra_cors_origins)
  entra_tenant_id    = var.entra_tenant_id
  admin_api_audience = var.admin_api_audience
  log_retention_days = var.log_retention_days
}

# ---- Alerts topic + alarms -----------------------------------------------

module "notifications" {
  source      = "./modules/notifications"
  prefix      = local.prefix
  alert_email = var.alert_email

  lambda_function_names = [
    module.lambda_webhook.function_name,
    module.lambda_graph_callback.function_name,
    module.lambda_resolve_roster.function_name,
    module.lambda_join_room.function_name,
    module.lambda_invite_member.function_name,
    module.lambda_check_joined.function_name,
    module.lambda_evaluate_outcome.function_name,
    module.lambda_presence_monitor.function_name,
    module.lambda_admin_api.function_name,
  ]
  state_machine_arn = module.stepfunctions.arn
  api_id            = module.api.api_id
}

# ---- Lambdas ---------------------------------------------------------------

module "lambda_webhook" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}webhook"
  description        = "New Relic webhook: validates secret, dedupes, opens incident and starts the convocation"
  source_file        = "${local.backend_dist_dir}/webhook/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["webhook"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env, {
    WEBHOOK_SECRET_ARN   = module.secrets.webhook_secret_arn
    STATE_MACHINE_ARN    = module.stepfunctions.arn
    MAX_ATTEMPTS         = tostring(var.max_attempts)
    RING_TIMEOUT_SECONDS = tostring(var.ring_timeout_seconds)
    MAX_ESCALATIONS      = tostring(var.max_escalations)
  })

  policy_statements = [
    {
      sid       = "ReadWebhookSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [module.secrets.webhook_secret_arn]
    },
    local.graph_secret_read, # participants check when a lock exists in `connected`
    {
      sid       = "SeverityRead"
      actions   = ["dynamodb:GetItem"]
      resources = [module.dynamodb.severity_table_arn]
    },
    {
      sid       = "RosterRead"
      actions   = ["dynamodb:Query"]
      resources = [module.dynamodb.roster_table_arn]
    },
    {
      sid       = "IncidentsAndLocks"
      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
    {
      sid       = "StartConvocation"
      actions   = ["states:StartExecution"]
      resources = [module.stepfunctions.arn]
    },
  ]
}

module "lambda_graph_callback" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}graph-callback"
  description        = "Microsoft Graph notifications: participants roster and call state"
  source_file        = "${local.backend_dist_dir}/graph-callback/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["graph-callback"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env)

  # Validates the Bot Framework JWT with public JWKS; it does not call Graph,
  # so it gets no access to the Graph client secret.
  policy_statements = [

    {
      sid       = "IncidentsUpdate"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
  ]
}

module "lambda_resolve_roster" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}resolve-roster"
  description        = "SFN task: resolves team, room, members, availability and backups"
  source_file        = "${local.backend_dist_dir}/resolve-roster/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["resolve-roster"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env)

  policy_statements = [
    {
      sid       = "RosterRead"
      actions   = ["dynamodb:Query"]
      resources = [module.dynamodb.roster_table_arn]
    },
    {
      sid       = "SeverityRead"
      actions   = ["dynamodb:GetItem"]
      resources = [module.dynamodb.severity_table_arn]
    },
    {
      sid       = "AvailabilityRead"
      actions   = ["dynamodb:Query"]
      resources = [module.dynamodb.availability_table_arn]
    },
    {
      sid       = "IncidentsUpdate"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
  ]
}

module "lambda_join_room" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}join-room"
  description        = "SFN task: the bot joins the team's persistent Teams room"
  source_file        = "${local.backend_dist_dir}/join-room/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["join-room"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env)

  policy_statements = [
    local.graph_secret_read,
    {
      sid       = "IncidentsUpdate"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
  ]
}

module "lambda_invite_member" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}invite-member"
  description        = "SFN task: invites (rings) one member into the room call"
  source_file        = "${local.backend_dist_dir}/invite-member/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["invite-member"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env)

  policy_statements = [
    local.graph_secret_read,
    {
      sid       = "IncidentsUpdate"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
  ]
}

module "lambda_check_joined" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}check-joined"
  description        = "SFN task: checks whether the member is in the room roster"
  source_file        = "${local.backend_dist_dir}/check-joined/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["check-joined"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env)

  policy_statements = [
    local.graph_secret_read,
    {
      sid       = "IncidentsUpdate"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
  ]
}

module "lambda_evaluate_outcome" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}evaluate-outcome"
  description        = "SFN task: decides connected / escalate / unanswered and notifies"
  source_file        = "${local.backend_dist_dir}/evaluate-outcome/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["evaluate-outcome"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env, {
    ALERTS_TOPIC_ARN = module.notifications.topic_arn
  })

  policy_statements = [
    {
      sid       = "ReadSeverityRule" # reloads escalation config when no eligible members were found
      actions   = ["dynamodb:GetItem"]
      resources = [module.dynamodb.severity_table_arn]
    },

    {
      sid       = "IncidentsUpdate"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
    local.sns_publish,
    local.sns_kms,
  ]
}

module "lambda_presence_monitor" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}presence-monitor"
  description        = "Scheduled: closes empty/stale incidents and makes the bot leave the room"
  source_file        = "${local.backend_dist_dir}/presence-monitor/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["presence-monitor"].timeout
  log_retention_days = var.log_retention_days

  # One run at a time: a 120 s run must never overlap with the next tick.
  # Reserved concurrency (1) would avoid overlapping runs, but small accounts
  # cannot spare it (the unreserved pool must keep >= 10). Overlaps are
  # tolerated: closing an incident is idempotent.
  reserved_concurrent_executions = null

  environment = merge(local.common_env, local.graph_env, {
    ALERTS_TOPIC_ARN       = module.notifications.topic_arn
    UNANSWERED_TTL_MINUTES = tostring(var.unanswered_ttl_minutes)
  })

  policy_statements = [
    local.graph_secret_read,
    {
      sid       = "IncidentsByStatus"
      actions   = ["dynamodb:Query"]
      resources = [module.dynamodb.incidents_table_arn, "${module.dynamodb.incidents_table_arn}/index/by_status"]
    },
    {
      sid       = "IncidentsAndLocks"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      resources = [module.dynamodb.incidents_table_arn]
    },
    local.audit_write,
    {
      sid       = "DescribeConvocation" # detects orphan `convoking` incidents
      actions   = ["states:DescribeExecution"]
      resources = [module.stepfunctions.execution_arn_pattern]
    },
    local.sns_publish,
    local.sns_kms,
  ]
}

module "lambda_admin_api" {
  source             = "./modules/lambda"
  function_name      = "${local.prefix}admin-api"
  description        = "Admin panel API: configuration CRUD, incidents, audit, user search"
  source_file        = "${local.backend_dist_dir}/admin-api/index.mjs"
  memory_size        = local.lambda_memory_size
  timeout            = local.handlers["admin-api"].timeout
  log_retention_days = var.log_retention_days

  environment = merge(local.common_env, local.graph_env, {
    ADMIN_GROUP_ID       = var.admin_group_id
    ADMIN_ALLOWED_ORIGIN = local.admin_url
  })

  policy_statements = [
    local.graph_secret_read, # /admin/users -> Graph /users?$search
    {
      sid       = "RosterCrud"
      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      resources = [module.dynamodb.roster_table_arn, "${module.dynamodb.roster_table_arn}/index/by_member"]
    },
    {
      sid       = "AvailabilityCrud"
      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      resources = [module.dynamodb.availability_table_arn]
    },
    {
      sid       = "SeverityCrud"
      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Scan"]
      resources = [module.dynamodb.severity_table_arn]
    },
    {
      sid       = "IncidentsRead"
      actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
      resources = [module.dynamodb.incidents_table_arn, "${module.dynamodb.incidents_table_arn}/index/*"]
    },
    local.audit_write,
  ]
}

# ---- Step Functions --------------------------------------------------------

module "stepfunctions" {
  source             = "./modules/stepfunctions"
  name               = "${local.prefix}convocation"
  definition_file    = local.asl_file
  log_retention_days = var.log_retention_days

  resolve_roster_arn   = module.lambda_resolve_roster.arn
  join_room_arn        = module.lambda_join_room.arn
  invite_member_arn    = module.lambda_invite_member.arn
  check_joined_arn     = module.lambda_check_joined.arn
  evaluate_outcome_arn = module.lambda_evaluate_outcome.arn
}

# ---- API routes ------------------------------------------------------------

module "api_routes" {
  source            = "./modules/api_routes"
  api_id            = module.api.api_id
  api_execution_arn = module.api.execution_arn
  authorizer_id     = module.api.authorizer_id

  routes = {
    webhook = {
      route_key            = "POST /webhook/newrelic"
      lambda_function_name = module.lambda_webhook.function_name
      lambda_invoke_arn    = module.lambda_webhook.invoke_arn
      authorized           = false
    }
    graph_callback = {
      route_key            = "POST /graph/callback"
      lambda_function_name = module.lambda_graph_callback.function_name
      lambda_invoke_arn    = module.lambda_graph_callback.invoke_arn
      authorized           = false
    }
    admin = {
      route_key            = "ANY /admin/{proxy+}"
      lambda_function_name = module.lambda_admin_api.function_name
      lambda_invoke_arn    = module.lambda_admin_api.invoke_arn
      authorized           = true
    }
  }
}

# ---- Scheduler -------------------------------------------------------------

module "scheduler" {
  source              = "./modules/scheduler"
  name                = "${local.prefix}presence-monitor"
  schedule_expression = "rate(1 minute)"
  target_lambda_arn   = module.lambda_presence_monitor.arn
}
