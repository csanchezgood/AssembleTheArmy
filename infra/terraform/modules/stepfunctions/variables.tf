variable "name" {
  description = "State machine name (already prefixed)."
  type        = string
}

variable "definition_file" {
  description = "Path to the ASL template (convocation.asl.json)."
  type        = string
}

variable "resolve_roster_arn" {
  type = string
}

variable "join_room_arn" {
  type = string
}

variable "invite_member_arn" {
  type = string
}

variable "check_joined_arn" {
  type = string
}

variable "evaluate_outcome_arn" {
  type = string
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the state machine log group."
  type        = number
}

variable "enable_xray" {
  description = "Enable X-Ray tracing for executions."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
