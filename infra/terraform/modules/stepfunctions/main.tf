# Standard state machine "convocation". The ASL lives in the backend package
# and only knows the five placeholders below (ARCHITECTURE.md section 3.3).

locals {
  task_arns = [
    var.resolve_roster_arn,
    var.join_room_arn,
    var.invite_member_arn,
    var.check_joined_arn,
    var.evaluate_outcome_arn,
  ]
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = substr("${var.name}-sfn-role", 0, 64)
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "this" {
  statement {
    sid       = "InvokeTasks"
    actions   = ["lambda:InvokeFunction"]
    resources = local.task_arns
  }

  # Permissions required by Step Functions to deliver logs to CloudWatch
  # (vended logs); AWS requires "*" for these actions.
  statement {
    sid = "VendedLogs"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutLogEvents",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.enable_xray ? [1] : []

    content {
      sid = "XRay"
      actions = [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "xray:GetSamplingRules",
        "xray:GetSamplingTargets",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "convocation"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.this.json
}

# The /aws/vendedlogs/ prefix keeps the CloudWatch resource policy small.
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/vendedlogs/states/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_sfn_state_machine" "this" {
  name     = var.name
  role_arn = aws_iam_role.this.arn
  type     = "STANDARD"

  definition = templatefile(var.definition_file, {
    resolve_roster_arn   = var.resolve_roster_arn
    join_room_arn        = var.join_room_arn
    invite_member_arn    = var.invite_member_arn
    check_joined_arn     = var.check_joined_arn
    evaluate_outcome_arn = var.evaluate_outcome_arn
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.this.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }

  tracing_configuration {
    enabled = var.enable_xray
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy.this]
}
