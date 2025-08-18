import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolService } from './toolService.js';
import { logger } from './utils/logger.js';

/**
 * Magnitude MCP Server
 */
export class MagnitudeMCPServer {
  private server: Server;
  private toolService: ToolService;

  /**
   * Create a new Magnitude MCP server
   */
  constructor() {
    this.server = new Server(
      {
        name: 'magnitude-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.toolService = new ToolService();

    // Error handling
    this.server.onerror = (error: any) => logger.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });

    // Register handlers
    this.toolService.registerToolHandlers(this.server);
  }

  /**
   * Run the server
   */
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Magnitude MCP server running on stdio');
  }
}
