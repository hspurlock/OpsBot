variable "prefix" {
  description = "Prefix for all resource names"
  type        = string
  default     = "gitea"
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
  default     = "gitea-relay-rg"
}

variable "location" {
  description = "Azure region to deploy resources"
  type        = string
  default     = "usgovvirginia"
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {
    Environment = "Development"
    Project     = "GitProxy"
  }
}

variable "relay_namespace" {
  description = "Name of the Azure Relay namespace"
  type        = string
  default     = "gitea-relay-ns"
}

variable "hybrid_connection_name" {
  description = "Name of the Azure Relay hybrid connection"
  type        = string
  default     = "gitea-connection"
}

variable "db_admin_password" {
  description = "Admin password for the PostgreSQL database - will be generated and stored in Key Vault if not provided"
  type        = string
  sensitive   = true
  default     = null
}

variable "admin_ip_address" {
  description = "Admin IP address allowed to access the resources (your current IP)"
  type        = string
  default     = null  # Should be set to your specific IP address
}



variable "relay_listener_app_name" {
  description = "Name of the Azure Relay listener App Service"
  type        = string
  default     = "relay-listener"
}


variable "vnet_address_space" {
  description = "Address space for the virtual network"
  type        = string
  default     = "10.0.0.0/24"
}

variable "admin_username" {
  description = "Admin username for the PostgreSQL database"
  type        = string
  default     = "giteaadmin"
}