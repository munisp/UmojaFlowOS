variable "aws_region" {
  type        = string
  description = "AWS region for the evidence bucket."
  default     = "eu-west-1"
}

variable "bucket_name" {
  type        = string
  description = "Globally unique lowercase evidence bucket name."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid lowercase S3 bucket name."
  }
}

variable "prefix" {
  type        = string
  description = "Normalized evidence prefix without traversal or duplicate separators."
  default     = "umoja/releases"
  validation {
    condition     = var.prefix != "" && !startswith(var.prefix, "/") && !endswith(var.prefix, "/") && !strcontains(var.prefix, "..") && !strcontains(var.prefix, "//")
    error_message = "prefix must be normalized and must not begin/end with slash or contain traversal."
  }
}

variable "retention_days" {
  type        = number
  description = "Approved default Object Lock COMPLIANCE retention period."
  validation {
    condition     = var.retention_days >= 30
    error_message = "retention_days must be at least 30 days; set it according to approved records policy."
  }
}

variable "github_oidc_provider_arn" { type = string }
variable "github_repository" { type = string }
variable "github_environment" { type = string, default = "production-release-evidence" }
variable "publisher_role_name" { type = string, default = "umoja-release-evidence-publisher" }
variable "tags" { type = map(string), default = {} }
