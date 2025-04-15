const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// Configure logging level from environment or default to 'info'
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

// Simple logger with levels
const logger = {
  error: (...args) => LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.error && console.error(`[ERROR] ${new Date().toISOString()}:`, ...args),
  warn: (...args) => LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.warn && console.warn(`[WARN] ${new Date().toISOString()}:`, ...args),
  info: (...args) => LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.info && console.info(`[INFO] ${new Date().toISOString()}:`, ...args),
  debug: (...args) => LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.debug && console.debug(`[DEBUG] ${new Date().toISOString()}:`, ...args),
  trace: (...args) => LOG_LEVELS[LOG_LEVEL] >= LOG_LEVELS.trace && console.trace(`[TRACE] ${new Date().toISOString()}:`, ...args)
};

// Log system information
logger.info('Starting Azure Relay Listener service');
logger.debug('Environment:', {
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  hostname: os.hostname(),
  cpus: os.cpus().length,
  memory: `${Math.round(os.totalmem() / (1024 * 1024))}MB`,
  freeMemory: `${Math.round(os.freemem() / (1024 * 1024))}MB`,
  uptime: os.uptime()
});

// Log configuration
logger.debug('Configuration:', {
  relayNamespace: process.env.RELAY_NAMESPACE,
  relayPath: process.env.RELAY_PATH,
  giteaHost: process.env.GITEA_HOST,
  giteaPort: process.env.GITEA_PORT,
  port: process.env.PORT || 8080,
  openTimeout: process.env.OPEN_TIMEOUT,
  pingInterval: process.env.PING_INTERVAL,
  pingTimeout: process.env.PING_TIMEOUT,
  closeTimeout: process.env.CLOSE_TIMEOUT
});

// Start the gitea-listener.js in a separate process
logger.info('Spawning listener process');
const listenerProcess = spawn('node', [path.join(__dirname, 'gitea-listener.js')], {
  stdio: 'pipe' // Capture output for logging
});

// Handle listener process events
listenerProcess.stdout.on('data', (data) => {
  logger.info(`Listener: ${data.toString().trim()}`);
});

listenerProcess.stderr.on('data', (data) => {
  logger.error(`Listener error: ${data.toString().trim()}`);
});

listenerProcess.on('close', (code) => {
  logger.warn(`Listener process exited with code ${code}`);
  
  // If in production, exit the health check process too so Azure can restart the app
  if (process.env.NODE_ENV === 'production') {
    logger.error('Listener process terminated, exiting health check to trigger restart');
    process.exit(1);
  }
});

// Create a minimal HTTP server that responds with 200 OK to any request
// This is all Azure App Service needs for health checks
http.createServer((req, res) => {
  // Log the request with more details
  logger.debug(`Health check request: ${req.method} ${req.url}`, {
    headers: req.headers,
    remoteAddress: req.socket.remoteAddress
  });
  
  // Always return 200 OK with a simple message
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(process.env.PORT || 8080, '0.0.0.0', () => {
  logger.info(`Health check server running on port ${process.env.PORT || 8080}`);
});

// Handle process termination
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  // Kill the listener process
  listenerProcess.kill();
  // Exit after a short delay
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  // Kill the listener process
  listenerProcess.kill();
  // Exit after a short delay
  setTimeout(() => process.exit(0), 1000);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  // Kill the listener process
  listenerProcess.kill();
  // Exit with error
  process.exit(1);
});
