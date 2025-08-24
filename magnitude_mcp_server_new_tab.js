#!/usr/bin/env node

/**
 * Enhanced Magnitude MCP Server with New Tab Support
 * 
 * This version ensures that each automation task opens in a new tab
 * within the same browser instance where the sidebar chat is running.
 */

import express from 'express';
import bodyParser from 'body-parser';
import { startBrowserAgent } from 'magnitude-core';
import z from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';
import { EventEmitter } from 'events';
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import {promises as fsp} from 'fs';
import { createRequire } from 'node:module';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
// Use dist CJS for recorder/player to match existing CLI utilities
const mcCore = require('./packages/magnitude-core/dist/index.cjs');

// Direct hardcoded API keys - no external dependencies
let cachedSecrets = {
  ANTHROPIC_API_KEY: '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',
  MCP_API_KEY: 'default-mcp-key',
  BROWSER_API_KEY: 'default-browser-key',
  initialized: true,
  source: 'hardcoded_keys'
};


// Helper function to get cached secret
function getSecret(key) {
  return cachedSecrets[key];
}

// Load environment variables (for non-secret configuration)
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
// Minimal CORS for chrome:// UI; adjust origin check if needed
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Workflows storage
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || process.env.MAGNITUDE_WORKFLOWS_DIR || join(__dirname, 'workflows');
const WORKFLOWS_INDEX = join(WORKFLOWS_DIR, 'workflows_index.json');
try { fs.mkdirSync(WORKFLOWS_DIR, { recursive: true }); } catch {}

async function readJsonSafe(filePath) {
  try { const txt = await fsp.readFile(filePath, 'utf8'); return JSON.parse(txt); } catch { return null; }
}

async function loadWorkflowIndex() {
  const idx = await readJsonSafe(WORKFLOWS_INDEX);
  return idx && typeof idx === 'object' ? idx : {};
}

async function saveWorkflowIndex(indexObj) {
  try {
    await fsp.writeFile(WORKFLOWS_INDEX, JSON.stringify(indexObj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Workflows] Failed to save index:', e?.message);
  }
}

function workflowIdFromFile(fileName) {
  return fileName.endsWith('.workflow.json') ? fileName.slice(0, -('.workflow.json'.length)) : fileName;
}

// Retention: keep at most N workflows (default 200)
const WORKFLOWS_RETENTION = Number(process.env.WORKFLOWS_RETENTION || 200);
async function enforceWorkflowRetention() {
  try {
    const files = await fsp.readdir(WORKFLOWS_DIR);
    const wfFiles = files.filter(f => f.endsWith('.workflow.json'));
    if (wfFiles.length <= WORKFLOWS_RETENTION) return;
    // sort by mtime desc, keep newest N
    const withTimes = await Promise.all(wfFiles.map(async f => {
      const full = join(WORKFLOWS_DIR, f);
      const st = await fsp.stat(full);
      return { f, t: st.mtime.getTime() };
    }));
    withTimes.sort((a, b) => b.t - a.t);
    const toDelete = withTimes.slice(WORKFLOWS_RETENTION);
    if (toDelete.length > 0) {
      console.log('[Workflows] Retention: pruning old workflows', { count: toDelete.length });
    }
    for (const item of toDelete) {
      const wf = join(WORKFLOWS_DIR, item.f);
      const mem = wf.replace(/\.workflow\.json$/, '.memory.json');
      const gen = wf.replace(/\.workflow\.json$/, '.generalized.workflow.json');
      try { await fsp.unlink(wf); } catch {}
      try { await fsp.unlink(mem); } catch {}
      try { await fsp.unlink(gen); } catch {}
      const id = workflowIdFromFile(item.f);
      const idx = await loadWorkflowIndex();
      delete idx[id];
      await saveWorkflowIndex(idx);
    }
  } catch (e) {
    console.warn('[Workflows] Retention enforcement failed:', e?.message);
  }
}

// Request logging middleware
const requestLogger = (req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    
    // Update metrics
    metrics.requests.total++;
    
    // Track by endpoint
    const endpoint = req.path;
    metrics.requests.byEndpoint.set(endpoint, 
      (metrics.requests.byEndpoint.get(endpoint) || 0) + 1);
    
    // Track by status
    const statusClass = Math.floor(res.statusCode / 100) * 100;
    metrics.requests.byStatus.set(statusClass,
      (metrics.requests.byStatus.get(statusClass) || 0) + 1);
    
    // Log security events
    if (res.statusCode === 401) {
      console.warn(`[Security] Unauthorized access attempt: ${req.ip} ${req.path}`);
      metrics.security.unauthorized_attempts++;
    }
    
    originalSend.call(this, data);
  };
  
  next();
};

app.use(requestLogger);

// API Key validation middleware
const validateApiKey = (req, res, next) => {
  // Skip validation for health and tool listing endpoints
  const publicEndpoints = ['/health', '/mcp/health', '/mcp/tools', '/register-browser', '/exchange-keys', '/validate-connection'];
  if (publicEndpoints.includes(req.path)) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const validApiKey = getSecret('MCP_API_KEY');
  
  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({ 
      error: 'Invalid or missing API key',
      message: 'Please provide a valid API key in X-API-Key header or api_key query parameter'
    });
  }
  
  next();
};

// API key validation will be applied after secrets initialization in startServer()

// Configuration
const PORT = process.env.MAGNITUDE_MCP_PORT || process.env.MAGNITUDE_PORT || 9123;
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const SECURE_IPC_SOCKET = process.env.SECURE_IPC_SOCKET;

// Protocol version and capabilities for enhanced registration
const PROTOCOL_VERSION = "1.0";
const SUPPORTED_CAPABILITIES = ["encrypted_communication", "token_rotation", "key_exchange"];

// Encryption key validation and recovery
// Note: crypto is already imported at the top

