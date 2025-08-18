#!/usr/bin/env node
import { MagnitudeMCPServer } from './server.js';
import { logger } from './utils/logger.js';

/**
 * Main entry point for the Magnitude MCP server
 */
const server = new MagnitudeMCPServer();
server.run().catch(error => logger.error('[Startup]', error));
