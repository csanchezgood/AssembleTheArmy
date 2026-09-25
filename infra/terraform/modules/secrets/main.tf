# Only the secret *containers* are managed here. Their values are loaded out of
# band with `aws secretsmanager put-secret-value` (see infra/scripts/set-secrets.sh)
# so that no credential ever lands in the Terraform state or the repository.

# Value shape: {"clientSecret": "..."}
resource "aws_secretsmanager_secret" "graph_client_secret" {
  name                    = "${var.prefix}graph-client-secret"
  description             = "Client secret of the Entra ID app used by the AssembleTheArmy bot to call Microsoft Graph. JSON: {\"clientSecret\": \"...\"}"
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = var.tags
}

# Value shape: {"secret": "..."}
resource "aws_secretsmanager_secret" "webhook_secret" {
  name                    = "${var.prefix}webhook-secret"
  description             = "Shared secret expected in the X-Webhook-Secret header of the New Relic webhook. JSON: {\"secret\": \"...\"}"
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = var.tags
}
