terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 6.0"
    }
  }
}

resource "aws_s3_bucket" "evidence" {
  bucket              = var.bucket_name
  object_lock_enabled = true
  force_destroy       = false
  tags                = var.tags
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.evidence]
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyUnencryptedObjectWrites"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.evidence.arn}/*"
        Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "AES256" } }
      },
      {
        Sid       = "DenyPublisherDestructiveActions"
        Effect    = "Deny"
        Principal = { AWS = aws_iam_role.publisher.arn }
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration", "s3:PutBucketPolicy", "s3:PutBucketVersioning", "s3:PutObjectAcl", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
        Resource  = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]
      },
      {
        Sid       = "DenyPublisherOverwriteOfImmutableEvidence"
        Effect    = "Deny"
        Principal = { AWS = aws_iam_role.publisher.arn }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.evidence.arn}/${var.prefix}/*"
        Condition = { StringEquals = { "s3:ExistingObjectTag/umoja-immutable" = "true" } }
      }
    ]
  })
}

data "aws_iam_policy_document" "github_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }
    condition { test = "StringEquals"; variable = "token.actions.githubusercontent.com:aud"; values = ["sts.amazonaws.com"] }
    condition { test = "StringEquals"; variable = "token.actions.githubusercontent.com:sub"; values = ["repo:${var.github_repository}:environment:${var.github_environment}"] }
  }
}

data "aws_iam_policy_document" "publisher_boundary" {
  statement {
    sid       = "AllowOnlyEvidencePublication"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:PutObject", "s3:GetObject"]
    resources = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/${var.prefix}/*"]
  }
  statement {
    sid       = "DenyWormMutationAndDeletion"
    effect    = "Deny"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration", "s3:PutBucketPolicy", "s3:PutBucketVersioning", "iam:*", "sts:AssumeRole"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "publisher_boundary" {
  name   = "${var.publisher_role_name}-permissions-boundary"
  policy = data.aws_iam_policy_document.publisher_boundary.json
  tags   = var.tags
}

resource "aws_iam_role" "publisher" {
  name                 = var.publisher_role_name
  assume_role_policy   = data.aws_iam_policy_document.github_trust.json
  permissions_boundary = aws_iam_policy.publisher_boundary.arn
  max_session_duration = 3600
  tags                 = var.tags
}

data "aws_iam_policy_document" "publisher" {
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.evidence.arn]
    condition { test = "StringLike"; variable = "s3:prefix"; values = ["${var.prefix}/*"] }
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.evidence.arn}/${var.prefix}/*"]
  }
}

resource "aws_iam_role_policy" "publisher" {
  name   = "${var.publisher_role_name}-object-lock-publish"
  role   = aws_iam_role.publisher.id
  policy = data.aws_iam_policy_document.publisher.json
}
