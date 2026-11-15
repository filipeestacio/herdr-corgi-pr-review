variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "env" {
  type = string
}

variable "retention_days" {
  type    = number
  default = 30
}

variable "receipt_expiry_days" {
  type    = number
  default = 365
}

locals {
  prefix = "orders-${var.env}"
}
