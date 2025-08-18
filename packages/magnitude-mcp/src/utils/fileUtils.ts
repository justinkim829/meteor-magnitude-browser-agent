import fs from 'node:fs/promises';

/**
 * Check if a file exists
 * @param filePath Path to the file to check
 * @returns Promise resolving to true if the file exists, false otherwise
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 * @param dirPath Path to the directory to ensure exists
 * @returns Promise resolving when the directory exists
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error: any) {
    console.log('[Error] Failed to create directory:', error);
    throw error;
  }
}
