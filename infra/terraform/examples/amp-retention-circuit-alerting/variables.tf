variable "aws_region" {
  description = "AWS region that contains the existing AMP workspace."
  type        = string
}

variable "amp_workspace_id" {
  description = "Existing Amazon Managed Service for Prometheus workspace ID."
  type        = string
}

variable "retention_pagerduty_routing_key" {
  description = "PagerDuty Events API routing key supplied by secure CI or a secret manager."
  type        = string
  sensitive   = true
}

variable "retention_engineering_webhook_url" {
  description = "HTTPS engineering webhook supplied by secure CI or a secret manager."
  type        = string
  sensitive   = true
}

variable "runbook_url" {
  description = "HTTPS URL for the production PostgreSQL circuit-breaker runbook."
  type        = string
}
