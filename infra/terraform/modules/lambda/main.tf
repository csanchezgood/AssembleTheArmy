# Generic Lambda module: one instance per handler. Packages
# packages/backend/dist/<name>/index.mjs, creates a dedicated least-privilege
# role, the function itself and an explicit log group with retention.

data "archive_file" "bundle" {
  type        = "zip"
  source_file = var.source_file
  output_path = "${path.root}/build/${var.function_name}.zip"
}

# ---- IAM ----------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = substr("${var.function_name}-role", 0, 64)
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

# Basic execution: CloudWatch Logs only.
resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "inline" {
  count = length(var.policy_statements) > 0 ? 1 : 0

  dynamic "statement" {
    for_each = var.policy_statements

    content {
      sid       = statement.value.sid
      effect    = "Allow"
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "inline" {
  count = length(var.policy_statements) > 0 ? 1 : 0

  name   = "least-privilege"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.inline[0].json
}

# ---- Logs ---------------------------------------------------------------

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# ---- Function -----------------------------------------------------------

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  description   = var.description
  role          = aws_iam_role.this.arn

  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = var.memory_size
  timeout       = var.timeout

  reserved_concurrent_executions = var.reserved_concurrent_executions

  environment {
    variables = var.environment
  }

  tags = var.tags

  depends_on = [
    aws_iam_role_policy_attachment.basic,
    aws_iam_role_policy.inline,
    aws_cloudwatch_log_group.this,
  ]
}