function validateEncryptionKeys(encryptionKey, authKey) {
  try {
    if (!encryptionKey || !authKey) {
      throw new Error('Missing encryption or auth key');
    }
    
    // Validate key format and length
    const encBuffer = Buffer.from(encryptionKey, 'base64');
    const authBuffer = Buffer.from(authKey, 'base64');
    
    if (encBuffer.length !== 32) {
      throw new Error(`Invalid encryption key length: ${encBuffer.length}, expected 32`);
    }
    
    if (authBuffer.length !== 32) {
      throw new Error(`Invalid auth key length: ${authBuffer.length}, expected 32`);
    }
    
    // Test encryption/decryption with the keys
    const testData = 'encryption_test_data';
    const nonce = crypto.randomBytes(12);
    
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', encBuffer, iv);
    cipher.setAAD(Buffer.from('test'));
    let encrypted = cipher.update(testData, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Test decryption
    const decipher = crypto.createDecipheriv('aes-256-gcm', encBuffer, iv);
    decipher.setAAD(Buffer.from('test'));
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    if (decrypted !== testData) {
      throw new Error('Encryption key validation failed - decryption mismatch');
    }
    
    console.log('[Security] Encryption keys validated successfully');
    return { valid: true, encBuffer, authBuffer };
    
  } catch (error) {
    console.error(`[Security] Key validation failed: ${error.message}`);
    return { valid: false, error: error.message };
  }
}

function generateFallbackKeys() {
  console.log('[Security] Generating fallback encryption keys');
  const encryptionKey = crypto.randomBytes(32);
  const authKey = crypto.randomBytes(32);
  
  return {
    encryption_key: encryptionKey.toString('base64'),
    auth_key: authKey.toString('base64'),
    generated: true
  };
}

// Fix hostname issue: magnitude-core uses 127.0.0.1 but Chrome binds to localhost/[::1]
// Convert any 127.0.0.1 URLs to localhost for compatibility
const FIXED_CDP_URL = CDP_URL.replace('127.0.0.1', 'localhost');

// Helper: guidance for agent prompt about when to request human intervention
function buildAgentPrompt() {
  return [
    'Tab usage policy:',
    '- When starting a task, open a new tab for your work. Do not navigate or repurpose existing user tabs unless explicitly requested.',
    '- Prefer creating the new tab in the background to avoid stealing focus.',
  ].join('\n');
}

// Resolve DevTools WS endpoint from an HTTP CDP URL that may include a token
// Ensures correct placement of token on /json/version and on the returned ws URL
async function resolveWsEndpoint(cdpHttpUrlWithToken) {
  try {
    const base = new URL(cdpHttpUrlWithToken);
    const token = base.searchParams.get('token');

    // Build correct /json/version URL and carry token as query param
    const versionUrl = new URL('/json/version', base.origin);
    if (token) versionUrl.searchParams.set('token', token);
    if (versionUrl.hostname === '127.0.0.1') versionUrl.hostname = 'localhost';

    const res = await fetch(versionUrl.toString());
    if (!res.ok) {
      throw new Error(`Unexpected status ${res.status} for ${versionUrl.toString()}`);
    }
    const body = await res.json();
    if (!body || !body.webSocketDebuggerUrl) {
      throw new Error('webSocketDebuggerUrl missing from /json/version response');
    }

    const wsUrl = new URL(body.webSocketDebuggerUrl);
    if (wsUrl.hostname === '127.0.0.1') wsUrl.hostname = 'localhost';
    // Ensure token is present on ws URL for secure handshake
    if (token) wsUrl.searchParams.set('token', token);
    return wsUrl.toString();
  } catch (e) {
    console.error(`[Security] Failed to resolve WS endpoint: ${e.message}`);
    throw e;
  }
}

// Secure IPC Client for Token Rotation
class SecureIPCClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.client = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;  // Heartbeat timer
    this.tokenRotationCallback = null;
    this.encryptionKey = null;  // AES-256-GCM key
    this.authKey = null;        // HMAC-SHA256 key
    this.sequenceNumber = 0;    // Message ordering
  }
  
  // Set encryption keys from browser registration
  setEncryptionKeys(encryptionKey, authKey) {
    this.encryptionKey = encryptionKey;
    this.authKey = authKey;
    console.log('[SecureIPC] Encryption keys configured for secure communication');
  }
  
  // Generate cryptographically secure nonce
  generateNonce() {
    return crypto.randomBytes(12); // 96-bit nonce for AES-GCM
  }
  
  // Encrypt payload using AES-256-GCM
  encryptPayload(payload, nonce) {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not available');
    }
    
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    
    let encrypted = cipher.update(payload, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    return Buffer.concat([encrypted, authTag]);
  }
  
  // Decrypt payload using AES-256-GCM  
  decryptPayload(encryptedData, nonce) {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not available');
    }
    
    // Extract encrypted data and auth tag
    const encrypted = encryptedData.slice(0, -16);  // All but last 16 bytes
    const authTag = encryptedData.slice(-16);       // Last 16 bytes
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, nonce);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  // Generate HMAC-SHA256 authentication tag
  generateAuthTag(messageType, nonce, encryptedPayload, timestamp, sequenceNumber) {
    if (!this.authKey) {
      throw new Error('Authentication key not available');
    }
    
    // Create data to authenticate (matching browser format exactly)
    // C++ uses: "%d|%s|%s|%ld|%u" with raw binary nonce and encrypted_payload (not base64!)
    // After base64 decode in C++: message.nonce.c_str() and message.encrypted_payload.c_str()
    const authData = `${messageType}|${nonce.toString('latin1')}|${encryptedPayload.toString('latin1')}|${timestamp}|${sequenceNumber}`;
    
    console.log(`[SecureIPC] STALENESS-DEBUG: Generating auth tag with data: ${authData}`);
    console.log(`[SecureIPC] STALENESS-DEBUG: Auth data length: ${authData.length}`);
    console.log(`[SecureIPC] STALENESS-DEBUG: Nonce length: ${nonce.length}, Encrypted payload length: ${encryptedPayload.length}`);
    
    const hmac = crypto.createHmac('sha256', this.authKey);
    hmac.update(authData, 'utf8');
    return hmac.digest();
  }
  
  // Create secure message (matching browser's SecureMessage format)
  createSecureMessage(messageType, payload) {
    if (!this.encryptionKey || !this.authKey) {
      throw new Error('Encryption keys not available for secure messaging');
    }
    
    const nonce = this.generateNonce();
    const encryptedPayload = this.encryptPayload(payload, nonce);
    const timestamp = Date.now();
    const sequenceNumber = ++this.sequenceNumber;
    
    // Map message types to integers (matching browser's MessageType enum)
    const messageTypeMap = {
      'TOKEN_REQUEST': 0,
      'TOKEN_RESPONSE': 1, 
      'TOKEN_REFRESH': 2,
      'HEALTH_CHECK': 3,
      'SHUTDOWN_SIGNAL': 4,
      'SUBSCRIBE_TOKEN_ROTATION': 5
    };
    
    const messageTypeInt = messageTypeMap[messageType] || 5; // Default to SUBSCRIBE_TOKEN_ROTATION
    
    // Generate auth tag using raw binary data (before base64 encoding)
    const authTag = this.generateAuthTag(messageTypeInt, nonce, encryptedPayload, timestamp, sequenceNumber);
    
    // Convert to base64 for message format (after auth tag generation)
    const nonceBase64 = nonce.toString('base64');
    const encryptedPayloadBase64 = encryptedPayload.toString('base64');
    
    return {
      message_type: messageTypeInt,
      nonce: nonceBase64,
      encrypted_payload: encryptedPayloadBase64,
      auth_tag: authTag.toString('base64'),
      timestamp: timestamp,
      sequence_number: sequenceNumber
    };
  }
  
  connect() {
    if (this.connected || !this.socketPath) {
      return Promise.resolve();
    }
    
    return new Promise((resolve, reject) => {
      console.log(`[SecureIPC] Connecting to socket: ${this.socketPath}`);
      console.log(`[SecureIPC] STALENESS-1: Current connection status: ${this.connected}`);
      console.log(`[SecureIPC] STALENESS-1: Socket path exists: ${this.socketPath ? 'YES' : 'NO'}`);
      
      this.client = net.createConnection(this.socketPath);
      
      this.client.on('connect', () => {
        console.log('[SecureIPC] Connected to secure IPC server');
        console.log('[SecureIPC] STALENESS-1: Connection established successfully');
        console.log('[SecureIPC] STALENESS-1: Connection timestamp:', new Date().toISOString());
        this.connected = true;
        this.lastConnectionTime = new Date();
        this.startTokenRotationListener();
        this.startHeartbeat();  // Start heartbeat to keep connection alive
        resolve();
      });
      
      this.client.on('data', (data) => {
        this.handleIPCMessage(data);
      });
      
      this.client.on('error', (err) => {
        console.error(`[SecureIPC] Connection error: ${err.message}`);
        console.error(`[SecureIPC] STALENESS-1: Connection failed - socket path: ${this.socketPath}`);
        console.error(`[SecureIPC] STALENESS-1: Error code: ${err.code}, syscall: ${err.syscall}`);
        this.lastErrorTime = new Date();
        this.lastError = err.message;
        this.handleConnectionLoss();
        reject(err);
      });
      
      this.client.on('close', () => {
        console.log('[SecureIPC] Connection closed');
        console.log('[SecureIPC] STALENESS-1: Connection closed at:', new Date().toISOString());
        const uptime = this.lastConnectionTime ? (new Date() - this.lastConnectionTime) : 0;
        console.log('[SecureIPC] STALENESS-1: Connection was up for:', Math.round(uptime/1000), 'seconds');
        this.lastCloseTime = new Date();
        this.handleConnectionLoss();
      });
    });
  }
  
  handleIPCMessage(data) {
    try {
      console.log(`[SecureIPC] STALENESS-4: Raw message received at ${new Date().toISOString()}`);
      console.log(`[SecureIPC] STALENESS-4: Message size: ${data.length} bytes`);
      console.log(`[SecureIPC] STALENESS-4: Raw data: ${data.toString().substring(0, 200)}...`);
      
      // Handle simple ping messages
      if (data.toString() === 'ping') {
        console.log('[SecureIPC] Received ping from browser - connection healthy');
        return;
      }
      
      const message = JSON.parse(data.toString());
      console.log(`[SecureIPC] STALENESS-4: Parsed message keys:`, Object.keys(message));
      
      // Check if this is an encrypted SecureMessage format from browser
      if (message.message_type !== undefined && message.encrypted_payload && message.auth_tag) {
        console.log('[SecureIPC] Processing encrypted SecureMessage from browser');
        console.log(`[SecureIPC] Message type: ${message.message_type}, sequence: ${message.sequence_number}`);
        
        if (message.message_type === 6) { // TOKEN_ROTATION_NOTIFICATION
          console.log('[SecureIPC] This is a token rotation notification (encrypted)');
          
          if (!this.encryptionKey || !this.authKey) {
            console.error('[SecureIPC] Cannot decrypt notification - no encryption keys available');
            return;
          }
          
          try {
            // Decrypt the payload
            const nonce = Buffer.from(message.nonce, 'base64');
            const encryptedPayload = Buffer.from(message.encrypted_payload, 'base64');
            
            const decryptedPayload = this.decryptPayload(encryptedPayload, nonce);
            const notificationData = JSON.parse(decryptedPayload);
            
            console.log('[SecureIPC] Decrypted token rotation notification:');
            console.log(`[SecureIPC] STALENESS-4: Browser instance: ${notificationData.browser_instance_id}`);
            console.log(`[SecureIPC] STALENESS-4: New token length: ${notificationData.new_token ? notificationData.new_token.length : 'UNDEFINED'}`);
            
            if (this.tokenRotationCallback) {
              this.lastTokenRotationTime = new Date();
              this.tokenRotationCallback(notificationData.browser_instance_id, notificationData.new_token);
            } else {
              console.warn('[SecureIPC] STALENESS-4: Token rotation received but no callback registered!');
            }
          } catch (decryptError) {
            console.error(`[SecureIPC] Failed to decrypt token rotation notification: ${decryptError.message}`);
          }
          
        } else if (message.message_type === 1) { // TOKEN_RESPONSE (subscription confirmation)
          console.log('[SecureIPC] Received subscription confirmation from browser');
          
        } else {
          console.log(`[SecureIPC] STALENESS-4: Unhandled encrypted message type: ${message.message_type}`);
        }
        
      } else if (message.type === 'token_rotation') {
        // Handle legacy plain JSON format (backward compatibility)
        console.log('[SecureIPC] Processing legacy token rotation notification (plain JSON)');
        console.log(`[SecureIPC] STALENESS-4: Token rotation for browser: ${message.browser_instance_id}`);
        console.log(`[SecureIPC] STALENESS-4: New token length: ${message.new_token ? message.new_token.length : 'UNDEFINED'}`);
        
        if (this.tokenRotationCallback) {
          this.lastTokenRotationTime = new Date();
          this.tokenRotationCallback(message.browser_instance_id, message.new_token);
        } else {
          console.warn('[SecureIPC] STALENESS-4: Token rotation message received but no callback registered!');
        }
        
      } else {
        console.log(`[SecureIPC] STALENESS-4: Unhandled message format:`, Object.keys(message));
      }
    } catch (error) {
      console.error(`[SecureIPC] Failed to parse message: ${error.message}`);
      console.error(`[SecureIPC] STALENESS-4: Parse error - raw data:`, data.toString());
    }
  }
  
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    console.log('[SecureIPC] Scheduling reconnection in 5 seconds...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        console.error(`[SecureIPC] Reconnection failed: ${err.message}`);
      });
    }, 5000);
  }
  
  startTokenRotationListener() {
    if (!this.connected) return;
    
    try {
      if (this.encryptionKey && this.authKey) {
        // Use secure encrypted messaging
        console.log('[SecureIPC] Sending encrypted token rotation subscription');
        
        // Create subscription payload 
        const payload = JSON.stringify({
          type: 'subscribe_token_rotation',
          timestamp: Date.now()
        });
        
        // Create encrypted message
        const secureMessage = this.createSecureMessage('SUBSCRIBE_TOKEN_ROTATION', payload);
        
        this.client.write(JSON.stringify(secureMessage));
        console.log('[SecureIPC] Encrypted subscription sent to browser');
        
      } else {
        // Fallback to plain JSON (compatibility mode)
        console.log('[SecureIPC] No encryption keys available, using plain JSON (compatibility mode)');
        
        const request = {
          type: 'subscribe_token_rotation',
          timestamp: Date.now()
        };
        
        this.client.write(JSON.stringify(request));
        console.log('[SecureIPC] Plain JSON subscription sent to browser');
      }
    } catch (error) {
      console.error(`[SecureIPC] Failed to subscribe to token rotation: ${error.message}`);
    }
  }
  
  startHeartbeat() {
    // Clear any existing heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Send periodic heartbeats to keep connection alive
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.client) {
        try {
          // The C++ side expects simple ping messages
          // Heartbeat is just to keep connection alive, not for token rotation
          console.log('[SecureIPC] Sending heartbeat ping to maintain connection');
        } catch (error) {
          console.error('[SecureIPC] Heartbeat failed:', error.message);
          this.handleConnectionLoss();
        }
      }
    }, 90000); // Ping every 90 seconds (less than C++ 2-minute timeout)
    
    console.log('[SecureIPC] Heartbeat monitor started (90-second interval)');
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('[SecureIPC] Heartbeat monitor stopped');
    }
  }
  
  handleConnectionLoss() {
    console.log('[SecureIPC] Connection loss detected, cleaning up...');
    this.connected = false;
    this.stopHeartbeat();
    
    if (this.client) {
      try {
        this.client.destroy();
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.client = null;
    }
    
    if (!this.reconnectTimer) {
      this.scheduleReconnect();
    }
  }
  
  onTokenRotation(callback) {
    this.tokenRotationCallback = callback;
  }
  
  disconnect() {
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    
    this.connected = false;
    console.log('[SecureIPC] Disconnected from secure IPC server');
  }
}

