resource "aws_s3_bucket" "receipts" {
  bucket = "${local.prefix}-receipts"
}

resource "aws_secretsmanager_secret" "mailer" {
  name = "${local.prefix}/mailer"
}

resource "aws_secretsmanager_secret_version" "mailer" {
  secret_id     = aws_secretsmanager_secret.mailer.id
  secret_string = "placeholder-one"
}
