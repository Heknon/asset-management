# Private, encrypted, versioned S3 bucket for asset documents. Browsers only
# ever touch it through short-lived presigned URLs issued by the files service.

data "aws_partition" "current" {}

resource "aws_s3_bucket" "documents" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
  tags          = var.tags
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

# Presigned POST uploads and inline previews come straight from the browser.
resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["GET", "HEAD", "POST"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "housekeeping"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.documents]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket     = aws_s3_bucket.documents.id
  policy     = data.aws_iam_policy_document.bucket.json
  depends_on = [aws_s3_bucket_public_access_block.documents]
}

# Least privilege for the files service: objects under assets/ only.
data "aws_iam_policy_document" "service" {
  statement {
    sid       = "Objects"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.documents.arn}/assets/*"]
  }
  statement {
    # Lets HeadObject return 404 (not 403) for uploads that never arrived.
    sid       = "ListPrefix"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.documents.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["assets/*"]
    }
  }
  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]
    content {
      sid       = "Kms"
      actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_policy" "service" {
  name        = "${var.bucket_name}-files-service"
  description = "Asset Management files service access to ${var.bucket_name}"
  policy      = data.aws_iam_policy_document.service.json
  tags        = var.tags
}

# Static credentials for clusters without AWS workload identity (typical for
# on-prem OpenShift). With ROSA/STS, attach the policy to a role instead.
resource "aws_iam_user" "service" {
  count = var.create_iam_user ? 1 : 0
  name  = "${var.bucket_name}-files-service"
  tags  = var.tags
}

resource "aws_iam_user_policy_attachment" "service" {
  count      = var.create_iam_user ? 1 : 0
  user       = aws_iam_user.service[0].name
  policy_arn = aws_iam_policy.service.arn
}

resource "aws_iam_access_key" "service" {
  count = var.create_iam_user ? 1 : 0
  user  = aws_iam_user.service[0].name
}
