/**
 * OpsBot Client - Azure Relay Sender
 * 
 * This module implements the Azure Relay sender for the OpsBot client.
 * It connects to the OpsBot server through Azure Relay and provides
 * methods for sending commands and processing responses.
 * 
 * Designed specifically for Azure Government cloud environments.
 */

const WebSocket = require('hyco-ws');
const readline = require('readline');
const net = require('net');

// Configuration
const config = {
    // Azure Relay configuration
    relay: {
        namespace: process.env.RELAY_NAMESPACE || 'your-namespace.servicebus.usgovcloudapi.net',
        path: process.env.RELAY_PATH || 'opsbot',
        keyName: process.env.RELAY_KEY_NAME || 'RootManageSharedAccessKey',
        key: process.env.RELAY_KEY || 'your-key'
    },
    // Connection settings with optimized values based on experience
    connection: {
        // Faster initial retry
        initialRetryDelay: 200,
        // More aggressive retry strategy
        maxRetryCount: 10,
        // Cap maximum delay
        maxRetryDelay: 5000,
        // Connection timeouts
        openTimeout: 15000,    // 15 seconds
        closeTimeout: 2000,    // 2 seconds
        pingInterval: 45000    // 45 seconds
    }
};

// Track command responses
const pendingCommands = new Map();
let ws = null;
let connected = false;
let commandId = 1;

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
 * Test basic TCP connectivity before attempting WebSocket connection
 */
async function testConnectivity(host, port) {
    return new Promise((resolve, reject) => {
        console.log(`Testing TCP connectivity to ${host}:${port}...`);
        const startTime = Date.now();
        const socket = new net.Socket();
        
        socket.setTimeout(5000); // 5 second timeout
        
        socket.on('connect', () => {
            const duration = (Date.now() - startTime) / 1000;
            console.log(`TCP connection successful in ${duration.toFixed(2)} seconds`);
            socket.destroy();
            resolve(true);
        });
        
        socket.on('timeout', () => {
            console.error('TCP connection timeout');
            socket.destroy();
            reject(new Error('Connection timeout'));
        });
        
        socket.on('error', (error) => {
            console.error(`TCP connection error: ${error.message}`);
            reject(error);
        });
        
        socket.connect(port, host);
    });
}

/**
 * Connect to the Azure Relay with retry logic
 */
