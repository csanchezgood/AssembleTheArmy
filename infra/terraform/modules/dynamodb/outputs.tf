output "roster_table_name" {
  value = aws_dynamodb_table.roster.name
}

output "roster_table_arn" {
  value = aws_dynamodb_table.roster.arn
}

output "availability_table_name" {
  value = aws_dynamodb_table.availability.name
}

output "availability_table_arn" {
  value = aws_dynamodb_table.availability.arn
}

output "severity_table_name" {
  value = aws_dynamodb_table.severity_rules.name
}

output "severity_table_arn" {
  value = aws_dynamodb_table.severity_rules.arn
}

output "incidents_table_name" {
  value = aws_dynamodb_table.incidents.name
}

output "incidents_table_arn" {
  value = aws_dynamodb_table.incidents.arn
}

output "audit_table_name" {
  value = aws_dynamodb_table.audit.name
}

output "audit_table_arn" {
  value = aws_dynamodb_table.audit.arn
}