// Initialize secure IPC client if socket path is provided
let secureIPCClient = null;
if (SECURE_IPC_SOCKET) {
  secureIPCClient = new SecureIPCClient(SECURE_IPC_SOCKET);
  
  // Set up token rotation handler
  secureIPCClient.onTokenRotation((browserInstanceId, newToken) => {
    console.log(`[TokenRotation] STALENESS-4: Received new token for browser ${browserInstanceId}`);
    console.log(`[TokenRotation] STALENESS-4: Callback invoked at ${new Date().toISOString()}`);
    console.log(`[TokenRotation] STALENESS-4: New token length: ${newToken ? newToken.length : 'UNDEFINED'}`);
    
    // Update browser connection with new token
    const connectionInfo = browserConnections.get(browserInstanceId);
    if (connectionInfo) {
      console.log(`[TokenRotation] STALENESS-4: Found existing connection for ${browserInstanceId}`);
      console.log(`[TokenRotation] STALENESS-4: Current token age: ${connectionInfo.updated_at ? Math.round((new Date() - connectionInfo.updated_at)/1000) : Math.round((new Date() - connectionInfo.registered_at)/1000)}s`);
      
      const newCdpUrl = `http://localhost:${connectionInfo.port}?token=${newToken}`;
      
      browserConnections.set(browserInstanceId, {
        ...connectionInfo,
        token: newToken,
        cdp_url: newCdpUrl,
        updated_at: new Date(),
        expiry: new Date(Date.now() + 60000) // Refresh expiry to 1 minute from now during token rotation
      });
      
      console.log(`[TokenRotation] Updated connection for browser ${browserInstanceId}`);
      console.log(`[TokenRotation] STALENESS-4: Connection map now has ${browserConnections.size} entries`);
      console.log(`[TokenRotation] New CDP URL: [REDACTED]`);
    } else {
      console.warn(`[TokenRotation] No connection found for browser ${browserInstanceId}`);
      console.warn(`[TokenRotation] STALENESS-4: Available browsers in map:`, Array.from(browserConnections.keys()));
      
      // CRITICAL FIX: Create missing connection entry when receiving token rotation
      // This handles cases where the MCP server restarted or connection was cleaned up
      console.log(`[TokenRotation] CRITICAL FIX: Creating missing connection for browser ${browserInstanceId}`);
      
      // We can reconstruct the connection info from the token rotation message
      // The CDP port is typically 9222 for the main Chrome instance
      const reconstructedConnection = {
        port: 9222, // Standard Chrome CDP port
        token: newToken,
        expiry: new Date(Date.now() + 60000), // 1 minute expiry (matches C++ token validity)
        cdp_url: newCdpUrl,
        registered_at: new Date(),
        updated_at: new Date(),
        mode: 'token_rotation_recovery',
        protocol_version: '1.0',
        capabilities: ['encrypted_communication', 'token_rotation']
      };
      
      browserConnections.set(browserInstanceId, reconstructedConnection);
      
      console.log(`[TokenRotation] RECOVERY: Added missing connection for browser ${browserInstanceId}`);
      console.log(`[TokenRotation] RECOVERY: Connection map now has ${browserConnections.size} entries`);
      console.log(`[TokenRotation] RECOVERY: Browser will be available for new tasks`);
    }
  });
  
  // Connect to secure IPC server
  console.log('[SecureIPC] STALENESS-1: Initiating connection to secure IPC server');
  console.log('[SecureIPC] STALENESS-1: Token rotation callback registered:', typeof secureIPCClient.tokenRotationCallback === 'function');
  
  secureIPCClient.connect().then(() => {
    console.log('[SecureIPC] STALENESS-1: Initial connection successful');
    console.log('[SecureIPC] STALENESS-1: Connection status check - connected:', secureIPCClient.connected);
  }).catch(err => {
    console.warn(`[SecureIPC] Initial connection failed: ${err.message}`);
    console.warn('[SecureIPC] STALENESS-1: Initial connection failed - will retry automatically...');
    console.warn('[SecureIPC] STALENESS-1: Failed connection details:', {
      socketPath: secureIPCClient.socketPath,
      connected: secureIPCClient.connected,
      error: err.code
    });
  });
  
  // Add periodic connection status logging
  setInterval(() => {
    console.log(`[SecureIPC] STALENESS-1: Periodic status check at ${new Date().toISOString()}`);
    console.log(`[SecureIPC] STALENESS-1: Connected: ${secureIPCClient.connected}`);
    console.log(`[SecureIPC] STALENESS-1: Last connection: ${secureIPCClient.lastConnectionTime || 'never'}`);
    console.log(`[SecureIPC] STALENESS-1: Last token rotation: ${secureIPCClient.lastTokenRotationTime || 'never'}`);
    console.log(`[SecureIPC] STALENESS-1: Last error: ${secureIPCClient.lastError || 'none'}`);
    console.log(`[SecureIPC] STALENESS-1: Browser connections in map: ${browserConnections.size}`);
  }, 15000); // Every 15 seconds
}

// Global state
let browserAgents = new Map(); // Map of task ID to browser agent
let narratorEvents = [];
let taskIdCounter = 1;
let taskEventQueues = new Map(); // Map of task ID to TaskEventQueue
let browserConnections = new Map(); // Map of browser instance ID to connection info
// Track human intervention requests/resolutions per task
// let interventionsByTask = new Map(); // taskId -> { taskId, message, context, created_at, resolved, action, response_message }

// Metrics tracking
const metrics = {
  requests: {
    total: 0,
    byEndpoint: new Map(),
    byStatus: new Map()
  },
  tasks: {
    total: 0,
    successful: 0,
    failed: 0,
    average_duration_ms: 0
  },
  security: {
    unauthorized_attempts: 0,
    expired_tokens: 0,
    registered_browsers: 0
  },
  startTime: new Date()
};

// Per-task event queue management
class TaskEventQueue {
  constructor(taskId, ttl = 300000) { // 5 min TTL
    this.taskId = taskId;
    this.events = [];
    this.eventEmitter = new EventEmitter();
    this.lastEventId = 0;
    this.ttl = ttl;
    this.acknowledged = new Set();
    
    // Auto-cleanup old events
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - this.ttl;
      this.events = this.events.filter(e => {
        return e.timestamp > cutoff && !this.acknowledged.has(e.id);
      });
      // Clean acknowledged set too
      this.acknowledged = new Set(
        Array.from(this.acknowledged).filter(id => 
          this.events.some(e => e.id === id)
        )
      );
    }, 60000); // Clean every minute
  }
  
  addEvent(type, message) {
    const event = {
      id: ++this.lastEventId,
      type,
      message,
      timestamp: Date.now(),
      taskId: this.taskId
    };
    
    this.events.push(event);
    this.eventEmitter.emit('event', event);
    console.log(`[TaskQueue ${this.taskId}] Added event ${event.id}: ${type}`);
    return event.id;
  }
  
  acknowledge(eventId) {
    this.acknowledged.add(eventId);
    console.log(`[TaskQueue ${this.taskId}] Acknowledged event ${eventId}`);
  }
  
  getUnacknowledged() {
    return this.events.filter(e => !this.acknowledged.has(e.id));
  }
  
  destroy() {
    clearInterval(this.cleanupTimer);
    this.eventEmitter.removeAllListeners();
    console.log(`[TaskQueue ${this.taskId}] Destroyed`);
  }
}




// Helper function to get secure browser connection
async function getSecureBrowserConnection(browserInstanceId) {
  // If no browser instance specified, try to use any registered browser
  if (!browserInstanceId) {
    // Find first non-expired browser
    for (const [id, info] of browserConnections) {
      if (new Date() < info.expiry) {
        browserInstanceId = id;
        break;
      }
    }
  }
  
  if (!browserInstanceId) {
    throw new Error('No registered browser available. Please register a browser first.');
  }
  
  const connectionInfo = browserConnections.get(browserInstanceId);
  if (!connectionInfo) {
    throw new Error(`Browser instance ${browserInstanceId} not registered`);
  }
  
  // Check if token is expired
  if (new Date() > connectionInfo.expiry) {
    browserConnections.delete(browserInstanceId);
    metrics.security.expired_tokens++;
    throw new Error(`Browser token expired for instance ${browserInstanceId}`);
  }
  
  // Check if token is too old (more than 30 seconds since registration or last update)
  const now = new Date();
  const tokenAge = connectionInfo.updated_at ? 
    (now - connectionInfo.updated_at) : 
    (now - connectionInfo.registered_at);
  
  console.log(`[Security] STALENESS-2: Token age check for ${browserInstanceId}`);
  console.log(`[Security] STALENESS-2: Current time: ${now.toISOString()}`);
  console.log(`[Security] STALENESS-2: Registered at: ${connectionInfo.registered_at ? connectionInfo.registered_at.toISOString() : 'UNDEFINED'}`);
  console.log(`[Security] STALENESS-2: Last updated: ${connectionInfo.updated_at ? connectionInfo.updated_at.toISOString() : 'NEVER'}`);
  console.log(`[Security] STALENESS-2: Calculated token age: ${Math.round(tokenAge/1000)}s`);
  console.log(`[Security] STALENESS-2: Using timestamp: ${connectionInfo.updated_at ? 'updated_at' : 'registered_at'}`);
  
  if (tokenAge > 30000) { // 30 seconds
    console.warn(`[Security] Token for ${browserInstanceId} is ${Math.round(tokenAge/1000)}s old, may be stale`);
    console.warn(`[Security] Consider requesting fresh token if connection fails`);
    console.warn(`[Security] STALENESS-2: TOKEN IS STALE - connection may fail`);
    console.warn(`[Security] STALENESS-2: Stale token details:`, {
      browserInstanceId,
      tokenAge: Math.round(tokenAge/1000) + 's',
      registeredAt: connectionInfo.registered_at,
      lastUpdated: connectionInfo.updated_at,
      port: connectionInfo.port
    });
  } else {
    console.log(`[Security] STALENESS-2: Token is fresh (${Math.round(tokenAge/1000)}s old)`);
  }
  
  return connectionInfo;
}

// Wait for a registered secure browser connection to become available.
// This eliminates a race between server startup/registration and the first task.
async function waitForRegisteredConnection(browserInstanceId, maxWaitMs = 8000) {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const endTime = Date.now() + maxWaitMs;
  let lastError = null;

  while (Date.now() < endTime) {
    try {
      // Prefer the requested browser instance if provided
      const info = await getSecureBrowserConnection(browserInstanceId);
      return info;
    } catch (err) {
      lastError = err;
      // As a fallback, try any non-expired registered browser
      for (const [id, info] of browserConnections) {
        if (new Date() < info.expiry) {
          return info;
        }
      }
      await sleep(250);
    }
  }

  // If we get here, no registration became available in time
  if (lastError) throw lastError;
  throw new Error('No registered browser available (timeout waiting for registration)');
}

