output "url" {
  value = module.app.url
}

output "documents_bucket" {
  value = module.documents.bucket
}

output "local_admin_password" {
  value     = module.app.local_admin_password
  sensitive = true
}
