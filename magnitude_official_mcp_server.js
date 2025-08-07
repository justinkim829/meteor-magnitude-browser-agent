#!/usr/bin/env node

/**
 * Official Magnitude MCP Server
 * 
 * This server uses the official Magnitude API to connect to Chrome via CDP
 * and provides MCP endpoints for browser automation.
 */

import express from 'express';
import bodyParser from 'body-parser';
import { startBrowserAgent } from 'magnitude-core';
import z from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json());

// Configuration
const PORT = process.env.MAGNITUDE_PORT || 9123;
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

// Global browser agent instance
let browserAgent = null;

// Initialize the browser agent with CDP connection
async function initializeBrowserAgent() {
  try {
    console.log(`Connecting to Chrome via CDP at ${CDP_URL}...`);
    
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
      // Enable narration for debugging
      narrate: true
    });
    
    console.log('✅ Browser agent initialized successfully');
    console.log('✅ Connected to Chrome via CDP');
    return true;
  } catch (error) {
    console.error('Failed to initialize browser agent:', error);
    return false;
  }
}

// MCP endpoints

// List available tools
app.get('/mcp/tools', (req, res) => {
  const tools = [
    {
      name: 'magnitude_act',
      description: 'Execute a high-level browser action',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Natural language description of the task to perform'
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
            description: 'Zod schema for the extracted data'
          }
        },
        required: ['instructions', 'schema']
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

// Execute a tool
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
        // Execute high-level action
        result = await browserAgent.act(args.task, { 
          data: args.data 
        });
        break;
        
      case 'magnitude_extract':
        // Extract data with schema
        // Convert the schema object to a Zod schema
        const schema = createZodSchemaFromObject(args.schema);
        result = await browserAgent.extract(args.instructions, schema);
        break;
        
      case 'magnitude_check':
        // Check condition
        result = await browserAgent.check(args.description);
        break;
        
      case 'magnitude_navigate':
        // Navigate to URL
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
    console.error(`Error executing tool ${name}:`, error);
    res.status(500).json({ 
      error: 'Tool execution failed',
      details: error.message 
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    browserAgent: browserAgent ? 'initialized' : 'not initialized',
    cdpUrl: CDP_URL
  });
});

// Helper function to create Zod schema from object
function createZodSchemaFromObject(schemaObj) {
  // This is a simplified version - in production, you'd want more sophisticated schema conversion
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
  
  // Default to string
  return z.string();
}

// Start server
app.listen(PORT, async () => {
  console.log(`Magnitude Official MCP Server starting on port ${PORT}`);
  console.log(`CDP URL: ${CDP_URL}`);
  console.log(`API Key loaded: ${process.env.ANTHROPIC_API_KEY ? 'Yes' : 'No'}`);
  console.log(`API Key prefix: ${process.env.ANTHROPIC_API_KEY?.substring(0, 10)}...`);
  
  // Try to initialize browser agent on startup
  await initializeBrowserAgent();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
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