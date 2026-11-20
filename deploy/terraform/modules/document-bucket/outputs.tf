output "bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "region" {
  value = aws_s3_bucket.documents.region
}

output "arn" {
  value = aws_s3_bucket.documents.arn
}

output "service_policy_arn" {
  description = "Attach to a workload role when using AWS STS instead of the IAM user."
  value       = aws_iam_policy.service.arn
}

# Virtual-hosted origin that browsers use for presigned URLs (for the CSP).
output "browser_origin" {
  value = "https://${aws_s3_bucket.documents.bucket_regional_domain_name}"
}

output "access_key_id" {
  value     = try(aws_iam_access_key.service[0].id, null)
  sensitive = true
}

output "secret_access_key" {
  value     = try(aws_iam_access_key.service[0].secret, null)
  sensitive = true
}
