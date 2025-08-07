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
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Helper function to create a new browser agent for each task
async function createBrowserAgentForTask(taskId, browserInstanceId = null) {
  try {
    console.log(`[${new Date().toISOString()}] Creating new browser agent for task ${taskId}`);
    
    let cdpUrl;
    
    // Parse CDP URL to check for token (auto-detect secure mode)
    const cdpUrlObj = new URL(FIXED_CDP_URL);
    const token = cdpUrlObj.searchParams.get('token');
    
    if (token) {
      // Token detected - use secure CDP mode
      console.log(`[Security] Token detected in CDP URL, using secure authentication`);
      console.log(`[Security] Fixed hostname issue: ${CDP_URL} -> ${FIXED_CDP_URL}`);
      console.log(`[Security] Passing secure CDP URL directly to magnitude-core: ${FIXED_CDP_URL}`);
      cdpUrl = FIXED_CDP_URL;
    } else if (process.env.USE_SECURE_CDP === 'true' && browserInstanceId) {
      // No token in URL but secure mode enabled - use browser registration
      console.log(`[Security] Using registered browser connection for ${browserInstanceId}`);
      
              try {
          const connectionInfo = await getSecureBrowserConnection(browserInstanceId);
          cdpUrl = connectionInfo.cdp_url;
          console.log(`[Security] Using secure CDP connection for browser ${browserInstanceId} on port ${connectionInfo.port}`);
          console.log(`[Security] Token age: ${connectionInfo.updated_at ? Math.round((new Date() - connectionInfo.updated_at)/1000) : Math.round((new Date() - connectionInfo.registered_at)/1000)}s since last update`);
        } catch (error) {
        console.error(`[Security] Failed to get registered browser connection: ${error.message}`);
        
        // Check if this is a token expiry issue and there's a fallback
        if (error.message.includes('expired') || error.message.includes('stale')) {
          console.log(`[Security] Token expired for ${browserInstanceId}, cleaning up connection`);
          
          // Clean up expired connection
          browserConnections.delete(browserInstanceId);
          
          // Provide a clear error message about token staleness
          throw new Error(`Browser token expired for ${browserInstanceId}. This may be due to token rotation. Please try the task again or restart the browser.`);
        } else {
          // Clean up expired or invalid connection
          browserConnections.delete(browserInstanceId);
          throw new Error(`Invalid CDP token or connection expired: ${error.message}`);
        }
      }
    } else {
      // No token detected - use insecure connection
      if (browserInstanceId) {
        console.log(`[INFO] Ignoring browser_instance_id '${browserInstanceId}' in non-secure mode`);
      }
      console.log(`[WARNING] Using insecure CDP connection at ${FIXED_CDP_URL}`);
      cdpUrl = FIXED_CDP_URL;
    }
    
    console.log(`[Task ${taskId}] Starting browser agent with CDP URL: ${cdpUrl}`);
    
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
      // Visual configuration - disable all effects except cursor
      visuals: {
        showCursor: true,      // Keep cursor visible
        showHoverCircle: false, // Disable hover circle
        showClickRipple: false, // Disable click animations
        showDragLine: false,    // Disable drag line
        showTypeEffects: false  // Disable keyboard effects
      },
      // Enable narration for debugging
      narrate: true
    });
    
    console.log(`[Task ${taskId}] ✨ Browser agent created successfully`);
    
    // Track browser instance ID for connection pooling
    browserAgent.browserInstanceId = browserInstanceId;
    
    // Set up narrator event listeners for this agent
    if (browserAgent.browserAgentEvents) {
      browserAgent.browserAgentEvents.on('nav', async (url) => {
        addNarratorEvent('navigate', `[Task ${taskId}] Navigating to ${url}`);
      });
      
      browserAgent.browserAgentEvents.on('extractStarted', (instructions) => {
        addNarratorEvent('extract', `[Task ${taskId}] Extracting: ${instructions}`);
      });
      
      browserAgent.browserAgentEvents.on('extractDone', (instructions, data) => {
        addNarratorEvent('extract_done', `[Task ${taskId}] Extraction complete`);
      });
      
      browserAgent.browserAgentEvents.on('action', (action) => {
        addNarratorEvent('action', `[Task ${taskId}] ${action}`);
      });
    }
    
    // Set up thought event listener - this captures the agent's reasoning
    if (browserAgent.events) {
      browserAgent.events.on('thought', (thought) => {
        console.log(`[Task ${taskId}] 💭 Thought: ${thought}`);
        addNarratorEvent('thought', `[Task ${taskId}] Thought: ${thought}`);
      });
    }
    
    console.log(`✅ Browser agent ${taskId} created with new tab`);
    return browserAgent;
  } catch (error) {
    console.error(`Failed to create browser agent for task ${taskId}:`, error);
    throw error;
  }
}

