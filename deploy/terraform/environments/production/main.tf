terraform {
  required_version = ">= 1.6"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.80" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.35" }
    helm       = { source = "hashicorp/helm", version = "~> 2.17" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
    tls        = { source = "hashicorp/tls", version = "~> 4.0" }
  }

  # Configure remote state for your organisation, e.g.:
  # backend "s3" { bucket = "tf-state", key = "asset-management/production.tfstate", region = "us-east-1" }
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = var.tags }
  # Only object_storage = "aws" creates anything on AWS; otherwise the provider is never contacted
  # (it is configured but unused, so no AWS account or network access is needed).
  skip_credentials_validation = var.object_storage != "aws"
  skip_requesting_account_id  = var.object_storage != "aws"
  skip_metadata_api_check     = var.object_storage != "aws"
}

# Authenticate with `oc login` first; the providers reuse that kubeconfig context.
provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kubeconfig_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kubeconfig_context
  }
}

# An S3 bucket on AWS, only with object_storage = "aws".
module "documents" {
  count           = var.object_storage == "aws" ? 1 : 0
  source          = "../../modules/document-bucket"
  bucket_name     = var.bucket_name
  allowed_origins = [var.public_url]
  kms_key_arn     = var.kms_key_arn
  create_iam_user = var.create_s3_iam_user
  tags            = var.tags
}

module "app" {
  source         = "../../modules/openshift-release"
  namespace      = var.namespace
  chart_path     = "${path.module}/../../../helm/asset-management"
  image_registry = var.image_registry
  image_tag      = var.image_tag
  public_url     = var.public_url
  route_host     = trimprefix(var.public_url, "https://")
  database_url   = var.database_url

  # Air-gapped: images from Artifactory, pulled with these credentials.
  image_pull_secret = var.image_pull_secret
  mirror_registry   = var.mirror_registry

  managed_postgres  = var.managed_postgres
  object_storage    = var.object_storage == "in-cluster" ? "in-cluster" : "external"
  auth_mode         = var.auth_mode
  local_admin_email = var.local_admin_email
  mcp_enabled       = var.mcp_enabled
  smtp_url          = var.smtp_url
  mail_from         = var.mail_from

  reminder_timezone = var.reminder_timezone

  s3 = var.object_storage == "aws" ? {
    bucket            = module.documents[0].bucket
    region            = var.aws_region
    browser_origin    = module.documents[0].browser_origin
    access_key_id     = module.documents[0].access_key_id
    secret_access_key = module.documents[0].secret_access_key
    kms_key_id        = var.kms_key_arn
  } : var.object_storage == "s3" ? var.s3 : null
  ldap = var.ldap
  oidc = var.oidc
}
