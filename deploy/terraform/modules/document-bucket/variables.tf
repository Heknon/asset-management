variable "bucket_name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "allowed_origins" {
  description = "Browser origins allowed to upload and preview (the app's public URL)."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for SSE-KMS; null uses SSE-S3 (AES256)."
  type        = string
  default     = null
}

variable "create_iam_user" {
  description = "Create an IAM user and access key for the files service."
  type        = bool
  default     = true
}

variable "noncurrent_version_retention_days" {
  description = "How long overwritten/deleted document versions are kept."
  type        = number
  default     = 90
}

variable "force_destroy" {
  description = "Allow destroying a non-empty bucket (never in production)."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
