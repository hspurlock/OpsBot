const WebSocket = require('hyco-ws');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');

// Load configuration from config.json
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Extract configuration values
const ns = config.namespace;
const path = config.path;
const keyrule = config.keyrule;
const key = config.key;

// Local proxy server port (where clients will connect)
const LOCAL_PORT = config.proxy.port;

// Track active connections
const activeConnections = new Map();
let connectionCounter = 0;

// Set a reasonable maximum buffer size
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB is a good balance

// Create a local TCP server to accept connections
const server = net.createServer((socket) => {
    const connectionId = ++connectionCounter;
    console.log(`[${connectionId}] New local connection`);
    
    // No connection pooling - create a fresh connection each time
    const connectToRelay = () => {
        console.log(`[${connectionId}] Creating new relay connection`);
        return false;
    };
    
    // Set up WebSocket handlers for a connection
    const setupWebSocketHandlers = (ws) => {
        console.log(`[${connectionId}] Connected to relay`);
        
        // Store the connection for tracking
        activeConnections.set(connectionId, { socket, ws });
        
        // Forward data from local socket to WebSocket (local → relay)
        socket.on('data', (data) => {
            // Only log for larger requests to reduce overhead
            if (data.length > 10240) { // Only log for requests > 10KB
                console.log(`[${connectionId}] Local → Relay: ${data.length} bytes`);
            }
            
            // Simple send without options
            ws.send(data);
        });
        
        // Simple flow control for all responses
        let pendingWrites = [];
        let isWriting = false;
        
        // Function to process the write queue - simple and reliable
        const processWriteQueue = () => {
            if (pendingWrites.length === 0 || isWriting) {
                return;
            }
            
            isWriting = true;
            const data = pendingWrites.shift();
            
            try {
                // Simple write with drain handling
                const writeSuccess = socket.write(data);
                if (!writeSuccess) {
                    socket.once('drain', () => {
                        isWriting = false;
                        processWriteQueue();
                    });
                } else {
                    isWriting = false;
                    processWriteQueue();
                }
            } catch (err) {
                console.error(`[${connectionId}] Error writing to socket: ${err.message}`);
                isWriting = false;
                processWriteQueue();
            }
            
            try {
                // Simple write with drain handling
                const writeSuccess = socket.write(data);
                if (!writeSuccess) {
                    socket.once('drain', () => {
                        isWriting = false;
                        setImmediate(processWriteQueue);
                    });
                } else {
                    isWriting = false;
                    setImmediate(processWriteQueue);
                }
            } catch (err) {
                console.error(`[${connectionId}] Error writing to socket: ${err.message}`);
                isWriting = false;
                setImmediate(processWriteQueue);
            }
        };
        
        // Forward data from WebSocket to local socket (relay → local)
        ws.on('message', (data) => {
            // Only log for larger responses to reduce overhead
            if (data.length > 102400) { // >100KB
                console.log(`[${connectionId}] Relay → Local: ${Math.round(data.length/1024)}KB`);
            }
            
            // For large data, split into reasonable chunks
            if (data.length > MAX_BUFFER_SIZE) {
                const chunkSize = MAX_BUFFER_SIZE / 2; // 512KB chunks
                for (let i = 0; i < data.length; i += chunkSize) {
                    const chunk = data.slice(i, Math.min(i + chunkSize, data.length));
                    pendingWrites.push(chunk);
                }
            } else {
                pendingWrites.push(data);
            }
            
            // Process the queue
            processWriteQueue();
        });
        
        // Handle WebSocket close
        ws.on('close', (code, reason) => {
            console.log(`[${connectionId}] Relay connection closed: ${code} ${reason || 'No reason'}`);
            
            // For normal closures, ensure we close the socket to prevent browser hanging
            if (code === 1000) {
                console.log(`[${connectionId}] Normal closure, ending local socket`);
                socket.end(); // Gracefully end the socket
            } else {
                // For abnormal closures, destroy the socket
                console.log(`[${connectionId}] Abnormal closure, destroying local socket`);
                socket.destroy();
            }
            
            // Remove from active connections
            activeConnections.delete(connectionId);
        });
        
        // Handle WebSocket errors
        ws.on('error', (err) => {
            console.error(`[${connectionId}] WebSocket error: ${err.message}`);
            socket.destroy(new Error(`Relay error: ${err.message}`));
            activeConnections.delete(connectionId);
        });
        
        // Set a timeout on the WebSocket to prevent hanging connections
        const wsTimeout = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                console.log(`[${connectionId}] Closing stale WebSocket connection after timeout`);
                ws.close(1000, 'Connection timeout');
            }
        }, 30000); // 30 second timeout
        
        // Clear the timeout if the connection closes normally
        ws.on('close', () => {
            clearTimeout(wsTimeout);
        });
    };
    
    // Connect to the relay with simple retry logic
    const connectWithRetry = (retryCount = 0, maxRetries = 10) => {
        // Always create a new connection
        connectToRelay();
        
        
        console.log(`[${connectionId}] Connecting to relay (attempt ${retryCount + 1}/${maxRetries})`);
        
        // Debug information for Azure Relay connection
        const relayUri = WebSocket.createRelaySendUri(ns, path);
        const relayToken = WebSocket.createRelayToken('https://' + ns, keyrule, key);
        console.log(`[${connectionId}] Relay URI: ${relayUri}`);
        console.log(`[${connectionId}] Using namespace: ${ns}`);
        
        try {
            WebSocket.relayedConnect(
                relayUri,
                relayToken,
                function (ws) {
                    // Use our common handler setup function
                    setupWebSocketHandlers(ws);
                    
                    // Close WebSocket when socket closes
                    socket.on('close', () => {
                        // Always close the WebSocket when the socket closes
                        if (ws.readyState === WebSocket.OPEN) {
                            console.log(`[${connectionId}] Closing WebSocket on socket close`);
                            ws.close(1000, 'Socket closed');
                        }
                    });
                },
                (err) => {
                    console.error(`[${connectionId}] Failed to connect to relay: ${err.message}`);
                    
                    // If we get a 404 error or other connection error, retry after a delay
                    if (retryCount < maxRetries) {
                        // Use a more aggressive initial retry (200ms) with exponential backoff
                        const delay = retryCount === 0 ? 200 : Math.min(Math.pow(1.5, retryCount) * 500, 5000);
                        console.log(`[${connectionId}] Retrying in ${delay}ms...`);
                        setTimeout(() => connectWithRetry(retryCount + 1, maxRetries), delay);
                    } else {
                        console.error(`[${connectionId}] Max retries reached. Giving up.`);
                        socket.end();
                        activeConnections.delete(connectionId);
                    }
                }
            );
        } catch (error) {
            console.error(`[${connectionId}] Exception during connection:`, error.message);
            if (retryCount < maxRetries) {
                // Use a more aggressive initial retry (200ms) with exponential backoff
                const delay = retryCount === 0 ? 200 : Math.min(Math.pow(1.5, retryCount) * 500, 5000);
                console.log(`[${connectionId}] Retrying in ${delay}ms after error...`);
                setTimeout(() => connectWithRetry(retryCount + 1, maxRetries), delay);
            } else {
                console.error(`[${connectionId}] Max retries reached after error. Giving up.`);
                socket.end();
            }
        }
    };
    
    // Start the connection process
    connectWithRetry();
    
    // Handle socket close
    socket.on('close', () => {
        console.log(`[${connectionId}] Local connection closed`);
        const conn = activeConnections.get(connectionId);
        
        if (conn && conn.ws) {
            // Always close the WebSocket if it's still open
            if (conn.ws.readyState === WebSocket.OPEN) {
                console.log(`[${connectionId}] Closing WebSocket connection`);
                conn.ws.close(1000, 'Connection closed');
            } else {
                // Otherwise close it immediately
                conn.ws.close(1000, 'Local connection closed');
            }
        }
        
        activeConnections.delete(connectionId);
    });
    
    // Handle socket errors
    socket.on('error', (err) => {
        console.error(`[${connectionId}] Socket error: ${err.message}`);
        const conn = activeConnections.get(connectionId);
        
        if (conn && conn.ws) {
            // For errors, we don't reuse the connection - close it immediately
            conn.ws.close(1011, 'Socket error');
        }
        
        activeConnections.delete(connectionId);
    });
});

// Start the server
server.listen(LOCAL_PORT, () => {
    console.log(`Gitea proxy sender running on localhost:${LOCAL_PORT}`);
    console.log(`Connect to http://localhost:${LOCAL_PORT} to access Gitea through the relay (HTTPS enabled)`);
});

// Handle server errors
server.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${LOCAL_PORT} is already in use. Please choose another port.`);
        process.exit(1);
    }
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('Shutting down...');
    
    // Close the server
    server.close(() => {
        console.log('Server closed');
    });
    
    // Close all active connections
    for (const [id, conn] of activeConnections.entries()) {
        console.log(`Closing connection ${id}`);
        if (conn.socket) conn.socket.destroy();
        if (conn.ws) conn.ws.close();
    }
    
    // Exit after a short delay to allow connections to close
    setTimeout(() => {
        console.log('Shutdown complete');
        process.exit(0);
    }, 1000);
});