async function connectWithRetry() {
    let retryCount = 0;
    let delay = config.connection.initialRetryDelay;
    
    while (retryCount < config.connection.maxRetryCount) {
        try {
            // Ensure namespace has the correct suffix for Azure Government
            let namespace = config.relay.namespace;
            if (!namespace.includes('.servicebus.usgovcloudapi.net')) {
                namespace += '.servicebus.usgovcloudapi.net';
            }
            
            // Extract host and port for connectivity test
            const host = namespace;
            const port = 443; // HTTPS port
            
            // Test basic connectivity first
            await testConnectivity(host, port);
            
            // Now try WebSocket connection
            const uri = `https://${namespace}/${config.relay.path}`;
            console.log(`Connecting to Azure Relay: ${uri}`);
            
            // Create a new WebSocket connection
            return new Promise((resolve, reject) => {
                const token = createRelayToken(uri, config.relay.keyName, config.relay.key);
                const ws = new WebSocket(uri, null, { token });
                
                // Set timeout for connection
                const connectionTimeout = setTimeout(() => {
                    ws.terminate();
                    reject(new Error('Connection timeout'));
                }, config.connection.openTimeout);
                
                ws.on('open', () => {
                    clearTimeout(connectionTimeout);
                    console.log('Connected to Azure Relay');
                    
                    // Send a probe message to verify the connection
                    ws.send(JSON.stringify({ type: 'probe' }));
                    
                    // Set a timeout for the probe response
                    const probeTimeout = setTimeout(() => {
                        ws.terminate();
                        reject(new Error('Probe timeout - no response from server'));
                    }, 5000);
                    
                    // One-time handler for the probe response
                    const handleProbeResponse = (message) => {
                        try {
                            const data = JSON.parse(message);
                            if (data.type === 'probe_response') {
                                clearTimeout(probeTimeout);
                                ws.removeListener('message', handleProbeResponse);
                                resolve(ws);
                            }
                        } catch (error) {
                            console.error(`Error parsing probe response: ${error.message}`);
                        }
                    };
                    
                    ws.on('message', handleProbeResponse);
                });
                
                ws.on('error', (error) => {
                    clearTimeout(connectionTimeout);
                    console.error(`WebSocket connection error: ${error.message}`);
                    reject(error);
                });
                
                ws.on('close', (code, reason) => {
                    clearTimeout(connectionTimeout);
                    console.log(`WebSocket connection closed: ${code} - ${reason}`);
                    reject(new Error(`Connection closed: ${code} - ${reason}`));
                });
            });
            
        } catch (error) {
            console.error(`Connection attempt ${retryCount + 1} failed: ${error.message}`);
            
            // Check if we've reached the maximum retry count
            if (retryCount >= config.connection.maxRetryCount - 1) {
                throw new Error(`Failed to connect after ${config.connection.maxRetryCount} attempts`);
            }
            
            // Wait before retrying
            console.log(`Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Increase delay for next retry (exponential backoff)
            delay = Math.min(delay * 1.5, config.connection.maxRetryDelay);
            retryCount++;
        }
    }
}

/**
 * Initialize the WebSocket connection
 */
async function initializeConnection() {
    try {
        ws = await connectWithRetry();
        connected = true;
        
        // Set up message handler
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                // Handle command responses
                if (data.type === 'command_response' && data.id) {
                    const callback = pendingCommands.get(data.id);
                    if (callback) {
                        callback(data.error, data.result);
                        pendingCommands.delete(data.id);
                    }
                } 
                // Handle errors
                else if (data.type === 'error') {
                    console.error(`Server error: ${data.message}`);
                }
            } catch (error) {
                console.error(`Error processing message: ${error.message}`);
            }
        });
        
        // Handle connection close
        ws.on('close', () => {
            console.log('Connection closed');
            connected = false;
            
            // Reject all pending commands
            pendingCommands.forEach((callback, id) => {
                callback(new Error('Connection closed'), null);
                pendingCommands.delete(id);
            });
            
            // Try to reconnect
            setTimeout(() => {
                console.log('Attempting to reconnect...');
                initializeConnection().catch(error => {
                    console.error(`Reconnection failed: ${error.message}`);
                });
            }, 5000);
        });
        
        // Handle errors
        ws.on('error', (error) => {
            console.error(`WebSocket error: ${error.message}`);
        });
        
        return true;
    } catch (error) {
        console.error(`Failed to initialize connection: ${error.message}`);
        return false;
    }
}

/**
 * Send a command to the server
 */
function sendCommand(command, params = {}) {
    return new Promise((resolve, reject) => {
        if (!connected || !ws) {
            return reject(new Error('Not connected to server'));
        }
        
        const id = commandId++;
        const message = {
            type: 'command',
            id,
            command,
            params
        };
        
        // Store callback for the response
        pendingCommands.set(id, (error, result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
        
        // Send the message
        ws.send(JSON.stringify(message));
        
        // Set a timeout for the response
        setTimeout(() => {
            if (pendingCommands.has(id)) {
                pendingCommands.delete(id);
                reject(new Error(`Command timed out: ${command}`));
            }
        }, 30000); // 30 second timeout
    });
}

/**
 * Start the interactive CLI
 */
function startCli() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    console.log('OpsBot Client CLI');
    console.log('Type "help" for available commands');
    
    function prompt() {
        rl.question('> ', async (input) => {
            const args = input.trim().split(' ');
            const command = args[0].toLowerCase();
            
            try {
                switch (command) {
                    case 'help':
                        console.log('Available commands:');
                        console.log('  ping        - Test connection to server');
                        console.log('  status      - Get server status');
                        console.log('  agents      - List deployment agents');
                        console.log('  exit        - Exit the client');
                        break;
                    
                    case 'ping':
                        const pingResult = await sendCommand('ping');
                        console.log(`Server response: ${pingResult.message} at ${pingResult.timestamp}`);
                        break;
                    
                    case 'status':
                        const statusResult = await sendCommand('status');
                        console.log('Server status:');
                        console.log(`  Status: ${statusResult.status}`);
                        console.log(`  Connections: ${statusResult.connections}`);
                        console.log(`  Uptime: ${statusResult.uptime} seconds`);
                        break;
                    
                    case 'agents':
                        const agentsResult = await sendCommand('agents');
                        console.log('Deployment agents:');
                        agentsResult.agents.forEach(agent => {
                            console.log(`  ${agent.id} - ${agent.status} (Last seen: ${agent.lastSeen})`);
                        });
                        break;
                    
                    case 'exit':
                        if (ws) {
                            ws.close();
                        }
                        rl.close();
                        process.exit(0);
                        break;
                    
                    default:
                        if (command) {
                            console.log(`Unknown command: ${command}`);
                        }
                }
            } catch (error) {
                console.error(`Error: ${error.message}`);
            }
            
            prompt();
        });
    }
    
    prompt();
}

/**
 * Main function
 */
async function main() {
    console.log('Starting OpsBot Client...');
    
    // Initialize connection
    const success = await initializeConnection();
    if (success) {
        console.log('OpsBot Client started successfully');
        startCli();
    } else {
        console.error('Failed to start OpsBot Client');
        process.exit(1);
    }
}

// Start the client
main();
