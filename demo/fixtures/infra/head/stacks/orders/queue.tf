# The queue the shop writes orders to.
resource "aws_sqs_queue" "orders" {
  name                       = "${local.prefix}-orders"
  visibility_timeout_seconds = 60
}
