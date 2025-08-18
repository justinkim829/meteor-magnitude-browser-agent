/**
 * Enhanced proxy server that converts between OpenAI and Anthropic formats
 * This allows using Anthropic through the openai-generic provider
 */

const express = require('express');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const { convertAnthropicToOpenAI, convertOpenAIToAnthropic } = require('./anthropic_to_openai_converter');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

const secretsManager = new AWS.SecretsManager({ region: 'us-east-1' });

async function getApiKey() {
  const secretData = await secretsManager.getSecretValue({ SecretId: 'browser-agent-api-key' }).promise();
  return JSON.parse(secretData.SecretString).ANTHROPIC_API_KEY;
}

// OpenAI-compatible chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // Simple authorization: Require non-empty user_id header (no verification for low latency)
    const userId = req.headers['x-user-id'];
    if (!userId || userId.trim() === '') {
      return res.status(401).json({ 
        error: {
          message: 'Missing or invalid user_id header',
          type: 'invalid_request_error',
          code: 'missing_user_id'
        }
      });
    }

    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('API key not found in Secrets Manager');
    }

    // Convert OpenAI request to Anthropic format
    const anthropicRequest = convertOpenAIToAnthropic(req.body);
    
    // Log the conversion for debugging
    console.log('OpenAI request received:', JSON.stringify(req.body, null, 2));
    console.log('Converted to Anthropic:', JSON.stringify(anthropicRequest, null, 2));

    // Call Anthropic API
    const anthropicVersion = '2023-06-01';
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': anthropicVersion,
        // Preserve prompt-caching support if client sent it
        ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {})
      },
      body: JSON.stringify(anthropicRequest),
    });

    const anthropicResponse = await upstream.json();
    
    // Log the Anthropic response for debugging
    console.log('Anthropic response:', JSON.stringify(anthropicResponse, null, 2));
    
    // Convert Anthropic response to OpenAI format
    const openaiResponse = convertAnthropicToOpenAI(anthropicResponse);
    
    // Log the converted response for debugging
    console.log('Converted to OpenAI:', JSON.stringify(openaiResponse, null, 2));
    
    // Return OpenAI-formatted response
    res.status(upstream.status);
    res.json(openaiResponse);
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: {
        message: String(error),
        type: 'upstream_error',
        code: null
      }
    });
  }
});

// Keep the original Anthropic messages endpoint for backward compatibility
app.post('/v1/messages', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId || userId.trim() === '') {
      return res.status(401).json({ error: 'Missing or invalid user_id header' });
    }

    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('API key not found in Secrets Manager');
    }

    const anthropicVersion = '2023-06-01';
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': anthropicVersion,
        ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {})
      },
      body: JSON.stringify(req.body),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    if (upstream.headers.get('content-type')) {
      res.set('content-type', upstream.headers.get('content-type'));
    }
    res.send(text);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ type: 'error', error: { type: 'upstream_error', message: String(error) } });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    endpoints: {
      anthropic: '/v1/messages',
      openai: '/v1/chat/completions'
    }
  });
});

app.listen(port, () => {
  console.log(`Enhanced proxy server running on port ${port}`);
  console.log(`  - OpenAI-compatible endpoint: /v1/chat/completions`);
  console.log(`  - Anthropic native endpoint: /v1/messages`);
});


