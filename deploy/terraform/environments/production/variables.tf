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

variable "object_storage" {
  description = <<-EOT
    Where documents are stored:
      aws        - Terraform creates a private S3 bucket on AWS (document-bucket module)
      s3         - an S3-compatible service you already run: MinIO, OpenShift Data Foundation (NooBaa),
                   Ceph RGW, another cloud's S3 API, or an existing AWS bucket — set `s3`
      in-cluster - the chart runs MinIO in the namespace (nothing outside the cluster)
  EOT
  type        = string
  default     = "s3"
  validation {
    condition     = contains(["aws", "s3", "in-cluster"], var.object_storage)
    error_message = "object_storage is \"aws\", \"s3\" or \"in-cluster\"."
  }
}

variable "s3" {
  description = "With object_storage = \"s3\": endpoint, bucket and keys of your S3-compatible storage (see the openshift-release module's s3 variable for every field)."
  type        = any
  default     = null
  sensitive   = true
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
  description = "With object_storage = \"aws\": the bucket Terraform creates."
  type        = string
  default     = "asset-management-documents"
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

variable "local_admin_email" {
  description = "Email of the break-glass administrator (optional)."
  type        = string
  default     = null
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
