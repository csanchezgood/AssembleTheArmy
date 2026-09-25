# Outputs of ARCHITECTURE.md section 6.

output "webhook_url" {
  description = "URL to configure in the New Relic Workflow (POST, header X-Webhook-Secret)."
  value       = "${module.api.api_endpoint}/webhook/newrelic"
}

output "graph_callback_url" {
  description = "Calling webhook URL to configure in the Azure Bot registration."
  value       = "${module.api.api_endpoint}/graph/callback"
}

output "admin_url" {
  description = "Admin panel URL (CloudFront). Register it as SPA redirect URI in Entra."
  value       = local.admin_url
}

output "admin_api_url" {
  description = "Base URL of the admin API (routes /admin/*)."
  value       = "${module.api.api_endpoint}/admin"
}

output "state_machine_arn" {
  value = module.stepfunctions.arn
}

output "graph_secret_arn" {
  description = "Load with: aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{\"clientSecret\":\"...\"}'"
  value       = module.secrets.graph_secret_arn
}

output "webhook_secret_arn" {
  description = "Load with: aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{\"secret\":\"...\"}'"
  value       = module.secrets.webhook_secret_arn
}

output "alerts_topic_arn" {
  value = module.notifications.topic_arn
}

output "admin_bucket" {
  description = "S3 bucket that hosts the admin SPA build."
  value       = module.admin_site.bucket_name
}

output "cloudfront_distribution_id" {
  value = module.admin_site.distribution_id
}
