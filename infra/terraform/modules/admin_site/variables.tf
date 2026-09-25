variable "prefix" {
  description = "Resource name prefix, e.g. `ata-dev-`."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