// Helper function to add narrator events
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
      taskQueue.addEvent(type, message);
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

// SSE endpoint for real-time event streaming
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
  
  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', taskId })}\n\n`);
  
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
  
  // Event listener for new events
  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
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

// Execute a high-level task using Magnitude (creates new tab)
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
    try {
      // Create task event queue
      const taskQueue = new TaskEventQueue(taskId);
      taskEventQueues.set(taskId, taskQueue);
      
      // Create a new browser agent for this task (opens new tab)
      const browserAgent = await createBrowserAgentForTask(taskId, browser_instance_id);
      browserAgents.set(taskId, browserAgent);
      
      let result;
      addNarratorEvent('task_start', `[Task ${taskId}] Starting ${mode}: ${task}`);
      
      // Navigate to URL if provided
      if (url) {
        addNarratorEvent('navigate', `[Task ${taskId}] Navigating to ${url}`);
        await browserAgent.nav(url);
      }
      
      switch (mode) {
        case 'act':
          // Execute high-level action
          addNarratorEvent('act', `[Task ${taskId}] ${task}`);
          result = await browserAgent.act(task, { data });
          break;
          
        case 'extract':
          // Extract data with schema
          addNarratorEvent('extract', `[Task ${taskId}] ${task}`);
          const zSchema = schema ? createZodSchemaFromObject(schema) : z.any();
          result = await browserAgent.extract(task, zSchema);
          break;
          
        case 'verify':
        case 'check':
          // Check condition
          addNarratorEvent('check', `[Task ${taskId}] ${task}`);
          result = await browserAgent.check(task);
          break;
          
        default:
          throw new Error(`Unknown mode: ${mode}`);
      }
      
      addNarratorEvent('task_complete', `[Task ${taskId}] Task completed successfully`);
      
      // Store the result for later retrieval
      if (!browserAgents.has(taskId)) {
        browserAgents.set(taskId, {});
      }
      const agentData = browserAgents.get(taskId);
      agentData.result = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      agentData.status = 'completed';
      
    } catch (error) {
      // Check if this is a stop-related error
      if (error.message && error.message.includes('Target page, context or browser has been closed')) {
        console.log(`Task ${taskId} was stopped by user`);
        addNarratorEvent('task_stopped', `[Task ${taskId}] Task stopped by user`);
        
        // Store stopped status
        if (browserAgents.has(taskId)) {
          const agentData = browserAgents.get(taskId);
          agentData.status = 'stopped';
          agentData.message = 'Task stopped by user';
        }
      } else {
        console.error(`Error executing task ${taskId}:`, error);
        addNarratorEvent('error', `[Task ${taskId}] ${error.message}`);
        
        // Check if this is a token-related error (500 status or token validation failure)
        if (error.message.includes('Unexpected status 500') || 
            error.message.includes('token') || 
            error.message.includes('hard expiry')) {
          
          console.log(`[TokenFailure] Detected token-related error for task ${taskId}`);
          
          // Find and clean up stale browser connections to force fresh registration
          for (const [browserId, connectionInfo] of browserConnections) {
            const tokenAge = connectionInfo.updated_at ? 
              (new Date() - connectionInfo.updated_at) : 
              (new Date() - connectionInfo.registered_at);
            
            if (tokenAge > 30000) { // Remove tokens older than 30 seconds
              console.log(`[TokenFailure] Removing stale connection for browser ${browserId} (age: ${Math.round(tokenAge/1000)}s)`);
              browserConnections.delete(browserId);
            }
          }
        }
        
        // Store error status
        if (browserAgents.has(taskId)) {
          const agentData = browserAgents.get(taskId);
          agentData.status = 'error';
          agentData.error = error.message;
        }
      }
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
    }
  ];
  
  res.json({ tools });
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