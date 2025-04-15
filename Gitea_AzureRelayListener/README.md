# Gitea Azure Relay Listener

This project enables private communication between an on-premises Git proxy and a Gitea server hosted in Azure, without exposing public endpoints on the Azure VM. It uses Azure Relay Hybrid Connections to establish a secure communication channel.

## Architecture

```
[On-Premises]                    [Azure Cloud]
+---------------+                +-------------------+
| Git Proxy     |                | Azure Relay       |
| (azure_relay  |<-------------->| Hybrid Connection |
|  _git_proxy.py)|               +-------------------+
+---------------+                        |
                                         v
                                  +-------------------+
                                  | Relay Listener    |
                                  | Service           |
                                  +-------------------+
                                         |
                                         v
                                  +-------------------+
                                  | Gitea Server      |
                                  | (Git Repositories)|
                                  +-------------------+
```

## Components

1. **On-premises Git Proxy**: Python application that serves Git repositories locally and communicates with Azure Relay
2. **Azure Relay**: Managed service that enables secure communication without opening firewall ports
3. **Relay Listener**: Python service running in Azure that listens for Git operations and executes them against Gitea
4. **Gitea Server**: Git repository hosting service running in Azure

## Setup Instructions

### Prerequisites

- Azure Government subscription
- Terraform installed locally
- Git installed locally
- Python 3.8+ installed locally
- Docker (optional, for containerized deployment)

### Deploying the Azure Infrastructure

1. Navigate to the terraform directory:
   ```bash
   cd terraform
   ```

2. Initialize Terraform:
   ```bash
   terraform init
   ```

3. Create a `terraform.tfvars` file with your Azure Government configuration:
   ```hcl
   resource_group_name     = "gitea-rg"
   location                = "usgovvirginia"
   prefix                  = "gitea"
   relay_namespace         = "gitea-relay-ns"
   hybrid_connection_name  = "gitea-connection"
   tags                    = { Environment = "Production" }
   admin_ip_address       = ["your-ip-address/32"]
   vm_size                = "Standard_B2s"
   admin_username         = "azureuser"
   ssh_public_key_path    = "~/.ssh/id_rsa.pub"
   ```

4. Plan the deployment:
   ```bash
   terraform plan -out=tfplan
   ```

5. Apply the deployment:
   ```bash
   terraform apply tfplan
   ```

6. Note the outputs, especially the relay connection details:
   ```bash
   terraform output
   ```

### Azure Government and Private Link Configuration

#### Setting up Private DNS Zones

When using Azure Private Link in Azure Government, you need to configure Private DNS Zones to ensure proper name resolution:

1. Create a Private DNS Zone for Azure Relay:
   ```bash
   az network private-dns zone create --resource-group gitea-rg --name privatelink.servicebus.usgovcloudapi.net
   ```

2. Link the Private DNS Zone to your VNet:
   ```bash
   az network private-dns link vnet create --resource-group gitea-rg --zone-name privatelink.servicebus.usgovcloudapi.net --name MyDNSLink --virtual-network gitea-vnet --registration-enabled false
   ```

3. Create DNS records for your Azure Relay namespace:
   ```bash
   az network private-dns record-set a create --resource-group gitea-rg --zone-name privatelink.servicebus.usgovcloudapi.net --name gitea-relay-ns
   az network private-dns record-set a add-record --resource-group gitea-rg --zone-name privatelink.servicebus.usgovcloudapi.net --record-set-name gitea-relay-ns --ipv4-address <private-endpoint-ip>
   ```

#### Creating a Private Endpoint for Azure Relay

1. Create a Private Endpoint for your Azure Relay namespace:
   ```bash
   az network private-endpoint create \
     --resource-group gitea-rg \
     --name gitea-relay-pe \
     --vnet-name gitea-vnet \
     --subnet default \
     --private-connection-resource-id $(az relay namespace show --resource-group gitea-rg --name gitea-relay-ns --query id -o tsv) \
     --group-id namespace \
     --connection-name gitea-relay-connection
   ```

2. Get the Private Endpoint IP address:
   ```bash
   az network private-endpoint show --resource-group gitea-rg --name gitea-relay-pe --query 'networkInterfaces[0].id' -o tsv | xargs az network nic show --ids | grep -oP '"privateIpAddress": "\K[^"]*'
   ```

3. Use this IP address in the DNS record creation step above.

### Deploying the Azure Relay Listener

#### Option 1: Containerized Deployment (Recommended for Azure App Service)

1. Build the Docker image:
   ```bash
   docker build -t gitea-relay-listener .
   ```

2. Run the container locally to test:
   ```bash
   docker run -p 8000:8000 --env-file .env gitea-relay-listener
   ```

3. Test the health endpoint:
   ```bash
   curl http://localhost:8000/health
   ```

