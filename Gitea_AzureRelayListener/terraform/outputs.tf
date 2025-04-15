output "relay_namespace" {
  description = "The Azure Relay namespace"
  value       = var.relay_namespace
}

output "hybrid_connection_name" {
  description = "The Azure Relay hybrid connection name"
  value       = var.hybrid_connection_name
}

output "gitea_app_url" {
  description = "The URL to access the Gitea web interface"
  value       = "https://${azurerm_linux_web_app.gitea_app.default_hostname}"
}

output "relay_listener_app_url" {
  description = "The URL of the relay listener app"
  value       = "https://${azurerm_linux_web_app.relay_listener_app.default_hostname}"
}

output "postgres_server_fqdn" {
  description = "The fully qualified domain name of the PostgreSQL server"
  value       = azurerm_postgresql_flexible_server.gitea_db.fqdn
}

output "key_vault_name" {
  description = "The name of the Key Vault where secrets are stored"
  value       = azurerm_key_vault.gitea_kv.name
}

output "postgres_password_secret_id" {
  description = "The ID of the PostgreSQL password secret in Key Vault"
  value       = azurerm_key_vault_secret.postgres_password.id
  sensitive   = true
}