// Helper function to create a new browser agent for each task
async function createBrowserAgentForTask(taskId, browserInstanceId = null) {
  try {
    // Creating new browser agent for task
    
    let cdpUrl;
    
    // Parse CDP URL to check for token (auto-detect secure mode)
    const cdpUrlObj = new URL(FIXED_CDP_URL);
    const token = cdpUrlObj.searchParams.get('token');
    
    if (token) {
      // Token detected - use secure CDP mode
      console.log(`[Security] Token detected in CDP URL, using secure authentication`);
      console.log(`[Security] Fixed hostname issue: ${CDP_URL} -> ${FIXED_CDP_URL}`);
      // Resolve ws endpoint to avoid malformed http?token=/json/version concatenation
      cdpUrl = await resolveWsEndpoint(FIXED_CDP_URL);
      console.log(`[Security] Resolved WS endpoint for secure CDP: [REDACTED]`);
      
      // Connect via Playwright and reuse persistent browser context to avoid creating a new one
      const browser = await chromium.connectOverCDP(cdpUrl);
      let context = browser.contexts()[0];
      if (!context) {
        for (let i = 0; i < 10 && !context; i++) {
          await new Promise(r => setTimeout(r, 100));
          context = browser.contexts()[0];
        }
      }
      if (!context) {
        throw new Error('Persistent browser context not available over CDP');
      }
      console.log('[Security] Using persistent browser context over secure CDP');
      
      const browserAgent = await startBrowserAgent({
        browser: { context },
        llm: {
          provider: 'anthropic',
          options: {
            model: 'claude-sonnet-4-20250514',
            apiKey: getSecret('ANTHROPIC_API_KEY'),
            temperature: 0.2,
            promptCaching: true
          }
        },
        // Add agent prompt to guide human intervention usage
        prompt: buildAgentPrompt(),
        visuals: {
          showCursor: true,
          showHoverCircle: false,
          showClickRipple: false,
          showDragLine: false,
          showTypeEffects: false
        },
        narrate: true
      });
      // Browser agent created using persistent context
      // Attach task id for actions (e.g., request_intervention)
      browserAgent.taskId = taskId;
      return browserAgent;
    } else if (process.env.USE_SECURE_CDP === 'true') {
      // Secure mode requested: prefer the registered connection, with a short wait to avoid race
      console.log('[Security] Secure mode enabled - waiting for registered browser connection (up to 3s)');
      try {
        const connectionInfo = await waitForRegisteredConnection(browserInstanceId, 3000);
        const chosenId = browserInstanceId || [...browserConnections.keys()][0];
        console.log(`[Security] Using registered connection for browser ${chosenId} on port ${connectionInfo.port}`);
        // connectionInfo.cdp_url is HTTP with token; resolve to WS endpoint with token
        cdpUrl = await resolveWsEndpoint(connectionInfo.cdp_url);
        console.log('[Security] Resolved WS endpoint for secure CDP via registered connection');
        
        // Connect via Playwright and reuse persistent browser context
        const browser = await chromium.connectOverCDP(cdpUrl);
        let context = browser.contexts()[0];
        if (!context) {
          for (let i = 0; i < 10 && !context; i++) {
            await new Promise(r => setTimeout(r, 100));
            context = browser.contexts()[0];
          }
        }
        if (!context) {
          throw new Error('Persistent browser context not available over CDP');
        }
        console.log('[Security] Using persistent browser context over secure CDP (registered connection)');
        
        const browserAgent = await startBrowserAgent({
          browser: { context },
          llm: {
            provider: 'anthropic',
            options: {
              model: 'claude-sonnet-4-20250514',
              apiKey: getSecret('ANTHROPIC_API_KEY'),
              temperature: 0.2,
              promptCaching: true
            }
          },
          // prompt: buildAgentPrompt(),
          visuals: {
            showCursor: false,
            showHoverCircle: false,
            showClickRipple: false,
            showDragLine: false,
            showTypeEffects: false
          },
          narrate: true
        });
        // Browser agent created using persistent context (registered)
        browserAgent.taskId = taskId;
        return browserAgent;
      } catch (error) {
        console.error(`[Security] Failed to obtain registered browser connection within timeout: ${error.message}`);
        throw new Error('Secure browser connection not yet available. Please retry momentarily.');
      }
    } else {
      // No token detected - use insecure connection
      if (browserInstanceId) {
        console.log(`[INFO] Ignoring browser_instance_id '${browserInstanceId}' in non-secure mode`);
      }
      console.log(`[WARNING] Using insecure CDP connection at ${FIXED_CDP_URL}`);
      cdpUrl = FIXED_CDP_URL;
    }
    
    // Starting browser agent with CDP URL
    
    // Let magnitude-core handle the connection internally by passing CDP URL
    // This ensures that magnitude-core uses our secure token instead of generating its own
    const browserAgent = await startBrowserAgent({
      browser: { 
        cdp: cdpUrl,  // Pass CDP URL directly to magnitude-core
        contextOptions: {
          viewport: { width: 1280, height: 720 }
        }
      },
      llm: {
        provider: 'anthropic',
        options: {
          model: 'claude-sonnet-4-20250514',
          apiKey: getSecret('ANTHROPIC_API_KEY'),
          temperature: 0.2,
          promptCaching: true
        }
      },
      // prompt: buildAgentPrompt(),
      // Visual configuration - disable all effects, including cursor and keyboard overlay
      visuals: {
        showCursor: false,
        showHoverCircle: false,
        showClickRipple: false,
        showDragLine: false,
        showTypeEffects: false
      },
      // Enable narration for debugging
      narrate: true
    });
    
    // Browser agent created successfully
    
    // Track browser instance ID for connection pooling
    browserAgent.browserInstanceId = browserInstanceId;
    // // Attach task id for actions (e.g., request_intervention)
    // browserAgent.taskId = taskId;
    
    // Set up narrator event listeners for this agent
    if (browserAgent.browserAgentEvents) {
      browserAgent.browserAgentEvents.on('nav', async (url) => {
        // Navigation event (not logged to avoid clutter)
      });
      
      browserAgent.browserAgentEvents.on('extractStarted', (instructions) => {
        // Extract started (not logged to avoid clutter)
      });
      
      browserAgent.browserAgentEvents.on('extractDone', (instructions, data) => {
        // Extract completed (not logged to avoid clutter)
      });
      
      browserAgent.browserAgentEvents.on('action', (action) => {
        // Action event (not logged to avoid clutter)
      });
      // Note: thought listeners are now handled via emit interception above
    }
    
    // Note: thought listeners are now handled via emit interception above
    
    // Verify that the browser agent is focused on the correct tab
    try {
      const currentPage = browserAgent.page;
      if (currentPage) {
        const currentUrl = currentPage.url();
        const currentTitle = await currentPage.title();
        console.log(`🔍 FOCUS VERIFICATION: Agent ${taskId} active tab - URL: ${currentUrl}, Title: ${currentTitle}`);
      } else {
        console.log(`⚠️  FOCUS WARNING: Agent ${taskId} has no active page!`);
      }
    } catch (error) {
      console.log(`⚠️  FOCUS ERROR: Could not verify agent ${taskId} focus: ${error.message}`);
    }
    
    // Browser agent created with new tab
    return browserAgent;
  } catch (error) {
    console.error(`Failed to create browser agent for task ${taskId}:`, error);
    throw error;
  }
}

// Simplified helper function to add narrator events
function addNarratorEvent(type, message) {
  const event = {
    type,
    message,
    timestamp: new Date().toISOString()
  };
  narratorEvents.push(event);
  console.log(`[Narrator] ${type}: ${message}`);
  
  // Keep only last 100 events
  if (narratorEvents.length > 100) {
    narratorEvents = narratorEvents.slice(-100);
  }
  
  // Extract task ID from message and add to task-specific queue
  const taskIdMatch = message.match(/\[Task (\d+)\]/);
  if (taskIdMatch) {
    const taskId = parseInt(taskIdMatch[1]);
    const taskQueue = taskEventQueues.get(taskId);
    if (taskQueue) {
      // Don't double-add events that are already being added directly to the queue
      // Only add narrator-specific events here
      if (!['task_start', 'act', 'extract', 'check', 'navigate', 'task_complete', 'error', 'task_stopped'].includes(type)) {
        taskQueue.addEvent(type, message);
      }
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeTasks: browserAgents.size,
    cdpUrl: FIXED_CDP_URL,
    originalCdpUrl: CDP_URL,
    port: PORT
  });
});

// MCP health check endpoint (for C++ integration)
app.get('/mcp/health', (req, res) => {
  res.json({
    status: 'ok',
    activeTasks: browserAgents.size,
    cdpUrl: FIXED_CDP_URL,
    originalCdpUrl: CDP_URL
  });
});

// Browser registration endpoint for secure CDP connections
// Enhanced browser registration with protocol negotiation
app.post('/register-browser', (req, res) => {
  const authHeader = req.headers.authorization;
  
  // Handle case where secrets haven't been initialized from AWS (beta users)
  let browserApiKey;
  try {
    browserApiKey = getSecret('BROWSER_API_KEY');
  } catch (error) {
    // If secrets not initialized, use default for registration validation
    browserApiKey = 'default-browser-key';
    console.log('[Security] Using default BROWSER_API_KEY for registration validation (secrets not initialized)');
  }
  
  // Extract protocol version from request
  const protocolVersion = req.headers['x-protocol-version'] || "1.0";
  const clientCapabilities = req.headers['x-capabilities'] ? 
    req.headers['x-capabilities'].split(',').map(c => c.trim()) : [];
  
  console.log(`[Protocol] Registration request - Version: ${protocolVersion}, Capabilities: [${clientCapabilities.join(', ')}]`);
  
  // For legacy compatibility, allow registration without authentication in degraded mode
  // This enables the key exchange flow for clients that fail initial registration
  let authenticationMode = 'secure';
  if (!authHeader || !authHeader.startsWith('Bearer ') || 
      authHeader.substring(7) !== browserApiKey) {
    
    // Check if this is a protocol negotiation request
    if (req.headers['x-protocol-negotiation'] === 'true') {
      console.log('[Protocol] Allowing unauthenticated registration for key exchange');
      authenticationMode = 'key_exchange_only';
    } else {
      return res.status(401).json({ 
        error: 'Invalid browser API key',
        protocol_version: PROTOCOL_VERSION,
        supported_capabilities: SUPPORTED_CAPABILITIES,
        hint: 'Try protocol negotiation mode for key exchange'
      });
    }
  }
  
  const { cdp_port, cdp_token, token_expiry, browser_instance_id, encryption_key, auth_key } = req.body;
  
  console.log(`[Security] Browser registration received - Mode: ${authenticationMode}`);
  
  if (!browser_instance_id) {
    return res.status(400).json({ error: 'Missing browser_instance_id' });
  }
  
  // For key exchange mode, only require browser instance ID
  if (authenticationMode === 'key_exchange_only') {
    // Generate temporary connection for key exchange
    const tempConnectionInfo = {
      browser_instance_id: browser_instance_id,
      registered_at: new Date(),
      mode: 'key_exchange_only',
      expires_at: new Date(Date.now() + 30000), // 30 second window
      key_exchange_pending: true
    };
    
    browserConnections.set(browser_instance_id, tempConnectionInfo);
    
    console.log(`[Protocol] Temporary registration for key exchange: ${browser_instance_id}`);
    return res.json({ 
      success: true, 
      message: 'Temporary registration for key exchange',
      browser_instance: browser_instance_id,
      mode: 'key_exchange_only',
      expires_in: 30,
      next_step: '/exchange-keys'
    });
  }
  
  // Full registration mode - require all fields
  if (!cdp_port || !cdp_token || !token_expiry) {
    return res.status(400).json({ error: 'Missing required fields for full registration' });
  }
  
  // Validate encryption keys are provided for secure IPC
  if (!encryption_key || !auth_key) {
    return res.status(400).json({ error: 'Missing encryption keys for secure IPC' });
  }
  
  console.log(`[Security] Received encryption keys for browser ${browser_instance_id}`);
  console.log(`  Encryption key length: ${encryption_key.length}`);
  console.log(`  Auth key length: ${auth_key.length}`);
  
  // Validate encryption keys with enhanced validation
  const keyValidation = validateEncryptionKeys(encryption_key, auth_key);
  if (!keyValidation.valid) {
    console.error(`[Security] Key validation failed: ${keyValidation.error}`);
    
    // Determine if this is a protocol negotiation request
    const use_protocol_negotiation = (authenticationMode === 'key_exchange_only');
    
    // Offer key recovery if this is a retry attempt
    if (use_protocol_negotiation) {
      console.log(`[Security] Attempting key recovery for protocol negotiation`);
      const fallbackKeys = generateFallbackKeys();
      
      return res.status(400).json({
        error: 'Invalid encryption keys - key recovery offered',
        key_validation_error: keyValidation.error,
        recovery_option: {
          message: 'Server can provide fallback keys for this session',
          fallback_keys: fallbackKeys,
          warning: 'Fallback keys are temporary and should be replaced'
        }
      });
    }
    
    return res.status(400).json({ 
      error: 'Invalid encryption keys format',
      details: keyValidation.error
    });
  }
  
  const encryptionKeyBuffer = keyValidation.encBuffer;
  const authKeyBuffer = keyValidation.authBuffer;
  
  // Store browser connection info with encryption keys
  browserConnections.set(browser_instance_id, {
    port: cdp_port,
    token: cdp_token,
    expiry: new Date(token_expiry),
    cdp_url: `http://localhost:${cdp_port}?token=${cdp_token}`,
    registered_at: new Date(),
    updated_at: new Date(),  // Track token updates
    encryptionKey: encryptionKeyBuffer,  // AES-256-GCM key
    authKey: authKeyBuffer,               // HMAC-SHA256 key
    mode: 'full_registration',
    protocol_version: protocolVersion,
    capabilities: clientCapabilities
  });
  
  console.log(`[Security] Browser registered: ${browser_instance_id} on port ${cdp_port}`);
  metrics.security.registered_browsers++;
  
  // Configure SecureIPC client with encryption keys if available
  if (secureIPCClient && encryptionKeyBuffer && authKeyBuffer) {
    secureIPCClient.setEncryptionKeys(encryptionKeyBuffer, authKeyBuffer);
    console.log(`[Security] SecureIPC client configured with encryption keys for browser ${browser_instance_id}`);
  }
  
  res.json({ 
    success: true, 
    browser_instance: browser_instance_id,
    message: 'Browser registered successfully',
    protocol_version: PROTOCOL_VERSION,
    server_capabilities: SUPPORTED_CAPABILITIES 
  });
});

