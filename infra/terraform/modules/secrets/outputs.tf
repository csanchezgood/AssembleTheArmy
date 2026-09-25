output "graph_secret_arn" {
  value = aws_secretsmanager_secret.graph_client_secret.arn
}

output "graph_secret_name" {
  value = aws_secretsmanager_secret.graph_client_secret.name
}

output "webhook_secret_arn" {
  value = aws_secretsmanager_secret.webhook_secret.arn
}

output "webhook_secret_name" {
  value = aws_secretsmanager_secret.webhook_secret.name
}
