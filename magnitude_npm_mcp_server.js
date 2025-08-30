#!/usr/bin/env node

/**
 * Official Magnitude MCP Server using npm package
 */

import express from 'express';
import bodyParser from 'body-parser';
import { startBrowserAgent, AgentMemory } from 'magnitude-core';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

const PORT = 9123;
const CDP_URL = 'http://localhost:9222';

let browserAgent = null;
let sharedMemory = null;

// Initialize browser agent
async function initBrowserAgent() {
  try {
    console.log('Initializing Magnitude browser agent with CDP...');
    
    browserAgent = await startBrowserAgent({
      browser: { 
        cdp: CDP_URL,
        contextOptions: {
          viewport: { width: 1280, height: 720 }
        }
      },
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514', 
        apiKey: process.env.ANTHROPIC_API_KEY,
        options: {
          temperature: 0.2
        }
      },
      narrate: true,
      debug: true
    });
    
    console.log('Browser agent initialized successfully');
    return browserAgent;
  } catch (error) {
    console.error('Failed to initialize browser agent:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'magnitude-npm-mcp',
    agentReady: browserAgent !== null
  });
});

// MCP tools endpoint
app.get('/mcp/tools', (req, res) => {
  res.json({
    tools: [
      {
        name: 'magnitude_navigate',
        description: 'Navigate to a URL',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to navigate to'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'magnitude_act',
        description: 'Perform a high-level action described in natural language',
        inputSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'A natural language description of what to do'
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
              description: 'Instructions for what data to extract'
            },
            schema: {
              type: 'object',
              description: 'JSON schema for the expected output structure'
            }
          },
          required: ['instructions']
        }
      },
      {
        name: 'magnitude_screenshot',
        description: 'Take a screenshot of the current page',
        inputSchema: {
          type: 'object',
          properties: {
            fullPage: {
              type: 'boolean',
              description: 'Whether to capture the full page or just the viewport',
              default: false
            }
          }
        }
      }
    ]
  });
});

// MCP tool call endpoint
app.post('/mcp/tool/call', async (req, res) => {
  const { name, arguments: args } = req.body;
  
  try {
    // Ensure browser agent is initialized
    if (!browserAgent) {
      await initBrowserAgent();
    }
    
    let result;
    
    switch (name) {
      case 'magnitude_navigate':
        console.log(`Navigating to ${args.url}`);
        await browserAgent.navigate(args.url);
        result = {
          success: true,
          url: args.url,
          message: 'Navigation completed'
        };
        break;
        
      case 'magnitude_act':
        console.log(`Performing action: ${args.task}`);
        if (!sharedMemory) {
          // Persist memory across requests and increase thought retention window
          sharedMemory = new AgentMemory({ thoughtLimit: 100, promptCaching: true });
        }
        const actResult = await browserAgent.act(args.task, { memory: sharedMemory });
        result = {
          success: true,
          task: args.task,
          result: actResult
        };
        break;
        
      case 'magnitude_extract':
        console.log(`Extracting data: ${args.instructions}`);
        const extractResult = await browserAgent.extract({
          instructions: args.instructions,
          schema: args.schema
        });
        result = {
          success: true,
          data: extractResult,
          instructions: args.instructions
        };
        break;
        
      case 'magnitude_screenshot':
        console.log('Taking screenshot');
        const screenshot = await browserAgent.screenshot({
          fullPage: args.fullPage || false
        });
        result = {
          success: true,
          screenshot: screenshot
        };
        break;
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
    res.json({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (error) {
    console.error(`Tool call error for ${name}:`, error);
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Magnitude NPM MCP Server listening on port ${PORT}`);
  console.log(`Using CDP at ${CDP_URL}`);
  console.log(`API Key: ${process.env.ANTHROPIC_API_KEY ? 'Set' : 'Not set'}`);
  
  try {
    await initBrowserAgent();
  } catch (error) {
    console.error('Failed to initialize browser agent on startup:', error);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (browserAgent) {
    await browserAgent.close();
  }
  process.exit(0);
});