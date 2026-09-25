# SNS alerts topic + CloudWatch alarms that watch the convocation system itself
# ("si el motor de orquestación falla, alguien debe enterarse").
#
# NOTE on encryption: CloudWatch Alarms cannot publish to a topic encrypted
# with the AWS managed key `alias/aws/sns` (its key policy cannot grant
# cloudwatch.amazonaws.com). We therefore use a small customer-managed key
# whose policy allows CloudWatch to use it; publishers (Lambdas) get
# kms:GenerateDataKey/Decrypt on this key through their own IAM roles.

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "CloudWatchAlarms"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "alerts" {
  description             = "${var.prefix}alerts SNS topic encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json
  tags                    = var.tags
}

resource "aws_kms_alias" "alerts" {
  name          = "alias/${var.prefix}alerts"
  target_key_id = aws_kms_key.alerts.key_id
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.prefix}alerts"
  display_name      = "AssembleTheArmy alerts"
  kms_master_key_id = aws_kms_key.alerts.id
  tags              = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---- Alarms ------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = toset(var.lambda_function_names)

  alarm_name          = "${each.value}-errors"
  alarm_description   = "Lambda ${each.value} reported >= 1 error in 5 minutes"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

resource "aws_cloudwatch_metric_alarm" "sfn" {
  for_each = toset(["ExecutionsFailed", "ExecutionsTimedOut"])

  alarm_name          = "${var.prefix}convocation-${lower(each.value)}"
  alarm_description   = "State machine convocation: ${each.value} >= 1 in 5 minutes"
  namespace           = "AWS/States"
  metric_name         = each.value
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = var.state_machine_arn
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.prefix}api-5xx"
  alarm_description   = "HTTP API returned >= 1 5xx response in 5 minutes"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiId = var.api_id
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}

# Custom metric published by the webhook Lambda through EMF when an alert
# cannot be convoked because of configuration (e.g. `no_roster`).
# Published by packages/backend/src/infra/metrics.ts: namespace
# `AssembleTheArmy/ConfigErrors`, metric `ConfigErrors`, dimension `Reason`.
resource "aws_cloudwatch_metric_alarm" "config_errors" {
  alarm_name        = "${var.prefix}config-errors"
  alarm_description = "Alerts ignored because no roster is configured for the system"
  namespace         = var.config_errors_namespace
  metric_name       = "ConfigErrors"
  dimensions = {
    Reason = "no_roster"
  }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = var.tags
}
