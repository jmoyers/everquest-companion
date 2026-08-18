# -----------------------------------------------------------------------------
# THE NIGHTLY LOGICAL EXPORT (JOS-398) — bucket, function, schedule, identity,
# alarms. One subsystem, one file, deliberately.
#
# The rest of this root is organised by RESOURCE KIND (s3.tf, lambda.tf, iam.tf,
# alarms.tf), which is the right shape for a stack whose resources all serve the
# same two endpoints. This is a self-contained thing that happens once a day and
# talks to nothing else, and splitting its eleven resources across four files
# would mean nobody could read it as one mechanism. `alarms.tf` and the README
# table both point here so the alarm inventory stays findable.
#
# WHY A THIRD FUNCTION rather than a scheduled path on an existing one: the same
# answer lambda.tf gives for the second. What a function may do should be readable
# as a GRANT list, and this one's list — SELECT ON EVERYTHING — is the widest in
# the cluster. Folding it into a handler that answers public HTTP would give a
# public endpoint's compromise a read of the whole backlog. Instead this role has
# no HTTP surface at all: EventBridge is its only invoker, and the DATABASE role
# it logs in as (`analytics_export`, infra/schema.sql) holds SELECT and no INSERT,
# UPDATE or DELETE anywhere.
#
# WHAT IT WRITES, AND WHY IN TWO PREFIXES:
#
#   exports/<YYYY-MM-DD>/<table>.json.gz  + manifest.json   the counters and ops tables
#   backlog/<YYYY-MM-DD>/report.json.gz   + manifest.json   the one table of human text
#
# The FORMAT is byte-for-byte what `triage-feedback analytics export` writes to the
# operator's own disk (JOS-399): a gzipped JSON array with one row per line, and a
# manifest carrying row counts, a sha256 per file, the cluster id and the schema
# revision. So `aws s3 sync` of one night into a directory and then
# `triage-feedback analytics import <dir>` restores it with no S3-specific code
# anywhere — one restore path, shared, verified by checksum before the first write.
# `gunzip | jq` also reads it, with no AWS and no code from this repo at all.
#
# The SPLIT is a promise rather than a filing system. An S3 lifecycle filter is a
# PREFIX and cannot pick one file out of a shared directory, and SECURITY.md
# promises a deletion request is honoured — so the one table holding anything a
# person wrote gets its own top level, where a rule can expire it. The lifecycle
# block below argues it where it happens.
#
# IT IS A COPY, NOT A NEW COLLECTION. Every byte was already in the cluster: the
# same tables, the same columns, nothing derived and nothing added. SECURITY.md
# states this in the user's own words, and states both retention windows rather
# than implying instant erasure.
# -----------------------------------------------------------------------------

locals {
  export_lambda_name   = "${var.name_prefix}-analytics-export"
  export_lambda_bundle = "${path.module}/dist/export.zip"

  # The database role the EXPORT path logs in as. Created by `migrate`, mapped to
  # this function's IAM role with `AWS IAM GRANT`, and granted SELECT on every
  # table and nothing else (schema.sql spells them out). Emphatically not `admin`.
  dsql_export_role = "analytics_export"
}

# ---- the archive bucket -----------------------------------------------------
#
# A SECOND BUCKET, NOT A PREFIX ON THE FIRST, and the difference is the whole
# point of both. `eqcompanion-logs-*` is where a user's uploaded slice lives:
# versioning is OFF there on purpose, because a versioned object makes "we deleted
# it on request" a lie. This bucket is the opposite promise — versioning ON, so
# that a corrupted or truncated export cannot overwrite the good one from the
# night before. Two contradictory retention policies cannot live in one bucket,
# so they live in two.
#
# The name carries the SAME random suffix as the logs bucket (s3.tf) rather than
# the account id: s3.tf chose the random suffix so a bucket name is never
# guessable from the account, and one convention beats two.
resource "aws_s3_bucket" "archive" {
  bucket = "${var.name_prefix}-analytics-archive-${random_id.bucket_suffix.hex}"

  # The whole reason this bucket exists is that data can be lost. A
  # `terraform destroy` that could take the backups with it would be the exact
  # failure mode, in one command.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket = aws_s3_bucket.archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    bucket_key_enabled = true
  }
}

