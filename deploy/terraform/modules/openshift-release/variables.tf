variable "namespace" {
  type = string
}

variable "create_namespace" {
  description = "Create the namespace. Set false when an OpenShift project already exists (e.g. via `oc new-project`)."
  type        = bool
  default     = true
}

variable "release_name" {
  type    = string
  default = "assets"
}

variable "chart_path" {
  description = "Path to the Helm chart."
  type        = string
}

variable "image_registry" {
  description = "Registry and namespace holding the asset-management-* images."
  type        = string
}

variable "image_tag" {
  type = string
}

variable "public_url" {
  description = "External URL of the app, e.g. https://assets.apps.ocp.example.com"
  type        = string
}

variable "openshift_route" {
  type    = bool
  default = true
}

variable "route_host" {
  description = "Route host; empty lets OpenShift generate one."
  type        = string
  default     = ""
}

variable "database_url" {
  description = "postgres:// URL of the application database (one database; each service owns a schema)."
  type        = string
  sensitive   = true
}

variable "database_ssl" {
  type    = bool
  default = true
}

variable "smtp_url" {
  description = "smtp(s):// relay used for reminder emails and Outlook invites, e.g. smtp://relay.corp.example.com:25"
  type        = string
  sensitive   = true
}

variable "mail_from" {
  type    = string
  default = "Asset Management <assets@example.com>"
}

variable "csv_export_enabled" {
  description = "Let people export tables to CSV (only rows they can see)."
  type        = bool
  default     = true
}

variable "request_inbox_emails" {
  description = "Shared mailboxes told about every new request (e.g. procurement@corp.com)."
  type        = list(string)
  default     = []
}

variable "reminder_timezone" {
  type    = string
  default = "UTC"
}

variable "log_level" {
  type    = string
  default = "info"
}

variable "local_admin_enabled" {
  description = "Keep the break-glass local administrator (password is generated and output)."
  type        = bool
  default     = true
}

variable "s3" {
  type = object({
    bucket            = string
    region            = string
    browser_origin    = string
    endpoint          = optional(string)
    public_endpoint   = optional(string)
    force_path_style  = optional(bool, false)
    access_key_id     = optional(string)
    secret_access_key = optional(string)
    kms_key_id        = optional(string)
  })
  sensitive = true
}

variable "ldap" {
  type = object({
    enabled         = bool
    url             = optional(string, "")
    start_tls       = optional(bool, false)
    ca_cert         = optional(string)
    bind_dn         = optional(string, "")
    bind_password   = optional(string)
    user_base_dn    = optional(string, "")
    user_filter     = optional(string, "(&(objectClass=person)(|(sAMAccountName={username})(userPrincipalName={username})))")
    admin_groups    = optional(list(string), [])
    unit_attributes = optional(list(string), ["department"])
  })
  default   = { enabled = false }
  sensitive = true
}

variable "oidc" {
  description = "ADFS (OpenID Connect). Register <public_url>/api/identity/auth/oidc/callback as the redirect URI."
  type = object({
    enabled         = bool
    issuer        = optional(string, "")
    client_id     = optional(string, "")
    client_secret = optional(string)
    groups_claim  = optional(string, "group")
    admin_groups    = optional(list(string), [])
    unit_claims   = optional(list(string), ["department"])
  })
  default   = { enabled = false }
  sensitive = true
}

variable "extra_values" {
  description = "Additional Helm values merged last (replicas, resources, ...)."
  type        = any
  default     = {}
}
