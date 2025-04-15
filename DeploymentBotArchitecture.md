# OpsBot with Azure Relay Architecture

This document outlines the architecture for OpsBot with Azure Relay integration, designed to support a fleet of deployment agents for Terraform operations.

## High-Level Architecture

```
┌─────────────────┐                  ┌───────────────────┐                  ┌─────────────────────┐
│                 │                  │                   │                  │                     │
│  Local Machine  │◄──Azure Relay──► │   OpsBot Server   │◄───────────────► │  Deployment Agents  │
│  (Relay Sender) │                  │  (Relay Listener) │                  │                     │
└─────────────────┘                  └───────────────────┘                  └─────────────────────┘
```

## Components Breakdown

### 1. OpsBot Server (Azure App Service)

This central server would:
- Connect to Azure Relay as a listener
- Manage a fleet of deployment agents
- Provide an API for client operations
- Handle authentication and authorization
- Maintain deployment state

```
┌─────────────────────────────────────────┐
│             OpsBot Server               │
│                                         │
│  ┌─────────────┐     ┌──────────────┐   │
│  │ Azure Relay │     │ REST API     │   │
│  │ Listener    │     │ Endpoints    │   │
│  └─────────────┘     └──────────────┘   │
│                                         │
│  ┌─────────────┐     ┌──────────────┐   │
│  │ Agent       │     │ Deployment   │   │
│  │ Management  │     │ Orchestrator │   │
│  └─────────────┘     └──────────────┘   │
│                                         │
│  ┌─────────────┐     ┌──────────────┐   │
│  │ Auth        │     │ State        │   │
│  │ Service     │     │ Management   │   │
│  └─────────────┘     └──────────────┘   │
└─────────────────────────────────────────┘
```

### 2. Local Client

A client application that:
- Connects to Azure Relay as a sender
- Provides a CLI or GUI interface
- Authenticates users
- Sends commands to the MCP server

```
┌─────────────────────────────────────────┐
│               Local Client              │
│                                         │
│  ┌─────────────┐     ┌──────────────┐   │
│  │ Azure Relay │     │ CLI/GUI      │   │
│  │ Sender      │     │ Interface    │   │
│  └─────────────┘     └──────────────┘   │
│                                         │
│  ┌─────────────┐     ┌──────────────┐   │
│  │ Auth        │     │ Command      │   │
│  │ Client      │     │ Builder      │   │
│  └─────────────┘     └──────────────┘   │
└─────────────────────────────────────────┘
```

### 3. Deployment Agents

Lightweight agents that:
- Connect to the MCP server
- Execute Terraform deployments
- Report status back to MCP
- Access target environments

```
┌─────────────────────────────────────────┐
│            Deployment Agent             │
│                                         │
│  ┌─────────────┐     ┌──────────────┐   │
│  │ OpsBot      │     │ Terraform    │   │
│  │ Client      │     │ Runner       │   │
│  └─────────────┘     └──────────────┘   │
│                                         │
│  ┌─────────────┐     ┌──────────────┐   │
│  │ Status      │     │ Credential   │   │
│  │ Reporter    │     │ Manager      │   │
│  └─────────────┘     └──────────────┘   │
└─────────────────────────────────────────┘
```

## Communication Flows

### Client → OpsBot Server (via Azure Relay)

1. Client authenticates with Azure Relay
2. Client establishes connection to MCP server through Azure Relay
3. Client sends HTTP/REST requests through the relay connection
4. OpsBot server processes requests and returns responses

### OpsBot Server → Deployment Agents

1. Agents connect directly to OpsBot server (could be over VPN, Private Link, or another secure channel)
2. OpsBot server distributes deployment tasks to appropriate agents
3. Agents execute tasks and stream status updates back to OpsBot server
4. OpsBot server aggregates status and makes it available to clients

## Azure Government Considerations

- Azure Relay namespace: `your-namespace.servicebus.usgovcloudapi.net`
- Proper HTTPS protocol usage for all connections
- Full FQDN handling in connection strings
- Appropriate retry logic with exponential backoff

## Authentication & Security

1. **Client Authentication**:
   - OAuth2 or API key authentication for client → OpsBot
   - SAS tokens for Azure Relay connections

2. **Agent Authentication**:
   - Mutual TLS or API key authentication
   - Possible integration with Azure AD for identity

3. **Deployment Credentials**:
   - Secure credential storage in Azure Key Vault
   - Just-in-time access to deployment credentials

## Implementation Technologies

1. **OpsBot Server**:
   - Node.js or Python for the server application
   - Express/Flask for REST API endpoints
   - Azure App Service for hosting
   - Azure Relay SDK for listener implementation

2. **Local Client**:
   - Node.js or Python for cross-platform support
   - Command-line interface with structured commands
   - Azure Relay SDK for sender implementation

3. **Deployment Agents**:
   - Lightweight containers or VMs
   - Terraform installed with necessary providers
   - Agent software in Node.js or Python
