variable "prefix" {
  description = "Resource name prefix, e.g. `ata-dev-`."
  type        = string
}

variable "tags" {
  description = "Extra tags applied to every table."
  type        = map(string)
  default     = {}
}
