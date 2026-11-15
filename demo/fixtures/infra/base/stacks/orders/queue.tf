# The queue the shop writes orders to, and where failed ones end up.
resource "aws_sqs_queue" "orders" {
  name                       = "${local.prefix}-orders"
  visibility_timeout_seconds = 30

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.orders_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "orders_dlq" {
  name                      = "${local.prefix}-orders-dlq"
  message_retention_seconds = 1209600
}
