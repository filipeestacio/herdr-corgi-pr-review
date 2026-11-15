resource "aws_lambda_function" "worker" {
  function_name = "${local.prefix}-worker"
  role          = aws_iam_role.worker.arn
  handler       = "worker.handle"
  runtime       = "python3.13"
  filename      = "build/worker.zip"
  timeout       = 10
  memory_size   = 256

  environment {
    variables = {
      QUEUE_URL = aws_sqs_queue.orders.url
    }
  }
}

resource "aws_lambda_event_source_mapping" "orders" {
  event_source_arn = aws_sqs_queue.orders.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 10
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.prefix}-worker"
  retention_in_days = var.retention_days
}
