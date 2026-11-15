terraform {
  required_version = ">= 1.6"

  backend "s3" {
    bucket = "acme-terraform-state"
    key    = "orders/terraform.tfstate"
    region = "eu-central-1"
  }
}

provider "aws" {
  region = var.region
}
