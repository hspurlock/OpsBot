const WebSocket = require('hyco-ws');
const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');

// Connection tracking is already defined below

// Load configuration from environment variables or config.json as fallback
let config;
try {
  if (process.env.RELAY_NAMESPACE) {
    // Use environment variables (for Azure App Service)
    config = {
      namespace: process.env.RELAY_NAMESPACE,
      path: process.env.RELAY_PATH,
      keyrule: process.env.RELAY_KEYRULE,
      key: process.env.RELAY_KEY,
      gitea: {
        host: process.env.GITEA_HOST || 'localhost',
        port: parseInt(process.env.GITEA_PORT || '3000')
      }
    };
    console.log('Using configuration from environment variables');
  } else {
    // Use config.json (for local development)
    config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    console.log('Using configuration from config.json');
  }
} catch (err) {
  console.error('Failed to load configuration:', err);
  process.exit(1);
}

// Extract configuration values
const ns = config.namespace;
const path = config.path;
const keyrule = config.keyrule;
const key = config.key;

// Local Gitea server details
const GITEA_HOST = config.gitea.host;
const GITEA_PORT = config.gitea.port;

// Track active connections
const activeConnections = new Map();
let connectionCounter = 0;

// Maximum buffer size for data chunks
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

// Disable caching for now as it's causing performance issues

// Implement a heartbeat mechanism to keep connections alive
let heartbeatInterval = null;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Function to send heartbeats to all active connections
function sendHeartbeats() {
    console.log(`Sending heartbeats to ${activeConnections.size} active connections`);
    activeConnections.forEach((conn, id) => {
        try {
            if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                // Send a ping to keep the connection alive
                conn.ws.ping();
                conn.lastActivity = Date.now();
            } else {
                // Clean up stale connections
                console.log(`[${id}] Cleaning up stale connection`);
                activeConnections.delete(id);
            }
        } catch (err) {
            console.error(`[${id}] Error sending heartbeat: ${err.message}`);
            activeConnections.delete(id);
        }
    });
}

console.log(`Starting Gitea proxy listener for ${ns}/${path}`);
console.log(`Will forward connections to ${GITEA_HOST}:${GITEA_PORT}`);

// Get timing parameters from environment variables or use defaults
const openTimeout = parseInt(process.env.OPEN_TIMEOUT || '1000');
const pingInterval = parseInt(process.env.PING_INTERVAL || '0'); // 0 means disabled
const pingTimeout = parseInt(process.env.PING_TIMEOUT || '1000');
const closeTimeout = parseInt(process.env.CLOSE_TIMEOUT || '1000');

console.log(`Using timing parameters: openTimeout=${openTimeout}ms, pingInterval=${pingInterval}ms, pingTimeout=${pingTimeout}ms, closeTimeout=${closeTimeout}ms`);

