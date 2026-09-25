# EventBridge Scheduler tick for presence-monitor.

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = substr("${var.name}-scheduler-role", 0, 64)
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "invoke" {
  statement {
    sid       = "InvokeTarget"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.target_lambda_arn, "${var.target_lambda_arn}:*"]
  }
}

resource "aws_iam_role_policy" "invoke" {
  name   = "invoke-target"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.invoke.json
}

resource "aws_scheduler_schedule" "this" {
  name                         = var.name
  description                  = "AssembleTheArmy presence monitor tick"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.target_lambda_arn
    role_arn = aws_iam_role.this.arn
    input    = var.input

    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 60
    }
  }

  depends_on = [aws_iam_role_policy.invoke]
}