// Separate key exchange endpoint for protocol negotiation
app.post('/exchange-keys', (req, res) => {
  const { browser_instance_id, encryption_key, auth_key } = req.body;
  
  if (!browser_instance_id || !encryption_key || !auth_key) {
    return res.status(400).json({ 
      error: 'Missing required fields: browser_instance_id, encryption_key, auth_key' 
    });
  }
  
  // Check if there's a temporary registration for this browser
  const connectionInfo = browserConnections.get(browser_instance_id);
  if (!connectionInfo) {
    return res.status(404).json({ 
      error: 'Browser instance not found. Please register first with protocol negotiation mode.' 
    });
  }
  
  // Check if this is a key exchange only registration
  if (connectionInfo.mode !== 'key_exchange_only') {
    return res.status(400).json({ 
      error: 'Key exchange not allowed for this registration mode.' 
    });
  }
  
  // Check if the temporary registration has expired
  if (new Date() > connectionInfo.expires_at) {
    browserConnections.delete(browser_instance_id);
    return res.status(410).json({ 
      error: 'Key exchange window expired. Please re-register.' 
    });
  }
  
  // Validate encryption keys with enhanced validation
  const keyValidation = validateEncryptionKeys(encryption_key, auth_key);
  if (!keyValidation.valid) {
    console.error(`[Protocol] Key validation failed for ${browser_instance_id}: ${keyValidation.error}`);
    
    // For key exchange, offer recovery with fallback keys
    console.log(`[Protocol] Offering key recovery for ${browser_instance_id}`);
    const fallbackKeys = generateFallbackKeys();
    
    // Update the temporary connection with fallback keys
    connectionInfo.fallback_keys_offered = true;
    connectionInfo.fallback_keys = fallbackKeys;
    browserConnections.set(browser_instance_id, connectionInfo);
    
    return res.status(400).json({
      error: 'Invalid encryption keys - key recovery available',
      key_validation_error: keyValidation.error,
      recovery_option: {
        message: 'Server has generated fallback keys for this session',
        fallback_keys: fallbackKeys,
        warning: 'These are temporary keys - consider regenerating client keys',
        next_step: 'Use fallback keys or regenerate client keys and retry'
      }
    });
  }
  
  const encryptionKeyBuffer = keyValidation.encBuffer;
  const authKeyBuffer = keyValidation.authBuffer;
  console.log(`[Protocol] Encryption keys validated for ${browser_instance_id}`);
  
  // Update connection info with encryption keys
  connectionInfo.encryptionKey = encryptionKeyBuffer;
  connectionInfo.authKey = authKeyBuffer;
  connectionInfo.key_exchange_pending = false;
  connectionInfo.key_exchange_completed_at = new Date();
  connectionInfo.mode = 'encryption_established';
  
  browserConnections.set(browser_instance_id, connectionInfo);
  
  // Configure SecureIPC client with encryption keys
  if (secureIPCClient) {
    secureIPCClient.setEncryptionKeys(encryptionKeyBuffer, authKeyBuffer);
    console.log(`[Protocol] SecureIPC client configured with encryption keys for ${browser_instance_id}`);
  }
  
  console.log(`[Protocol] Key exchange completed for ${browser_instance_id}`);
  
  res.json({ 
    success: true, 
    message: 'Encryption keys exchanged successfully',
    browser_instance: browser_instance_id,
    protocol_version: PROTOCOL_VERSION,
    encryption_status: 'established',
    next_step: 'Secure communication now available'
  });
});

