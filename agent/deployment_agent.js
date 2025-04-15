/**
 * OpsBot Deployment Agent
 * 
 * This module implements a deployment agent that connects to the OpsBot server,
 * receives deployment tasks, and executes Terraform operations.
 * 
 * Designed to work with the OpsBot server in Azure Government environments.
 */

const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const config = {
    // OpsBot server configuration
    server: {
        host: process.env.OPSBOT_HOST || 'localhost',
        port: process.env.OPSBOT_PORT || 8080,
        useHttps: process.env.OPSBOT_USE_HTTPS === 'true' || false,
        apiKey: process.env.OPSBOT_API_KEY || 'your-api-key'
    },
    // Agent configuration
    agent: {
        id: process.env.AGENT_ID || `agent-${os.hostname()}`,
        pollInterval: parseInt(process.env.AGENT_POLL_INTERVAL || '30000', 10),
        workDir: process.env.AGENT_WORK_DIR || path.join(os.tmpdir(), 'opsbot-agent')
    },
    // Local API server configuration
    api: {
        port: process.env.API_PORT || 8081
    }
};

// Track deployments
const deployments = new Map();
let agentStatus = 'idle';

/**
 * Make an HTTP request to the OpsBot server
 */
function makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: config.server.host,
            port: config.server.port,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.server.apiKey,
                'X-Agent-ID': config.agent.id
            }
        };
        
        const httpModule = config.server.useHttps ? https : http;
        
        const req = httpModule.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsedData = JSON.parse(responseData);
                        resolve(parsedData);
                    } catch (error) {
                        reject(new Error(`Failed to parse response: ${error.message}`));
                    }
                } else {
                    reject(new Error(`Request failed with status code ${res.statusCode}: ${responseData}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        if (data) {
            req.write(JSON.stringify(data));
        }
        
        req.end();
    });
}

/**
 * Register the agent with the OpsBot server
 */
async function registerAgent() {
    try {
        console.log(`Registering agent ${config.agent.id} with OpsBot server...`);
        
        const data = {
            id: config.agent.id,
            capabilities: {
                terraform: true,
                azure: true,
                azureGov: true
            },
            system: {
                hostname: os.hostname(),
                platform: os.platform(),
                release: os.release(),
                cpus: os.cpus().length,
                memory: Math.floor(os.totalmem() / (1024 * 1024))
            }
        };
        
        const response = await makeRequest('POST', '/api/agents/register', data);
        console.log(`Agent registered successfully: ${response.message}`);
        return true;
    } catch (error) {
        console.error(`Failed to register agent: ${error.message}`);
        return false;
    }
}

/**
 * Poll for new deployment tasks
 */
async function pollForTasks() {
    try {
        if (agentStatus !== 'idle') {
            // Skip polling if agent is busy
            return;
        }
        
        console.log('Polling for new deployment tasks...');
        const response = await makeRequest('GET', '/api/tasks/next');
        
        if (response.task) {
            console.log(`Received new task: ${response.task.id}`);
            agentStatus = 'busy';
            
            // Process the task
            processTask(response.task)
                .then(() => {
                    agentStatus = 'idle';
                })
                .catch((error) => {
                    console.error(`Error processing task: ${error.message}`);
                    agentStatus = 'idle';
                });
        } else {
            console.log('No new tasks available');
        }
    } catch (error) {
        console.error(`Error polling for tasks: ${error.message}`);
    }
}

/**
 * Process a deployment task
 */
async function processTask(task) {
    console.log(`Processing task ${task.id} - ${task.type}`);
    
    // Update task status
    await updateTaskStatus(task.id, 'running', 'Task started');
    
    try {
        // Track deployment
        deployments.set(task.id, {
            id: task.id,
            status: 'running',
            startTime: new Date(),
            logs: []
        });
        
        // Process based on task type
        switch (task.type) {
            case 'terraform_plan':
                await runTerraformPlan(task);
                break;
                
            case 'terraform_apply':
                await runTerraformApply(task);
                break;
                
            case 'terraform_destroy':
                await runTerraformDestroy(task);
                break;
                
            default:
                throw new Error(`Unknown task type: ${task.type}`);
        }
        
        // Update deployment status
        const deployment = deployments.get(task.id);
        if (deployment) {
            deployment.status = 'completed';
            deployment.endTime = new Date();
        }
        
        // Update task status
        await updateTaskStatus(task.id, 'completed', 'Task completed successfully');
        
    } catch (error) {
        console.error(`Task ${task.id} failed: ${error.message}`);
        
        // Update deployment status
        const deployment = deployments.get(task.id);
        if (deployment) {
            deployment.status = 'failed';
            deployment.endTime = new Date();
            deployment.error = error.message;
        }
        
        // Update task status
        await updateTaskStatus(task.id, 'failed', `Task failed: ${error.message}`);
    }
}

/**
 * Update task status on the OpsBot server
 */
async function updateTaskStatus(taskId, status, message) {
    try {
        console.log(`Updating task ${taskId} status to ${status}: ${message}`);
        
        const data = {
            status,
            message,
            timestamp: new Date().toISOString()
        };
        
        await makeRequest('POST', `/api/tasks/${taskId}/status`, data);
    } catch (error) {
        console.error(`Failed to update task status: ${error.message}`);
    }
}

/**
 * Run a Terraform plan operation
 */
async function runTerraformPlan(task) {
    // Create working directory
    const workDir = path.join(config.agent.workDir, task.id);
    await createWorkDir(workDir);
    
    // Clone repository if specified
    if (task.repository) {
        await cloneRepository(task.repository, workDir);
    } else if (task.terraform_code) {
        await writeFiles(workDir, task.terraform_code);
    } else {
        throw new Error('No Terraform code provided');
    }
    
    // Write variables file if provided
    if (task.variables) {
        await writeVariablesFile(workDir, task.variables);
    }
    
    // Initialize Terraform
    await runCommand('terraform init', workDir, task.id);
    
    // Run Terraform plan
    const planOutput = await runCommand('terraform plan -out=tfplan', workDir, task.id);
    
    // Upload plan output
    await uploadArtifact(task.id, 'plan_output', planOutput);
    
    return { success: true, message: 'Terraform plan completed' };
}

/**
 * Run a Terraform apply operation
 */
async function runTerraformApply(task) {
    // Create working directory
    const workDir = path.join(config.agent.workDir, task.id);
    await createWorkDir(workDir);
    
    // Clone repository if specified
    if (task.repository) {
        await cloneRepository(task.repository, workDir);
    } else if (task.terraform_code) {
        await writeFiles(workDir, task.terraform_code);
    } else {
        throw new Error('No Terraform code provided');
    }
    
    // Write variables file if provided
    if (task.variables) {
        await writeVariablesFile(workDir, task.variables);
    }
    
    // Initialize Terraform
    await runCommand('terraform init', workDir, task.id);
    
    // Run Terraform apply
    const applyOutput = await runCommand('terraform apply -auto-approve', workDir, task.id);
    
    // Upload apply output
    await uploadArtifact(task.id, 'apply_output', applyOutput);
    
    return { success: true, message: 'Terraform apply completed' };
}

/**
 * Run a Terraform destroy operation
 */
async function runTerraformDestroy(task) {
    // Create working directory
    const workDir = path.join(config.agent.workDir, task.id);
    await createWorkDir(workDir);
    
    // Clone repository if specified
    if (task.repository) {
        await cloneRepository(task.repository, workDir);
    } else if (task.terraform_code) {
        await writeFiles(workDir, task.terraform_code);
    } else {
        throw new Error('No Terraform code provided');
    }
    
    // Write variables file if provided
    if (task.variables) {
        await writeVariablesFile(workDir, task.variables);
    }
    
    // Initialize Terraform
    await runCommand('terraform init', workDir, task.id);
    
    // Run Terraform destroy
    const destroyOutput = await runCommand('terraform destroy -auto-approve', workDir, task.id);
    
    // Upload destroy output
    await uploadArtifact(task.id, 'destroy_output', destroyOutput);
    
    return { success: true, message: 'Terraform destroy completed' };
}

/**
 * Create working directory
 */
async function createWorkDir(workDir) {
    return new Promise((resolve, reject) => {
        fs.mkdir(workDir, { recursive: true }, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

/**
 * Clone a Git repository
 */
async function cloneRepository(repository, workDir) {
    const command = `git clone ${repository.url} ${workDir}`;
    
    if (repository.branch) {
        command += ` --branch ${repository.branch}`;
    }
    
    return runCommand(command, path.dirname(workDir));
}

/**
 * Write Terraform files to the working directory
 */
async function writeFiles(workDir, files) {
    const promises = Object.entries(files).map(([filename, content]) => {
        return new Promise((resolve, reject) => {
            const filePath = path.join(workDir, filename);
            fs.writeFile(filePath, content, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    });
    
    return Promise.all(promises);
}

/**
 * Write variables file
 */
async function writeVariablesFile(workDir, variables) {
    return new Promise((resolve, reject) => {
        const filePath = path.join(workDir, 'terraform.tfvars');
        let content = '';
        
        Object.entries(variables).forEach(([key, value]) => {
            if (typeof value === 'string') {
                content += `${key} = "${value}"\n`;
            } else {
                content += `${key} = ${JSON.stringify(value)}\n`;
            }
        });
        
        fs.writeFile(filePath, content, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

/**
 * Run a shell command
 */
function runCommand(command, cwd, taskId = null) {
    return new Promise((resolve, reject) => {
        console.log(`Running command: ${command} in ${cwd}`);
        
        const process = exec(command, { cwd });
        let output = '';
        
        process.stdout.on('data', (data) => {
            output += data;
            console.log(data);
            
            // Log to deployment if taskId is provided
            if (taskId) {
                const deployment = deployments.get(taskId);
                if (deployment) {
                    deployment.logs.push({
                        timestamp: new Date().toISOString(),
                        type: 'stdout',
                        message: data
                    });
                }
            }
        });
        
        process.stderr.on('data', (data) => {
            output += data;
            console.error(data);
            
            // Log to deployment if taskId is provided
            if (taskId) {
                const deployment = deployments.get(taskId);
                if (deployment) {
                    deployment.logs.push({
                        timestamp: new Date().toISOString(),
                        type: 'stderr',
                        message: data
                    });
                }
            }
        });
        
        process.on('close', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`Command failed with exit code ${code}: ${output}`));
            }
        });
    });
}

/**
 * Upload an artifact to the OpsBot server
 */
async function uploadArtifact(taskId, name, content) {
    try {
        console.log(`Uploading artifact ${name} for task ${taskId}`);
        
        const data = {
            name,
            content,
            timestamp: new Date().toISOString()
        };
        
        await makeRequest('POST', `/api/tasks/${taskId}/artifacts`, data);
    } catch (error) {
        console.error(`Failed to upload artifact: ${error.message}`);
    }
}

/**
 * Initialize the local API server
 */
function initializeApiServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        
        // Basic routing
        if (url.pathname === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                id: config.agent.id,
                status: agentStatus,
                deployments: Array.from(deployments.values()).map(d => ({
                    id: d.id,
                    status: d.status,
                    startTime: d.startTime,
                    endTime: d.endTime
                }))
            }));
        } else if (url.pathname.startsWith('/deployments/')) {
            const deploymentId = url.pathname.split('/')[2];
            const deployment = deployments.get(deploymentId);
            
            if (deployment) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(deployment));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Deployment not found' }));
            }
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
 * Main function
 */
async function main() {
    console.log('Starting OpsBot Deployment Agent...');
    
    // Create work directory
    await createWorkDir(config.agent.workDir);
    
    // Register agent with OpsBot server
    const registered = await registerAgent();
    if (!registered) {
        console.error('Failed to register agent with OpsBot server');
        process.exit(1);
    }
    
    // Initialize API server
    const apiServer = initializeApiServer();
    
    // Start polling for tasks
    setInterval(pollForTasks, config.agent.pollInterval);
    
    console.log(`OpsBot Deployment Agent started successfully (ID: ${config.agent.id})`);
    
    // Handle process termination
    process.on('SIGINT', () => {
        console.log('Shutting down...');
        apiServer.close(() => {
            console.log('Agent shutdown complete');
            process.exit(0);
        });
    });
}

// Start the agent
main();
