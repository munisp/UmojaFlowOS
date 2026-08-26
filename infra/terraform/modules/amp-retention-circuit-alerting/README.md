# AMP Retention Circuit Alerting Module

This Terraform module deploys the UmojaFlowOS retention circuit-breaker and PostgreSQL lock-wait rule bundles to an existing Amazon Managed Service for Prometheus (AMP) workspace. It also writes the corresponding AMP Alertmanager definition for PagerDuty and engineering-webhook delivery.

## Resources

| Resource | Purpose |
|---|---|
| `aws_prometheus_rule_group_namespace.retention_circuit` | Deploys circuit-open, circuit-transition, and circuit-rejection rules |
| `aws_prometheus_rule_group_namespace.retention_lockwait` | Deploys PostgreSQL lock-wait warning and critical rules |
| `aws_prometheus_alert_manager_definition.retention` | Deploys Alertmanager routing and receivers for the AMP workspace |

The module assumes that AMP already receives the worker metric series with `environment="production"`, including `umoja_retention_worker_db_circuit_state`, `umoja_retention_worker_db_circuit_open_total`, and `umoja_retention_worker_db_circuit_rejections_total`.

## Usage

```hcl
module "retention_amp_alerting" {
  source = "../../modules/amp-retention-circuit-alerting"

  workspace_id       = var.amp_workspace_id
  circuit_rule_file  = "${path.root}/../../../retention-gateway/prometheus-production-circuit-alerts.yml"
  lockwait_rule_file = "${path.root}/../../../retention-gateway/prometheus-production-lockwait-alerts.yml"

  pagerduty_routing_key   = var.retention_pagerduty_routing_key
  engineering_webhook_url = var.retention_engineering_webhook_url
  runbook_url             = "https://operations.example.com/runbooks/retention-worker-postgres-circuit"

  tags = {
    System      = "UmojaFlowOS"
    Environment = "production"
    Owner       = "platform-engineering"
  }
}
```

Pass `pagerduty_routing_key` and `engineering_webhook_url` from a protected CI secret, a secret manager integration, or a Terraform Cloud variable marked sensitive. Do not put them in `terraform.tfvars` committed to source control.

## State protection

AMP stores the Alertmanager definition as a single resource body. That body includes the PagerDuty routing key and webhook URL. Although the variables are marked `sensitive`, Terraform state still contains the underlying configuration. Use an encrypted remote state backend, restrict read access to platform deployment identities, enable versioning, and retain audit logs for state access.

## Example environment

An example root module is provided at `infra/terraform/examples/amp-retention-circuit-alerting`. It does not create an AMP workspace and does not create PagerDuty or webhook secrets. It consumes an existing workspace and protected inputs.

## Validation

Run local static checks before an approved apply:

```bash
terraform fmt -recursive infra/terraform/modules/amp-retention-circuit-alerting
terraform -chdir=infra/terraform/examples/amp-retention-circuit-alerting init -backend=false
terraform -chdir=infra/terraform/examples/amp-retention-circuit-alerting validate
```

Then run the repository dry-run validator for source Prometheus and Alertmanager configuration:

```bash
PROMTOOL_BIN=/path/to/promtool \
AMTOOL_BIN=/path/to/amtool \
./scripts/infra/dry_run_retention_circuit_alerting.sh
```

## References

[1]: https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/prometheus_rule_group_namespace "Terraform AWS Provider — AMP Rule Group Namespace"
[2]: https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/prometheus_alert_manager_definition "Terraform AWS Provider — AMP Alert Manager Definition"
[3]: https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-rules-upload.html "AWS Documentation — Rule group namespaces"
