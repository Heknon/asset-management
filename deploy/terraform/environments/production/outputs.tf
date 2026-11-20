output "url" {
  value = module.app.url
}

output "documents_bucket" {
  value = var.managed_object_storage ? module.documents[0].bucket : "in-cluster MinIO"
}

output "local_admin_password" {
  value     = module.app.local_admin_password
  sensitive = true
}

output "mcp_url" {
  description = "Add this URL as an MCP server (remote / Streamable HTTP) in Claude or another client; people sign in and press Accept."
  value       = var.mcp_enabled ? "${module.app.url}/mcp" : null
}