4. Push the image to Azure Container Registry (ACR):
   ```bash
   az acr login --name <your-acr-name>
   docker tag gitea-relay-listener <your-acr-name>.azurecr.io/gitea-relay-listener:latest
   docker push <your-acr-name>.azurecr.io/gitea-relay-listener:latest
   ```

5. Deploy to Azure App Service:
   ```bash
   az webapp create --resource-group gitea-rg --plan <your-app-service-plan> --name gitea-relay-listener --deployment-container-image-name <your-acr-name>.azurecr.io/gitea-relay-listener:latest
   ```

6. Configure environment variables in Azure App Service:
   ```bash
   az webapp config appsettings set --resource-group gitea-rg --name gitea-relay-listener --settings RELAY_NAMESPACE=gitea-relay-ns RELAY_HYBRID_CONNECTION=gitea-connection RELAY_KEY_NAME=RootManageSharedAccessKey RELAY_KEY=<your-relay-key> RELAY_ENDPOINT_SUFFIX=servicebus.usgovcloudapi.net GITEA_HOST=localhost GITEA_PORT=3000
   ```

#### Option 2: Direct Deployment

1. Clone the repository on your Azure VM:
   ```bash
   git clone https://github.com/yourusername/Gitea_AzureRelayListener.git
   cd Gitea_AzureRelayListener
   ```

2. Create a `.env` file with your configuration:
   ```
   RELAY_NAMESPACE=gitea-relay-ns
   RELAY_HYBRID_CONNECTION=gitea-connection
   RELAY_KEY_NAME=RootManageSharedAccessKey
   RELAY_KEY=<your-relay-key>
   RELAY_ENDPOINT_SUFFIX=servicebus.usgovcloudapi.net
   GITEA_HOST=localhost
   GITEA_PORT=3000
   ```

3. Run the deployment script:
   ```bash
   ./deploy.sh
   ```

### Troubleshooting

#### DNS Resolution Issues

When working with Azure Private Link in Azure Government, DNS resolution issues are common. The Azure Relay Listener has been enhanced to handle these scenarios:

1. **Health Check Endpoint**: The `/health` endpoint provides detailed information about DNS resolution status:
   ```bash
   curl http://localhost:8000/health
   ```
   Look for the `dns_status` field in the response to verify if DNS resolution is working correctly.

2. **Private Link Mode**: The relay listener automatically detects if it's running in a private link environment and adjusts its behavior accordingly:
   - Longer timeouts for DNS resolution
   - Retry logic for DNS resolution
   - Detailed logging for troubleshooting

3. **Manual DNS Testing**: You can manually test DNS resolution using the following commands:
   ```bash
   # Using host command
   host <relay-namespace>.<relay-endpoint-suffix>
   
   # Using dig command
   dig <relay-namespace>.<relay-endpoint-suffix>
   
   # Using nslookup
   nslookup <relay-namespace>.<relay-endpoint-suffix>
   ```

4. **Common Issues and Solutions**:
   - **Issue**: DNS resolution fails with NXDOMAIN
     **Solution**: Verify that the private DNS zone is correctly linked to your VNet
   
   - **Issue**: DNS resolution succeeds but returns a public IP instead of private IP
     **Solution**: Verify that the A record in your private DNS zone is correctly configured
   
   - **Issue**: Connection times out despite successful DNS resolution
     **Solution**: Check network security groups (NSGs) to ensure traffic is allowed

### Setting Up the On-Premises Git Proxy

1. Create a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install dependencies:
   ```bash
   pip install websockets asyncio requests flask python-dotenv
   ```

3. Configure the environment variables:
   ```bash
   # Create a .env file with the following variables:
   RELAY_NAMESPACE=your-relay-namespace
   RELAY_HYBRID_CONNECTION=gitea-connection
   RELAY_KEY_NAME=RootManageSharedAccessKey
   RELAY_KEY=your-relay-key
   REPO_NAME=user/repo  # Repository path in Gitea
   ```

4. Run the Git proxy:
   ```bash
   python azure_relay_git_proxy.py
   ```

5. Clone repositories using:
   ```bash
   git clone git://localhost:9418/repo.git
   ```

## How It Works

1. The on-premises Git proxy creates a bare repository locally
2. When a Git client requests data, the proxy serves it from the local bare repository
3. The proxy periodically syncs with the Gitea server through Azure Relay:
   - It sends Git operation requests to the relay
   - The relay listener in Azure receives these requests
   - The listener executes Git operations against the local Gitea server
   - Results are sent back through the relay to the proxy
   - The proxy updates its local bare repository

## Security Considerations

- No public endpoints are exposed on the Azure VM
- All communication goes through Azure Relay's secure channel
- The Gitea server is only accessible from within the Azure VM
- Authentication is handled via Shared Access Signatures (SAS)

## Troubleshooting

- Check logs in the `logs` directory
- Ensure Azure Relay connection strings are correct
- Verify that the relay listener service is running on the Azure VM
- Check Gitea is properly configured and running

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
