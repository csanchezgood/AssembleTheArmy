output "topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "kms_key_arn" {
  description = "Key used by the topic; publishers need kms:GenerateDataKey + kms:Decrypt on it."
  value       = aws_kms_key.alerts.arn
}
