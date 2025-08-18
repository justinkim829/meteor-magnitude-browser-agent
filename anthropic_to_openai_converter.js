/**
 * Converter to transform Anthropic API responses to OpenAI format
 * This allows using Anthropic through the openai-generic provider which supports custom baseUrl
 */

/**
 * Convert Anthropic response to OpenAI format
 * @param {Object} anthropicResponse - The response from Anthropic API
 * @returns {Object} OpenAI-formatted response
 */
function convertAnthropicToOpenAI(anthropicResponse) {
  // Handle streaming responses (if applicable)
  if (anthropicResponse.type === 'message_start' || anthropicResponse.type === 'content_block_delta') {
    return convertAnthropicStreamToOpenAI(anthropicResponse);
  }

  // Handle regular message responses
  if (anthropicResponse.type === 'message') {
    return {
      id: anthropicResponse.id || 'chatcmpl-' + generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: anthropicResponse.model || 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: anthropicResponse.role || 'assistant',
          content: extractContent(anthropicResponse.content)
        },
        finish_reason: mapStopReason(anthropicResponse.stop_reason)
      }],
      usage: {
        prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
        completion_tokens: anthropicResponse.usage?.output_tokens || 0,
        total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0)
      }
    };
  }

  // Handle error responses
  if (anthropicResponse.type === 'error') {
    return {
      error: {
        message: anthropicResponse.error?.message || 'Unknown error',
        type: anthropicResponse.error?.type || 'api_error',
        code: anthropicResponse.error?.code || null
      }
    };
  }

  // Fallback for unknown response types
  return anthropicResponse;
}

/**
 * Extract text content from Anthropic content blocks
 */
function extractContent(content) {
  if (!content) return '';
  
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }
  
  return '';
}

/**
 * Map Anthropic stop reasons to OpenAI finish reasons
 */
function mapStopReason(stopReason) {
  const mapping = {
    'end_turn': 'stop',
    'max_tokens': 'length',
    'stop_sequence': 'stop',
    'tool_use': 'tool_calls'
  };
  return mapping[stopReason] || 'stop';
}

/**
 * Convert OpenAI request to Anthropic format
 * @param {Object} openaiRequest - The OpenAI-formatted request
 * @returns {Object} Anthropic-formatted request
 */
function convertOpenAIToAnthropic(openaiRequest) {
  const anthropicRequest = {
    model: mapOpenAIModel(openaiRequest.model),
    messages: convertMessages(openaiRequest.messages),
    max_tokens: openaiRequest.max_tokens || 4096,
    temperature: openaiRequest.temperature,
    top_p: openaiRequest.top_p,
    stream: openaiRequest.stream || false
  };

  // Add system message if present
  const systemMessage = openaiRequest.messages?.find(m => m.role === 'system');
  if (systemMessage) {
    anthropicRequest.system = systemMessage.content;
    // Remove system message from messages array as Anthropic handles it separately
    anthropicRequest.messages = anthropicRequest.messages.filter(m => m.role !== 'system');
  }

  // Add stop sequences if present
  if (openaiRequest.stop) {
    anthropicRequest.stop_sequences = Array.isArray(openaiRequest.stop) ? openaiRequest.stop : [openaiRequest.stop];
  }

  return anthropicRequest;
}

/**
 * Map OpenAI model names to Anthropic model names
 */
function mapOpenAIModel(model) {
  // If already an Anthropic model name, return as-is
  if (model?.includes('claude')) {
    return model;
  }
  
  // Map common OpenAI models to Anthropic equivalents
  const mapping = {
    'gpt-4': 'claude-3-5-sonnet-20241022',
    'gpt-4-turbo': 'claude-3-5-sonnet-20241022',
    'gpt-3.5-turbo': 'claude-3-haiku-20240307',
    'gpt-4o': 'claude-3-5-sonnet-20241022',
    'gpt-4o-mini': 'claude-3-haiku-20240307'
  };
  
  return mapping[model] || 'claude-3-5-sonnet-20241022';
}

/**
 * Convert OpenAI messages format to Anthropic format
 */
function convertMessages(messages) {
  if (!messages) return [];
  
  return messages
    .filter(m => m.role !== 'system') // System messages handled separately
    .map(message => {
      if (typeof message.content === 'string') {
        return {
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content
        };
      }
      
      // Handle multimodal content
      if (Array.isArray(message.content)) {
        return {
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content.map(part => {
            if (part.type === 'text') {
              return { type: 'text', text: part.text };
            }
            if (part.type === 'image_url') {
              return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: part.image_url.url } };
            }
            return part;
          })
        };
      }
      
      return message;
    });
}

/**
 * Generate a random ID for OpenAI format
 */
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Convert Anthropic streaming response to OpenAI streaming format
 */
function convertAnthropicStreamToOpenAI(chunk) {
  if (chunk.type === 'message_start') {
    return {
      id: 'chatcmpl-' + generateId(),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: chunk.message?.model || 'gpt-4',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null
      }]
    };
  }
  
  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
    return {
      id: 'chatcmpl-' + generateId(),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4',
      choices: [{
        index: 0,
        delta: { content: chunk.delta.text },
        finish_reason: null
      }]
    };
  }
  
  if (chunk.type === 'message_delta') {
    return {
      id: 'chatcmpl-' + generateId(),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: mapStopReason(chunk.delta?.stop_reason)
      }]
    };
  }
  
  return null;
}

// Export for ES modules
export {
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  convertAnthropicStreamToOpenAI
};
