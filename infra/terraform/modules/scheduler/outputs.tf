output "schedule_arn" {
  value = aws_scheduler_schedule.this.arn
}

output "role_arn" {
  value = aws_iam_role.this.arn
}
