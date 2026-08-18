# -----------------------------------------------------------------------------
# Inputs.
#
# Anything that would embed an ACCOUNT ID in a committed file has NO default and
# must be passed at apply time (`-var` or a gitignored *.auto.tfvars). This repo
# is public; an account id in git is a free gift to anyone probing.
#
# Every knob that bounds spend is a variable so a flood can be answered by an
# apply instead of an edit — but the defaults are the designed values and should
# not be raised casually.
# -----------------------------------------------------------------------------

variable "region" {
  description = "AWS region for every resource in this root. Owner decision: us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for physical names shared with future roots (web, auth) in this account."
  type        = string
  default     = "eqcompanion"
}

variable "alarm_email" {
  description = "Address subscribed to the ops SNS topic. AWS sends a confirmation mail once."
  type        = string
  default     = "jmoyers+eqc@gmail.com"
}

variable "triage_principal_arn" {
  description = "IAM principal (user or role ARN) allowed to assume the triage role. NO DEFAULT: it contains the account id, which must never be committed."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:(root$|user/|role/)", var.triage_principal_arn))
    error_message = "triage_principal_arn must be an IAM principal ARN: arn:aws:iam::<account>:root|user/<name>|role/<name>."
  }
}

variable "monthly_budget_usd" {
  description = "AWS Budgets monthly cost limit for the account. Notifications at 50/80/100% go to the ops topic. Owner 2026-08-12: raised 10 -> 100 as the intent threshold; the real spend ceiling is the telemetry route throttle (~$1/day at 5 rps)."
  type        = number
  default     = 100
}

variable "lambda_reserved_concurrency" {
  description = "The hard blast-radius cap. Bounds spend even if every throttle above it is misconfigured. -1 (UNRESERVED) is the default for the same reason as the telemetry function's: the sub-account's total limit of 10 makes ANY reservation illegal ('below minimum unreserved' — measured, 2026-08-04 apply). Set back to 5 once the account quota is raised."
  type        = number
  default     = -1
}

variable "api_rate_limit" {
  description = "Stage-wide steady-state request rate (rps) across every route on this API. JOS-394 (2026-08-16): 5 -> 15. It has to stay ABOVE the per-route ceilings it contains, or the stage throttles a route that is inside its own budget — measured live at 4.5 RPS steady on /v1/telemetry alone, i.e. ~10% headroom under the old 5."
  type        = number
  default     = 15
}

variable "api_burst_limit" {
  description = "Stage-wide burst capacity. Raised with the rate (JOS-394), keeping the same 2x relationship."
  type        = number
  default     = 30
}

variable "route_rate_limit" {
  description = "Steady-state rate (rps) for POST /v1/feedback specifically."
  type        = number
  default     = 2
}

variable "route_burst_limit" {
  description = "Burst capacity for POST /v1/feedback specifically."
  type        = number
  default     = 5
}

variable "log_retention_days" {
  description = "CloudWatch retention for the Lambda log group AND the API access log group. Access logs carry source IPs, so this doubles as a PII retention bound (incident-only evidence)."
  type        = number
  default     = 14
}

variable "log_object_expiration_days" {
  description = "S3 lifecycle expiry for uploaded log slices under logs/."
  type        = number
  default     = 90
}

variable "dsql_dpu_alarm_threshold" {
  description = "Aurora DSQL TotalDPU (Sum) over 5 minutes that trips the ops alarm. 200 is ~17x the free tier's average burn rate and lands under the monthly budget if sustained — it fires before the bill does, not after."
  type        = number
  default     = 200
}

variable "default_max_reports_per_day" {
  description = "Fallback per-install daily quota used when the feedback_config row does not override it. That row is the live control; this is only the cold-start default."
  type        = number
  default     = 10
}

# ---- usage analytics ingest (docs/plans/usage-analytics.md A2) ---------------

variable "telemetry_reserved_concurrency" {
  description = "Reserved concurrency for the telemetry ingest function. -1 means UNRESERVED, which is the default for a reason: a fresh sub-account's total limit is 10, and reserving from it made the feedback function's own reservation illegal ('below minimum unreserved'). Set a real number once the account's quota is raised."
  type        = number
  default     = -1
}

variable "telemetry_route_rate_limit" {
  description = "Steady-state rate (rps) for POST /v1/telemetry. Wider than feedback's because every install is a caller on a flush timer, not a human pressing a button. Owner 2026-08-12: halved 10 -> 5 alongside the client flush going 60s -> 5min (JOS-269); throttled callers buffer and retry by design, and unanswered 429s are unbilled, so this is the account's de facto spend ceiling. JOS-394 (2026-08-16): back to 10, on a MEASUREMENT rather than a guess — the live route sits at 4.5 RPS (~1,350 requests per 5 min, flat) with 4xx at 2-12 per 5 min, so the old 5 left ~10% headroom and the next few installs would have started throttling real flushes. 10 RPS worst case is ~$2/day, still bounded by this ceiling and alarmed within five minutes."
  type        = number
  default     = 10
}

variable "telemetry_route_burst_limit" {
  description = "Burst capacity for POST /v1/telemetry. Doubled with the rate limit (JOS-394), keeping the same 2x relationship it has had since it was halved."
  type        = number
  default     = 20
}

variable "default_max_events_per_id_per_day" {
  description = "Fallback per-analyticsId daily EVENT cap, used when the feedback_config column is NULL. The column is the live control (deploy-free); this is the cold-start default. 20,000 is ~14 events/minute sustained for 24h — far past a real install's flush loop."
  type        = number
  default     = 20000
}

# ---- never lose the data (JOS-398): AWS Backup + the nightly S3 export -------
#
# Every knob here bounds STORAGE spend, which is why each is a variable rather
# than a literal — but the defaults are the designed windows and the two SECURITY
# numbers among them (the backlog's 90 days, the monthly plan's 12 months) are
# stated to users in SECURITY.md. Changing either is a change to a published
# promise, not a tuning decision.

variable "backup_daily_retention_days" {
  description = "How long a DAILY AWS Backup recovery point of the DSQL cluster is kept. 35 days is comfortably longer than the time it has ever taken to notice a data problem here, and it matches the depth the S3 archive gives the same window."
  type        = number
  default     = 35
}

variable "backup_monthly_retention_days" {
  description = "How long a MONTHLY recovery point is kept. 12 months: the depth that makes a slow, quiet corruption recoverable at all. STATED IN SECURITY.md — a deleted report can survive in a monthly recovery point for this long, which is inherent to having backups and is disclosed rather than discovered."
  type        = number
  default     = 365
}

variable "archive_glacier_transition_days" {
  description = "Days before a nightly export object moves to GLACIER_IR. Nothing reads a month-old export except a restore, and a restore can wait milliseconds."
  type        = number
  default     = 30
}

variable "archive_noncurrent_retention_days" {
  description = "How long a SUPERSEDED export version is kept. A superseded object is a broken or duplicated night rather than history, but a year makes 'the export has been silently wrong since March' recoverable."
  type        = number
  default     = 365
}

variable "archive_backlog_retention_days" {
  description = "How long `exports/report/` objects are kept — the ONE prefix that expires, because `report` is the only table holding human-written text and SECURITY.md promises a deletion request is honoured. 90 days is the window an attached log slice already has in s3.tf: one published number, not a second one to explain."
  type        = number
  default     = 90
}

variable "export_schedule_expression" {
  description = "EventBridge schedule for the nightly analytics export. 09:30 UTC — half an hour after the AWS Backup daily rule, so the two never meet on the same cluster and a morning's recovery point exists before the export."
  type        = string
  default     = "cron(30 9 * * ? *)"
}