// Connection validation endpoint to test encryption setup
app.post('/validate-connection', (req, res) => {
  const { browser_instance_id, test_message } = req.body;
  
  if (!browser_instance_id) {
    return res.status(400).json({ error: 'Missing browser_instance_id' });
  }
  
  const connectionInfo = browserConnections.get(browser_instance_id);
  if (!connectionInfo) {
    return res.status(404).json({ 
      error: 'Browser instance not found',
      browser_instance_id: browser_instance_id
    });
  }
  
  // Check if encryption keys are available
  if (!connectionInfo.encryptionKey || !connectionInfo.authKey) {
    return res.status(400).json({
      error: 'No encryption keys available for this browser instance',
      suggestion: 'Complete key exchange first'
    });
  }
  
  try {
    // Test encryption/decryption round trip
    const testData = test_message || 'connection_validation_test';
    const nonce = crypto.randomBytes(12);
    
    // Encrypt
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', connectionInfo.encryptionKey, iv);
    cipher.setAAD(Buffer.from('validation_test'));
    let encrypted = cipher.update(testData, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', connectionInfo.encryptionKey, iv);
    decipher.setAAD(Buffer.from('validation_test'));
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    if (decrypted !== testData) {
      throw new Error('Decryption validation failed');
    }
    
    console.log(`[Validation] Connection validation successful for ${browser_instance_id}`);
    
    res.json({
      success: true,
      message: 'Connection validation successful',
      browser_instance_id: browser_instance_id,
      test_result: {
        original_message: testData,
        encrypted_length: encrypted.length,
        decrypted_message: decrypted,
        validation_passed: true
      },
      encryption_status: 'operational'
    });
    
  } catch (error) {
    console.error(`[Validation] Connection validation failed for ${browser_instance_id}: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: 'Connection validation failed',
      details: error.message,
      browser_instance_id: browser_instance_id,
      suggestion: 'Key exchange may be required'
    });
  }
});

// Get registered browsers (for monitoring)
app.get('/registered-browsers', (req, res) => {
  const browsers = [];
  for (const [id, info] of browserConnections) {
    browsers.push({
      browser_instance: id,
      port: info.port,
      registered_at: info.registered_at,
      expires_at: info.expiry,
      is_expired: new Date() > info.expiry
    });
  }
  res.json({ browsers });
});

// Token refresh endpoint (fallback when Secure IPC fails)
app.post('/refresh-token/:browserInstanceId', (req, res) => {
  const browserInstanceId = req.params.browserInstanceId;
  
  const connectionInfo = browserConnections.get(browserInstanceId);
  if (!connectionInfo) {
    return res.status(404).json({ 
      error: 'Browser instance not found',
      browser_instance_id: browserInstanceId 
    });
  }
  
  // Check if token is getting stale (older than 20 seconds)
  const now = new Date();
  const tokenAge = connectionInfo.updated_at ? 
    (now - connectionInfo.updated_at) : 
    (now - connectionInfo.registered_at);
  
  if (tokenAge < 20000) {
    return res.json({ 
      message: 'Token is still fresh',
      token_age_seconds: Math.round(tokenAge / 1000),
      refresh_needed: false
    });
  }
  
  // Return current token info and mark that refresh is needed
  res.json({
    message: 'Token refresh recommended',
    browser_instance_id: browserInstanceId,
    token_age_seconds: Math.round(tokenAge / 1000),
    refresh_needed: true,
    // Note: In a full implementation, this would trigger a fresh token request
    // For now, we recommend browser restart for fresh tokens
    recommendation: 'Consider browser restart if connection issues persist'
  });
});

// Connection management - cleanup expired connections
const cleanupExpiredConnections = () => {
  const now = new Date();
  let cleanedCount = 0;
  
  for (const [id, info] of browserConnections) {
    if (now > info.expiry) {
      browserConnections.delete(id);
      cleanedCount++;
      console.log(`[Cleanup] Removed expired browser connection: ${id}`);
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`[Cleanup] Cleaned up ${cleanedCount} expired browser connections`);
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupExpiredConnections, 5 * 60 * 1000);

// Unregister browser endpoint
app.post('/unregister-browser', (req, res) => {
  const authHeader = req.headers.authorization;
  const browserApiKey = getSecret('BROWSER_API_KEY');
  
  if (!authHeader || !authHeader.startsWith('Bearer ') || 
      authHeader.substring(7) !== browserApiKey) {
    return res.status(401).json({ error: 'Invalid browser API key' });
  }
  
  const { browser_instance_id } = req.body;
  
  if (!browser_instance_id) {
    return res.status(400).json({ error: 'Missing browser_instance_id' });
  }
  
  if (browserConnections.has(browser_instance_id)) {
    browserConnections.delete(browser_instance_id);
    console.log(`[Security] Browser unregistered: ${browser_instance_id}`);
    res.json({ 
      success: true, 
      message: 'Browser unregistered successfully'
    });
  } else {
    res.status(404).json({ 
      error: 'Browser instance not found',
      browser_instance: browser_instance_id
    });
  }
});

// Get narrator events (polling endpoint - kept for backward compatibility)
app.get('/mcp/events', (req, res) => {
  // Return a copy of events without removing them
  // This allows multiple clients to poll for events
  res.json({ events: [...narratorEvents] });
});

// Fixed SSE endpoint for real-time event streaming
app.get('/mcp/events/stream/:taskId', (req, res) => {
  const taskId = parseInt(req.params.taskId);
  console.log(`[SSE] Client connected for task ${taskId}`);
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // Send initial connection event (minimal)
  res.write(`data: ${JSON.stringify({ type: 'connected', message: '', taskId })}\n\n`);
  
  // Get task queue
  const taskQueue = taskEventQueues.get(taskId);
  if (!taskQueue) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Task not found' })}\n\n`);
    res.end();
    return;
  }
  
  // Send any unacknowledged events
  const unacknowledged = taskQueue.getUnacknowledged();
  unacknowledged.forEach(event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  
  // Track last sent event to avoid duplicate consecutive thoughts, but with timestamp check
  let lastSent = { type: null, message: null, timestamp: 0 };
  
  // Event listener for new events
  const sendEvent = (event) => {
    // Only suppress if it's the exact same thought within 100ms (true duplicate)
    const now = Date.now();
    if (event && event.type === 'thought' &&
        lastSent.type === 'thought' && 
        lastSent.message === event.message &&
        (now - lastSent.timestamp) < 100) {
      return; // suppress only rapid-fire duplicate thoughts
    }
    
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    lastSent = { 
      type: event?.type || null, 
      message: event?.message || null,
      timestamp: now
    };
  };
  
  // Subscribe to new events
  taskQueue.eventEmitter.on('event', sendEvent);
  
  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);
  
  // Cleanup on disconnect
  req.on('close', () => {
    console.log(`[SSE] Client disconnected for task ${taskId}`);
    clearInterval(heartbeat);
    taskQueue.eventEmitter.off('event', sendEvent);
  });
});

// Acknowledge events endpoint
app.post('/mcp/events/acknowledge/:taskId', express.json(), (req, res) => {
  const taskId = parseInt(req.params.taskId);
  const { eventIds } = req.body;
  
  const taskQueue = taskEventQueues.get(taskId);
  if (!taskQueue) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  
  if (Array.isArray(eventIds)) {
    eventIds.forEach(id => taskQueue.acknowledge(id));
  }
  
  res.json({ success: true, acknowledged: eventIds });
});

// Report the currently active agent page (URL + DevTools targetId) to enable glow
app.get('/mcp/agent/active', async (req, res) => {
  try {
    // Find the most recent task that still has an agent with a page
    let active = null;
    for (const [taskId, agent] of Array.from(browserAgents.entries()).reverse()) {
      if (!agent) continue;
      // Ignore agents that have completed, been stopped, or errored
      const status = (agent.status || '').toLowerCase();
      if (status === 'completed' || status === 'stopped' || status === 'error') {
        continue;
      }
      if (agent.page && typeof agent.page.url === 'function') {
        const url = agent.page.url();
        // Best-effort: target id may be available via playwright's CDP session
        let targetId = undefined;
        try {
          if (agent.page.context && agent.page.context()._browser && agent.page.context()._browser._connection) {
            // Avoid deep introspection; leave targetId undefined
          }
        } catch (_e) {}
        active = { url, targetId };
        break;
      }
    }
    // If no active running agent, explicitly return empty so the browser clears glow
    res.json(active || { url: '', targetId: '' });
  } catch (e) {
    res.json({ url: '', targetId: '' });
  }
});

// Fixed Execute endpoint with proper event handling
app.post('/mcp/execute', async (req, res) => {
  const { task, mode = 'act', url, data, schema, browser_instance_id } = req.body;
  const taskId = taskIdCounter++;
  
  // Return immediately with task ID
  res.json({
    success: true,
    taskId,
    message: 'Task started in new tab'
  });
  
  // Execute task asynchronously
  (async () => {
    // Create task event queue FIRST
    const taskQueue = new TaskEventQueue(taskId);
    taskEventQueues.set(taskId, taskQueue);
    
    // Define console restoration function at the top level
    const originalLog = console.log;
    let consoleRestored = false;
    const restoreConsole = () => {
      if (!consoleRestored) {
        console.log = originalLog;
        consoleRestored = true;
      }
    };
    
    // Recorder wiring
    let recorder = null;
    let harness = null;
    let savedWorkflowPath = null;
    try {
      // Create a new browser agent for this task (opens new tab)
      const browserAgent = await createBrowserAgentForTask(taskId, browser_instance_id);
      browserAgents.set(taskId, browserAgent);

      // Initialize workflow recorder (non-fatal on error)
      try {
        harness = browserAgent.require(mcCore.BrowserConnector).getHarness();
        const name = (typeof task === 'string' && task.trim()) ? task.trim().slice(0, 80) : 'untitled';
        const startUrl = (url && typeof url === 'string') ? url : (browserAgent.page && typeof browserAgent.page.url === 'function' ? browserAgent.page.url() : '');
        recorder = new mcCore.WorkflowRecorder({
          name,
          startUrl,
          browser: { mode: 'cdp', cdpUrl: FIXED_CDP_URL, contextOptions: { viewport: { width: 1280, height: 720 } } },
          virtualScreenDimensions: { width: 1024, height: 768 }
        });
        const onStep = (step) => { try { recorder && recorder.record(step); } catch {} };
        harness.events.on('stepRecorded', onStep);
        // Stash unsubscriber for finally
        recorder.__onStep = onStep;
        console.log('[Workflows] Recording started', { taskId, name, startUrl });
      } catch (e) {
        console.warn('[Workflows] Recorder initialization failed:', e?.message);
      }
      
      // Detect an explicit "done" signal and immediately surface a task_complete node once
      let doneEventSent = false;
      const maybeEmitDoneEvent = (text) => {
        try {
          if (doneEventSent) return;
          const t = (text ?? '').toString().trim();
          if (/^✓\s*done$/i.test(t) || /^done$/i.test(t) || /task\s*completed/i.test(t)) {
            taskQueue.addEvent('task_complete', 'Task completed successfully');
            doneEventSent = true;
            // Mark agent as completed immediately so /mcp/agent/active stops reporting it
            try { if (browserAgent && typeof browserAgent === 'object') browserAgent.status = 'completed'; } catch (_) {}
            removeCursorFromAllPagesForAgent(browserAgent).catch(() => {});
          }
        } catch (_) {}
      };
      
      // Simplified thought capture - only capture thoughts, no other events
      if (browserAgent.events) {
        browserAgent.events.on('thought', (thought) => {
          // Just the thought directly, no task prefix
          taskQueue.addEvent('thought', String(thought));
          maybeEmitDoneEvent(thought);
        });
      }
      
      if (browserAgent.browserAgentEvents) {
        browserAgent.browserAgentEvents.on('thought', (thought) => {
          // Just the thought directly, no task prefix
          taskQueue.addEvent('thought', String(thought));
          maybeEmitDoneEvent(thought);
        });
        browserAgent.browserAgentEvents.on('navigate', (url) => {
          if (typeof url === 'string') taskQueue.addEvent('navigate', url);
        });
        browserAgent.browserAgentEvents.on('action', (action) => {
          try {
            const name = (action && (action.name || action.type || action.id)) ? String(action.name || action.type || action.id) : '';
            if (name) taskQueue.addEvent('action', name);
          } catch (_) {}
        });
        // Detect explicit task:done action to surface completion immediately
        browserAgent.browserAgentEvents.on('action', (action) => {
          try {
            const name = (action && (action.name || action.type || action.id)) ? String(action.name || action.type || action.id) : '';
            if (!doneEventSent && name.toLowerCase() === 'task:done') {
              taskQueue.addEvent('task_complete', 'Task completed successfully');
              doneEventSent = true;
              // Mark agent as completed immediately so /mcp/agent/active stops reporting it
              try { if (browserAgent && typeof browserAgent === 'object') browserAgent.status = 'completed'; } catch (_) {}
              removeCursorFromAllPagesForAgent(browserAgent).catch(() => {});
            }
          } catch (_) {}
        });
      }
      
      // Optional: Simple console.log override for thought capture (less invasive)
      const thoughtPatterns = [
        /I need to/i, /I will/i, /I should/i, /Let me/i, 
        /I can/i, /I'm /i, /Looking at/i, /Checking/i
      ];
      
      console.log = function(...args) {
        const text = args.join(' ');
        
        // Check if this looks like a thought (not our own debug messages)
        if (text && !text.includes('[Task') && !text.includes('💭')) {
          const isThought = thoughtPatterns.some(pattern => pattern.test(text));
          if (isThought) {
            // Just the thought directly, no task prefix
            taskQueue.addEvent('thought', text);
          }
          // Also detect explicit done signal and surface completion node
          maybeEmitDoneEvent(text);
        }
        
        return originalLog.apply(console, args);
      };
      
      let result;
      
      // Navigate to URL if provided (but don't emit navigation events)
      if (url) {
        await browserAgent.nav(url);
      }
      
      // Execute based on mode (no action event messages)
      switch (mode) {
        case 'act':
          result = await browserAgent.act(task, { data });
          break;
          
        case 'extract':
          const zSchema = schema ? createZodSchemaFromObject(schema) : z.any();
          result = await browserAgent.extract(task, zSchema);
          break;
          
        case 'verify':
        case 'check':
          result = await browserAgent.check(task);
          break;
          
        default:
          throw new Error(`Unknown mode: ${mode}`);
      }
      
      // Restore console
      restoreConsole();
      
      // Store the result for later retrieval
      if (!browserAgents.has(taskId)) {
        browserAgents.set(taskId, {});
      }
      const agentData = browserAgents.get(taskId);
      agentData.result = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      agentData.status = 'completed';
      // Mark the running agent (if present) as no longer active so /mcp/agent/active stops returning it
      try {
        const runningAgent = browserAgents.get(taskId);
        if (runningAgent && typeof runningAgent === 'object') {
          runningAgent.status = 'completed';
        }
      } catch (_) {}
      // Ensure a task_complete node is emitted if it wasn't already
      try {
        if (!doneEventSent) {
          taskQueue.addEvent('task_complete', 'Task completed successfully');
          doneEventSent = true;
        }
      } catch (_) {}
      
      // Queue summary for the user BEFORE any persistence/generalization work
      try {
        const summaryPrompt = buildSummaryRequestMessage(task, taskQueue, 'completed');
        taskQueue.addEvent('summary_request', summaryPrompt);
      } catch (_) {}

      // Save workflow and memory (runs after summary_request is queued)
      try {
        if (recorder) {
          savedWorkflowPath = await recorder.save(WORKFLOWS_DIR);
          console.log('[Workflows] Saved workflow', { path: savedWorkflowPath });
          // Save memory alongside
          try {
            const mem = await browserAgent.memory.toJSON();
            const memPath = savedWorkflowPath.replace(/\.workflow\.json$/, '.memory.json');
            await fsp.writeFile(memPath, JSON.stringify(mem, null, 2), 'utf8');
          } catch (e) {
            console.warn('[Workflows] Failed to save memory:', e?.message);
          }
          // Index update and autogeneralize
          try {
            const index = await loadWorkflowIndex();
            const id = workflowIdFromFile(savedWorkflowPath.split('/').pop());
            index[id] = index[id] || {};
            const wfMetaName = typeof recorder?.getWorkflow === 'function'
              ? recorder.getWorkflow().metadata?.name
              : undefined;
            if (wfMetaName && typeof wfMetaName === 'string' && wfMetaName.trim()) {
              index[id].name = wfMetaName.trim().slice(0, 120);
            } else if (!index[id].name) {
              index[id].name = 'untitled';
            }
            index[id].starred = Boolean(index[id].starred);

            // Attempt autogeneralize using the live agent and recorded workflow
            try {
              const wfObj = typeof recorder?.getWorkflow === 'function' ? recorder.getWorkflow() : null;
              if (wfObj) {
                const gens = await mcCore.generateGeneralizations(browserAgent, wfObj);
                if (gens && Object.keys(gens).length > 0) {
                  const gwf = mcCore.attachGeneralizationsToWorkflow(wfObj, gens);
                  const genPath = savedWorkflowPath.replace(/\.workflow\.json$/, '.generalized.workflow.json');
                  await fsp.writeFile(genPath, JSON.stringify(gwf, null, 2), 'utf8');
                  // Extract variable names for index summary
                  let varNames = [];
                  if (Array.isArray(gwf.variables)) {
                    varNames = gwf.variables.map(v => v && v.name).filter(Boolean);
                  }
                  if ((!varNames || varNames.length === 0) && gwf.generalizations && typeof gwf.generalizations === 'object') {
                    try {
                      varNames = Object.values(gwf.generalizations).map(g => g && g.control && g.control.variable && g.control.variable.name).filter(Boolean);
                    } catch {}
                  }
                  index[id].hasGeneralized = true;
                  if (varNames && varNames.length) index[id].variables = varNames.slice(0, 12);
                  console.log('[Workflows] Autogeneralized workflow', { id, variables: varNames.length });
                } else {
                  index[id].hasGeneralized = false;
                }
              }
            } catch (ge) {
              console.warn('[Workflows] Autogeneralize skipped:', ge?.message);
            }

            await saveWorkflowIndex(index);
          } catch {}
          // Retention guard
          await enforceWorkflowRetention();
        }
      } catch (e) {
        console.warn('[Workflows] Failed to persist workflow:', e?.message);
      }
      // (summary already queued above)
      // Remove any cursor overlays from all pages now that the task is complete
      try {
        await removeCursorFromAllPagesForAgent(browserAgent);
      } catch (_) {}
      
    } catch (error) {
      // Restore console on error
      restoreConsole();
      
      // Check if this is a stop-related error
      if (error.message && error.message.includes('Target page, context or browser has been closed')) {
        console.log(`Task ${taskId} was stopped by user`);
        taskQueue.addEvent('task_stopped', 'Task stopped by user');
        
        // Store stopped status
        if (browserAgents.has(taskId)) {
          const agentData = browserAgents.get(taskId);
          agentData.status = 'stopped';
          agentData.message = 'Task stopped by user';
        }
        // Ensure cursor overlay is removed on stop
        try {
          const agentToClean = browserAgents.get(taskId);
          await removeCursorFromAllPagesForAgent(agentToClean);
        } catch (_) {}
      } else {
        console.error(`Error executing task ${taskId}:`, error);
        taskQueue.addEvent('error', error.message);
        
        // Check if this is a token-related error
        if (error.message.includes('Unexpected status 500') || 
            error.message.includes('token') || 
            error.message.includes('hard expiry')) {
          
          console.log(`[TokenFailure] Detected token-related error for task ${taskId}`);
          
          // In static-token mode, preserve registration; otherwise cleanup stale connections
          const rotationDisabled = process.env.DISABLE_CDP_TOKEN_ROTATION !== 'false';
          if (!rotationDisabled) {
            // Find and clean up stale browser connections
            for (const [browserId, connectionInfo] of browserConnections) {
              const tokenAge = connectionInfo.updated_at ? 
                (new Date() - connectionInfo.updated_at) : 
                (new Date() - connectionInfo.registered_at);
              
              if (tokenAge > 30000) { // Remove tokens older than 30 seconds
                console.log(`[TokenFailure] Removing stale connection for browser ${browserId} (age: ${Math.round(tokenAge/1000)}s)`);
                browserConnections.delete(browserId);
              }
            }
          } else {
            console.log('[TokenFailure] Rotation disabled - preserving existing browser registrations');
          }
        }
        
        // Store error status
        if (browserAgents.has(taskId)) {
          const agentData = browserAgents.get(taskId);
          agentData.status = 'error';
          agentData.error = error.message;
        }
        // Best-effort: clean up cursor if present even on error
        try {
          const agentToClean = browserAgents.get(taskId);
          await removeCursorFromAllPagesForAgent(agentToClean);
        } catch (_) {}
      }
    } finally {
      // Detach recorder listener if set
      try {
        if (harness && recorder && recorder.__onStep) {
          harness.events.off('stepRecorded', recorder.__onStep);
        }
      } catch {}
    }
  })();
});

// Clean up a specific task's browser agent
app.post('/mcp/cleanup/:taskId', async (req, res) => {
  const taskId = parseInt(req.params.taskId);
  
  // Clean up browser agent
  if (browserAgents.has(taskId)) {
    try {
      const agent = browserAgents.get(taskId);
      
      // Emit stop event first to signal agent should stop
      console.log(`■ [stop] agent stopped`);
      addNarratorEvent('task_stop', `[Task ${taskId}] Stopping task...`);
      
      // Mark agent as stopped to prevent /mcp/agent/active from reporting it
      try { if (agent && typeof agent === 'object') agent.status = 'stopped'; } catch (_) {}

      // Remove any cursor overlays from all pages before closing
      try {
        await removeCursorFromAllPagesForAgent(agent);
      } catch (_) {}
      
      // Do not summarize on stop; only summarize on successful completion
      
      // Try to stop gracefully if stop method exists
      if (agent && typeof agent.stop === 'function') {
        await agent.stop();
      } else if (agent && agent.page) {
        // If no stop method, just close the page
        try {
          await agent.page.close();
        } catch (closeError) {
          // Page might already be closed
          console.log(`Page already closed for task ${taskId}`);
        }
      }
      
      browserAgents.delete(taskId);
    } catch (error) {
      // This error is expected when browser is closed mid-action
      if (error.message && error.message.includes('Target page, context or browser has been closed')) {
        console.log(`Task ${taskId} browser was closed (expected during stop)`);
      } else {
        console.error(`Error stopping browser agent ${taskId}:`, error);
      }
    }
  }
  
  // Clean up event queue
  if (taskEventQueues.has(taskId)) {
    taskEventQueues.get(taskId).destroy();
    taskEventQueues.delete(taskId);
  }
  
  res.json({ success: true, message: `Task cleaned up` });
});

// List available tools (MCP standard endpoint)
app.get('/mcp/tools', (req, res) => {
  const tools = [
    {
      name: 'magnitude_act',
      description: 'Execute a high-level browser action using AI in a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Natural language description of the task to perform'
          },
          url: {
            type: 'string',
            description: 'Optional URL to navigate to before performing the task'
          },
          data: {
            type: 'object',
            description: 'Optional data to use in the task'
          }
        },
        required: ['task']
      }
    },
    {
      name: 'magnitude_extract',
      description: 'Extract structured data from the current page in a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: {
            type: 'string',
            description: 'What data to extract'
          },
          schema: {
            type: 'object',
            description: 'JSON schema for the extracted data'
          }
        },
        required: ['instructions']
      }
    },
    {
      name: 'magnitude_check',
      description: 'Check if a condition is met on the page in a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Description of what to check'
          }
        },
        required: ['description']
      }
    },
    // {
    //   name: 'magnitude_request_intervention',
    //   description: 'Ask the user to perform a required action (e.g., login or consent) and wait for their response',
    //   inputSchema: {
    //     type: 'object',
    //     properties: {
    //       message: {
    //         type: 'string',
    //         description: 'What you need the user to do'
    //       },
    //       context: {
    //         type: 'string',
    //         description: 'Optional additional context'
    //       },
    //       taskId: {
    //         type: 'number',
    //         description: 'Task identifier to associate the intervention with'
    //       }
    //     },
    //     required: ['message']
    //   }
    // }
  ];
  
  res.json({ tools });
});

