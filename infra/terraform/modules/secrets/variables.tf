variable "prefix" {
  description = "Resource name prefix, e.g. `ata-dev-`."
  type        = string
}

variable "recovery_window_in_days" {
  description = "Days Secrets Manager waits before actually deleting a secret."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Extra tags applied to the secrets."
  type        = map(string)
  default     = {}
}
