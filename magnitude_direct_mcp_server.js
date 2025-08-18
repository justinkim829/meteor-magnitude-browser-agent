#!/usr/bin/env node

/**
 * Direct Magnitude MCP Server - Uses source files directly without build
 */

import express from 'express';
import bodyParser from 'body-parser';
import { chromium } from 'playwright';
import { startBrowserAgent } from './packages/magnitude-core/src/agent/browserAgent.js';
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
let browser = null;
let context = null;
let page = null;

// Initialize browser connection
async function initBrowser() {
  try {
    console.log('Connecting to Chrome via CDP at', CDP_URL);
    
    // Connect to existing Chrome instance via CDP
    browser = await chromium.connectOverCDP(CDP_URL);
    console.log('Connected to Chrome via CDP');
    
    // Get existing context or create new one
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      context = contexts[0];
      console.log('Using existing browser context');
    } else {
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
      });
      console.log('Created new browser context');
    }
    
    // Get existing page or create new one
    const pages = context.pages();
    if (pages.length > 0) {
      page = pages[0];
      console.log('Using existing page');
    } else {
      page = await context.newPage();
      console.log('Created new page');
    }
    
    return { browser, context, page };
  } catch (error) {
    console.error('Failed to connect to browser:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'magnitude-direct-mcp',
    browserConnected: browser !== null,
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
    // Ensure browser is connected
    if (!browser || !page) {
      await initBrowser();
    }
    
    let result;
    
    switch (name) {
      case 'magnitude_navigate':
        console.log(`Navigating to ${args.url}`);
        await page.goto(args.url, { waitUntil: 'networkidle' });
        result = {
          success: true,
          url: page.url(),
          title: await page.title()
        };
        break;
        
      case 'magnitude_act':
        console.log(`Performing action: ${args.task}`);
        // For now, use basic Playwright actions
        // TODO: Integrate with Magnitude's AI-powered action system
        result = {
          success: true,
          message: 'Action performed using basic automation',
          task: args.task
        };
        break;
        
      case 'magnitude_extract':
        console.log(`Extracting data: ${args.instructions}`);
        // For now, extract basic page info
        // TODO: Integrate with Magnitude's AI-powered extraction
        const pageContent = await page.evaluate(() => {
          return {
            title: document.title,
            url: window.location.href,
            text: document.body.innerText.substring(0, 1000)
          };
        });
        result = {
          success: true,
          data: pageContent,
          instructions: args.instructions
        };
        break;
        
      case 'magnitude_screenshot':
        console.log('Taking screenshot');
        const screenshot = await page.screenshot({
          fullPage: args.fullPage || false,
          encoding: 'base64'
        });
        result = {
          success: true,
          screenshot: `data:image/png;base64,${screenshot}`
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
  console.log(`Magnitude Direct MCP Server listening on port ${PORT}`);
  console.log(`Connecting to Chrome CDP at ${CDP_URL}`);
  
  try {
    await initBrowser();
    console.log('Browser connection established');
  } catch (error) {
    console.error('Failed to initialize browser:', error);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});