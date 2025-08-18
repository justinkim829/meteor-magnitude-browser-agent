#!/usr/bin/env node

/**
 * Enhanced Magnitude MCP Server for C++ Integration
 * 
 * This server provides the official Magnitude API with additional endpoints
 * required by the C++ ChatService integration.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

// Configuration
const PORT = process.env.MAGNITUDE_MCP_PORT || process.env.MAGNITUDE_PORT || 9123;
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

// Global state
let browserAgent = null;
let pendingCommands = [];
let commandIdCounter = 1;
let narratorEvents = [];
let taskIdCounter = 1;
let currentTaskId = null;
let currentTaskEventQueue = null;
let currentTaskStatus = null; // 'running', 'completed', 'error'

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

// Initialize the browser agent with CDP connection
async function initializeBrowserAgent() {
  try {
    console.log(`[${new Date().toISOString()}] Connecting to Chrome via CDP at ${CDP_URL}...`);
    
    browserAgent = await startBrowserAgent({
      browser: { 
        cdp: CDP_URL,
        contextOptions: {
          viewport: { width: 1280, height: 720 }
        }
      },
      llm: {
        provider: 'anthropic',
        options: {
          model: 'claude-sonnet-4-20250514',
          apiKey: process.env.ANTHROPIC_API_KEY,
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
    
    // Set up narrator event listeners
    if (browserAgent.browserAgentEvents) {
      browserAgent.browserAgentEvents.on('nav', async (url) => {
        addNarratorEvent('navigate', `[Task ${currentTaskId}] Navigating to ${url}`);
      });
      
      browserAgent.browserAgentEvents.on('extractStarted', (instructions) => {
        addNarratorEvent('extract', `[Task ${currentTaskId}] Extracting: ${instructions}`);
      });
      
      browserAgent.browserAgentEvents.on('extractDone', (instructions, data) => {
        addNarratorEvent('extract_done', `[Task ${currentTaskId}] Extraction complete`);
      });
      
      browserAgent.browserAgentEvents.on('action', (action) => {
        addNarratorEvent('action', `[Task ${currentTaskId}] ${action}`);
      });
    }
    
    // Set up thought event listener - this captures the agent's reasoning
    if (browserAgent.events) {
      browserAgent.events.on('thought', (thought) => {
        console.log(`[Task ${currentTaskId}] 💭 Thought: ${thought}`);
        addNarratorEvent('thought', `[Task ${currentTaskId}] Thought: ${thought}`);
      });
    }
    
    console.log('✅ Browser agent initialized successfully');
    console.log('✅ Connected to Chrome via CDP');
    return true;
  } catch (error) {
    console.error('Failed to initialize browser agent:', error);
    return false;
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
  
  // Add to current task queue if exists
  if (currentTaskEventQueue && currentTaskId) {
    currentTaskEventQueue.addEvent(type, message);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browserAgent: browserAgent ? 'initialized' : 'not initialized',
    currentTask: currentTaskId,
    taskStatus: currentTaskStatus,
    cdpUrl: CDP_URL,
    port: PORT
  });
});

// MCP health check endpoint (for C++ integration)
app.get('/mcp/health', (req, res) => {
  res.json({
    status: 'ok',
    browserAgent: browserAgent ? 'initialized' : 'not initialized',
    cdpUrl: CDP_URL
  });
});

// Get pending browser commands (for C++ polling)
app.get('/mcp/commands/pending', (req, res) => {
  const commands = pendingCommands.splice(0, pendingCommands.length);
  res.json({ 
    commands,
    count: commands.length
  });
});

// Report command result from browser
app.post('/mcp/commands/result', (req, res) => {
  const { commandId, success, result } = req.body;
  console.log(`Command ${commandId} result:`, { success, result });
  res.json({ received: true });
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
  
  // Check if this is the current task
  if (!currentTaskEventQueue || currentTaskId !== taskId) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Task not found or not active' })}\n\n`);
    res.end();
    return;
  }
  
  // Send any unacknowledged events
  const unacknowledged = currentTaskEventQueue.getUnacknowledged();
  unacknowledged.forEach(event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  
  // Event listener for new events
  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  
  // Subscribe to new events
  currentTaskEventQueue.eventEmitter.on('event', sendEvent);
  
  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);
  
  // Cleanup on disconnect
  req.on('close', () => {
    console.log(`[SSE] Client disconnected for task ${taskId}`);
    clearInterval(heartbeat);
    if (currentTaskEventQueue) {
      currentTaskEventQueue.eventEmitter.off('event', sendEvent);
    }
  });
});

// Acknowledge events endpoint
app.post('/mcp/events/acknowledge/:taskId', express.json(), (req, res) => {
  const taskId = parseInt(req.params.taskId);
  const { eventIds } = req.body;
  
  if (!currentTaskEventQueue || currentTaskId !== taskId) {
    res.status(404).json({ error: 'Task not found or not active' });
    return;
  }
  
  if (Array.isArray(eventIds)) {
    eventIds.forEach(id => currentTaskEventQueue.acknowledge(id));
  }
  
  res.json({ success: true, acknowledged: eventIds });
});

// Execute a high-level task using Magnitude
app.post('/mcp/execute', async (req, res) => {
  const { task, mode = 'act', url, data, schema } = req.body;
  
  // Check if a task is already running
  if (currentTaskStatus === 'running') {
    return res.json({
      success: false,
      error: 'A task is already running. Please wait for it to complete or stop it first.',
      currentTaskId: currentTaskId
    });
  }
  
  // Generate new task ID
  const taskId = taskIdCounter++;
  currentTaskId = taskId;
  currentTaskStatus = 'running';
  
  // Create event queue for this task
  currentTaskEventQueue = new TaskEventQueue(taskId);
  
  // Return immediately with task ID
  res.json({
    success: true,
    taskId,
    message: 'Task started'
  });
  
  // Execute task asynchronously
  (async () => {
    try {
      if (!browserAgent) {
        const initialized = await initializeBrowserAgent();
        if (!initialized) {
          currentTaskStatus = 'error';
          addNarratorEvent('error', `[Task ${taskId}] Failed to initialize browser agent`);
          return;
        }
      }
      
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
      currentTaskStatus = 'completed';
      
    } catch (error) {
      console.error(`Error executing task ${taskId}:`, error);
      addNarratorEvent('error', `[Task ${taskId}] ${error.message}`);
      currentTaskStatus = 'error';
    }
  })();
});

// List available tools (MCP standard endpoint)
app.get('/mcp/tools', (req, res) => {
  const tools = [
    {
      name: 'magnitude_act',
      description: 'Execute a high-level browser action using AI',
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
      description: 'Extract structured data from the current page',
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
      description: 'Check if a condition is met on the page',
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
    {
      name: 'magnitude_navigate',
      description: 'Navigate to a URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to navigate to'
          }
        },
        required: ['url']
      }
    }
  ];
  
  res.json({ tools });
});

// Stop/cleanup current task
app.post('/mcp/cleanup/:taskId', async (req, res) => {
  const taskId = parseInt(req.params.taskId);
  
  // Check if this is the current task
  if (!currentTaskId || currentTaskId !== taskId) {
    return res.status(404).json({ 
      error: 'Task not found or not active',
      currentTaskId: currentTaskId
    });
  }
  
  // Clean up event queue
  if (currentTaskEventQueue) {
    currentTaskEventQueue.destroy();
    currentTaskEventQueue = null;
  }
  
  // Reset task state
  currentTaskId = null;
  currentTaskStatus = null;
  
  addNarratorEvent('task_stopped', `[Task ${taskId}] Task stopped by user`);
  
  res.json({ 
    success: true, 
    message: `Task ${taskId} cleaned up` 
  });
});

// Alternative stop endpoint (simpler)
app.post('/mcp/stop', async (req, res) => {
  if (!currentTaskId) {
    return res.json({ 
      success: false,
      message: 'No active task to stop'
    });
  }
  
  const taskId = currentTaskId;
  
  // Clean up event queue
  if (currentTaskEventQueue) {
    currentTaskEventQueue.destroy();
    currentTaskEventQueue = null;
  }
  
  // Reset task state
  currentTaskId = null;
  currentTaskStatus = null;
  
  addNarratorEvent('task_stopped', `[Task ${taskId}] Task stopped by user`);
  
  res.json({ 
    success: true, 
    message: `Task ${taskId} stopped`,
    taskId: taskId
  });
});

// Execute a tool (MCP standard endpoint)
app.post('/mcp/tool/call', async (req, res) => {
  const { name, arguments: args } = req.body;
  
  if (!browserAgent) {
    const initialized = await initializeBrowserAgent();
    if (!initialized) {
      return res.status(500).json({ 
        error: 'Browser agent not initialized',
        details: 'Failed to connect to Chrome via CDP'
      });
    }
  }
  
  try {
    let result;
    
    switch (name) {
      case 'magnitude_act':
        result = await browserAgent.act(args.task, { 
          data: args.data 
        });
        break;
        
      case 'magnitude_extract':
        const schema = createZodSchemaFromObject(args.schema || {});
        result = await browserAgent.extract(args.instructions, schema);
        break;
        
      case 'magnitude_check':
        result = await browserAgent.check(args.description);
        break;
        
      case 'magnitude_navigate':
        await browserAgent.nav(args.url);
        result = { success: true, url: args.url };
        break;
        
      default:
        return res.status(400).json({ 
          error: 'Unknown tool',
          details: `Tool '${name}' is not supported`
        });
    }
    
    res.json({ 
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    });
    
  } catch (error) {
    console.error(`Tool call error for ${name}:`, error);
    res.status(500).json({ 
      error: 'Tool execution failed',
      details: error.message 
    });
  }
});

// Helper function to get current URL
async function getCurrentUrl() {
  try {
    // This would be implemented based on browser agent API
    return '';
  } catch {
    return '';
  }
}

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

// Start server
app.listen(PORT, async () => {
  console.log(`Enhanced Magnitude MCP Server starting on port ${PORT}`);
  console.log(`CDP URL: ${CDP_URL}`);
  console.log(`API Key loaded: ${process.env.ANTHROPIC_API_KEY ? 'Yes' : 'No'}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  // Try to initialize browser agent on startup
  await initializeBrowserAgent();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  
  // Clean up current task event queue
  if (currentTaskEventQueue) {
    currentTaskEventQueue.destroy();
    console.log(`Cleaned up event queue for task ${currentTaskId}`);
  }
  
  // Stop browser agent
  if (browserAgent) {
    try {
      await browserAgent.stop();
      console.log('Browser agent stopped');
    } catch (error) {
      console.error('Error stopping browser agent:', error);
    }
  }
  
  process.exit(0);
});