// Create the relay server with optimized timing parameters
const wss = WebSocket.createRelayedServer(
    {
        server: WebSocket.createRelayListenUri(ns, path),
        token: WebSocket.createRelayToken(ns.includes('.') ? 'https://' + ns : 'https://' + ns + '.servicebus.usgovcloudapi.net', keyrule, key),
        open_timeout: openTimeout,
        ping_interval: pingInterval,
        ping_timeout: pingTimeout,
        close_timeout: closeTimeout
    },
    function (ws) {
        const connectionId = ++connectionCounter;
        console.log(`[${connectionId}] New relay connection accepted`);
        
        // Store the connection in our active connections map
        activeConnections.set(connectionId, { ws, lastActivity: Date.now() });
        
        // Create an HTTPS connection to the Gitea server
        console.log(`[${connectionId}] Establishing HTTPS connection to ${GITEA_HOST}:${GITEA_PORT}`);
        
        // Store the connection for tracking
        activeConnections.set(connectionId, { ws });
        
        // Set up message handler for WebSocket
        ws.on('message', (data) => {
            try {
                console.log(`[${connectionId}] Received message from relay, length: ${data.length} bytes`);
                
                // Parse the incoming WebSocket data to get HTTP request details
                let httpRequest;
                try {
                    // Try to parse as string first
                    const requestText = data.toString('utf8');
                    const requestLines = requestText.split('\r\n');
                    const requestLine = requestLines[0];
                    const [method, path] = requestLine.split(' ');
                    
                    // Extract headers
                    const headers = {};
                    let i = 1;
                    while (i < requestLines.length && requestLines[i]) {
                        const [key, value] = requestLines[i].split(': ');
                        if (key && value) {
                            headers[key] = value;
                        }
                        i++;
                    }
                    
                    httpRequest = {
                        method: method || 'GET',
                        path: path || '/',
                        headers: headers || {}
                    };
                    
                    console.log(`[${connectionId}] Parsed HTTP request: ${httpRequest.method} ${httpRequest.path}`);
                } catch (parseErr) {
                    console.error(`[${connectionId}] Failed to parse HTTP request, using defaults: ${parseErr.message}`);
                    httpRequest = {
                        method: 'GET',
                        path: '/',
                        headers: {}
                    };
                }
                
                // Create options for HTTPS request
                const options = {
                    hostname: GITEA_HOST,
                    port: GITEA_PORT,
                    path: httpRequest.path || '/',
                    method: httpRequest.method || 'GET',
                    headers: {
                        // Always use GITEA_HOST as the Host header for Azure App Services
                        'Host': GITEA_HOST,
                        // Add proxy headers for Gitea to work correctly
                        'X-Real-IP': httpRequest.headers['x-forwarded-for'] || httpRequest.headers['x-real-ip'] || '127.0.0.1',
                        'X-Forwarded-For': httpRequest.headers['x-forwarded-for'] || httpRequest.headers['x-real-ip'] || '127.0.0.1',
                        'X-Forwarded-Proto': 'https',
                        'X-Forwarded-Host': httpRequest.headers['host'] || GITEA_HOST,
                        // Forward all other headers except Host
                        ...Object.fromEntries(Object.entries(httpRequest.headers).filter(([key]) => 
                            !['host', 'x-forwarded-for', 'x-real-ip'].includes(key.toLowerCase())))
                    },
                    rejectUnauthorized: false // Allow self-signed certificates for Azure App Service
                };
                
                // Only log paths that aren't static assets to reduce overhead
                if (!options.path.match(/\.(js|css|png|jpg|gif|ico|woff|woff2|ttf|svg)/) || options.path === '/') {
                    console.log(`[${connectionId}] Forwarding request to ${GITEA_HOST}:${GITEA_PORT}${options.path} with Host: ${options.headers['Host']}`);
                }
                
                // Make HTTPS request to Gitea
                const req = https.request(options, (res) => {
                    // Only log non-static asset responses or non-200 status codes
                    if (!options.path.match(/\.(js|css|png|jpg|gif|ico|woff|woff2|ttf|svg)/) || res.statusCode !== 200) {
                        console.log(`[${connectionId}] HTTPS response from Gitea: ${res.statusCode}`);
                    }
                    
                    // Create a response header with status code and headers
                    const headerLines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
                    Object.keys(res.headers).forEach(key => {
                        // Forward all headers except those that might cause issues
                        if (!['connection', 'transfer-encoding'].includes(key.toLowerCase())) {
                            headerLines.push(`${key}: ${res.headers[key]}`);
                        }
                    });
                    
                    // Simple caching header for static assets
                    if (options.path.match(/\.(js|css|png|jpg|gif|ico|woff|woff2|ttf|svg)/)) {
                        headerLines.push('Cache-Control: public, max-age=86400');
                    }
                    
                    // Add a blank line to separate headers from body
                    headerLines.push('');
                    headerLines.push('');
                    
                    // Convert headers to buffer
                    const headerBuffer = Buffer.from(headerLines.join('\r\n'));
                    
                    // Check if this is a static asset (for logging purposes)
                    const isStaticAsset = options.path.match(/\.(js|css|png|jpg|gif|ico|woff|woff2|ttf|svg)/);
                    
                    // Collect all response data and send it at once
                    const responseData = [headerBuffer];
                    let totalSize = headerBuffer.length;
                    
                    res.on('data', (chunk) => {
                        responseData.push(chunk);
                        totalSize += chunk.length;
                    });
                    
                    res.on('end', () => {
                        // Only log for larger responses to reduce overhead
                        if (totalSize > 102400) { // >100KB
                            console.log(`[${connectionId}] Sending response: ${Math.round(totalSize/1024)}KB`);
                        }
                        
                        // Send the full response
                        if (ws.readyState === WebSocket.OPEN) {
                            try {
                                const fullResponse = Buffer.concat(responseData);
                                
                                // Log static asset sizes for debugging
                                if (isStaticAsset && totalSize > 102400) { // >100KB
                                    console.log(`[${connectionId}] Large static asset: ${options.path} (${Math.round(totalSize/1024)}KB)`);
                                }
                                
                                // Identify file types for proper handling
                                const isJsFile = options.path.endsWith('.js');
                                const isCssFile = options.path.endsWith('.css');
                                
                                // Check if this is a core JS file that shouldn't be closed immediately
                                const isCoreJsFile = isJsFile && (
                                    options.path.includes('webcomponents.js') ||
                                    options.path.includes('serviceworker.js')
                                );
                                
                                // Simple send with appropriate connection handling
                                ws.send(fullResponse, (err) => {
                                    if (err) {
                                        console.error(`[${connectionId}] Error in send callback: ${err.message}`);
                                    } else if (isJsFile && !isCoreJsFile) {
                                        // For regular JS files, immediately close the connection
                                        console.log(`[${connectionId}] Closing connection after sending JS file: ${options.path}`);
                                        if (ws.readyState === WebSocket.OPEN) {
                                            ws.close(1000, 'JavaScript file complete');
                                        }
                                    } else if (isCoreJsFile) {
                                        // For core JS files, don't close the connection
                                        console.log(`[${connectionId}] Core JS file sent: ${options.path}`);
                                    } else if (isCssFile) {
                                        // For CSS files, close after a small delay
                                        console.log(`[${connectionId}] Closing connection after sending CSS file: ${options.path}`);
                                        setTimeout(() => {
                                            if (ws.readyState === WebSocket.OPEN) {
                                                ws.close(1000, 'CSS file complete');
                                            }
                                        }, 100);
                                    }
                                });
                            } catch (err) {
                                console.error(`[${connectionId}] Error sending response: ${err.message}`);
                            }
                        } else {
                            console.warn(`[${connectionId}] WebSocket closed, cannot send response`);
                        }
                    });

                });
                
                req.on('error', (err) => {
                    console.error(`[${connectionId}] HTTPS request error: ${err.message}`);
                    if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || 
                        err.code === 'CERT_HAS_EXPIRED' || 
                        err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
                        console.error('SSL certificate verification error. Using rejectUnauthorized: false for self-signed certificates.');
                    }
                    
                    // Check if WebSocket is still open before sending error message
                    if (ws.readyState === WebSocket.OPEN) {
                        try {
                            ws.send(`Error connecting to Gitea: ${err.message}`);
                        } catch (sendErr) {
                            console.error(`[${connectionId}] Error sending error message: ${sendErr.message}`);
                        }
                    } else {
                        console.warn(`[${connectionId}] WebSocket closed, cannot send error message`);
                    }
                });
                
                // Send the request data if any
                if (data.length > 0) {
                    req.write(data);
                }
                req.end();
            } catch (err) {
                console.error(`[${connectionId}] Error processing message: ${err.message}`);
            }
        });
        
        // Handle WebSocket errors
        ws.on('error', (err) => {
            console.error(`[${connectionId}] WebSocket error: ${err.message}`);
            activeConnections.delete(connectionId);
        });
        
        // Handle WebSocket close
        ws.on('close', () => {
            console.log(`[${connectionId}] Relay connection closed`);
            activeConnections.delete(connectionId);
        });
    }
);

// Handle server errors
wss.on('error', function(err) {
    console.error('Relay server error:', err);
});

// Start the heartbeat mechanism
heartbeatInterval = setInterval(sendHeartbeats, HEARTBEAT_INTERVAL);
console.log(`Heartbeat mechanism started (interval: ${HEARTBEAT_INTERVAL}ms)`);

// Proper cleanup on process exit
process.on('SIGINT', () => {
    console.log('Shutting down...');
    
    // Clear the heartbeat interval
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    // Close all active connections
    for (const [id, conn] of activeConnections.entries()) {
        console.log(`Closing connection ${id}`);
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
            try {
                // Send a close frame to properly close the connection
                conn.ws.close(1000, 'Server shutting down');
            } catch (err) {
                console.error(`Error closing connection ${id}: ${err.message}`);
            }
        }
    }
    
    // Clear the connections map
    activeConnections.clear();
    
    // Give some time for connections to close gracefully
    setTimeout(() => {
        console.log('Shutdown complete');
        process.exit(0);
    }, 1000);
});

console.log('Gitea proxy listener is running');
