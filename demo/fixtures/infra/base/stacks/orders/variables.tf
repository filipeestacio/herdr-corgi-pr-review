variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "env" {
  type = string
}

variable "retention_days" {
  type    = number
  default = 14
}

locals {
  prefix = "orders-${var.env}"
}
