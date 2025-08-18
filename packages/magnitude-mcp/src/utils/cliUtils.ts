import { spawn, SpawnOptions, ChildProcess } from 'child_process';
import { logger } from './logger.js';

/**
 * Execute a CLI command using spawn
 * @param command The main command to execute
 * @param args Array of arguments for the command
 * @param options Additional spawn options (like cwd for directory)
 * @returns Promise resolving to the command output
 */
export function executeCliCommand(command: string, args: string[], options: SpawnOptions = {}): Promise<string> {
  const cwd = options.cwd ? ` (in ${options.cwd})` : '';
  logger.info(`[CLI] Executing: ${command} ${args.join(' ')}${cwd}`);
  
  // Merge default options with provided options
  const spawnOptions: SpawnOptions = {
    env: { ...process.env }, // Include all environment variables
    shell: true, // Use shell to help with PATH resolution
    stdio: 'pipe', // Capture output
    ...options // Override with any provided options
  };
  
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, spawnOptions);
    
    let stdout = '';
    let stderr = '';
    
    childProcess.stdout!.on('data', (data) => {
      stdout += data.toString();
    });
    
    childProcess.stderr!.on('data', (data) => {
      stderr += data.toString();
    });
    
    childProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Process exited with code ${code}: ${stderr}`));
      }
    });
    
    childProcess.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Handle errors from tool execution
 * @param message Error message prefix
 * @param error Error object
 * @returns Formatted error response for MCP
 */
export function handleError(message: string, error: any): any {
  logger.error(`[Error] ${message}:`, error);
  return {
    content: [
      {
        type: 'text',
        text: `${message}: ${error}`,
      },
    ],
    isError: true,
  };
}

/**
 * Execute a command and watch for URLs in stdout for a specified time
 * without waiting for process completion
 * @param command The main command to execute
 * @param args Array of arguments for the command
 * @param options Additional spawn options (like cwd for directory)
 * @param watchTime Time (ms) to watch for URLs before returning (default: 2000ms)
 * @param urlPattern Regex pattern to match URLs in stdout
 * @returns Promise resolving to an array of unique matched URLs
 */
export function watchProcessForUrls(
  command: string,
  args: string[],
  options: SpawnOptions = {},
  watchTime: number = 5000,
  urlPattern: RegExp = /https:\/\/app\.magnitude\.run\/console\/[a-z0-9]+\/runs\/[a-z0-9]+/g
): Promise<string[]> {
  const cwd = options.cwd ? ` (in ${options.cwd})` : '';
  logger.info(`[CLI] Watching process for URLs: ${command} ${args.join(' ')}${cwd} (for ${watchTime}ms)`);
  
  // Merge default options with provided options
  const spawnOptions: SpawnOptions = {
    env: { ...process.env },
    shell: true,
    stdio: 'pipe',
    detached: true, // Allow process to run in background
    ...options
  };
  
  // Store unique URLs
  const urlSet = new Set<string>();
  
  // Create child process
  const childProcess = spawn(command, args, spawnOptions);
  
  // Process stdout to capture URLs
  childProcess.stdout?.on('data', (data) => {
    const output = data.toString();
    //logger.info(`Processing chunk: ${output}`);
    const matches = output.match(urlPattern);
    
    if (matches) {
      matches.forEach((url: string) => {
        urlSet.add(url);
        logger.info(`URL detected in logs: ${url}`);
      });
    }
  });
  
  // Handle errors but don't end the process
  childProcess.on('error', (error) => {
    logger.error(`[Error] Process error: ${error}`);
  });
  
  // Return promise that resolves after watchTime with collected URLs
  return new Promise((resolve) => {
    setTimeout(() => {
      // Unref to allow Node.js to exit even if process is still running
      childProcess.unref();
      resolve([...urlSet]);
    }, watchTime);
  });
}
