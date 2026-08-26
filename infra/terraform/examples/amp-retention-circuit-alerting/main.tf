terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "retention_amp_alerting" {
  source = "../../modules/amp-retention-circuit-alerting"

  workspace_id       = var.amp_workspace_id
  circuit_rule_file  = "${path.module}/../../../retention-gateway/prometheus-production-circuit-alerts.yml"
  lockwait_rule_file = "${path.module}/../../../retention-gateway/prometheus-production-lockwait-alerts.yml"

  pagerduty_routing_key   = var.retention_pagerduty_routing_key
  engineering_webhook_url = var.retention_engineering_webhook_url
  runbook_url             = var.runbook_url

  tags = {
    System      = "UmojaFlowOS"
    Environment = "production"
    Owner       = "platform-engineering"
  }
}
