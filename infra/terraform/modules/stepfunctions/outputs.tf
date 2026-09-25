output "arn" {
  value = aws_sfn_state_machine.this.arn
}

output "name" {
  value = aws_sfn_state_machine.this.name
}

# ARN pattern matching every execution of this machine (for states:DescribeExecution).
output "execution_arn_pattern" {
  value = replace("${aws_sfn_state_machine.this.arn}:*", ":stateMachine:", ":execution:")
}

output "role_arn" {
  value = aws_iam_role.this.arn
}
