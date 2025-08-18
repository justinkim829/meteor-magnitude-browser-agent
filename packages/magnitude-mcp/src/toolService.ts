import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import { logger } from './utils/logger.js';

// Import from tools file
import { initProject, runTests, buildTests } from './tools.js';

// Import schemas
import {
  createToolDefinition,
  toolSchemas
} from './schemas.js';

/**
 * Service for handling MCP tools
 */
export class ToolService {
  // Tool handler mapping with type-safe input validation
  private toolHandlers: Record<string, { handler: Function; schema: z.ZodType }> = {
    'magnitude_init_project': {
      handler: initProject,
      schema: toolSchemas.init_project
    },
    'magnitude_run_tests': {
      handler: runTests,
      schema: toolSchemas.run_tests
    },
    'magnitude_build_tests': {
      handler: buildTests,
      schema: toolSchemas.build_tests
    },
  };

  private toolDefinitions = [
    createToolDefinition(
      toolSchemas.init_project,
      'magnitude_init_project',
      'Initialize the user\'s project to be able to be tested by Magnitude. Use this tool when the user has NO "magnitude.config.ts" file present anywhere in their project but wants to write tests with Magnitude.'
    ),
    createToolDefinition(
      toolSchemas.run_tests,
      'magnitude_run_tests',
      'Run Magnitude tests matching the given pattern in the user\'s project. Use this tool after building tests with the "build_tests" tool or when the user explicitly asks to run Magnitude tests.'
    ),
    createToolDefinition(
      toolSchemas.build_tests,
      'magnitude_build_tests',
      'Use this tool IMMEDIATELY whenever a user wants to build tests with Magnitude, assuming that "magniude.config.ts" exists in the project. If not, call magnitude_init_project'
      //'Build Magnitude test cases for a certain piece of functionality. Use this tool when the user asks to build tests with Magnitude or to build end-to-end (E2E) tests. This tool assumes that the "magnitude.config.ts" file is present in the user\'s project OR that the "initialize_project" tool has been called to create one.'
    ),
  ];

  /**
   * Call a tool by name with arguments
   * @param name Tool name
   * @param args Tool arguments
   * @returns Tool execution result
   */
  async callTool(name: string, args: any): Promise<any> {
    logger.info(`[Tool] Calling tool: ${name}`);

    const toolInfo = this.toolHandlers[name];
    if (!toolInfo) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      // Validate input against schema
      const validationResult = toolInfo.schema.safeParse(args);

      if (!validationResult.success) {
        logger.error(`[Validation] Failed for tool ${name}:`, validationResult.error);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters for tool ${name}: ${validationResult.error.message}`
        );
      }

      // Execute handler with validated input
      return await toolInfo.handler(validationResult.data);
    } catch (error) {
      logger.error(`[Error] Tool execution failed: ${error}`);
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error}`);
    }
  }

  /**
   * Register tool handlers with the server
   * @param server MCP server
   */
  registerToolHandlers(server: Server): void {
    logger.info(`Registering tool handlers: ${this.toolDefinitions}`);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolDefinitions,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      return this.callTool(request.params.name, request.params.arguments);
    });
  }
}
