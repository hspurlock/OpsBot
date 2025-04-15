terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = true
    }
  }
  environment = "usgovernment"
}

# Get current Azure client configuration
data "azurerm_client_config" "current" {}

# Resource Group
resource "azurerm_resource_group" "gitea_rg" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

# Virtual Network for private connectivity
resource "azurerm_virtual_network" "gitea_vnet" {
  name                = "${var.prefix}-vnet"
  address_space       = [var.vnet_address_space]
  location            = azurerm_resource_group.gitea_rg.location
  resource_group_name = azurerm_resource_group.gitea_rg.name
  tags                = var.tags
}

# Subnet for App Service integration
resource "azurerm_subnet" "app_service_subnet" {
  name                 = "${var.prefix}-app-subnet"
  resource_group_name  = azurerm_resource_group.gitea_rg.name
  virtual_network_name = azurerm_virtual_network.gitea_vnet.name
  address_prefixes     = ["10.0.0.0/26"]
  service_endpoints    = ["Microsoft.Web", "Microsoft.Storage"]
  delegation {
    name = "appservice-delegation"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

# Subnet for PostgreSQL
resource "azurerm_subnet" "postgres_subnet" {
  name                 = "${var.prefix}-postgres-subnet"
  resource_group_name  = azurerm_resource_group.gitea_rg.name
  virtual_network_name = azurerm_virtual_network.gitea_vnet.name
  address_prefixes     = ["10.0.0.64/26"]
  service_endpoints    = ["Microsoft.Sql"]
  delegation {
    name = "postgres-delegation"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Subnet for Private Endpoints
resource "azurerm_subnet" "private_endpoint_subnet" {
  name                 = "${var.prefix}-pe-subnet"
  resource_group_name  = azurerm_resource_group.gitea_rg.name
  virtual_network_name = azurerm_virtual_network.gitea_vnet.name
  address_prefixes     = ["10.0.0.128/26"]
  private_endpoint_network_policies = "Disabled"
}

# Azure Relay Namespace
resource "azurerm_relay_namespace" "gitea_relay" {
  name                = var.relay_namespace
  location            = azurerm_resource_group.gitea_rg.location
  resource_group_name = azurerm_resource_group.gitea_rg.name
  sku_name            = "Standard"
  tags                = var.tags
  
  # Azure Government specific settings
  # The environment is automatically detected by the provider
}

# Azure Relay Hybrid Connection
resource "azurerm_relay_hybrid_connection" "gitea_connection" {
  name                 = var.hybrid_connection_name
  resource_group_name  = azurerm_resource_group.gitea_rg.name
  relay_namespace_name = azurerm_relay_namespace.gitea_relay.name
  requires_client_authorization = true
}

# Authorization Rule for the Relay
resource "azurerm_relay_hybrid_connection_authorization_rule" "gitea_auth" {
  name                   = "RootManageSharedAccessKey"
  resource_group_name    = azurerm_resource_group.gitea_rg.name
  hybrid_connection_name = azurerm_relay_hybrid_connection.gitea_connection.name
  namespace_name         = azurerm_relay_namespace.gitea_relay.name
  
  listen = true
  send   = true
  manage = true
}

# Generate a random password for PostgreSQL if not provided
resource "random_password" "postgres_password" {
  length           = 16
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
  min_lower        = 1
  min_upper        = 1
  min_numeric      = 1
  min_special      = 1
}

# Azure Key Vault for storing secrets
resource "azurerm_key_vault" "gitea_kv" {
  name                        = "${var.prefix}-kv"
  location                    = azurerm_resource_group.gitea_rg.location
  resource_group_name         = azurerm_resource_group.gitea_rg.name
  enabled_for_disk_encryption = true
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  soft_delete_retention_days  = 7
  purge_protection_enabled    = false

  sku_name = "standard"
  
  # Restrict public network access but allow admin IP
  public_network_access_enabled = true
  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
    ip_rules       = var.admin_ip_address != null ? [var.admin_ip_address] : []
  }

  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    key_permissions = [
      "Get", "List", "Create", "Delete", "Update",
    ]

    secret_permissions = [
      "Get", "List", "Set", "Delete",
    ]
  }

  tags = var.tags
}

# Private endpoint for Key Vault
resource "azurerm_private_endpoint" "key_vault_endpoint" {
  name                = "${var.prefix}-kv-endpoint"
  location            = azurerm_resource_group.gitea_rg.location
  resource_group_name = azurerm_resource_group.gitea_rg.name
  subnet_id           = azurerm_subnet.private_endpoint_subnet.id

  private_service_connection {
    name                           = "${var.prefix}-kv-connection"
    private_connection_resource_id = azurerm_key_vault.gitea_kv.id
    is_manual_connection           = false
    subresource_names              = ["vault"]
  }
}

# Store the PostgreSQL password in Key Vault
resource "azurerm_key_vault_secret" "postgres_password" {
  name         = "postgres-admin-password"
  value        = var.db_admin_password != null ? var.db_admin_password : random_password.postgres_password.result
  key_vault_id = azurerm_key_vault.gitea_kv.id
}

# PostgreSQL Flexible Server
resource "azurerm_postgresql_flexible_server" "gitea_db" {
  name                   = "${var.prefix}-postgres"
  resource_group_name    = azurerm_resource_group.gitea_rg.name
  location               = azurerm_resource_group.gitea_rg.location
  version                = "14"
  delegated_subnet_id    = azurerm_subnet.postgres_subnet.id
  private_dns_zone_id    = azurerm_private_dns_zone.postgres.id
  administrator_login    = var.admin_username
  administrator_password = var.db_admin_password != null ? var.db_admin_password : random_password.postgres_password.result
  zone                   = "1"
  storage_mb             = 32768
  sku_name               = "B_Standard_B1ms"
  backup_retention_days  = 7
  tags                   = var.tags
  
  # Explicitly disable public network access when using private networking
  public_network_access_enabled = false

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

# PostgreSQL Database
resource "azurerm_postgresql_flexible_server_database" "gitea_db" {
  name      = "gitea"
  server_id = azurerm_postgresql_flexible_server.gitea_db.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# Instead of using firewall rules, we'll rely on private networking
# The PostgreSQL server is already in a delegated subnet with private DNS zone
# and the App Service is already connected to the VNet

# PostgreSQL Configuration for allowing connections
resource "azurerm_postgresql_flexible_server_configuration" "gitea_db_config" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.gitea_db.id
  value     = "off"
}

# Private DNS Zone for PostgreSQL
resource "azurerm_private_dns_zone" "postgres" {
  name                = "${var.prefix}-postgres.private.postgres.database.usgovcloudapi.net"
  resource_group_name = azurerm_resource_group.gitea_rg.name
}

# Link the private DNS zone to the virtual network
resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${var.prefix}-postgres-link"
  resource_group_name   = azurerm_resource_group.gitea_rg.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.gitea_vnet.id
}

# App Service Plan for containers
resource "azurerm_service_plan" "gitea_plan" {
  name                = "${var.prefix}-plan"
  resource_group_name = azurerm_resource_group.gitea_rg.name
  location            = azurerm_resource_group.gitea_rg.location
  os_type             = "Linux"
  sku_name            = "P1v2"
  tags                = var.tags
}

# App Service for Gitea
resource "azurerm_linux_web_app" "gitea_app" {
  name                = "${var.prefix}-app"
  resource_group_name = azurerm_resource_group.gitea_rg.name
  location            = azurerm_resource_group.gitea_rg.location
  service_plan_id     = azurerm_service_plan.gitea_plan.id
  tags                = var.tags

  site_config {
    always_on        = true
    app_command_line = ""

    application_stack {
      docker_image_name        = "gitea/gitea:latest"
      docker_registry_url      = "https://index.docker.io"
      docker_registry_username = null
      docker_registry_password = null
    }
    
    # IP restrictions - only if admin_ip_address is provided
    dynamic "ip_restriction" {
      for_each = var.admin_ip_address != null ? [1] : []
      content {
        action     = "Allow"
        ip_address = "${var.admin_ip_address}/32"
        name       = "AllowAdminIP"
        priority   = 100
      }
    }
    
    # Allow VNet traffic
    ip_restriction {
      action     = "Allow"
      ip_address = var.vnet_address_space
      name       = "AllowVNetTraffic"
      priority   = 150
    }
    
    # Allow Azure portal and deployment services
    ip_restriction {
      action      = "Allow"
      service_tag = "AzureCloud"
      name        = "AllowAzureServices"
      priority    = 200
    }
  }

  app_settings = {
    # Gitea configuration
    "GITEA__database__DB_TYPE"      = "postgres"
    "GITEA__database__HOST"         = "${azurerm_postgresql_flexible_server.gitea_db.fqdn}:5432"
    "GITEA__database__NAME"         = azurerm_postgresql_flexible_server_database.gitea_db.name
    "GITEA__database__USER"         = var.admin_username
    # Using direct password instead of Key Vault reference for Azure Government compatibility
    "GITEA__database__PASSWD"       = var.db_admin_password != null ? var.db_admin_password : random_password.postgres_password.result
    
    # Server configuration for Azure Government
    "GITEA__server__DOMAIN"         = "${var.prefix}-app.azurewebsites.us"
    "GITEA__server__ROOT_URL"       = "https://${var.prefix}-app.azurewebsites.us/"
    "GITEA__server__SSH_DOMAIN"     = "${var.prefix}-app.azurewebsites.us"
    "GITEA__server__HTTP_PORT"      = "8080"
    "GITEA__server__DISABLE_SSH"    = "true"
    "GITEA__server__PROTOCOL"       = "https"
    "GITEA__server__ENABLE_GZIP"    = "true"
    "WEBSITES_PORT"                 = "8080"
    
    # Proxy configuration for Azure Relay
    "GITEA__service__ENABLE_REVERSE_PROXY_AUTHENTICATION" = "true"
    "GITEA__service__ENABLE_REVERSE_PROXY_AUTO_REGISTRATION" = "true"
    "GITEA__security__REVERSE_PROXY_TRUSTED_PROXIES" = "*"
    "GITEA__security__REVERSE_PROXY_LIMIT" = "1"
    
    # Storage configuration
    "GITEA__repository__ROOT"       = "/data/gitea/repos"
    "GITEA__repository__SCRIPT_TYPE" = "bash"
    "GITEA__attachment__PATH"       = "/data/gitea/attachments"
    "GITEA__picture__AVATAR_UPLOAD_PATH" = "/data/gitea/avatars"
    "GITEA__log__ROOT_PATH"         = "/data/gitea/log"
    # Disable queue for now to allow Gitea to start
    "GITEA__queue__TYPE"            = "immediate"
    "GITEA__queue__LENGTH"          = "100"
    
    # Startup script to create required directories
    "STARTUP_COMMAND" = "mkdir -p /data/gitea/repos /data/gitea/attachments /data/gitea/avatars /data/gitea/log && chmod -R 777 /data/gitea"
    
    # Container settings
    "WEBSITES_ENABLE_APP_SERVICE_STORAGE" = "true"
    "DOCKER_REGISTRY_SERVER_URL"    = "https://index.docker.io"
  }

  # Connect to the virtual network
  virtual_network_subnet_id = azurerm_subnet.app_service_subnet.id
  
  # Allow public access but restrict with IP rules in the site_config block above
  public_network_access_enabled = true
  https_only = true
  
  # Persistent storage settings
  storage_account {
    name         = "gitea"
    type         = "AzureFiles"
    account_name = azurerm_storage_account.gitea_storage.name
    access_key   = azurerm_storage_account.gitea_storage.primary_access_key
    share_name   = azurerm_storage_share.gitea_share.name
    mount_path   = "/data"
  }
  
  # Add custom hostname for private endpoint access
  lifecycle {
    ignore_changes = [
      # Ignore changes to custom_domain_verification_id as they may be managed outside of Terraform
      custom_domain_verification_id,
      # Ignore changes to app_settings that might be modified during runtime
      app_settings["WEBSITES_ENABLE_APP_SERVICE_STORAGE"]
    ]
  }
}

# Storage Account for Gitea persistent data
resource "azurerm_storage_account" "gitea_storage" {
  name                     = "${var.prefix}storage"
  resource_group_name      = azurerm_resource_group.gitea_rg.name
  location                 = azurerm_resource_group.gitea_rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = var.tags
  
  # Secure the storage account
  min_tls_version                 = "TLS1_2"
  # Using the newer property instead of deprecated enable_https_traffic_only
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  
  # Network rules - allow access from the VNet
  network_rules {
    default_action             = "Deny"
    virtual_network_subnet_ids = [azurerm_subnet.app_service_subnet.id]
    ip_rules                   = var.admin_ip_address != null ? [var.admin_ip_address] : []
    bypass                     = ["AzureServices"]
  }
}

# File Share for Gitea data
resource "azurerm_storage_share" "gitea_share" {
  name                 = "gitea-data"
  storage_account_name = azurerm_storage_account.gitea_storage.name
  quota                = 50 # GB
}

# Note: We're not using azurerm_storage_share_directory due to Azure Government endpoint issues
# Instead, we'll create directories at container startup using a script

# Application Insights for monitoring and logging
resource "azurerm_application_insights" "relay_insights" {
  name                = "${var.prefix}-relay-insights"
  location            = azurerm_resource_group.gitea_rg.location
  resource_group_name = azurerm_resource_group.gitea_rg.name
  application_type    = "web"
  workspace_id        = azurerm_log_analytics_workspace.gitea_logs.id
  tags                = var.tags
}

# Log Analytics Workspace for centralized logging
resource "azurerm_log_analytics_workspace" "gitea_logs" {
  name                = "${var.prefix}-logs"
  location            = azurerm_resource_group.gitea_rg.location
  resource_group_name = azurerm_resource_group.gitea_rg.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

# Private DNS Zone for App Service
resource "azurerm_private_dns_zone" "app_service_dns" {
  name                = "privatelink.azurewebsites.us"
  resource_group_name = azurerm_resource_group.gitea_rg.name
}

# Link the Private DNS Zone to the VNet
resource "azurerm_private_dns_zone_virtual_network_link" "app_service_dns_link" {
  name                  = "${var.prefix}-app-service-dns-link"
  resource_group_name   = azurerm_resource_group.gitea_rg.name
  private_dns_zone_name = azurerm_private_dns_zone.app_service_dns.name
  virtual_network_id    = azurerm_virtual_network.gitea_vnet.id
}

# Private Endpoint for the Gitea App Service
resource "azurerm_private_endpoint" "gitea_app_endpoint" {
  name                = "${var.prefix}-app-endpoint"
  location            = azurerm_resource_group.gitea_rg.location
  resource_group_name = azurerm_resource_group.gitea_rg.name
  subnet_id           = azurerm_subnet.private_endpoint_subnet.id

  private_service_connection {
    name                           = "${var.prefix}-app-connection"
    private_connection_resource_id = azurerm_linux_web_app.gitea_app.id
    is_manual_connection           = false
    subresource_names              = ["sites"]
  }

  private_dns_zone_group {
    name                 = "${var.prefix}-app-dns-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.app_service_dns.id]
  }
}

# Private Endpoint for the Relay Listener App Service
resource "azurerm_private_endpoint" "relay_listener_endpoint" {
  name                = "${var.prefix}-relay-listener-endpoint"
  location            = azurerm_resource_group.gitea_rg.location
  resource_group_name = azurerm_resource_group.gitea_rg.name
  subnet_id           = azurerm_subnet.private_endpoint_subnet.id

  private_service_connection {
    name                           = "${var.prefix}-relay-listener-connection"
    private_connection_resource_id = azurerm_linux_web_app.relay_listener_app.id
    is_manual_connection           = false
    subresource_names              = ["sites"]
  }

  private_dns_zone_group {
    name                 = "${var.prefix}-relay-listener-dns-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.app_service_dns.id]
  }
}


# Package the Node.js code for deployment
module "relay_listener_code" {
  source      = "./modules/app_code"
  source_dir  = "../src"
  output_path = "${path.module}/relay_listener_code.zip"
}

# App Service for Azure Relay Listener
resource "azurerm_linux_web_app" "relay_listener_app" {
  name                = "${var.prefix}-relay-listener"
  resource_group_name = azurerm_resource_group.gitea_rg.name
  location            = azurerm_resource_group.gitea_rg.location
  service_plan_id     = azurerm_service_plan.gitea_plan.id
  tags                = var.tags
  
  # In Azure Government, we need to allow public access for deployment
  # but we'll restrict it with IP rules
  public_network_access_enabled = true

  site_config {
    always_on        = true
    app_command_line = "npm cache clean --force && npm install && npm start"
    
    # Health check to ensure the service is running
    health_check_path = "/health"
    health_check_eviction_time_in_min = 5
    
    # Logging is configured via app_settings instead
    
    # IP restrictions - only if admin_ip_address is provided
    dynamic "ip_restriction" {
      for_each = var.admin_ip_address != null ? [1] : []
      content {
        action     = "Allow"
        ip_address = "${var.admin_ip_address}/32"
        name       = "AllowAdminIP"
        priority   = 100
      }
    }
    
    # Allow VNet traffic
    ip_restriction {
      action     = "Allow"
      ip_address = var.vnet_address_space
      name       = "AllowVNetTraffic"
      priority   = 150
    }
    
    # Allow Azure portal and deployment services
    ip_restriction {
      action      = "Allow"
      service_tag = "AzureCloud"
      name        = "AllowAzureServices"
      priority    = 200
    }

    application_stack {
      node_version = "18-lts"
    }
  }

  app_settings = {
    # Azure Relay configuration
    "RELAY_NAMESPACE"          = "${var.relay_namespace}.servicebus.usgovcloudapi.net",
    "RELAY_PATH"               = var.hybrid_connection_name,
    "RELAY_KEYRULE"            = "RootManageSharedAccessKey",
    "RELAY_KEY"                = azurerm_relay_namespace.gitea_relay.primary_key,
    
    # Gitea configuration - using private endpoint for internal network access
    "GITEA_HOST"               = "${var.prefix}-app.privatelink.azurewebsites.us",
    # Using port 443 for HTTPS connections over private endpoint
    "GITEA_PORT"               = "443",
    
    # Node.js specific settings
    "WEBSITE_NODE_DEFAULT_VERSION" = "~18",
    "SCM_DO_BUILD_DURING_DEPLOYMENT" = "true",
    
    # Timing settings based on our optimizations
    "OPEN_TIMEOUT"             = "1000",
    "PING_INTERVAL"            = "0",
    "PING_TIMEOUT"             = "1000",
    "CLOSE_TIMEOUT"            = "1000",
    
    # For zip deployment tracking
    "HASH"                     = module.relay_listener_code.output_base64sha256,
    
    # Enhanced logging settings
    "APPINSIGHTS_INSTRUMENTATIONKEY"    = azurerm_application_insights.relay_insights.instrumentation_key,
    "APPLICATIONINSIGHTS_CONNECTION_STRING" = azurerm_application_insights.relay_insights.connection_string,
    "ApplicationInsightsAgent_EXTENSION_VERSION" = "~3",
    
    # Node.js specific logging
    "NODE_ENV"                 = "production",
    "LOG_LEVEL"                = "debug",
    "DEBUG"                    = "hyco-ws:*,ws:*"
  }

  # Connect to the virtual network
  virtual_network_subnet_id = azurerm_subnet.app_service_subnet.id
  
  # Enforce HTTPS
  https_only = true
  
  # Deploy the Python code
  zip_deploy_file = module.relay_listener_code.output_path
}

