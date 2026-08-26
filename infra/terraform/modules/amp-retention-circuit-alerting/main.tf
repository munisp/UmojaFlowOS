terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  alertmanager_definition = templatefile("${path.module}/templates/alertmanager.yaml.tftpl", {
    pagerduty_routing_key = var.pagerduty_routing_key
    engineering_webhook   = var.engineering_webhook_url
    environment           = var.environment
    runbook_url           = var.runbook_url
  })
}

resource "aws_prometheus_rule_group_namespace" "retention_circuit" {
  name         = var.rule_group_namespace
  workspace_id = var.workspace_id
  data         = file(var.circuit_rule_file)
  tags         = var.tags
}

resource "aws_prometheus_rule_group_namespace" "retention_lockwait" {
  name         = "${var.rule_group_namespace}-lockwait"
  workspace_id = var.workspace_id
  data         = file(var.lockwait_rule_file)
  tags         = var.tags
}

resource "aws_prometheus_alert_manager_definition" "retention" {
  workspace_id = var.workspace_id
  definition   = local.alertmanager_definition
}
