output "workspace_id" {
  description = "AMP workspace receiving the retention alert configuration."
  value       = var.workspace_id
}

output "circuit_rule_group_namespace_arn" {
  description = "ARN of the deployed retention circuit rule-group namespace."
  value       = aws_prometheus_rule_group_namespace.retention_circuit.arn
}

output "lockwait_rule_group_namespace_arn" {
  description = "ARN of the deployed retention lock-wait rule-group namespace."
  value       = aws_prometheus_rule_group_namespace.retention_lockwait.arn
}
