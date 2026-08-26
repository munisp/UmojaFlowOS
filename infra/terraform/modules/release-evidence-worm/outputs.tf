output "bucket_name" {
  value       = aws_s3_bucket.evidence.bucket
  description = "Immutable evidence bucket name."
}

output "bucket_arn" {
  value       = aws_s3_bucket.evidence.arn
  description = "Immutable evidence bucket ARN."
}

output "publisher_role_arn" {
  value       = aws_iam_role.publisher.arn
  description = "GitHub OIDC publisher role ARN."
}

output "evidence_prefix" {
  value       = var.prefix
  description = "Prefix root allowed to the publisher role."
}
