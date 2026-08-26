variable "bucket_name" {
  type        = string
  description = "Globally unique S3 bucket name for immutable release evidence."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid lowercase S3 bucket name."
  }
}

variable "retention_days" {
  type        = number
  description = "Default Object Lock COMPLIANCE retention in days."
  validation {
    condition     = var.retention_days >= 30
    error_message = "retention_days must be at least 30 days."
  }
}

variable "github_oidc_provider_arn" {
  type        = string
  description = "ARN of the existing token.actions.githubusercontent.com IAM OIDC provider."
}

variable "github_repository" {
  type        = string
  description = "GitHub owner/repository allowed to assume the publisher role."
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must have owner/repository form."
  }
}

variable "github_environment" {
  type        = string
  description = "Protected GitHub environment name allowed by the trust policy."
  default     = "production-release-evidence"
}

variable "publisher_role_name" {
  type        = string
  description = "IAM role assumed by the protected evidence publication workflow."
  default     = "umoja-release-evidence-publisher"
}

variable "prefix" {
  type        = string
  description = "Allowed immutable object prefix root."
  default     = "umoja/releases"
  validation {
    condition     = var.prefix != "" && !strcontains(var.prefix, "..") && !strcontains(var.prefix, "//")
    error_message = "prefix must be a nonempty normalized path without traversal."
  }
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to created AWS resources."
  default     = {}
}
