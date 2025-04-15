# OpsBot

OpsBot is a Management Control Plane (MCP) system that uses Azure Relay to enable secure communication between clients and deployment agents. It's designed for managing Terraform deployments across environments, particularly in Azure Government scenarios.

## Project Structure

- `server/`: OpsBot server implementation (Azure Relay listener)
- `client/`: Local client application (Azure Relay sender)
- `agent/`: Deployment agent implementation
- `DeploymentBotArchitecture.md`: Detailed architecture documentation

## Key Features

- Secure communication through Azure Relay Hybrid Connections
- Fleet management of deployment agents
- Terraform deployment orchestration
- Support for Azure Government cloud environments
- Private network connectivity without public endpoints

## Azure Government Considerations

This project is specifically designed to work with Azure Government cloud, addressing:

- Different domain suffixes (`.usgovcloudapi.net`)
- HTTPS protocol requirements
- Full FQDN handling in connection strings
- Proper retry logic with exponential backoff

## Getting Started

### Prerequisites

- Azure subscription (preferably Azure Government)
- Azure Relay Hybrid Connections namespace
- Node.js or Python environment

### Configuration

Each component requires specific configuration:

1. **Server**: Azure Relay connection details, agent management settings
2. **Client**: Azure Relay connection details, authentication credentials
3. **Agent**: Connection details to OpsBot server, Terraform configuration

## Development Roadmap

- [x] Architecture design
- [ ] Server implementation
- [ ] Client implementation
- [ ] Agent implementation
- [ ] Authentication and security
- [ ] Deployment orchestration
- [ ] Monitoring and logging

## License

[MIT](LICENSE)
