# The five tables of ARCHITECTURE.md section 2. All of them are on-demand,
# encrypted with the AWS managed key and protected by point-in-time recovery.
# `prevent_destroy` guards the configuration and the incident history against
# an accidental `terraform destroy`; remove it deliberately when tearing down.

# 2.1 roster (equipos_guardia)
resource "aws_dynamodb_table" "roster" {
  name         = "${var.prefix}roster"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "system_id"
  range_key    = "roster_key"

  attribute {
    name = "system_id"
    type = "S"
  }

  attribute {
    name = "roster_key"
    type = "S"
  }

  attribute {
    name = "member_id"
    type = "S"
  }

  global_secondary_index {
    name            = "by_member"
    hash_key        = "member_id"
    range_key       = "system_id"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

# 2.2 availability (disponibilidad)
resource "aws_dynamodb_table" "availability" {
  name         = "${var.prefix}availability"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "member_id"
  range_key    = "valid_from"

  attribute {
    name = "member_id"
    type = "S"
  }

  attribute {
    name = "valid_from"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

# 2.3 severity_rules (severidad_equipo)
resource "aws_dynamodb_table" "severity_rules" {
  name         = "${var.prefix}severity-rules"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "severity"

  attribute {
    name = "severity"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

# 2.4 incidents (incident items + dedupe locks)
resource "aws_dynamodb_table" "incidents" {
  name         = "${var.prefix}incidents"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "system_id"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "opened_at"
    type = "S"
  }

  global_secondary_index {
    name            = "by_system"
    hash_key        = "system_id"
    range_key       = "opened_at"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "by_status"
    hash_key        = "status"
    range_key       = "opened_at"
    projection_type = "ALL"
  }

  # Used by the LOCK#<system_id> items (24 h safety expiry).
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

# 2.5 audit (immutable log; immutability is enforced by IAM, see lambda policies)
resource "aws_dynamodb_table" "audit" {
  name         = "${var.prefix}audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "incident_id"
  range_key    = "event_key"

  attribute {
    name = "incident_id"
    type = "S"
  }

  attribute {
    name = "event_key"
    type = "S"
  }

  # Optional 400-day retention set by the writers.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}
