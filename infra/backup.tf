# -----------------------------------------------------------------------------
# AWS BACKUP FOR THE DSQL CLUSTER (JOS-398, owner ruling 2026-08-16: the analytics
# data must never be lost).
#
# WHAT EXISTED BEFORE THIS FILE, and it was not nothing: Aurora DSQL replicates
# across availability zones by construction, and `deletion_protection_enabled` +
# `prevent_destroy` (dsql.tf) between them make "terraform destroy took the
# backlog" impossible. What NONE of that answers is the class of loss that
# actually threatens this product: a bad migration, `scripts/analyticsBackfill.mts`
# swapping the wrong table, a fat-fingered DROP, or an account-level event.
# Durability protects the bytes you wrote; it faithfully replicates a mistake.
#
# SO THERE ARE TWO LAYERS, and they fail differently on purpose:
#
#   * THIS FILE — AWS Backup point-in-time recovery points of the whole cluster.
#     Restores to a NEW cluster (AWS Backup cannot restore DSQL in place), which
#     is also why it is safe: a restore cannot damage the live one. It is the
#     answer to "the cluster is wrong and I want yesterday's, all of it".
#   * infra/export.tf — a nightly row-level dump to S3 in a format anybody can
#     read with `gunzip`. It is the answer to "one table is wrong", to "I want to
#     look at this without standing up a cluster", and to the AWS-Backup-shaped
#     failure where the recovery point itself is the thing that is missing.
#
# AURORA DSQL IS A SUPPORTED AWS BACKUP RESOURCE TYPE — VERIFIED, NOT ASSUMED
# (2026-08-16, against this very account):
#   * `aws backup describe-region-settings --region us-east-1` reports
#     `"DSQL": true` in ResourceTypeOptInPreference — the opt-in is already on, so
#     no `aws_backup_region_settings` resource is needed and none is declared.
#   * `AWSBackupServiceRolePolicyForBackup` v30 carries a
#     `DSQLResourcePermissionsForBackup` statement (`dsql:StartBackupJob`,
#     `GetBackupJob`, `StopBackupJob`, `GetCluster`, `ListClusters`,
#     `ListTagsForResource`) plus the matching KMS grant. There is NO
#     DSQL-specific managed policy; the two general ones are the current answer.
#   * `AWSBackupServiceRolePolicyForRestores` v35 carries
#     `DSQLResourcePermissionsForRestore` (`dsql:StartRestoreJob`,
#     `CreateCluster`, `TagResource`, …). Restore is granted here rather than
#     bolted on during an incident, which is the only time it would be needed.
#
# THE PROVIDER NEEDED NO BUMP. `versions.tf` already pins `~> 6.0` and the lock
# file resolves 6.57.1, in which `aws_backup_plan` / `aws_backup_selection` take a
# resource ARN with no per-service schema — a DSQL cluster ARN is simply an ARN to
# them. Nothing in this file is a provider feature that postdates the lock.
#
# COST: recovery points of a database whose live storage is measured in megabytes.
# The daily rule keeps 35 of them and the monthly rule 12, all in warm storage;
# this is cents per month and it is inside the budget in alarms.tf.
# -----------------------------------------------------------------------------

# The service role AWS Backup assumes to take and to restore a recovery point.
# It is a ROLE THE SERVICE ASSUMES, not a role anybody logs in as — there is no
# human path to it and no credential in it.
data "aws_iam_policy_document" "backup_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name_prefix}-backup-role"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

# Both halves, attached up front. A backup role that cannot restore is a role that
# has to be edited during the incident it exists for, and IAM changes made in a
# panic are how a recovery becomes a second outage.
resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

# KMS: the AWS Backup default key. Stated rather than left implicit — a
# customer-managed key would be one more thing whose deletion loses every
# recovery point at once, and this account has no key-isolation requirement that
# would pay for that risk.
resource "aws_backup_vault" "analytics" {
  name = "${var.name_prefix}-analytics"

  tags = {
    Name = "${var.name_prefix}-analytics-backups"
  }

  # The same brace the bucket and the cluster carry. A vault holding recovery
  # points refuses deletion service-side anyway; this makes the refusal happen at
  # plan time, where it is a sentence rather than a failed apply.
  lifecycle {
    prevent_destroy = true
  }
}

# TWO RULES, TWO QUESTIONS.
#
#   daily   — "give me yesterday". 35 days deep, which is comfortably longer than
#             the time it has ever taken to notice a data problem here, and the
#             same window the archive bucket keeps the backlog's exports for.
#   monthly — "give me the shape of things before that release". One point per
#             month for a year: the granularity nobody needs day-to-day and the
#             depth that makes a slow, quiet corruption recoverable at all.
#
# 09:00 UTC (02:00 Pacific) is a deliberately quiet hour, and it is 30 minutes
# BEFORE the S3 export in export.tf so the two never contend for the same cluster
# — and so that a morning with no export still has a recovery point behind it.
resource "aws_backup_plan" "analytics" {
  name = "${var.name_prefix}-analytics"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.analytics.name
    schedule          = "cron(0 9 * * ? *)"

    # Defaults, stated: a job that has not started within an hour has missed its
    # window, and one still running after three has a problem worth an alarm
    # rather than an open-ended retry.
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = var.backup_daily_retention_days
    }
  }

  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.analytics.name
    # First of the month, same hour. The daily rule also runs that morning; two
    # recovery points of the same cluster minutes apart is the intended cost of
    # keeping the two retentions independent.
    schedule = "cron(0 9 1 * ? *)"

    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = var.backup_monthly_retention_days
    }
  }
}

# BY ARN, NOT BY TAG. A tag-based selection is a selection that silently stops
# covering the cluster the day somebody edits a tag; naming the ARN means the
# coverage is a line in this file that a reviewer can check against dsql.tf.
resource "aws_backup_selection" "analytics" {
  name         = "${var.name_prefix}-analytics-cluster"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.analytics.id

  resources = [aws_dsql_cluster.feedback.arn]
}

# THE ONLY THING WORSE THAN NO BACKUP IS A BACKUP THAT STOPPED AND SAID NOTHING.
#
# `NumberOfBackupJobsFailed` is dimensioned on the vault, which is the dimension
# AWS Backup publishes it under (the same trap `dsql_occ_conflicts` documents for
# DSQL's two dimension names: the wrong one gives an alarm that sits in
# INSUFFICIENT_DATA forever). The threshold is ONE, because there is one job a day
# and a single failure is already the whole fact.
#
# `notBreaching` on missing data is correct here and is NOT the same as "we would
# not notice a silent stop": a plan that stopped firing altogether shows up as a
# vault with no new recovery points, which the drill in infra/README.md is what
# actually checks. This alarm is for the job that RAN and FAILED.
resource "aws_cloudwatch_metric_alarm" "backup_failed" {
  alarm_name          = "${var.name_prefix}-backup-jobs-failed"
  alarm_description   = "An AWS Backup job for the DSQL cluster FAILED. There is one a day; a single failure is the whole fact."
  namespace           = "AWS/Backup"
  metric_name         = "NumberOfBackupJobsFailed"
  dimensions          = { BackupVaultName = aws_backup_vault.analytics.name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}