// -------- Workflows endpoints --------
// List workflows
app.get('/mcp/workflows', async (_req, res) => {
  try {
    const files = await fsp.readdir(WORKFLOWS_DIR);
    const list = [];
    for (const name of files) {
      if (!name.endsWith('.workflow.json')) continue;
      // Exclude generalized companions from the main list; they are surfaced via hasGeneralized + variables
      if (name.endsWith('.generalized.workflow.json')) continue;
      const id = workflowIdFromFile(name);
      const full = join(WORKFLOWS_DIR, name);
      const stat = await fsp.stat(full);
      const wf = await readJsonSafe(full);
      const index = await loadWorkflowIndex();
      list.push({
        id,
        name: (index[id]?.name) || (wf?.metadata?.name) || id,
        createdAt: wf?.metadata?.createdAt || stat.mtime.toISOString(),
        steps: Array.isArray(wf?.steps) ? wf.steps.length : 0,
        hasMemory: fs.existsSync(full.replace(/\.workflow\.json$/, '.memory.json')),
        size: stat.size,
        hasGeneralized: Boolean(index[id]?.hasGeneralized) || fs.existsSync(full.replace(/\.workflow\.json$/, '.generalized.workflow.json')),
        variables: Array.isArray(index[id]?.variables) ? index[id].variables : undefined
      });
    }
    // sort newest first
    list.sort((a, b) => (new Date(b.createdAt).getTime()) - (new Date(a.createdAt).getTime()));
    res.json({ success: true, workflows: list });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Get single workflow
app.get('/mcp/workflows/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const pathWf = join(WORKFLOWS_DIR, `${id}.workflow.json`);
    const wf = await readJsonSafe(pathWf);
    if (!wf) return res.status(404).json({ success: false, error: 'Not found' });
    const mem = await readJsonSafe(pathWf.replace(/\.workflow\.json$/, '.memory.json'));
    res.json({ success: true, workflow: wf, memory: Boolean(mem) });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Get generalized workflow info (existence + variables)
app.get('/mcp/workflows/:id/generalized', async (req, res) => {
  try {
    const id = String(req.params.id);
    const pathWf = join(WORKFLOWS_DIR, `${id}.generalized.workflow.json`);
    const gwf = await readJsonSafe(pathWf);
    if (!gwf) {
      return res.json({ success: true, exists: false, variables: [] });
    }
    // Build a user-friendly schema: [{ name, kind, description?, defaultStringValue?, options?: [string] }]
    const byName = new Map();
    const addVar = (vName, vKind, vDesc, vDefault, optionLabels) => {
      if (!vName) return;
      if (!byName.has(vName)) {
        byName.set(vName, {
          name: String(vName),
          kind: String(vKind || 'string'),
          ...(vDesc ? { description: String(vDesc) } : {}),
          ...(vDefault ? { defaultStringValue: String(vDefault) } : {}),
          ...(Array.isArray(optionLabels) && optionLabels.length ? { options: Array.from(new Set(optionLabels.map(String))) } : {})
        });
      } else {
        const cur = byName.get(vName);
        if (vDesc && !cur.description) cur.description = String(vDesc);
        if (vDefault && !cur.defaultStringValue) cur.defaultStringValue = String(vDefault);
        if (Array.isArray(optionLabels) && optionLabels.length) {
          const set = new Set(cur.options || []);
          for (const lbl of optionLabels) set.add(String(lbl));
          cur.options = Array.from(set);
        }
      }
    };

    if (gwf && gwf.generalizations && typeof gwf.generalizations === 'object') {
      for (const g of Object.values(gwf.generalizations)) {
        try {
          const variable = g && g.control && g.control.variable ? g.control.variable : null;
          const name = variable && variable.name;
          const kind = (variable && variable.kind) || 'string';
          const desc = variable && variable.description;
          const def = variable && variable.defaultStringValue;
          const options = (g && g.control && Array.isArray(g.control.options)) ? g.control.options.map(o => o && (o.displayLabel || o.id)).filter(Boolean) : [];
          addVar(name, kind, desc, def, options);
        } catch {}
      }
    }
    // Some generalized workflows may also include a top-level variables array
    if (Array.isArray(gwf.variables)) {
      for (const v of gwf.variables) {
        try { addVar(v && v.name, (v && v.kind) || 'string', v && v.description, v && v.defaultStringValue, Array.isArray(v.options) ? v.options : []); } catch {}
      }
    }
    const variables = Array.from(byName.values());
    try { console.log('[Workflows] Generalized schema', { id, variables: variables.length }); } catch {}
    res.json({ success: true, exists: true, variables });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Replay generalized workflow with variable overrides
app.post('/mcp/workflows/:id/replay-generalized', express.json(), async (req, res) => {
  try {
    const id = String(req.params.id);
    const pathWf = join(WORKFLOWS_DIR, `${id}.generalized.workflow.json`);
    const gwf = await readJsonSafe(pathWf);
    if (!gwf) return res.status(404).json({ success: false, error: 'Generalized workflow not found' });
    const variables = (req.body && typeof req.body === 'object') ? (req.body.variables || {}) : {};

    const taskId = taskIdCounter++;
    console.log('[Workflows] Replay generalized requested', { id, taskId, overrideVars: Object.keys(variables || {}).length });
    res.json({ success: true, taskId });

    (async () => {
      const taskQueue = new TaskEventQueue(taskId);
      taskEventQueues.set(taskId, taskQueue);
      try {
        const browserAgent = await createBrowserAgentForTask(taskId, req.body?.browser_instance_id || null);
        browserAgents.set(taskId, browserAgent);
        const harness = browserAgent.require(mcCore.BrowserConnector).getHarness();
        const player = new mcCore.WorkflowPlayer(harness);
        await player.play(gwf, { variables, autoGeneralize: false, agentForGeneralize: browserAgent });
        taskQueue.addEvent('task_complete', 'Generalized workflow replay completed');
        const agentData = browserAgents.get(taskId) || {};
        agentData.status = 'completed';
        browserAgents.set(taskId, agentData);
        console.log('[Workflows] Replay generalized completed', { id, taskId });
      } catch (e) {
        taskQueue.addEvent('error', String(e?.message || e));
        const agentData = browserAgents.get(taskId) || {};
        agentData.status = 'error';
        agentData.error = String(e?.message || e);
        browserAgents.set(taskId, agentData);
        console.error('[Workflows] Replay generalized failed', { id, taskId, error: String(e?.message || e) });
      }
    })();
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Delete workflow
app.delete('/mcp/workflows/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const wf = join(WORKFLOWS_DIR, `${id}.workflow.json`);
    const mem = wf.replace(/\.workflow\.json$/, '.memory.json');
    const gen = wf.replace(/\.workflow\.json$/, '.generalized\.workflow\.json');
    try { await fsp.unlink(wf); } catch {}
    try { await fsp.unlink(mem); } catch {}
    try { await fsp.unlink(gen); } catch {}
    const idx = await loadWorkflowIndex();
    delete idx[id];
    await saveWorkflowIndex(idx);
    console.log('[Workflows] Deleted workflow', { id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Patch workflow (rename, star)
app.patch('/mcp/workflows/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const { name, starred } = req.body || {};
    const idx = await loadWorkflowIndex();
    idx[id] = idx[id] || {};
    if (typeof name === 'string') idx[id].name = name.slice(0, 120);
    if (typeof starred === 'boolean') idx[id].starred = starred;
    await saveWorkflowIndex(idx);
    console.log('[Workflows] Updated workflow', { id, renamed: typeof name === 'string', starred });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Replay workflow (secure CDP path is reused inside agent creation)
app.post('/mcp/workflows/:id/replay', async (req, res) => {
  try {
    const id = String(req.params.id);
    const pathWf = join(WORKFLOWS_DIR, `${id}.workflow.json`);
    const wf = await readJsonSafe(pathWf);
    if (!wf) return res.status(404).json({ success: false, error: 'Not found' });

    const taskId = taskIdCounter++;
    console.log('[Workflows] Replay requested', { id, taskId });
    res.json({ success: true, taskId });

    // async execution
    (async () => {
      const taskQueue = new TaskEventQueue(taskId);
      taskEventQueues.set(taskId, taskQueue);
      try {
        const browserAgent = await createBrowserAgentForTask(taskId, req.body?.browser_instance_id || null);
        browserAgents.set(taskId, browserAgent);
        const harness = browserAgent.require(mcCore.BrowserConnector).getHarness();
        const player = new mcCore.WorkflowPlayer(harness);
        await player.play(wf, { autoGeneralize: false, agentForGeneralize: browserAgent });
        taskQueue.addEvent('task_complete', 'Workflow replay completed');
        const agentData = browserAgents.get(taskId) || {};
        agentData.status = 'completed';
        browserAgents.set(taskId, agentData);
        console.log('[Workflows] Replay completed', { id, taskId });
      } catch (e) {
        taskQueue.addEvent('error', String(e?.message || e));
        const agentData = browserAgents.get(taskId) || {};
        agentData.status = 'error';
        agentData.error = String(e?.message || e);
        browserAgents.set(taskId, agentData);
        console.error('[Workflows] Replay failed', { id, taskId, error: String(e?.message || e) });
      }
    })();
  } catch (e) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Helper function to create Zod schema from object
function createZodSchemaFromObject(schemaObj) {
  if (!schemaObj || !schemaObj.type) {
    return z.any();
  }
  
  if (schemaObj.type === 'array') {
    const itemSchema = createZodSchemaFromObject(schemaObj.items);
    return z.array(itemSchema);
  } else if (schemaObj.type === 'object') {
    const shape = {};
    for (const [key, value] of Object.entries(schemaObj.properties || {})) {
      shape[key] = createZodSchemaFromObject(value);
    }
    return z.object(shape);
  } else if (schemaObj.type === 'string') {
    return z.string();
  } else if (schemaObj.type === 'number') {
    return z.number();
  } else if (schemaObj.type === 'boolean') {
    return z.boolean();
  }
  
  return z.any();
}

// Remove visual cursor overlays from all pages in an agent's context
async function removeCursorFromAllPagesForAgent(agent) {
  try {
    if (!agent || !agent.page || typeof agent.page.context !== 'function') return;
    const context = agent.page.context();
    const pages = context && typeof context.pages === 'function' ? context.pages() : [];
    await Promise.all(pages.map(async (p) => {
      try {
        await p.evaluate(() => {
          const ids = ['action-visual-indicator', 'custom-cursor'];
          for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.remove();
          }
        });
      } catch (_) {
        // Ignore per-page errors (page may be closed or cross-origin)
      }
    }));
  } catch (e) {
    console.log(`[VisualCleanup] Failed to remove cursor overlays: ${e.message}`);
  }
}

// Build a summarization request message for the backend, including objective and timeline
function buildSummaryRequestMessage(taskText, taskQueue, status = 'completed') {
  try {
    const events = Array.isArray(taskQueue?.events) ? taskQueue.events : [];
    // Keep last 40 events max to bound the prompt size
    const recent = events.slice(-40);
    // Build timeline lines with type tags; trim messages
    const lines = [];
    for (const ev of recent) {
      if (!ev || typeof ev.message !== 'string') continue;
      const type = ev.type || 'event';
      let msg = ev.message.trim();
      if (!msg) continue;
      if (msg.length > 300) msg = msg.slice(0, 297) + '…';
      lines.push(`[${type}] ${msg}`);
    }
    const statusLine = status === 'completed' ? 'completed' : 'stopped';
    const objective = (taskText || '').toString().trim();
    const timeline = lines.join('\n');
    const prompt = [
      'Please write a concise summary of the browser agent task outcome.',
      `Objective: ${objective || '(unspecified)'}`,
      `Task status: ${statusLine}`,
      '',
      'Focus on:',
      '- the current achieved state/result,',
      '- any key outcome the user should know.',
      '- if the task was a research task provide all the relevant information the user should know.',
      'Do NOT list step-by-step actions. Do NOT narrate clicks or navigation. Be direct about current state. These are actions you took.',
      '',
      'Timeline (for context):',
      timeline || '(no timeline available)'
    ].join('\n');
    return prompt;
  } catch (_e) {
    const objective = (taskText || '').toString().trim();
    return `Please summarize the outcome for: ${objective}. Focus on current state, not steps.`;
  }
}

// Start server with enhanced initialization
async function startServer() {
  try {
    // Hardcoded keys are already initialized - no additional setup needed
    console.log('🔑 Using hardcoded API keys - ready immediately');
    
    // Apply API key validation middleware AFTER secrets are initialized
    app.use(validateApiKey);
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`Enhanced Magnitude MCP Server (New Tab Mode) starting on port ${PORT}`);
      console.log(`CDP URL: ${CDP_URL}`);
      if (CDP_URL !== FIXED_CDP_URL) {
        console.log(`Fixed CDP URL: ${FIXED_CDP_URL} (hostname compatibility fix)`);
      }
      
      // Check API key status and determine source
      const anthropicKeyStatus = cachedSecrets.ANTHROPIC_API_KEY ? 'Yes' : 'No';
      console.log(`API Key loaded: ${anthropicKeyStatus}`);
      
      // Keys are always hardcoded now
      console.log(`Secrets source: Hardcoded keys`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
      console.log('\n✨ Each task will open in a new tab in your browser');
      console.log('\n🔑 Using hardcoded keys - system ready for immediate use');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Security monitoring endpoint
app.get('/mcp/security/status', (req, res) => {
  const now = new Date();
  const stats = {
    server_mode: process.env.USE_SECURE_CDP === 'true' ? 'secure' : 'development',
    security: {
      cdp_token_validation: process.env.USE_SECURE_CDP === 'true',
      api_key_required: true,
      browser_api_key_configured: !!getSecret('BROWSER_API_KEY'),
      mcp_api_key_configured: !!getSecret('MCP_API_KEY')
    },
    registered_browsers: browserConnections.size,
    active_tasks: browserAgents.size,
    connections: [],
    metrics: {
      unauthorized_attempts: metrics.security.unauthorized_attempts,
      expired_tokens: metrics.security.expired_tokens,
      registered_browsers_total: metrics.security.registered_browsers
    }
  };
  
  // Include basic connection info (no sensitive data)
  for (const [id, info] of browserConnections) {
    const expiresIn = Math.floor((info.expiry - now) / 60000);
    stats.connections.push({
      browser_instance: id,
      port: info.port,
      expires_in_minutes: expiresIn,
      is_expired: expiresIn <= 0,
      registered_at: info.registered_at
    });
  }
  
  res.json(stats);
});

// Metrics endpoint
app.get('/mcp/metrics', (req, res) => {
  const uptime = Math.floor((new Date() - metrics.startTime) / 1000);
  
  // Convert Maps to objects for JSON serialization
  const endpointStats = {};
  for (const [endpoint, count] of metrics.requests.byEndpoint) {
    endpointStats[endpoint] = count;
  }
  
  const statusStats = {};
  for (const [status, count] of metrics.requests.byStatus) {
    statusStats[status] = count;
  }
  
  res.json({
    uptime_seconds: uptime,
    requests: {
      total: metrics.requests.total,
      by_endpoint: endpointStats,
      by_status: statusStats,
      rate_per_minute: uptime > 0 ? (metrics.requests.total / uptime * 60).toFixed(2) : 0
    },
    tasks: {
      ...metrics.tasks,
      success_rate: metrics.tasks.total > 0 
        ? ((metrics.tasks.successful / metrics.tasks.total) * 100).toFixed(2) + '%'
        : 'N/A'
    },
    security: {
      ...metrics.security,
      registered_browsers: browserConnections.size
    },
    system: {
      memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      active_connections: browserConnections.size,
      active_tasks: browserAgents.size,
      pending_events: narratorEvents.length
    }
  });
});

// -------------------- Human Intervention Endpoints (disabled) --------------------
// app.post('/mcp/intervention/request', (req, res) => { ... });
// app.get('/mcp/intervention/pending', (req, res) => { ... });
// app.get('/mcp/intervention/status/:taskId', (req, res) => { ... });
// app.post('/mcp/intervention/respond/:taskId', (req, res) => { ... });

// Connection pooling - get least loaded browser
app.get('/mcp/browser/recommend', (req, res) => {
  let recommendedBrowser = null;
  let minTasks = Infinity;
  
  // Count tasks per browser
  const taskCounts = new Map();
  for (const [browserId, info] of browserConnections) {
    if (new Date() < info.expiry) {
      taskCounts.set(browserId, 0);
    }
  }
  
  // Count active tasks per browser
  for (const [taskId, agent] of browserAgents) {
    const browserId = agent.browserInstanceId;
    if (browserId && taskCounts.has(browserId)) {
      taskCounts.set(browserId, taskCounts.get(browserId) + 1);
    }
  }
  
  // Find browser with least tasks
  for (const [browserId, count] of taskCounts) {
    if (count < minTasks) {
      minTasks = count;
      recommendedBrowser = browserId;
    }
  }
  
  if (recommendedBrowser) {
    res.json({
      browser_instance_id: recommendedBrowser,
      current_tasks: minTasks,
      connection_info: {
        port: browserConnections.get(recommendedBrowser).port,
        expires_at: browserConnections.get(recommendedBrowser).expiry
      }
    });
  } else {
    res.status(404).json({
      error: 'No available browsers',
      message: 'Please register a browser first'
    });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  
  // Clean up connection cleanup interval
  cleanupExpiredConnections();
  
  // Disconnect secure IPC client
  if (secureIPCClient) {
    secureIPCClient.disconnect();
    console.log('Disconnected secure IPC client');
  }
  
  // Stop all browser agents
  for (const [taskId, agent] of browserAgents) {
    try {
      await agent.stop();
      console.log(`Stopped agent for task ${taskId}`);
    } catch (error) {
      console.error(`Error stopping agent ${taskId}:`, error);
    }
  }
  
  // Clean up all event queues
  for (const [taskId, queue] of taskEventQueues) {
    queue.destroy();
    console.log(`Cleaned up event queue for task ${taskId}`);
  }
  
  process.exit(0);
});