# -----------------------------------------------------------------------------
# Ops: one SNS topic, one email subscription, NINE alarms, one budget (§9.2).
#
# The point of the alarms is TIME TO KNOWLEDGE. A budget alone tells you about a
# flood at the end of the month; a 5-minute request-count alarm tells you while
# it is happening, which is when the kill switch is still useful.
#
# The email subscription needs ONE manual confirmation click after the first
# apply. Terraform shows it as `pending confirmation` until then, and an
# unconfirmed subscription delivers nothing — check it before trusting the alarms.
#
# THREE MORE ALARMS LIVE ELSEWHERE, and this line is here so the inventory stays
# findable from the file called alarms.tf: `backup.tf` carries the AWS Backup
# job-failure alarm, and `export.tf` carries the nightly export's failure and
# staleness pair. Both were kept beside their subsystem because each is one
# mechanism a reader has to take in whole, not because the split is a preference.
# They all publish to `aws_sns_topic.ops` below.
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "ops" {
  name = "EqCompanionOpsAlerts"
}

data "aws_iam_policy_document" "ops_topic" {
  # AWS Budgets publishes from a SERVICE principal and is therefore denied by the
  # default topic policy. This statement is what makes the budget alerts arrive.
  statement {
    sid     = "AllowBudgetsPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    resources = [aws_sns_topic.ops.arn]
  }

  statement {
    sid     = "AllowCloudWatchAlarmsPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    resources = [aws_sns_topic.ops.arn]
  }

  # Setting ANY topic policy replaces the default one, which is what grants the
  # account owner management of the topic. Restate it, or a future subscribe from
  # the console starts failing for no visible reason.
  statement {
    sid    = "AllowOwnerManagement"
    effect = "Allow"

    actions = [
      "SNS:AddPermission",
      "SNS:DeleteTopic",
      "SNS:GetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
      "SNS:RemovePermission",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
    ]

    principals {
      type        = "AWS"
      identifiers = [data.aws_caller_identity.current.account_id]
    }

    resources = [aws_sns_topic.ops.arn]
  }
}

