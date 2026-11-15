#!/usr/bin/env python3
"""Writes pr.diff next to this file: an invented Terraform stack that a PR adds whole (three new files, 32 resources and
two data sources, 49 references between them), for "Infrastructure changes" with many resources (infra.js isDense).
Usage: python3 demo/fixtures/infra/dense/gen.py"""
import os
D = "infra/stacks/notifications"
def q(name, dlq=None, extra=""):
    red = f'\n  redrive_policy = jsonencode({{ deadLetterTargetArn = aws_sqs_queue.{dlq}.arn, maxReceiveCount = 5 }})' if dlq else ""
    return f'resource "aws_sqs_queue" "{name}" {{\n  name                       = "${{local.prefix}}-{name.replace("_", "-")}"\n  visibility_timeout_seconds = 120{red}{extra}\n}}\n'
queues = f'''locals {{
  prefix = "notify-${{var.stage}}"
}}

resource "aws_kms_key" "messages" {{
  description         = "Messages of the notification stack"
  enable_key_rotation = true
}}

{q("inbox", "inbox_dlq")}
{q("inbox_dlq")}
{q("digest", "digest_dlq")}
{q("digest_dlq")}
resource "aws_sns_topic" "events" {{
  name              = "${{local.prefix}}-events"
  kms_master_key_id = aws_kms_key.messages.id
}}

resource "aws_sns_topic" "alerts" {{
  name = "${{local.prefix}}-alerts"
}}

resource "aws_sns_topic_subscription" "events_to_inbox" {{
  topic_arn = aws_sns_topic.events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.inbox.arn
}}

resource "aws_sns_topic_subscription" "events_to_digest" {{
  topic_arn = aws_sns_topic.events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.digest.arn
}}

resource "aws_sqs_queue_policy" "inbox" {{
  queue_url = aws_sqs_queue.inbox.id
  policy    = data.aws_iam_policy_document.from_events.json
}}

resource "aws_sqs_queue_policy" "digest" {{
  queue_url = aws_sqs_queue.digest.id
  policy    = data.aws_iam_policy_document.from_events.json
}}

data "aws_iam_policy_document" "from_events" {{
  statement {{
    actions   = ["sqs:SendMessage"]
    resources = ["*"]
    principals {{
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }}
    condition {{
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.events.arn]
    }}
  }}
}}
'''
def fn(name, role, env):
    envs = "\n".join(f"      {k} = {v}" for k, v in env)
    return f'''resource "aws_lambda_function" "{name}" {{
  function_name = "${{local.prefix}}-{name}"
  role          = aws_iam_role.{role}.arn
  handler       = "{name}.handler"
  runtime       = "python3.12"
  timeout       = 30
  filename      = "build/{name}.zip"
  environment {{
    variables = {{
{envs}
    }}
  }}
}}

resource "aws_cloudwatch_log_group" "{name}" {{
  name              = "/aws/lambda/${{local.prefix}}-{name}"
  retention_in_days = var.log_days
}}
'''
functions = f'''resource "aws_iam_role" "workers" {{
  name               = "${{local.prefix}}-workers"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}}

resource "aws_iam_role" "mailer" {{
  name               = "${{local.prefix}}-mailer"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}}

data "aws_iam_policy_document" "assume_lambda" {{
  statement {{
    actions = ["sts:AssumeRole"]
    principals {{
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }}
  }}
}}

resource "aws_iam_role_policy" "workers_queues" {{
  name = "queues"
  role = aws_iam_role.workers.id
  policy = jsonencode({{
    Statement = [{{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "kms:Decrypt"]
      Resource = [aws_sqs_queue.inbox.arn, aws_sqs_queue.digest.arn, aws_kms_key.messages.arn]
    }}]
  }})
}}

resource "aws_iam_role_policy" "mailer_send" {{
  name = "send"
  role = aws_iam_role.mailer.id
  policy = jsonencode({{
    Statement = [{{
      Effect   = "Allow"
      Action   = ["ses:SendEmail", "s3:PutObject"]
      Resource = ["*", "${{aws_s3_bucket.outbox.arn}}/*"]
    }}]
  }})
}}

{fn("router", "workers", [("EVENTS_TOPIC", "aws_sns_topic.events.arn"), ("MAILER", "aws_lambda_function.mailer.arn")])}
{fn("digest", "workers", [("OUTBOX", "aws_s3_bucket.outbox.bucket"), ("MAILER", "aws_lambda_function.mailer.arn")])}
{fn("mailer", "mailer", [("OUTBOX", "aws_s3_bucket.outbox.bucket"), ("ALERTS_TOPIC", "aws_sns_topic.alerts.arn")])}
resource "aws_lambda_event_source_mapping" "inbox_to_router" {{
  event_source_arn = aws_sqs_queue.inbox.arn
  function_name    = aws_lambda_function.router.arn
  batch_size       = 10
}}

resource "aws_lambda_event_source_mapping" "digest_to_digest" {{
  event_source_arn = aws_sqs_queue.digest.arn
  function_name    = aws_lambda_function.digest.arn
  batch_size       = 100
}}

resource "aws_lambda_permission" "router_invokes_mailer" {{
  statement_id  = "AllowRouter"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.mailer.function_name
  principal     = "lambda.amazonaws.com"
  source_arn    = aws_lambda_function.router.arn
}}
'''
def alarm(name, metric, ns, dim_key, dim_val):
    return f'''resource "aws_cloudwatch_metric_alarm" "{name}" {{
  alarm_name          = "${{local.prefix}}-{name.replace("_", "-")}"
  namespace           = "{ns}"
  metric_name         = "{metric}"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 300
  statistic           = "Sum"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {{
    {dim_key} = {dim_val}
  }}
}}
'''
monitoring = f'''resource "aws_s3_bucket" "outbox" {{
  bucket = "${{local.prefix}}-outbox"
}}

resource "aws_s3_bucket_lifecycle_configuration" "outbox" {{
  bucket = aws_s3_bucket.outbox.id
  rule {{
    id     = "expire"
    status = "Enabled"
    expiration {{
      days = 30
    }}
  }}
}}

{alarm("inbox_dlq_depth", "ApproximateNumberOfMessagesVisible", "AWS/SQS", "QueueName", "aws_sqs_queue.inbox_dlq.name")}
{alarm("digest_dlq_depth", "ApproximateNumberOfMessagesVisible", "AWS/SQS", "QueueName", "aws_sqs_queue.digest_dlq.name")}
{alarm("router_errors", "Errors", "AWS/Lambda", "FunctionName", "aws_lambda_function.router.function_name")}
{alarm("digest_errors", "Errors", "AWS/Lambda", "FunctionName", "aws_lambda_function.digest.function_name")}
{alarm("mailer_errors", "Errors", "AWS/Lambda", "FunctionName", "aws_lambda_function.mailer.function_name")}
resource "aws_cloudwatch_dashboard" "notifications" {{
  dashboard_name = "${{local.prefix}}"
  dashboard_body = jsonencode({{
    widgets = [
      {{ type = "metric", properties = {{ metrics = [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.inbox.name]] }} }},
      {{ type = "metric", properties = {{ metrics = [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.digest.name]] }} }},
      {{ type = "metric", properties = {{ metrics = [["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.router.function_name]] }} }}
    ]
  }})
}}
'''
out = []
for name, text in [("functions.tf", functions), ("monitoring.tf", monitoring), ("queues.tf", queues)]:
    lines = text.rstrip("\n").split("\n")
    out += [f"diff --git a/{D}/{name} b/{D}/{name}", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", f"+++ b/{D}/{name}", f"@@ -0,0 +1,{len(lines)} @@", *("+" + l for l in lines)]
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "pr.diff"), "w").write("\n".join(out) + "\n")
