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

variable "image_pull_secret" {
  description = "Artifactory (or other private registry) credentials for pulling images: { server, username, password }."
  type = object({
    server   = string
    username = string
    password = string
  })
  default   = null
  sensitive = true
}

variable "mirror_registry" {
  description = "Registry mirror for third-party images when air-gapped, e.g. artifactory.example.com/docker-remote."
  type        = string
  default     = ""
}

variable "managed_postgres" {
  description = "true: managed PostgreSQL at database_url. false: PostgreSQL runs in the namespace."
  type        = bool
  default     = true
}

variable "managed_object_storage" {
  description = "true: an AWS S3 bucket (document-bucket module). false: MinIO runs in the namespace."
  type        = bool
  default     = true
}

variable "auth_mode" {
  description = "Sign-in methods: manual, ldap, adfs, comma-separated. Empty = from local_admin / ldap / oidc settings."
  type        = string
  default     = ""
}

variable "mcp_enabled" {
  description = "Serve the MCP endpoint (<public_url>/mcp) for AI assistants."
  type        = bool
  default     = true
}

variable "bucket_name" {
  type    = string
  default = "asset-management-documents"
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
  description = "Required when managed_postgres = true."
  type        = string
  default     = null
  sensitive   = true
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
