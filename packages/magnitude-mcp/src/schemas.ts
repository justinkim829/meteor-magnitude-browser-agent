import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Schema for initialize_project tool
 */
export const initProjectSchema = z.object({
  projectDir: z.string().describe('Absolute root directory of the Node.js project where Magnitude should be initialized'),
}).strict();

/**
 * Schema for run_tests tool
 */
export const runTestsSchema = z.object({
//   projectDir: z.string().describe('Absolute directory of the Node.js project where Magnitude tests should be run'),
//   pattern: z.string().optional().describe('Glob pattern for test files to run')
}).strict();

/**
 * Schema for build_tests tool
 */
export const buildTestsSchema = z.object({}).strict();

/**
 * Helper function to convert a Zod schema to a JSON Schema for MCP compatibility
 * @param schema Zod schema
 * @param name Tool name
 * @param description Tool description
 * @returns Tool definition compatible with MCP
 */
export function createToolDefinition(schema: z.ZodType, name: string, description: string) {
  // Convert Zod schema to JSON Schema
  const inputSchema = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });

  return {
    name,
    description,
    inputSchema,
  };
}

// Map of all tool schemas
export const toolSchemas = {
  init_project: initProjectSchema,
  run_tests: runTestsSchema,
  build_tests: buildTestsSchema,
};

// Type exports derived from Zod schemas
export type InitializeProjectInput = z.infer<typeof initProjectSchema>;
export type RunTestsInput = z.infer<typeof runTestsSchema>;
export type BuildTestsInput = z.infer<typeof buildTestsSchema>;
