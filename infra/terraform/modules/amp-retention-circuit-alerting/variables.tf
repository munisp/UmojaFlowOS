variable "workspace_id" {
  description = "Amazon Managed Service for Prometheus workspace ID receiving the rules and Alertmanager definition."
  type        = string

  validation {
    condition     = can(regex("^ws-[A-Za-z0-9-]+$", var.workspace_id))
    error_message = "workspace_id must be an AMP workspace ID beginning with ws-."
  }
}

variable "environment" {
  description = "Deployment environment represented by the alert rules."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "rule_group_namespace" {
  description = "AMP rule-group namespace for retention circuit rules."
  type        = string
  default     = "umoja-retention-circuit"
}

variable "circuit_rule_file" {
  description = "Absolute path to rendered Prometheus circuit-breaker rule YAML."
  type        = string
}

variable "lockwait_rule_file" {
  description = "Absolute path to rendered Prometheus PostgreSQL lock-wait rule YAML."
  type        = string
}

variable "pagerduty_routing_key" {
  description = "PagerDuty Events API routing key for retention production pages. Supply from a secret manager or CI secret; never commit it."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.pagerduty_routing_key)) > 0
    error_message = "pagerduty_routing_key must not be empty."
  }
}

variable "engineering_webhook_url" {
  description = "HTTPS engineering incident webhook destination. Supply from a secret manager or CI secret."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^https://", var.engineering_webhook_url))
    error_message = "engineering_webhook_url must use HTTPS."
  }
}

variable "runbook_url" {
  description = "HTTPS URL presented with retention circuit and lock-wait pages."
  type        = string

  validation {
    condition     = can(regex("^https://", var.runbook_url))
    error_message = "runbook_url must use HTTPS."
  }
}

variable "tags" {
  description = "Tags applied to AMP rule-group namespaces."
  type        = map(string)
  default = {
    System     = "UmojaFlowOS"
    Component  = "retention-alerting"
    ManagedBy  = "Terraform"
  }
}
