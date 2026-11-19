variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "tags" {
  type    = map(string)
  default = { application = "asset-management", environment = "production" }
}

variable "kubeconfig_path" {
  type    = string
  default = "~/.kube/config"
}

variable "kubeconfig_context" {
  description = "Context of the target OpenShift cluster (see `oc config get-contexts`)."
  type        = string
}

variable "namespace" {
  type    = string
  default = "asset-management"
}

variable "public_url" {
  description = "https://assets.apps.<cluster-domain>"
  type        = string
}

variable "image_registry" {
  description = "Where the asset-management-* images were pushed."
  type        = string
  default     = "image-registry.openshift-image-registry.svc:5000/asset-management"
}

variable "image_tag" {
  type = string
}

variable "bucket_name" {
  type = string
}

variable "kms_key_arn" {
  type    = string
  default = null
}

variable "create_s3_iam_user" {
  type    = bool
  default = true
}

variable "database_url" {
  type      = string
  sensitive = true
}

variable "smtp_url" {
  type      = string
  sensitive = true
}

variable "mail_from" {
  type    = string
  default = "Asset Management <assets@example.com>"
}

variable "reminder_timezone" {
  type    = string
  default = "UTC"
}

variable "ldap" {
  type      = any
  default   = { enabled = false }
  sensitive = true
}

variable "oidc" {
  type      = any
  default   = { enabled = false }
  sensitive = true
}
