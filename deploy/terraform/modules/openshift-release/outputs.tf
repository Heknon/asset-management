output "url" {
  value = var.public_url
}

output "local_admin_password" {
  description = "Break-glass administrator password (username: admin)."
  value       = var.local_admin_enabled ? random_password.local_admin.result : null
  sensitive   = true
}

output "jwt_public_key_pem" {
  value = tls_private_key.jwt.public_key_pem
}
