import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '.env') });

console.log('API Key loaded:', process.env.ANTHROPIC_API_KEY ? 'Yes' : 'No');
console.log('API Key starts with:', process.env.ANTHROPIC_API_KEY?.substring(0, 10));
console.log('API Key length:', process.env.ANTHROPIC_API_KEY?.length);