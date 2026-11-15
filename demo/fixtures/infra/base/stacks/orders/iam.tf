resource "aws_iam_role" "worker" {
  name               = "${local.prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "worker_queue" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.orders.arn, aws_sqs_queue.orders_dlq.arn]
  }
}

resource "aws_iam_role_policy" "worker_queue" {
  name   = "queue"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_queue.json
}