# ON, and stated as the deliberate opposite of the logs bucket's OFF. A backup
# that a bad run can overwrite is not a backup: the export writes the same key
# every night for a given date, and a version is what makes yesterday's good copy
# survive today's broken one.
resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  # THE ANALYTICS EXPORTS ARE KEPT. They are anonymous daily sums with no id in
  # them (infra/schema.sql's long note over `usage_daily` is the argument), there
  # is nothing in them to expire on anyone's behalf, and "the series starts
  # 2026-08-04 and there will never be earlier data" is exactly the kind of thing
  # that makes an old copy valuable. GLACIER_IR after 30 days because nothing
  # reads a month-old export except a restore, and a restore can wait
  # milliseconds.
  rule {
    id     = "archive-cold-storage"
    status = "Enabled"

    filter {
      prefix = "exports/"
    }

    transition {
      days          = var.archive_glacier_transition_days
      storage_class = "GLACIER_IR"
    }

    # A superseded version is a broken or duplicated night, not history. A year is
    # long enough that "the export has been silently wrong since March" is still
    # recoverable.
    noncurrent_version_expiration {
      noncurrent_days = var.archive_noncurrent_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # ---------------------------------------------------------------------------
  # THE ONE PREFIX THAT EXPIRES, AND WHY IT EXISTS AS A SEPARATE PREFIX AT ALL
  # ---------------------------------------------------------------------------
  # `report` is the one table in this cluster that holds HUMAN-WRITTEN TEXT, and
  # SECURITY.md makes an unconditional promise about it: ask for a report to be
  # deleted and the report and its slice both go. A versioned archive with no
  # expiry would quietly turn that into "the live row goes and a copy of your
  # words stays in a bucket forever", which is not what anyone was told.
  #
  # AN S3 LIFECYCLE FILTER IS A PREFIX. It has no wildcard and cannot select one
  # file out of a per-night directory — which is why `report` is written under its
  # own TOP-LEVEL prefix by infra/lambda/export.ts rather than beside the
  # counters. The object layout is shaped by this rule, not the other way round,
  # and that is the honest ordering: the retention promise is the requirement.
  #
  # 90 days is the window the attached log slice already has in s3.tf — one
  # published number rather than a second one to explain. Because the prefixes do
  # not overlap, nothing here transitions to GLACIER_IR first, so there is no
  # early-delete charge to reason about either.
  #
  # AWS BACKUP IS THE OTHER HALF OF THIS SENTENCE. A monthly recovery point in
  # infra/backup.tf holds the whole cluster for 12 months, so a deleted report can
  # survive there for up to a year. That is inherent to having backups at all;
  # what matters is that SECURITY.md STATES it rather than leaving it to be
  # discovered.
  rule {
    id     = "expire-backlog-exports"
    status = "Enabled"

    filter {
      prefix = "backlog/"
    }

    expiration {
      days = var.archive_backlog_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.archive_backlog_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # An expiration on a VERSIONED bucket leaves a delete marker behind rather than
  # removing the object. Without this rule the prefix would accumulate markers
  # forever and a `ListObjectVersions` during a restore would be wading through
  # them. It cannot share the block above: S3 refuses `days` and
  # `expired_object_delete_marker` in one expiration.
  rule {
    id     = "sweep-backlog-delete-markers"
    status = "Enabled"

    filter {
      prefix = "backlog/"
    }

    expiration {
      expired_object_delete_marker = true
    }
  }
}

# TWO DENIES, AND THEY ARE THE DOCUMENTED PAIR rather than one clever condition.
# `Null` catches a PutObject that carries no encryption header at all;
# `StringNotEquals` catches one that carries the wrong algorithm. Bucket DEFAULT
# encryption would satisfy neither — it encrypts the object without putting a
# header on the request, and a policy can only see the request — so
# infra/lambda/export.ts sets `ServerSideEncryption: 'AES256'` explicitly and this
# policy is what makes that mandatory rather than habitual.
#
# The third statement is the ordinary one every bucket should have and this repo's
# first bucket predates: plain HTTP is refused outright.
data "aws_iam_policy_document" "archive_bucket" {
  statement {
    sid     = "DenyUnencryptedObjectUploads"
    effect  = "Deny"
    actions = ["s3:PutObject"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    resources = ["${aws_s3_bucket.archive.arn}/*"]

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["true"]
    }
  }

  statement {
    sid     = "DenyIncorrectEncryptionHeader"
    effect  = "Deny"
    actions = ["s3:PutObject"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    resources = ["${aws_s3_bucket.archive.arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["AES256"]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    actions = ["s3:*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    resources = [
      aws_s3_bucket.archive.arn,
      "${aws_s3_bucket.archive.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "archive" {
  bucket = aws_s3_bucket.archive.id
  policy = data.aws_iam_policy_document.archive_bucket.json

  # A bucket policy applied before the Block Public Access flags exist can be
  # rejected as a public policy. Ordering it explicitly costs nothing and removes
  # a first-apply race.
  depends_on = [aws_s3_bucket_public_access_block.archive]
}

# ---- the identity -----------------------------------------------------------
#
# TWO STATEMENTS, AND THE PutObject IS PREFIX-SCOPED. Read it beside iam.tf's two
# ingest roles: this one has no presign, no DELETE, no GetObject and no
# ListBucket. It can add objects under `exports/` and it can open a database
# connection as a role that can only SELECT. A full compromise of this function
# can read the corpus — that is its job — and can write nothing anywhere except
# new archive objects, which versioning then keeps it from destroying.
data "aws_iam_policy_document" "export_inline" {
  statement {
    sid       = "ExportDsqlConnectAsExportRole"
    effect    = "Allow"
    actions   = ["dsql:DbConnect"]
    resources = [aws_dsql_cluster.feedback.arn]
  }

  # The TWO prefixes it writes, listed rather than a wildcard on the bucket. This
  # list IS the set of paths the function can create an object at, and naming them
  # keeps the retention split (kept vs 90 days) enforceable rather than a
  # convention the code happens to follow.
  statement {
    sid     = "ExportWriteArchiveObjects"
    effect  = "Allow"
    actions = ["s3:PutObject"]

    resources = [
      "${aws_s3_bucket.archive.arn}/exports/*",
      "${aws_s3_bucket.archive.arn}/backlog/*",
    ]
  }
}

resource "aws_iam_role" "export" {
  name = "${var.name_prefix}-analytics-export-role"
  # The same trust document the other two functions use: it says only
  # "lambda.amazonaws.com may assume this".
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "export" {
  name   = "analytics-export"
  role   = aws_iam_role.export.id
  policy = data.aws_iam_policy_document.export_inline.json
}

resource "aws_iam_role_policy_attachment" "export_basic" {
  role       = aws_iam_role.export.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---- the function -----------------------------------------------------------

resource "aws_cloudwatch_log_group" "export" {
  name              = "/aws/lambda/${local.export_lambda_name}"
  retention_in_days = var.log_retention_days
}

# BIGGER AND SLOWER THAN THE INGEST FUNCTIONS, on purpose. Those answer a user in
# 30 ms; this one reads every table in the cluster once a day. 512 MB is room for
# the largest table plus its gzip buffer (infra/lambda/export.ts fails loudly at a
# stated 512 MB ceiling rather than being OOM-killed), and 300 s is many times the
# measured pass at this data volume while still being a bound rather than an
# open-ended run.
#
# NO RESERVED CONCURRENCY. The sub-account's total limit is 10 and reserving from
# it made the feedback function's own reservation illegal (variables.tf records
# the measurement). A once-a-day function needs no blast-radius cap anyway: it has
# no public trigger to be flooded through.
resource "aws_lambda_function" "export" {
  function_name = local.export_lambda_name
  role          = aws_iam_role.export.arn
  runtime       = "nodejs22.x"
  handler       = "export.handler"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300
  filename      = local.export_lambda_bundle

  # The same guard the other two bundles carry: a missing zip must fail at
  # plan/apply (where it means "you forgot `node build.mjs`"), never at CI's
  # `terraform validate`.
  source_code_hash = fileexists(local.export_lambda_bundle) ? filebase64sha256(local.export_lambda_bundle) : null

  environment {
    variables = {
      DSQL_ENDPOINT    = local.dsql_endpoint
      DSQL_USER        = local.dsql_export_role
      DSQL_APPLICATION = "eqc-analytics-export"
      ARCHIVE_BUCKET   = aws_s3_bucket.archive.bucket
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.export,
    aws_iam_role_policy.export,
  ]
}

# ---- the schedule -----------------------------------------------------------
#
# 09:30 UTC — half an hour after the AWS Backup daily rule, so the two never meet
# on the same cluster and so a morning's recovery point exists before the export
# that would otherwise be the only copy of it.
#
# A CLASSIC EventBridge RULE, not an EventBridge Scheduler schedule: Scheduler
# needs its own IAM role to invoke the target, and a rule needs only a resource
# policy on the function. One fewer identity for one fewer thing to audit.
resource "aws_cloudwatch_event_rule" "export_nightly" {
  name                = "${var.name_prefix}-analytics-export-nightly"
  description         = "Nightly logical export of every analytics table to S3 (09:30 UTC)."
  schedule_expression = var.export_schedule_expression
}

resource "aws_cloudwatch_event_target" "export_nightly" {
  rule      = aws_cloudwatch_event_rule.export_nightly.name
  target_id = "analytics-export"
  arn       = aws_lambda_function.export.arn
}

resource "aws_lambda_permission" "export_events" {
  statement_id  = "AllowNightlyExportSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.export.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.export_nightly.arn
}

# ---- the two alarms ---------------------------------------------------------
#
# THEY WATCH DIFFERENT FAILURES AND NEITHER IMPLIES THE OTHER. `ExportFailed` is
# the run that started and broke. The staleness alarm is the run that never
# started at all — a disabled rule, a deleted target, a permission removed — which
# emits nothing and would therefore be invisible to any alarm on an error metric.
# A backup that silently stopped is the failure mode this whole ticket exists to
# prevent, so it gets its own alarm and it is the one allowed to be noisy.

resource "aws_cloudwatch_metric_alarm" "export_failed" {
  alarm_name          = "${var.name_prefix}-analytics-export-failed"
  alarm_description   = "The nightly analytics export raised ExportFailed — last night's rows exist only in the cluster."
  namespace           = "EQCompanion/Telemetry"
  metric_name         = "ExportFailed"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# 26 ONE-HOUR PERIODS, ALL OF WHICH MUST BE EMPTY. A CloudWatch alarm period
# cannot be 26 hours (86,400 s is the ceiling), so the window is spelled as 26
# consecutive hourly periods with `datapoints_to_alarm` equal to the count.
#
# `treat_missing_data = "breaching"` is the whole alarm and it is the OPPOSITE of
# every other alarm in this stack: everywhere else "no data" means "nothing bad
# happened", and here it means "no export happened". The 26 rather than 24 is the
# slack a schedule needs — a run that starts late must not page anybody.
#
# It will sit in ALARM for the first day after the apply, until the first export
# emits the metric. That is correct: until then, there really has not been one.
resource "aws_cloudwatch_metric_alarm" "export_stale" {
  alarm_name          = "${var.name_prefix}-analytics-export-stale"
  alarm_description   = "No analytics export has reported rows in 26 hours — the nightly job stopped, and a job that stops silently is the failure this exists to catch."
  namespace           = "EQCompanion/Telemetry"
  metric_name         = "ExportRows"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 26
  datapoints_to_alarm = 26
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}
