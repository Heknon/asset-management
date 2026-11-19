# Namespace, generated secrets and the Helm release for one environment.

locals {
  secret_name = "asset-management"
  labels      = { "app.kubernetes.io/part-of" = "asset-management", "app.kubernetes.io/managed-by" = "terraform" }

  # Only non-empty keys end up in the Secret; the chart marks optional keys as such.
  secret_data = { for k, v in {
    DATABASE_URL         = var.database_url
    AUTH_SIGNING_KEY     = tls_private_key.jwt.private_key_pem_pkcs8
    COOKIE_SECRET        = random_password.cookie.result
    LOCAL_ADMIN_PASSWORD = var.local_admin_enabled ? random_password.local_admin.result : null
    SMTP_URL             = var.smtp_url
    S3_ACCESS_KEY_ID     = var.s3.access_key_id
    S3_SECRET_ACCESS_KEY = var.s3.secret_access_key
    S3_KMS_KEY_ID        = var.s3.kms_key_id
    LDAP_BIND_PASSWORD   = var.ldap.bind_password
    LDAP_CA_CERT         = var.ldap.ca_cert
    OIDC_CLIENT_SECRET   = var.oidc.client_secret
  } : k => v if v != null && v != "" }
}

resource "kubernetes_namespace_v1" "this" {
  count = var.create_namespace ? 1 : 0
  metadata {
    name   = var.namespace
    labels = local.labels
  }
}

# ES256 key for access tokens; rotate with `terraform apply -replace=...tls_private_key.jwt`.
resource "tls_private_key" "jwt" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "random_password" "cookie" {
  length  = 48
  special = false
}

resource "random_password" "local_admin" {
  length  = 24
  special = true
}

resource "kubernetes_secret_v1" "app" {
  metadata {
    name      = local.secret_name
    namespace = var.namespace
    labels    = local.labels
  }
  data       = local.secret_data
  depends_on = [kubernetes_namespace_v1.this]
}

resource "helm_release" "app" {
  name             = var.release_name
  namespace        = var.namespace
  chart            = var.chart_path
  create_namespace = false
  atomic           = true
  cleanup_on_fail  = true
  wait             = true
  timeout          = 600

  values = [
    yamlencode({
      publicUrl = var.public_url
      image     = { registry = var.image_registry, tag = var.image_tag }
      route     = { enabled = var.openshift_route, host = var.route_host }
      secrets   = { existingSecret = local.secret_name, create = false }
      config    = { LOG_LEVEL = var.log_level, DATABASE_SSL = tostring(var.database_ssl) }
      services = {
        identity = {
          env = merge(
            {
              LOCAL_AUTH_ENABLED   = tostring(var.local_admin_enabled)
              LOCAL_ADMIN_USERNAME = "admin"
              LDAP_ENABLED         = tostring(var.ldap.enabled)
              OIDC_ENABLED         = tostring(var.oidc.enabled)
            },
            var.ldap.enabled ? {
              LDAP_URL             = var.ldap.url
              LDAP_STARTTLS        = tostring(var.ldap.start_tls)
              LDAP_BIND_DN         = var.ldap.bind_dn
              LDAP_USER_BASE_DN    = var.ldap.user_base_dn
              LDAP_USER_FILTER     = var.ldap.user_filter
              LDAP_ADMIN_GROUPS    = join(",", var.ldap.admin_groups)
              LDAP_UNIT_ATTRIBUTES = join(",", var.ldap.unit_attributes)
            } : {},
            var.oidc.enabled ? {
              OIDC_ISSUER       = var.oidc.issuer
              OIDC_CLIENT_ID    = var.oidc.client_id
              OIDC_GROUPS_CLAIM = var.oidc.groups_claim
              OIDC_ADMIN_GROUPS = join(",", var.oidc.admin_groups)
              OIDC_UNIT_CLAIMS  = join(",", var.oidc.unit_claims)
            } : {},
          )
        }
        files = {
          env = {
            S3_BUCKET           = var.s3.bucket
            S3_REGION           = var.s3.region
            S3_ENDPOINT         = (var.s3.endpoint == null ? "" : var.s3.endpoint)
            S3_PUBLIC_ENDPOINT  = (var.s3.public_endpoint == null ? "" : var.s3.public_endpoint)
            S3_FORCE_PATH_STYLE = tostring(var.s3.force_path_style)
            S3_SSE              = (var.s3.kms_key_id == null ? "AES256" : "aws:kms")
          }
        }
        registry = {
          env = { CSV_EXPORT_ENABLED = tostring(var.csv_export_enabled) }
        }
        scheduler = {
          env = { MAIL_FROM = var.mail_from, REMINDER_TIMEZONE = var.reminder_timezone, REQUEST_INBOX_EMAILS = join(",", var.request_inbox_emails) }
        }
      }
      web = { s3Origin = var.s3.browser_origin }
    }),
    yamlencode(var.extra_values),
  ]

  depends_on = [kubernetes_secret_v1.app]
}
