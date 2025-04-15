/**
 * OpsBot Server - Azure Relay Listener
 * 
 * This module implements the Azure Relay listener for the OpsBot server.
 * It handles incoming connections from clients and routes requests to the appropriate handlers.
 * 
 * Designed specifically for Azure Government cloud environments.
 */

const WebSocket = require('hyco-ws');
const http = require('http');
const url = require('url');

// Configuration
const config = {
    // Azure Relay configuration
    relay: {
        namespace: process.env.RELAY_NAMESPACE || 'your-namespace.servicebus.usgovcloudapi.net',
        path: process.env.RELAY_PATH || 'opsbot',
        keyName: process.env.RELAY_KEY_NAME || 'RootManageSharedAccessKey',
        key: process.env.RELAY_KEY || 'your-key'
    },
    // Local API server configuration
    api: {
        port: process.env.API_PORT || 8080
    },
    // Connection settings
    connection: {
        // Reduced timeouts for probe connections
        probeOpenTimeout: 1000,  // 1 second
        probeCloseTimeout: 1000, // 1 second
        // Disable ping for probe connections to reduce overhead
        probePingInterval: 0,
        // Regular connection settings
        openTimeout: 5000,      // 5 seconds
        closeTimeout: 2000,     // 2 seconds
        pingInterval: 45000     // 45 seconds
    }
};

// Track active connections
const connections = new Map();

/**
 * Create a token for Azure Relay authentication
 */
function createRelayToken(uri, keyName, key) {
    // Ensure we're using HTTPS for Azure Government
    if (!uri.startsWith('https://')) {
        uri = 'https://' + uri;
    }
    return WebSocket.createRelayToken(uri, keyName, key);
}

/**
 * Initialize the Azure Relay listener
 */
function initializeRelayListener() {
    // Ensure namespace has the correct suffix for Azure Government
    let namespace = config.relay.namespace;
    if (!namespace.includes('.servicebus.usgovcloudapi.net')) {
        namespace += '.servicebus.usgovcloudapi.net';
    }

    const uri = `https://${namespace}/${config.relay.path}`;
    console.log(`Initializing Azure Relay listener on ${uri}`);

    // Create the relay server
    const wss = WebSocket.createRelayedServer({
        server: null,
        token: () => createRelayToken(uri, config.relay.keyName, config.relay.key)
    }, (ws) => {
        // Generate a unique connection ID
        const connectionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        console.log(`New connection established: ${connectionId}`);
        
        // Store connection with metadata
        connections.set(connectionId, {
            ws,
            connectedAt: new Date(),
            lastActivity: new Date(),
            isProbe: false
        });

        // Handle messages
        ws.on('message', (message) => {
            try {
                const connection = connections.get(connectionId);
                if (connection) {
                    connection.lastActivity = new Date();
                }
                
                // Parse the message
                const data = JSON.parse(message);
                console.log(`Received message from ${connectionId}: ${data.type}`);
                
                // Handle different message types
                switch (data.type) {
                    case 'probe':
                        // Mark as probe connection
                        if (connection) {
                            connection.isProbe = true;
                        }
                        // Respond immediately to probe
                        ws.send(JSON.stringify({ type: 'probe_response', success: true }));
                        break;
                    
                    case 'command':
                        // Process command and send response
                        processCommand(data.command, data.params)
                            .then(result => {
                                ws.send(JSON.stringify({ 
                                    type: 'command_response', 
                                    id: data.id,
                                    success: true, 
                                    result 
                                }));
                            })
                            .catch(error => {
                                ws.send(JSON.stringify({ 
                                    type: 'command_response', 
                                    id: data.id,
                                    success: false, 
                                    error: error.message 
                                }));
                            });
                        break;
                    
                    default:
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: `Unknown message type: ${data.type}` 
                        }));
                }
            } catch (error) {
                console.error(`Error processing message: ${error.message}`);
                ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
        });

        // Handle connection close
        ws.on('close', () => {
            console.log(`Connection closed: ${connectionId}`);
            connections.delete(connectionId);
        });

        // Handle errors
        ws.on('error', (error) => {
            console.error(`Connection error (${connectionId}): ${error.message}`);
            connections.delete(connectionId);
        });
    });

    // Handle server errors
    wss.on('error', (error) => {
        console.error(`Server error: ${error.message}`);
    });

    console.log('Azure Relay listener initialized');
    return wss;
}

/**
 * Process commands received from clients
 */
async function processCommand(command, params) {
    console.log(`Processing command: ${command}`);
    
    switch (command) {
        case 'ping':
            return { message: 'pong', timestamp: new Date().toISOString() };
        
        case 'status':
            return { 
                status: 'running',
                connections: connections.size,
                uptime: process.uptime()
            };
        
        case 'agents':
            // This would be replaced with actual agent management logic
            return { 
                agents: [
                    { id: 'agent-1', status: 'online', lastSeen: new Date().toISOString() },
                    { id: 'agent-2', status: 'offline', lastSeen: new Date(Date.now() - 3600000).toISOString() }
                ]
            };
        
        default:
            throw new Error(`Unknown command: ${command}`);
    }
}

/**
 * Initialize the local API server
 */
function initializeApiServer() {
    const server = http.createServer((req, res) => {
        const parsedUrl = url.parse(req.url, true);
        
        // Basic routing
        if (parsedUrl.pathname === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'running',
                connections: connections.size,
                uptime: process.uptime()
            }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });

    server.listen(config.api.port, () => {
        console.log(`API server listening on port ${config.api.port}`);
    });

    return server;
}

/**
 * Periodically clean up stale connections
 */
function startConnectionCleanup() {
    setInterval(() => {
        const now = new Date();
        let cleanedCount = 0;
        
        connections.forEach((connection, id) => {
            // Clean up connections that haven't had activity in 5 minutes
            const inactiveTime = now - connection.lastActivity;
            if (inactiveTime > 5 * 60 * 1000) {
                console.log(`Cleaning up inactive connection: ${id}`);
                connection.ws.close();
                connections.delete(id);
                cleanedCount++;
            }
        });
        
        if (cleanedCount > 0) {
            console.log(`Cleaned up ${cleanedCount} stale connections`);
        }
    }, 60 * 1000); // Run every minute
}

/**
 * Main function
 */
function main() {
    console.log('Starting OpsBot Server...');
    
    // Initialize components
    const wss = initializeRelayListener();
    const apiServer = initializeApiServer();
    startConnectionCleanup();
    
    console.log('OpsBot Server started successfully');
    
    // Handle process termination
    process.on('SIGINT', () => {
        console.log('Shutting down...');
        wss.close(() => {
            apiServer.close(() => {
                console.log('Server shutdown complete');
                process.exit(0);
            });
        });
    });
}

// Start the server
main();