resource "aws_sns_topic_policy" "ops" {
  arn    = aws_sns_topic.ops.arn
  policy = data.aws_iam_policy_document.ops_topic.json
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---- alarms -----------------------------------------------------------------

# A flood is visible in minutes, not at month end. 5,000 requests in 5 minutes is
# ~16 rps sustained. It used to be three times the stage ceiling; since JOS-394
# raised that ceiling to 15 rps it is just above a SATURATED stage (15 rps is
# 4,500 per 5 min), which is still the right reading — at the throttle for five
# solid minutes is exactly the anomaly this is for, and the measured steady state
# is 4.5 RPS. Raising the stage further means revisiting this number with it.
resource "aws_cloudwatch_metric_alarm" "api_flood" {
  alarm_name          = "${var.name_prefix}-api-request-flood"
  alarm_description   = "API Gateway request count over 5,000 in 5 minutes."
  namespace           = "AWS/ApiGateway"
  metric_name         = "Count"
  dimensions          = { ApiId = aws_apigatewayv2_api.main.id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name_prefix}-api-5xx"
  alarm_description   = "API Gateway 5xx responses over 10 in 5 minutes."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.main.id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${var.name_prefix}-feedback-lambda-errors"
  alarm_description   = "Submit handler errors over 10 in 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.submit.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# Throttles mean the reserved-concurrency cap is doing its job — which is exactly
# when a human should look, so the threshold is zero.
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${var.name_prefix}-feedback-lambda-throttles"
  alarm_description   = "Submit handler hit its reserved concurrency cap."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.submit.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# ---- telemetry ingest ---------------------------------------------------------
#
# THE 5xx ALARM IS THE POINT. Everything else on this route fails as a CLIENT
# error by design — a closed kill switch is a 503 the handler chose, a spent cap
# is a 429, a malformed batch is a 400 — so a 5xx here is the handler itself
# breaking, and it is invisible to users (nothing in the app surfaces a failed
# flush; the buffer just refills). Without this alarm, telemetry ingest could be
# down for a week and the first symptom would be a flat dashboard.

resource "aws_cloudwatch_metric_alarm" "telemetry_lambda_errors" {
  alarm_name          = "${var.name_prefix}-telemetry-lambda-errors"
  alarm_description   = "Telemetry ingest handler errors over 10 in 5 minutes (a 5xx is always ours — 4xx/503 are by design)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.telemetry.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# Throttles mean the concurrency cap is doing its job, which is exactly when a
# human should look — the threshold is zero. Harmless while the function runs
# UNRESERVED (it can then only throttle on the ACCOUNT limit, which is a much
# louder thing to learn about).
resource "aws_cloudwatch_metric_alarm" "telemetry_lambda_throttles" {
  alarm_name          = "${var.name_prefix}-telemetry-lambda-throttles"
  alarm_description   = "Telemetry ingest hit a concurrency cap."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.telemetry.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# ---- the database ------------------------------------------------------------
#
# These two replace the DynamoDB read/write throttle alarms. There is no
# "throttling" to watch on DSQL — it does not provision capacity — so the two
# things worth knowing about are SPEND and CONTENTION.
#
# MIND THE DIMENSION. Aurora DSQL splits its metrics across two dimension names
# in the SAME namespace: the *usage* (DPU) metrics key on `ResourceId`, the
# *observability* metrics key on `ClusterId`. Getting that wrong produces an
# alarm that is permanently INSUFFICIENT_DATA and therefore never fires — the
# exact failure mode the plan's `ThrottledRequests` alarm had. Both names below
# are taken from the published metric tables, not guessed.

# DPU is the billing unit and the free tier is 100k/month (~12 DPU per 5-minute
# period averaged over a month). A sustained 200 is unambiguous: either the route
# throttle was widened or something is wrong.
resource "aws_cloudwatch_metric_alarm" "dsql_dpu" {
  alarm_name          = "${var.name_prefix}-feedback-dsql-dpu"
  alarm_description   = "Aurora DSQL total DPU consumption over the 5-minute budget."
  namespace           = "AWS/AuroraDSQL"
  metric_name         = "TotalDPU"
  dimensions          = { ResourceId = aws_dsql_cluster.feedback.identifier }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.dsql_dpu_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# DSQL is optimistic: a write conflict is a commit-time abort the caller retries.
#
# A RAW COUNT IS NOT A HEALTH SIGNAL, AND THIS ALARM PROVED IT (JOS-394). The old
# form of this resource fired on `OccConflicts > 50 per 5 min` and fired ALL DAY.
# What was measured on 2026-08-16 while it was firing: ~1,350 telemetry requests
# per 5 min (4.5 RPS, flat, 3-4 concurrent Lambdas) and 60-90 conflicts per 5 min
# — about 5% of writes — with a retry ladder over two hours of 1,634 first-attempt
# conflicts -> 104 second -> 6 third -> ZERO exhausted, and zero API 5xx. That is
# a healthy optimistic database under concurrency, not an incident: the threshold
# was written when this product's traffic made 50 conflicts impossible without a
# bug, and traffic outgrew it. An alarm that is always on is an alarm nobody reads.
#
# SO IT IS A RATIO NOW: conflicts per TELEMETRY INVOCATION, which is the number
# that stays flat as the install base grows and moves only when writes start
# colliding at a rate the retry ladder cannot absorb. 0.25 is five times the
# measured pre-shard rate and more than a hundred times the post-shard one (32-way
# sharding takes ~5% to ~0.2%), and it must hold for THREE consecutive periods, so
# a single busy five minutes cannot page anybody.
#
# `IF(invocations > 0, ...)` is not decoration: metric math over a zero
# denominator yields no data point, and an alarm that goes INSUFFICIENT_DATA every
# quiet night is one nobody trusts either.
#
# THE OTHER HALF OF THE PAIR IS `telemetry_db_retry_exhausted` BELOW. This alarm
# watches for PATHOLOGY (contention out of proportion to traffic); that one watches
# for LOSS (a bounded retry ladder actually running out). Neither implies the other,
# which is exactly why there are two.
resource "aws_cloudwatch_metric_alarm" "dsql_occ_conflicts" {
  alarm_name          = "${var.name_prefix}-feedback-dsql-occ-conflicts"
  alarm_description   = "Aurora DSQL OCC aborts over 25% of telemetry invocations for 15 minutes (measured healthy: ~5% pre-shard, ~0.2% expected after the 32-way shard)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 0.25
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]

  metric_query {
    id = "conflicts"

    metric {
      namespace   = "AWS/AuroraDSQL"
      metric_name = "OccConflicts"
      dimensions  = { ClusterId = aws_dsql_cluster.feedback.identifier }
      stat        = "Sum"
      period      = 300
    }
  }

  # The denominator is the TELEMETRY function's invocations rather than the API's
  # request count: every conflict measured here came from the counter transaction,
  # and a request throttled at the route never reached the database at all.
  metric_query {
    id = "invocations"

    metric {
      namespace   = "AWS/Lambda"
      metric_name = "Invocations"
      dimensions  = { FunctionName = aws_lambda_function.telemetry.function_name }
      stat        = "Sum"
      period      = 300
    }
  }

  metric_query {
    id          = "ratio"
    expression  = "IF(invocations > 0, conflicts / invocations, 0)"
    label       = "OCC conflicts per telemetry invocation"
    return_data = true
  }
}

# THE LOSS ALARM, and the one that is allowed to be twitchy (JOS-394).
#
# `DbRetryExhausted` is emitted by infra/lambda/db.ts — one EMF document, no
# dimensions — when a bounded, full-jittered retry ladder gives up on a 40001. Up
# to that point a conflict costs milliseconds and nothing is lost; past it the
# handler returns 500, the client buffers the batch for a later flush, and NOTHING
# ELSE ANYWHERE SAYS SO. The measured ladder never reached attempt four, so the
# honest threshold is one: a single exhausted write is already the fact this alarm
# exists to deliver.
#
# EMF IS A LOG LINE, so this metric only exists once the handler has emitted it at
# least once — before that the alarm sits in INSUFFICIENT_DATA, which
# `notBreaching` renders as OK. That is the correct reading: no metric here means
# no ladder has ever run out.
resource "aws_cloudwatch_metric_alarm" "telemetry_db_retry_exhausted" {
  alarm_name          = "${var.name_prefix}-telemetry-db-retry-exhausted"
  alarm_description   = "A bounded DSQL retry ladder gave up — an aggregate write was LOST (the client buffers and re-flushes, so nothing else reports this)."
  namespace           = "EQCompanion/Telemetry"
  metric_name         = "DbRetryExhausted"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# ---- budget -----------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 50
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.ops.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.ops.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.ops.arn]
  }
}
