resource "aws_s3_bucket" "receipts" {
  bucket = "${local.prefix}-receipts"
}

resource "aws_s3_bucket_lifecycle_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    id     = "expire"
    status = "Enabled"

    expiration {
      days = var.receipt_expiry_days
    }
  }
}

import {
  to = aws_s3_bucket.archive
  id = "orders-archive"
}

resource "aws_s3_bucket" "archive" {
  bucket = "orders-archive"
}

resource "aws_secretsmanager_secret" "mailer" {
  name = "${local.prefix}/mailer"
}

resource "aws_secretsmanager_secret_version" "mailer" {
  secret_id     = aws_secretsmanager_secret.mailer.id
  secret_string = "placeholder-two"
}
