terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "release_evidence_worm" {
  source = "../../modules/release-evidence-worm"

  bucket_name              = var.bucket_name
  prefix                   = var.prefix
  retention_days           = var.retention_days
  github_oidc_provider_arn = var.github_oidc_provider_arn
  github_repository        = var.github_repository
  github_environment       = var.github_environment
  publisher_role_name      = var.publisher_role_name
  tags = merge(var.tags, {
    system       = "umojaflowos"
    data_class   = "regulatory-evidence"
    retention    = "object-lock-compliance"
    managed_by   = "opentofu"
  })
}

output "bucket_name" { value = var.bucket_name }
output "publisher_role_arn" { value = module.release_evidence_worm.publisher_role_arn }
output "object_lock_mode" { value = "COMPLIANCE" }
output "retention_days" { value = var.retention_days }
