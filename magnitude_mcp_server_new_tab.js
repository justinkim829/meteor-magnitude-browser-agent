#!/usr/bin/env node

/**
 * Enhanced Magnitude MCP Server with New Tab Support
 * 
 * This version ensures that each automation task opens in a new tab
 * within the same browser instance where the sidebar chat is running.
 */

import express from 'express';
import bodyParser from 'body-parser';
import { startBrowserAgent } from 'magnitude-core';
import z from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';

import { EventEmitter } from 'events';
import net from 'net';
import crypto from 'crypto';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Direct hardcoded API keys - no external dependencies
let cachedSecrets = {
  ANTHROPIC_API_KEY: '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',
  OPENAI_API_KEY: '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',
  BRAVE_SEARCH_API_KEY: 'BSAHyFJjyHZPwR5J2o_vKsrKqN0PDwo',
  MCP_API_KEY: 'default-mcp-key',
  BROWSER_API_KEY: 'default-browser-key',
  initialized: true,
  source: 'hardcoded_keys'
};


// Helper function to get cached secret
function getSecret(key) {
  // Prefer env override if present, then cached value
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key];
  }
  return cachedSecrets[key];
}

// Load environment variables (for non-secret configuration)
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

// Request logging middleware
const requestLogger = (req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    
    // Update metrics
    metrics.requests.total++;
    
    // Track by endpoint
    const endpoint = req.path;
    metrics.requests.byEndpoint.set(endpoint, 
      (metrics.requests.byEndpoint.get(endpoint) || 0) + 1);
    
    // Track by status
    const statusClass = Math.floor(res.statusCode / 100) * 100;
    metrics.requests.byStatus.set(statusClass,
      (metrics.requests.byStatus.get(statusClass) || 0) + 1);
    
    // Log security events
    if (res.statusCode === 401) {
      console.warn(`[Security] Unauthorized access attempt: ${req.ip} ${req.path}`);
      metrics.security.unauthorized_attempts++;
    }
    
    originalSend.call(this, data);
  };
  
  next();
};

app.use(requestLogger);

// API Key validation middleware
const validateApiKey = (req, res, next) => {
  // Skip validation for health and tool listing endpoints
  const publicEndpoints = ['/health', '/mcp/health', '/mcp/tools', '/register-browser', '/exchange-keys', '/validate-connection'];
  if (publicEndpoints.includes(req.path)) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const validApiKey = getSecret('MCP_API_KEY');
  
  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({ 
      error: 'Invalid or missing API key',
      message: 'Please provide a valid API key in X-API-Key header or api_key query parameter'
    });
  }
  
  next();
};

// API key validation will be applied after secrets initialization in startServer()

// Configuration
const PORT = process.env.MAGNITUDE_MCP_PORT || process.env.MAGNITUDE_PORT || 9123;
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const SECURE_IPC_SOCKET = process.env.SECURE_IPC_SOCKET;
const METEOR_BACKEND_URL = process.env.METEOR_BACKEND_URL || 'http://meteor-backend-alb-1286252766.us-west-2.elb.amazonaws.com';
const FAVICON_SIZE = parseInt(process.env.FAVICON_SIZE || '32', 10);



// Protocol version and capabilities for enhanced registration
const PROTOCOL_VERSION = "1.0";
const SUPPORTED_CAPABILITIES = ["encrypted_communication", "key_exchange"];

// Encryption key validation and recovery
// Note: crypto is already imported at the top

function validateEncryptionKeys(encryptionKey, authKey) {
  try {
    if (!encryptionKey || !authKey) {
      throw new Error('Missing encryption or auth key');
    }
    
    // Validate key format and length
    const encBuffer = Buffer.from(encryptionKey, 'base64');
    const authBuffer = Buffer.from(authKey, 'base64');
    
    if (encBuffer.length !== 32) {
      throw new Error(`Invalid encryption key length: ${encBuffer.length}, expected 32`);
    }
    
    if (authBuffer.length !== 32) {
      throw new Error(`Invalid auth key length: ${authBuffer.length}, expected 32`);
    }
    
    // Test encryption/decryption with the keys
    const testData = 'encryption_test_data';
    const nonce = crypto.randomBytes(12);
    
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', encBuffer, iv);
    cipher.setAAD(Buffer.from('test'));
    let encrypted = cipher.update(testData, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Test decryption
    const decipher = crypto.createDecipheriv('aes-256-gcm', encBuffer, iv);
    decipher.setAAD(Buffer.from('test'));
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    if (decrypted !== testData) {
      throw new Error('Encryption key validation failed - decryption mismatch');
    }
    
    console.log('[Security] Encryption keys validated successfully');
    return { valid: true, encBuffer, authBuffer };
    
  } catch (error) {
    console.error(`[Security] Key validation failed: ${error.message}`);
    return { valid: false, error: error.message };
  }
}

// --- Favicon helpers (backend data-URI) -------------------------------------
const _faviconCache = new Map(); // key: pageUrl|size -> data_uri
async function fetchFaviconDataUri(pageUrl, size = FAVICON_SIZE, timeoutMs = 2500) {
  try {
    if (!pageUrl) return null;
    const key = `${pageUrl}|${size}`;
    if (_faviconCache.has(key)) return _faviconCache.get(key);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const url = `${METEOR_BACKEND_URL}/favicon/data-uri?url=${encodeURIComponent(pageUrl)}&size=${size}`;
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return null;
    const json = await resp.json();
    const data = (json && typeof json.data_uri === 'string') ? json.data_uri : null;
    if (data && data.startsWith('data:')) _faviconCache.set(key, data);
    return data || null;
  } catch (_e) {
    return null;
  }
}

// -------------------------------------------------------------
// Enhanced Prompt Utilities (Brave enrichment + OpenAI synthesis)
// -------------------------------------------------------------
async function withTimeout(promise, ms, label = 'operation') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    // If the promise supports signal, pass controller.signal in the caller
    return await promise;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn(`[EnhancePrompt] ${label} timed out after ${ms}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function braveSearchTop(query, { count = 8, timeoutMs = 3000 } = {}) {
  try {
    console.log(`[EnhancePrompt] braveSearchTop: query="${(query||'').toString().slice(0,120)}" count=${count} timeoutMs=${timeoutMs}`);
    const token = getSecret('BRAVE_SEARCH_API_KEY') || process.env.BRAVE_SEARCH_API_KEY;
    if (!token || !query) return [];
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('spellcheck', '1');
    url.searchParams.set('country', 'us');
    const headers = { 'X-Subscription-Token': token };
    const res = await withTimeout(fetch(url.toString(), { headers }), timeoutMs, 'Brave search');
    if (!res.ok) return [];
    const body = await res.json();
    const results = [];
    const seenHosts = new Set();
    const webResults = (body && body.web && Array.isArray(body.web.results)) ? body.web.results : (Array.isArray(body.results) ? body.results : []);
    for (const r of webResults) {
      const urlStr = r.url || r.link || '';
      let host = '';
      try { host = new URL(urlStr).hostname.replace(/^www\./, ''); } catch (_) {}
      if (!urlStr || seenHosts.has(host)) continue;
      seenHosts.add(host);
      results.push({ title: r.title || '', url: urlStr, description: r.description || r.snippet || '' });
      if (results.length >= count) break;
    }
    console.log(`[EnhancePrompt] braveSearchTop: uniqueSources=${results.length}`);
    return results;
  } catch (_) {
    console.warn('[EnhancePrompt] braveSearchTop: failed, returning empty results');
    return [];
  }
}

// Generate a single web-search query from the user's task using gpt-5-nano
async function generateSearchQueryFromTask(task) {
  try {
    const apiKey = getSecret('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
    if (!apiKey || !task) return '';

    const instruction = `Turn the user's task into one web search query that targets the core subject(s) to get background context (not the action). No quotes, no explanations, no multiple queries. Output only the final query string to web search.

Examples
'Create a resume for Jinseok Kim' → Jinseok Kim
'Create a Slack channel for Browse.dev' → Browse.dev
'Book dinner at Canlis in Seattle' → Canlis Seattle
'Use the browser agent to book a movie ticket we can watch with my dad tomorrow after dinner near University Village, Seattle.' -> movies to watch tomorrow at 7pm
'Use the browser agent to find the weather in SF' -> Weather in SF
'Use the browser agent to go to chess.com and play a new game as a guest' -> how to play a game as a guest in chess.com

Again, your answer should only be the query string to web search, not anything else. Your response is directly going to be web searched without any parsing.`;

    console.log(`[QueryGen] Using gpt-5-nano for query generation; taskLen=${String(task).length}`);
    const body = {
      model: 'gpt-5-nano',
      max_output_tokens: 1024,
      reasoning: { effort: 'minimal' },
      text: { format: { type: 'text' }, verbosity: 'low' },
      tool_choice: 'none',
      input: [  
        { role: 'user', content: [
          { type: 'input_text', text: instruction },
          { type: 'input_text', text: `Task: ${String(task)}` }
        ]}
      ]
    };

    const res = await withTimeout(fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }), 8000, 'OpenAI query generation');

    if (!res.ok) {
      console.warn(`[QueryGen] Responses failed status=${res.status}`);
      return '';
    }
    const json = await res.json();

    const out = (json && Array.isArray(json.output)) ? json.output : [];
    const textPieces = [];
    for (const p of out) {
      if (!p) continue;
      if (p.type === 'message') {
        const contents = Array.isArray(p.content) ? p.content : (p.message && Array.isArray(p.message.content) ? p.message.content : []);
        for (const c of contents) {
          if (!c) continue;
          if ((c.type === 'output_text' || c.type === 'text' || c.type === 'reasoning_text') && typeof c.text === 'string') {
            textPieces.push(c.text);
          }
        }
      } else if (p.type === 'output_text' && typeof p.text === 'string') {
        textPieces.push(p.text);
      } else if (p.type === 'summary_text' && typeof p.text === 'string') {
        textPieces.push(p.text);
      }
    }
    let finalText = (textPieces.join('\n') || '').toString().trim();
    if (!finalText && typeof json.output_text === 'string') finalText = json.output_text.toString().trim();
    if (!finalText && Array.isArray(json.output_text)) finalText = json.output_text.filter(s => typeof s === 'string').join('\n').trim();

    // Sanitize: single line, strip surrounding quotes/backticks
    const query = (finalText || '').replace(/^\s*["'`]|["'`]\s*$/g, '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    console.log(`[QueryGen] Generated query: "${query.slice(0, 160)}"`);
    return query;
  } catch (e) {
    console.warn(`[QueryGen] Failed: ${e && e.message ? e.message : String(e)}`);
    return '';
  }
}

function renderHistoryTaste(searchHistory) {
  if (!Array.isArray(searchHistory) || searchHistory.length === 0) return '';
  const items = searchHistory.slice(-20).map((h) => {
    const ts = h.timestamp ? new Date(h.timestamp).toISOString() : '';
    const q = (h.query || '').toString().trim();
    const d = Array.isArray(h.domains) ? ` domains=${h.domains.slice(0,3).join(',')}` : '';
    return `- ${ts} :: ${q}${d}`;
  });
  return items.join('\n');
}

async function synthesizeEnhancedPrompt({ task, searchHistory, braveSources, webQuery }) {
  try {
    const apiKey = getSecret('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
    if (!apiKey) return '';
    // Use only o3-mini for enhancement (reasoning model via Responses API)
    const modelCandidates = ['o3-mini'];
    // Build inputs for the exact user-provided enhancement prompt
    const taste = renderHistoryTaste(searchHistory);
    const searchHistoryText = (taste && taste.trim().length > 0) ? taste : '(none)';
    const webSearchText = (Array.isArray(braveSources) && braveSources.length > 0)
      ? braveSources.map((s) => `- ${s.title || s.url} (${s.url})${s.description ? ` — ${String(s.description).slice(0,180)}` : ''}`).join('\n')
      : '(none)';
    const displayQuery = (webQuery && String(webQuery).trim().length) ? String(webQuery).trim() : String(task || '').trim();

    // EXACT prompt as a single string with variables filled
    const exactPrompt = `You are a "prompt enhancer", taking in a user prompt which describes a web automation the user wants to perform. Your enhanced prompt will be given to a browser agent to perform the web automation. Your job is to enhance the prompt the user gave, adding in personal taste specific to the user and add details into the prompt so that the browser agent starts a task with more thorough description.

Here is the user's prompt: ${(task || '').toString()}

To give you more context, here is the search history of the past 7 days of the user: ${searchHistoryText}

Here are the search results that appear for "${displayQuery}" for reference: ${webSearchText}

Even if the user prompt is not clear or lacks details, you should enhance the prompt so that the browser agent explores first to fill in those details that are ambiguous.

For example, if the user prompt is "What are some github repos I might be interested in?", you could enhance the prompt so that the browser agent first tries to read the user's github profile and repositories to understand the user's interests before looking for github repos to recommend.

You want to "enhance" the prompt in ALL 4 aspects:

1. Personalization (adding taste)
For example, suppose the user prompt is "Find me headphones to buy" and looking into the search history, you notice that the user often buys products from Amazon. Then, you might want to enhance the prompt to "Find me headphones to buy. Prioritize looking for options in Amazon."

2. Add details into the user prompt so that the browser agent performs the task in a thorough manner.

We want our browser agent to be thorough. Suppose the user prompt is "find the one-way cheapest flight from SEA to SFO tomorrow". If we gave this prompt without any enhancements, the browser agent might just look into one flight website to find the cheapest flight and end the task. Think about how a thoughtful and thorough person would do the user's task if they had to manually perform it. That person would look into at least 3 flight websites to find the cheapest flight options in each of them, compare/contrast between them, and give the absolute cheapest option. 

For another example, suppose the user prompt is "I have a date night with my girlfriend tomorrow. Book a movie ticket we can watch after dinner near University Village, Seattle.". We absolutely do not want the browser agent to go and book the first movie they look appears in the theater website. Again, how would a thorough and thoughtful person do the same task? After seeing the movie options that are available, that person would ask questions like "is this movie appropriate to watch with my girlfriend at date night?", "what seat position should I select?", "what are the reviews of the movies I am considering?" and might perform additional browsing to make sure that the chosen movie is appropriate and was chosen after careful considerations. Thus, you can enhance the prompt to something like "I have a date night with my girlfriend tomorrow. Book a movie ticket we can watch after dinner near University Village, Seattle. Approach step by step. First, look into at least 2 theaters near that location, look at the images for each of those theaters, and select the theater which has the most romantic and aesthetic surroundings. Do NOT stop until you find a beautiful theater that is nearby. Second, go into that theater website and browse the top 3 movies that are available tomorrow around dinner. For each of those movies, perform additional searches to see the reviews of them. After careful examination, carefully think to choose the movie that is the best option to watch with my girlfriend considering my situation. Lastly, book the movie. Find seats near the center back of the theater.". 

You can also add into detail with your existing knowledge. For example, if the user prompt is "I am a CS major. Go to my LinkedIn to read my work history, then create a resume.". We know that Jake's Resume Template is a famous template used by cs majors to create their resume. Thus, you can enhance the prompt to "I am a CS major. Go to my LinkedIn to read my work history, then create a resume. Use Jake's resume template and create the resume in Overleaf". 

3. IMPORTANT: Always gather the necessary context before acting so the output is relevant, complete, and accurate.

A thoughtful and thorough person would never attempt the task blindly — they would first gather the background knowledge needed to make good decisions. The browser agent should mirror this same mindset: pause, collect the relevant context, and only then proceed.

For example, if the user prompt is "Find me courses to take at UW the following quarter using MyPlan." In this case, you don't want the browser agent to just go and recommend any courses. How would a thorough person perform this user task? They would first go and find out the major of that user and all courses that the user took, the graduation requirements. Then, they would recommend courses that are relevant to the user's major and graduation requirements. Thus, you can enhance the prompt to "Find me courses to take at UW the following quarter using MyPlan. Before you start looking for courses for the upcoming quarter, find out my major and all courses that the I took, the graduation requirements, etc. Then, recommend courses that are relevant to the my major/interests and graduation requirements."

For another example, if the user prompt is "Find me groceries in Amazon for this week", you would want to first check the previous orders of that user to understand what they typically buy. Do NOT overfit to the examples I gave you, but think carefully about how a thorough person would perform the task. They would ask questions like "What does the user typically buy?", "Any deals or discounts that the user might want to take?", etc. Thus, you can enhance the prompt to something like "find me groceries in Amazon for this week. Before you start looking for groceries, check the previous orders of the user to understand what they typically buy. Then, recommend groceries that are relevant to the user's typical purchases and any deals or discounts that the user might want to take."

One more example could be if the user prompt is "Create a resume for Jinseok Kim", you want the browser agent to first do research to find who Jinseok Kim is. In general, if the user prompt mentions something/someone/some organization/some name you don't recognize, you could enhance the prompt to first research that out before resuming the task.

Since this aspect is crucial, I will give you one more example. If the user prompt is 'Do my homework for ENGL288 in Canvas', the browser agent should not simply locate the most recent homework and complete it. Instead, it could first go to Canvas and carefully review the course syllabus, the homework instructions, and the contents of previous lectures or readings. A thoughtful and thorough person — especially a grade-A student — would never just rush to finish the assignment. They would make sure they understand the context, expectations, and requirements in depth before producing the work. The browser agent should act with this same mindset, and you are responsible to enhance the prompt so that the browser agent acts this way.

What would a thorough person "research" before starting the task? A thoughtful and thorough person would never attempt the task blindly — they would first gather the background knowledge needed to make good decisions. Think about it. 

4. Add in completion and quality rules
It is always good to add in lines like "Approach step by step. You should NEVER stop until ALL tasks are FULLY complete. Even if you think you completed everything, look at the current state to confirm that you performed the task in high quality before calling the task complete. Take your time. It is MUCH better to spend your time to perform a thorough automation rather than doing the bare minimum of the task specifications". For example, if the user's prompt is "accept all my 400 LinkedIn Connections", you want to make sure that all 400 connection requests are accepted before the browser agent stops. Thus, you can enhance to "accept all my 400 LinkedIn Connections. You should NEVER stop until EVERY SINGLE connection request is accepted. That means you have to accept 400 times.".

Another example could be if the user prompt is "find the cheapest headphones in Amazon". Even though you found the cheapest headphones available, you want to make sure if it not a scam. Thus, you can enhance the prompt to "find the cheapest headphones in Amazon. Make sure to check the reviews and ratings of the headphones to make sure that the cheapest option is not a scam.".

There should be no world in which the browser agent ends the task before it is fully completed because it takes a long time, task is hard to do, agent wants to ask clarification, or any other reason.
________________________________________________________________________________

To summarize, you want to enhance the user's prompt so that the browser agent executes the user's will in a more thorough and thoughtful way. You have the ability to generate the prompt to give to the browser agent, so you have very high responsibility. You MUST think into depth what the user wants to achieve and how a thorough and thoughtful person would execute the task if that person had to manually perform it, and enhance the user prompt so that the browser agent also performs the task in that manner. Assume that the browser agent will not be as thorough unless you explicitly mention the steps to take and the things to consider.

Do NOT overwrite the user prompt. It is not required to make use of search history and web search results if it does not make sense to do so.

MOST IMPORTANT: You should NOT overfit to the examples I gave you. The goal is not to rewrite the prompt mechanically, but to channel the mindset of a thoughtful, thorough person performing the task carefully, step by step, making sure nothing important is missed.

Again, we want the browser agent to adopt the mindset of a highly responsible worker — someone whose livelihood depends on delivering high quality results. Such a worker would never approach the task carelessly or half-heartedly. That worker would even go the extra mile to ensure the user is fully satisfied.

Your response should be ONLY the enhanced prompt with no other text. Your response is going to be directly given to the browser agent without any parsing.`;

    const hCount = Array.isArray(searchHistory) ? searchHistory.length : 0;
    const sCount = Array.isArray(braveSources) ? braveSources.length : 0;
    console.log(`[EnhancePrompt] Synthesis inputs: taskLen=${(task||'').toString().length} history=${hCount} sources=${sCount}`);
    if (hCount > 0) {
      try {
        const sample = renderHistoryTaste(Array.isArray(searchHistory) ? searchHistory.slice(-5) : []);
        console.log(`[EnhancePrompt] Sample history taste (last 5): ${sample.replace(/\n/g,' | ').slice(0,200)}`);
      } catch (_e) {}
    }
    console.log(`[EnhancePrompt] Model trial order: ${modelCandidates.join(' -> ')}`);

    // Try candidates in order: prefer Responses API with reasoning when appropriate,
    // fall back to Responses without reasoning or Chat Completions for broad compatibility.
    for (const model of modelCandidates) {
      try {
        const isReasoningModel = /^o[34](-|$)/.test(model);
        console.log(`[EnhancePrompt] Using OpenAI model: ${model} (reasoning=${isReasoningModel})`);

        if (true) { // Prefer Responses API for all models per current docs
          const body = {
            model,
            ...(isReasoningModel ? { reasoning: { effort: 'medium' } } : {}),
            max_output_tokens: 1024,
            input: [
              { role: 'user', content: [ { type: 'input_text', text: exactPrompt } ] }
            ]
          };
          const res = await withTimeout(fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }), 15000, 'OpenAI responses synthesis');
          if (!res.ok) {
            console.warn(`[EnhancePrompt] Responses synthesis failed for model=${model}: status=${res.status}`);
            continue;
          }
          const json = await res.json();
          const out = (json && Array.isArray(json.output)) ? json.output : [];
          const textPieces = [];
          for (const p of out) {
            if (!p) continue;
            if (p.type === 'message') {
              const contents = Array.isArray(p.content) ? p.content : (p.message && Array.isArray(p.message.content) ? p.message.content : []);
              for (const c of contents) {
                if (!c) continue;
                if ((c.type === 'output_text' || c.type === 'text' || c.type === 'reasoning_text') && typeof c.text === 'string') {
                  textPieces.push(c.text);
                }
              }
            } else if (p.type === 'output_text' && typeof p.text === 'string') {
              textPieces.push(p.text);
            } else if (p.type === 'summary_text' && typeof p.text === 'string') {
              textPieces.push(p.text);
            }
          }
          let finalText = (textPieces.join('\n') || '').toString().trim();
          if (!finalText && typeof json.output_text === 'string') {
            finalText = json.output_text.toString().trim();
          }
          if (!finalText && Array.isArray(json.output_text)) {
            finalText = json.output_text.filter(s => typeof s === 'string').join('\n').trim();
          }
          if (finalText) {
            console.log(`[EnhancePrompt] Synthesis OK (responses, model=${model}): chars=${finalText.length} preview="${finalText.slice(0,200).replace(/\n/g,' ')}"`);
            return finalText;
          }
          console.warn(`[EnhancePrompt] Empty output with Responses API for model=${model}`);
          continue;
        }
      } catch (err) {
        console.warn(`[EnhancePrompt] Synthesis attempt failed for model=${model}: ${err?.message || String(err)}`);
        // Try Chat Completions as a last resort for non-reasoning models only
        try {
          if (!/^o[34](-|$)/.test(model)) {
            const res2 = await withTimeout(fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                temperature: 0.2,
                messages: [
                  { role: 'user', content: exactPrompt }
                ]
              })
            }), 10000, 'OpenAI chat synthesis (fallback)');
            if (res2.ok) {
              const json2 = await res2.json();
              const text = json2 && json2.choices && json2.choices[0] && json2.choices[0].message && json2.choices[0].message.content;
              const finalText2 = (text || '').toString().trim();
              if (finalText2) {
                console.log(`[EnhancePrompt] Synthesis OK (chat, model=${model}): chars=${finalText2.length} preview="${finalText2.slice(0,200).replace(/\n/g,' ')}"`);
                return finalText2;
              }
            } else {
              console.warn(`[EnhancePrompt] Chat synthesis failed for model=${model}: status=${res2.status}`);
            }
          }
        } catch (fallbackErr) {
          console.warn(`[EnhancePrompt] Chat fallback failed for model=${model}: ${fallbackErr?.message || String(fallbackErr)}`);
        }
      }
    }

    console.warn('[EnhancePrompt] All model attempts failed, returning empty prompt');
    return '';
  } catch (e) {
    console.error(`[EnhancePrompt] Synthesis error: ${e && e.message ? e.message : String(e)}`);
    return '';
  }
}

function generateFallbackKeys() {
  console.log('[Security] Generating fallback encryption keys');
  const encryptionKey = crypto.randomBytes(32);
  const authKey = crypto.randomBytes(32);
  
  return {
    encryption_key: encryptionKey.toString('base64'),
    auth_key: authKey.toString('base64'),
    generated: true
  };
}

// Fix hostname issue: magnitude-core uses 127.0.0.1 but Chrome binds to localhost/[::1]
// Convert any 127.0.0.1 URLs to localhost for compatibility
const FIXED_CDP_URL = CDP_URL.replace('127.0.0.1', 'localhost');

// Helper: guidance for agent prompt about when to request human intervention
function buildAgentPrompt() {
  return [
    'Tab usage policy:',
    '- When starting a task, open a new tab for your work. Do not navigate or repurpose existing user tabs unless explicitly requested.',
    '- Prefer creating the new tab in the background to avoid stealing focus.',
  ].join('\n');
}

// Resolve DevTools WS endpoint from an HTTP CDP URL that may include a token
// Ensures correct placement of token on /json/version and on the returned ws URL
async function resolveWsEndpoint(cdpHttpUrlWithToken) {
  try {
    const base = new URL(cdpHttpUrlWithToken);
    const token = base.searchParams.get('token');

    // Build correct /json/version URL and carry token as query param
    const versionUrl = new URL('/json/version', base.origin);
    if (token) versionUrl.searchParams.set('token', token);
    if (versionUrl.hostname === '127.0.0.1') versionUrl.hostname = 'localhost';

    const res = await fetch(versionUrl.toString());
    if (!res.ok) {
      throw new Error(`Unexpected status ${res.status} for ${versionUrl.toString()}`);
    }
    const body = await res.json();
    if (!body || !body.webSocketDebuggerUrl) {
      throw new Error('webSocketDebuggerUrl missing from /json/version response');
    }

    const wsUrl = new URL(body.webSocketDebuggerUrl);
    if (wsUrl.hostname === '127.0.0.1') wsUrl.hostname = 'localhost';
    // Ensure token is present on ws URL for secure handshake
    if (token) wsUrl.searchParams.set('token', token);
    return wsUrl.toString();
  } catch (e) {
    console.error(`[Security] Failed to resolve WS endpoint: ${e.message}`);
    throw e;
  }
}

// Secure IPC Client for Token Rotation
class SecureIPCClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.client = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;  // Heartbeat timer
    this.tokenRotationCallback = null;
    this.encryptionKey = null;  // AES-256-GCM key
    this.authKey = null;        // HMAC-SHA256 key
    this.sequenceNumber = 0;    // Message ordering
  }
  
  // Set encryption keys from browser registration
  setEncryptionKeys(encryptionKey, authKey) {
    this.encryptionKey = encryptionKey;
    this.authKey = authKey;
    console.log('[SecureIPC] Encryption keys configured for secure communication');
  }
  
  // Generate cryptographically secure nonce
  generateNonce() {
    return crypto.randomBytes(12); // 96-bit nonce for AES-GCM
  }
  
  // Encrypt payload using AES-256-GCM
  encryptPayload(payload, nonce) {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not available');
    }
    
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    
    let encrypted = cipher.update(payload, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    return Buffer.concat([encrypted, authTag]);
  }
  
  // Decrypt payload using AES-256-GCM  
  decryptPayload(encryptedData, nonce) {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not available');
    }
    
    // Extract encrypted data and auth tag
    const encrypted = encryptedData.slice(0, -16);  // All but last 16 bytes
    const authTag = encryptedData.slice(-16);       // Last 16 bytes
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, nonce);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  // Generate HMAC-SHA256 authentication tag
  generateAuthTag(messageType, nonce, encryptedPayload, timestamp, sequenceNumber) {
    if (!this.authKey) {
      throw new Error('Authentication key not available');
    }
    
    // Create data to authenticate (matching browser format exactly)
    // C++ uses: "%d|%s|%s|%ld|%u" with raw binary nonce and encrypted_payload (not base64!)
    // After base64 decode in C++: message.nonce.c_str() and message.encrypted_payload.c_str()
    const authData = `${messageType}|${nonce.toString('latin1')}|${encryptedPayload.toString('latin1')}|${timestamp}|${sequenceNumber}`;
    
    console.log(`[SecureIPC] STALENESS-DEBUG: Generating auth tag with data: ${authData}`);
    console.log(`[SecureIPC] STALENESS-DEBUG: Auth data length: ${authData.length}`);
    console.log(`[SecureIPC] STALENESS-DEBUG: Nonce length: ${nonce.length}, Encrypted payload length: ${encryptedPayload.length}`);
    
    const hmac = crypto.createHmac('sha256', this.authKey);
    hmac.update(authData, 'utf8');
    return hmac.digest();
  }
  
  // Create secure message (matching browser's SecureMessage format)
  createSecureMessage(messageType, payload) {
    if (!this.encryptionKey || !this.authKey) {
      throw new Error('Encryption keys not available for secure messaging');
    }
    
    const nonce = this.generateNonce();
    const encryptedPayload = this.encryptPayload(payload, nonce);
    const timestamp = Date.now();
    const sequenceNumber = ++this.sequenceNumber;
    
    // Map message types to integers (matching browser's MessageType enum)
    const messageTypeMap = {
      'TOKEN_REQUEST': 0,
      'TOKEN_RESPONSE': 1, 
      'TOKEN_REFRESH': 2,
      'HEALTH_CHECK': 3,
      'SHUTDOWN_SIGNAL': 4,
      'SUBSCRIBE_TOKEN_ROTATION': 5
    };
    
    const messageTypeInt = messageTypeMap[messageType] || 5; // Default to SUBSCRIBE_TOKEN_ROTATION
    
    // Generate auth tag using raw binary data (before base64 encoding)
    const authTag = this.generateAuthTag(messageTypeInt, nonce, encryptedPayload, timestamp, sequenceNumber);
    
    // Convert to base64 for message format (after auth tag generation)
    const nonceBase64 = nonce.toString('base64');
    const encryptedPayloadBase64 = encryptedPayload.toString('base64');
    
    return {
      message_type: messageTypeInt,
      nonce: nonceBase64,
      encrypted_payload: encryptedPayloadBase64,
      auth_tag: authTag.toString('base64'),
      timestamp: timestamp,
      sequence_number: sequenceNumber
    };
  }
  
  connect() {
    if (this.connected || !this.socketPath) {
      return Promise.resolve();
    }
    
    return new Promise((resolve, reject) => {
      console.log(`[SecureIPC] Connecting to socket: ${this.socketPath}`);
      console.log(`[SecureIPC] STALENESS-1: Current connection status: ${this.connected}`);
      console.log(`[SecureIPC] STALENESS-1: Socket path exists: ${this.socketPath ? 'YES' : 'NO'}`);
      
      this.client = net.createConnection(this.socketPath);
      
      this.client.on('connect', () => {
        console.log('[SecureIPC] Connected to secure IPC server');
        console.log('[SecureIPC] STALENESS-1: Connection established successfully');
        console.log('[SecureIPC] STALENESS-1: Connection timestamp:', new Date().toISOString());
        this.connected = true;
        this.lastConnectionTime = new Date();
        this.startTokenRotationListener();
        this.startHeartbeat();  // Start heartbeat to keep connection alive
        resolve();
      });
      
      this.client.on('data', (data) => {
        this.handleIPCMessage(data);
      });
      
      this.client.on('error', (err) => {
        console.error(`[SecureIPC] Connection error: ${err.message}`);
        console.error(`[SecureIPC] STALENESS-1: Connection failed - socket path: ${this.socketPath}`);
        console.error(`[SecureIPC] STALENESS-1: Error code: ${err.code}, syscall: ${err.syscall}`);
        this.lastErrorTime = new Date();
        this.lastError = err.message;
        this.handleConnectionLoss();
        reject(err);
      });
      
      this.client.on('close', () => {
        console.log('[SecureIPC] Connection closed');
        console.log('[SecureIPC] STALENESS-1: Connection closed at:', new Date().toISOString());
        const uptime = this.lastConnectionTime ? (new Date() - this.lastConnectionTime) : 0;
        console.log('[SecureIPC] STALENESS-1: Connection was up for:', Math.round(uptime/1000), 'seconds');
        this.lastCloseTime = new Date();
        this.handleConnectionLoss();
      });
    });
  }
  
  handleIPCMessage(data) {
    try {
      console.log(`[SecureIPC] STALENESS-4: Raw message received at ${new Date().toISOString()}`);
      console.log(`[SecureIPC] STALENESS-4: Message size: ${data.length} bytes`);
      console.log(`[SecureIPC] STALENESS-4: Raw data: ${data.toString().substring(0, 200)}...`);
      
      // Handle simple ping messages
      if (data.toString() === 'ping') {
        console.log('[SecureIPC] Received ping from browser - connection healthy');
        return;
      }
      
      const message = JSON.parse(data.toString());
      console.log(`[SecureIPC] STALENESS-4: Parsed message keys:`, Object.keys(message));
      
      // Check if this is an encrypted SecureMessage format from browser
      if (message.message_type !== undefined && message.encrypted_payload && message.auth_tag) {
        console.log('[SecureIPC] Processing encrypted SecureMessage from browser');
        console.log(`[SecureIPC] Message type: ${message.message_type}, sequence: ${message.sequence_number}`);
        
        if (message.message_type === 6) { // TOKEN_ROTATION_NOTIFICATION
          console.log('[SecureIPC] This is a token rotation notification (encrypted)');
          
          if (!this.encryptionKey || !this.authKey) {
            console.error('[SecureIPC] Cannot decrypt notification - no encryption keys available');
            return;
          }
          
          try {
            // Decrypt the payload
            const nonce = Buffer.from(message.nonce, 'base64');
            const encryptedPayload = Buffer.from(message.encrypted_payload, 'base64');
            
            const decryptedPayload = this.decryptPayload(encryptedPayload, nonce);
            const notificationData = JSON.parse(decryptedPayload);
            
            console.log('[SecureIPC] Decrypted token rotation notification:');
            console.log(`[SecureIPC] STALENESS-4: Browser instance: ${notificationData.browser_instance_id}`);
            console.log(`[SecureIPC] STALENESS-4: New token length: ${notificationData.new_token ? notificationData.new_token.length : 'UNDEFINED'}`);
            
            if (this.tokenRotationCallback) {
              this.lastTokenRotationTime = new Date();
              this.tokenRotationCallback(notificationData.browser_instance_id, notificationData.new_token);
            } else {
              console.warn('[SecureIPC] STALENESS-4: Token rotation received but no callback registered!');
            }
          } catch (decryptError) {
            console.error(`[SecureIPC] Failed to decrypt token rotation notification: ${decryptError.message}`);
          }
          
        } else if (message.message_type === 1) { // TOKEN_RESPONSE (subscription confirmation)
          console.log('[SecureIPC] Received subscription confirmation from browser');
          
        } else {
          console.log(`[SecureIPC] STALENESS-4: Unhandled encrypted message type: ${message.message_type}`);
        }
        
      } else if (message.type === 'token_rotation') {
        // Handle legacy plain JSON format (backward compatibility)
        console.log('[SecureIPC] Processing legacy token rotation notification (plain JSON)');
        console.log(`[SecureIPC] STALENESS-4: Token rotation for browser: ${message.browser_instance_id}`);
        console.log(`[SecureIPC] STALENESS-4: New token length: ${message.new_token ? message.new_token.length : 'UNDEFINED'}`);
        
        if (this.tokenRotationCallback) {
          this.lastTokenRotationTime = new Date();
          this.tokenRotationCallback(message.browser_instance_id, message.new_token);
        } else {
          console.warn('[SecureIPC] STALENESS-4: Token rotation message received but no callback registered!');
        }
        
      } else {
        console.log(`[SecureIPC] STALENESS-4: Unhandled message format:`, Object.keys(message));
      }
    } catch (error) {
      console.error(`[SecureIPC] Failed to parse message: ${error.message}`);
      console.error(`[SecureIPC] STALENESS-4: Parse error - raw data:`, data.toString());
    }
  }
  
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    console.log('[SecureIPC] Scheduling reconnection in 5 seconds...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        console.error(`[SecureIPC] Reconnection failed: ${err.message}`);
      });
    }, 5000);
  }
  
  startTokenRotationListener() {
    if (!this.connected) return;
    
    try {
      if (this.encryptionKey && this.authKey) {
        // Use secure encrypted messaging
        console.log('[SecureIPC] Sending encrypted token rotation subscription');
        
        // Create subscription payload 
        const payload = JSON.stringify({
          type: 'subscribe_token_rotation',
          timestamp: Date.now()
        });
        
        // Create encrypted message
        const secureMessage = this.createSecureMessage('SUBSCRIBE_TOKEN_ROTATION', payload);
        
        this.client.write(JSON.stringify(secureMessage));
        console.log('[SecureIPC] Encrypted subscription sent to browser');
        
      } else {
        // Fallback to plain JSON (compatibility mode)
        console.log('[SecureIPC] No encryption keys available, using plain JSON (compatibility mode)');
        
        const request = {
          type: 'subscribe_token_rotation',
          timestamp: Date.now()
        };
        
        this.client.write(JSON.stringify(request));
        console.log('[SecureIPC] Plain JSON subscription sent to browser');
      }
    } catch (error) {
      console.error(`[SecureIPC] Failed to subscribe to token rotation: ${error.message}`);
    }
  }
  
  startHeartbeat() {
    // Clear any existing heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Send periodic heartbeats to keep connection alive
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.client) {
        try {
          // The C++ side expects simple ping messages
          // Heartbeat is just to keep connection alive, not for token rotation
          console.log('[SecureIPC] Sending heartbeat ping to maintain connection');
        } catch (error) {
          console.error('[SecureIPC] Heartbeat failed:', error.message);
          this.handleConnectionLoss();
        }
      }
    }, 90000); // Ping every 90 seconds (less than C++ 2-minute timeout)
    
    console.log('[SecureIPC] Heartbeat monitor started (90-second interval)');
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('[SecureIPC] Heartbeat monitor stopped');
    }
  }
  
  handleConnectionLoss() {
    console.log('[SecureIPC] Connection loss detected, cleaning up...');
    this.connected = false;
    this.stopHeartbeat();
    
    if (this.client) {
      try {
        this.client.destroy();
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.client = null;
    }
    
    if (!this.reconnectTimer) {
      this.scheduleReconnect();
    }
  }
  
  onTokenRotation(callback) {
    this.tokenRotationCallback = callback;
  }
  
  disconnect() {
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    
    this.connected = false;
    console.log('[SecureIPC] Disconnected from secure IPC server');
  }
}

// Initialize secure IPC client if socket path is provided
let secureIPCClient = null;
if (SECURE_IPC_SOCKET) {
  secureIPCClient = new SecureIPCClient(SECURE_IPC_SOCKET);
  
  // Disable token rotation handling per configuration: do not rotate secure tokens
  secureIPCClient.onTokenRotation((browserInstanceId, newToken) => {
    console.log('[TokenRotation] Disabled: ignoring token rotation event');
    return; // no-op
    /*
    console.log(`[TokenRotation] STALENESS-4: Received new token for browser ${browserInstanceId}`);
    console.log(`[TokenRotation] STALENESS-4: Callback invoked at ${new Date().toISOString()}`);
    console.log(`[TokenRotation] STALENESS-4: New token length: ${newToken ? newToken.length : 'UNDEFINED'}`);
    
    // Update browser connection with new token
    const connectionInfo = browserConnections.get(browserInstanceId);
    if (connectionInfo) {
      console.log(`[TokenRotation] STALENESS-4: Found existing connection for ${browserInstanceId}`);
      console.log(`[TokenRotation] STALENESS-4: Current token age: ${connectionInfo.updated_at ? Math.round((new Date() - connectionInfo.updated_at)/1000) : Math.round((new Date() - connectionInfo.registered_at)/1000)}s`);
      
      const newCdpUrl = `http://localhost:${connectionInfo.port}?token=${newToken}`;
      
      browserConnections.set(browserInstanceId, {
        ...connectionInfo,
        token: newToken,
        cdp_url: newCdpUrl,
        updated_at: new Date(),
        expiry: null // no expiry tracking
      });
      
      console.log(`[TokenRotation] Updated connection for browser ${browserInstanceId}`);
      console.log(`[TokenRotation] STALENESS-4: Connection map now has ${browserConnections.size} entries`);
      console.log(`[TokenRotation] New CDP URL: [REDACTED]`);
    } else {
      console.warn(`[TokenRotation] No connection found for browser ${browserInstanceId}`);
      console.warn(`[TokenRotation] STALENESS-4: Available browsers in map:`, Array.from(browserConnections.keys()));
      
      // CRITICAL FIX: Create missing connection entry when receiving token rotation
      // This handles cases where the MCP server restarted or connection was cleaned up
      console.log(`[TokenRotation] CRITICAL FIX: Creating missing connection for browser ${browserInstanceId}`);
      
      // We can reconstruct the connection info from the token rotation message
      // The CDP port is typically 9222 for the main Chrome instance
      const reconstructedConnection = {
        port: 9222, // Standard Chrome CDP port
        token: newToken,
        expiry: null,
        cdp_url: newCdpUrl,
        registered_at: new Date(),
        updated_at: new Date(),
        mode: 'token_rotation_recovery',
        protocol_version: '1.0',
        capabilities: ['encrypted_communication']
      };
      
      browserConnections.set(browserInstanceId, reconstructedConnection);
      
      console.log(`[TokenRotation] RECOVERY: Added missing connection for browser ${browserInstanceId}`);
      console.log(`[TokenRotation] RECOVERY: Connection map now has ${browserConnections.size} entries`);
      console.log(`[TokenRotation] RECOVERY: Browser will be available for new tasks`);
    }
  */});
  
  // Connect to secure IPC server
  console.log('[SecureIPC] STALENESS-1: Initiating connection to secure IPC server');
  console.log('[SecureIPC] STALENESS-1: Token rotation callback registered:', typeof secureIPCClient.tokenRotationCallback === 'function');
  
  secureIPCClient.connect().then(() => {
    console.log('[SecureIPC] STALENESS-1: Initial connection successful');
    console.log('[SecureIPC] STALENESS-1: Connection status check - connected:', secureIPCClient.connected);
  }).catch(err => {
    console.warn(`[SecureIPC] Initial connection failed: ${err.message}`);
    console.warn('[SecureIPC] STALENESS-1: Initial connection failed - will retry automatically...');
    console.warn('[SecureIPC] STALENESS-1: Failed connection details:', {
      socketPath: secureIPCClient.socketPath,
      connected: secureIPCClient.connected,
      error: err.code
    });
  });
  
  // Add periodic connection status logging
  setInterval(() => {
    console.log(`[SecureIPC] STALENESS-1: Periodic status check at ${new Date().toISOString()}`);
    console.log(`[SecureIPC] STALENESS-1: Connected: ${secureIPCClient.connected}`);
    console.log(`[SecureIPC] STALENESS-1: Last connection: ${secureIPCClient.lastConnectionTime || 'never'}`);
    console.log(`[SecureIPC] STALENESS-1: Last token rotation: ${secureIPCClient.lastTokenRotationTime || 'never'}`);
    console.log(`[SecureIPC] STALENESS-1: Last error: ${secureIPCClient.lastError || 'none'}`);
    console.log(`[SecureIPC] STALENESS-1: Browser connections in map: ${browserConnections.size}`);
  }, 15000); // Every 15 seconds
}

// Global state
let browserAgents = new Map(); // Map of task ID to browser agent
let narratorEvents = [];
let taskIdCounter = 1;
let taskEventQueues = new Map(); // Map of task ID to TaskEventQueue
let browserConnections = new Map(); // Map of browser instance ID to connection info
// Track human intervention requests/resolutions per task
// let interventionsByTask = new Map(); // taskId -> { taskId, message, context, created_at, resolved, action, response_message }

// Metrics tracking
const metrics = {
  requests: {
    total: 0,
    byEndpoint: new Map(),
    byStatus: new Map()
  },
  tasks: {
    total: 0,
    successful: 0,
    failed: 0,
    average_duration_ms: 0
  },
  security: {
    unauthorized_attempts: 0,
    expired_tokens: 0,
    registered_browsers: 0
  },
  startTime: new Date()
};

// Per-task event queue management
class TaskEventQueue {
  constructor(taskId, ttl = 300000) { // 5 min TTL
    this.taskId = taskId;
    this.events = [];
    this.eventEmitter = new EventEmitter();
    this.lastEventId = 0;
    this.ttl = ttl;
    this.acknowledged = new Set();
    
    // Auto-cleanup old events
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - this.ttl;
      this.events = this.events.filter(e => {
        return e.timestamp > cutoff && !this.acknowledged.has(e.id);
      });
      // Clean acknowledged set too
      this.acknowledged = new Set(
        Array.from(this.acknowledged).filter(id => 
          this.events.some(e => e.id === id)
        )
      );
    }, 60000); // Clean every minute
  }
  
  addEvent(type, message) {
    const event = {
      id: ++this.lastEventId,
      type,
      message,
      timestamp: Date.now(),
      taskId: this.taskId
    };
    
    this.events.push(event);
    this.eventEmitter.emit('event', event);
    console.log(`[TaskQueue ${this.taskId}] Added event ${event.id}: ${type}`);
    return event.id;
  }
  
  acknowledge(eventId) {
    this.acknowledged.add(eventId);
    console.log(`[TaskQueue ${this.taskId}] Acknowledged event ${eventId}`);
  }
  
  getUnacknowledged() {
    return this.events.filter(e => !this.acknowledged.has(e.id));
  }
  
  destroy() {
    clearInterval(this.cleanupTimer);
    this.eventEmitter.removeAllListeners();
    console.log(`[TaskQueue ${this.taskId}] Destroyed`);
  }
}




// Helper function to get secure browser connection
async function getSecureBrowserConnection(browserInstanceId) {
  // If no browser instance specified, try to use any registered browser
  if (!browserInstanceId) {
    // Pick any registered browser (no expiry)
    for (const [id, info] of browserConnections) { browserInstanceId = id; break; }
  }
  
  if (!browserInstanceId) {
    throw new Error('No registered browser available. Please register a browser first.');
  }
  
  const connectionInfo = browserConnections.get(browserInstanceId);
  if (!connectionInfo) {
    throw new Error(`Browser instance ${browserInstanceId} not registered`);
  }
  
  // Disable expiry/staleness enforcement; assume connection is valid as long as it exists
  
  return connectionInfo;
}

// Wait for a registered secure browser connection to become available.
// This eliminates a race between server startup/registration and the first task.
async function waitForRegisteredConnection(browserInstanceId, maxWaitMs = 8000) {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const endTime = Date.now() + maxWaitMs;
  let lastError = null;

  while (Date.now() < endTime) {
    try {
      // Prefer the requested browser instance if provided
      const info = await getSecureBrowserConnection(browserInstanceId);
      return info;
    } catch (err) {
      lastError = err;
      // As a fallback, try any registered browser
      for (const [id, info] of browserConnections) { return info; }
      await sleep(250);
    }
  }

  // If we get here, no registration became available in time
  if (lastError) throw lastError;
  throw new Error('No registered browser available (timeout waiting for registration)');
}

// Helper function to create a new browser agent for each task
async function createBrowserAgentForTask(taskId, browserInstanceId = null, enhancedPrompt = '') {
  try {
    // Creating new browser agent for task
    
    let cdpUrl;
    
    // Parse CDP URL to check for token (auto-detect secure mode)
    const cdpUrlObj = new URL(FIXED_CDP_URL);
    const token = cdpUrlObj.searchParams.get('token');
    
    if (token) {
      // Token detected - use secure CDP mode
      console.log(`[Security] Token detected in CDP URL, using secure authentication`);
      console.log(`[Security] Fixed hostname issue: ${CDP_URL} -> ${FIXED_CDP_URL}`);
      // Resolve ws endpoint to avoid malformed http?token=/json/version concatenation
      cdpUrl = await resolveWsEndpoint(FIXED_CDP_URL);
      console.log(`[Security] Resolved WS endpoint for secure CDP: [REDACTED]`);
      
      // Connect via Playwright and reuse persistent browser context to avoid creating a new one
      const browser = await chromium.connectOverCDP(cdpUrl);
      let context = browser.contexts()[0];
      if (!context) {
        for (let i = 0; i < 10 && !context; i++) {
          await new Promise(r => setTimeout(r, 100));
          context = browser.contexts()[0];
        }
      }
      if (!context) {
        throw new Error('Persistent browser context not available over CDP');
      }
      console.log('[Security] Using persistent browser context over secure CDP');
      
      const browserAgent = await startBrowserAgent({
        browser: { context },
        llm: {
          provider: 'anthropic',
          options: {
            model: 'claude-sonnet-4-20250514',
            apiKey: getSecret('ANTHROPIC_API_KEY'),
            temperature: 0.2,
            promptCaching: true
          }
        },
        // Combine existing guidance with enhancedPrompt (if provided)
        prompt: [enhancedPrompt || '', buildAgentPrompt()].filter(Boolean).join('\n\n'),
        visuals: {
          showCursor: true,
          showHoverCircle: false,
          showClickRipple: false,
          showDragLine: false,
          showTypeEffects: false
        },
        narrate: true
      });
      // Browser agent created using persistent context
      // Attach task id for actions (e.g., request_intervention)
      browserAgent.taskId = taskId;
      return browserAgent;
    } else if (process.env.USE_SECURE_CDP === 'true') {
      // Secure mode requested: prefer the registered connection, with a short wait to avoid race
      console.log('[Security] Secure mode enabled - waiting for registered browser connection (up to 3s)');
      try {
        const connectionInfo = await waitForRegisteredConnection(browserInstanceId, 3000);
        const chosenId = browserInstanceId || [...browserConnections.keys()][0];
        console.log(`[Security] Using registered connection for browser ${chosenId} on port ${connectionInfo.port}`);
        // connectionInfo.cdp_url is HTTP with token; resolve to WS endpoint with token
        cdpUrl = await resolveWsEndpoint(connectionInfo.cdp_url);
        console.log('[Security] Resolved WS endpoint for secure CDP via registered connection');
        
        // Connect via Playwright and reuse persistent browser context
        const browser = await chromium.connectOverCDP(cdpUrl);
        let context = browser.contexts()[0];
        if (!context) {
          for (let i = 0; i < 10 && !context; i++) {
            await new Promise(r => setTimeout(r, 100));
            context = browser.contexts()[0];
          }
        }
        if (!context) {
          throw new Error('Persistent browser context not available over CDP');
        }
        console.log('[Security] Using persistent browser context over secure CDP (registered connection)');
        
        const browserAgent = await startBrowserAgent({
          browser: { context },
          llm: {
            provider: 'anthropic',
            options: {
              model: 'claude-sonnet-4-20250514',
              apiKey: getSecret('ANTHROPIC_API_KEY'),
              temperature: 0.2,
              promptCaching: true
            }
          },
          prompt: enhancedPrompt || undefined,
          visuals: {
            showCursor: false,
            showHoverCircle: false,
            showClickRipple: false,
            showDragLine: false,
            showTypeEffects: false
          },
          narrate: true
        });
        // Browser agent created using persistent context (registered)
        browserAgent.taskId = taskId;
        return browserAgent;
      } catch (error) {
        console.error(`[Security] Failed to obtain registered browser connection within timeout: ${error.message}`);
        throw new Error('Secure browser connection not yet available. Please retry momentarily.');
      }
    } else {
      // No token detected - use insecure connection
      if (browserInstanceId) {
        console.log(`[INFO] Ignoring browser_instance_id '${browserInstanceId}' in non-secure mode`);
      }
      console.log(`[WARNING] Using insecure CDP connection at ${FIXED_CDP_URL}`);
      cdpUrl = FIXED_CDP_URL;
    }
    
    // Starting browser agent with CDP URL
    
    // Let magnitude-core handle the connection internally by passing CDP URL
    // This ensures that magnitude-core uses our secure token instead of generating its own
    const browserAgent = await startBrowserAgent({
      browser: { 
        cdp: cdpUrl,  // Pass CDP URL directly to magnitude-core
        contextOptions: {
          viewport: { width: 1280, height: 720 }
        }
      },
      llm: {
        provider: 'anthropic',
        options: {
          model: 'claude-sonnet-4-20250514',
          apiKey: getSecret('ANTHROPIC_API_KEY'),
          temperature: 0.2,
          promptCaching: true
        }
      },
      prompt: enhancedPrompt || undefined,
      // Visual configuration - disable all effects, including cursor and keyboard overlay
      visuals: {
        showCursor: false,
        showHoverCircle: false,
        showClickRipple: false,
        showDragLine: false,
        showTypeEffects: false
      },
      // Enable narration for debugging
      narrate: true
    });
    
    // Browser agent created successfully
    
    // Track browser instance ID for connection pooling
    browserAgent.browserInstanceId = browserInstanceId;
    // // Attach task id for actions (e.g., request_intervention)
    // browserAgent.taskId = taskId;
    
    // Set up narrator event listeners for this agent
    if (browserAgent.browserAgentEvents) {
      browserAgent.browserAgentEvents.on('nav', async (url) => {
        // Navigation event (not logged to avoid clutter)
      });
      
      browserAgent.browserAgentEvents.on('extractStarted', (instructions) => {
        // Extract started (not logged to avoid clutter)
      });
      
      browserAgent.browserAgentEvents.on('extractDone', (instructions, data) => {
        // Extract completed (not logged to avoid clutter)
      });
      
      browserAgent.browserAgentEvents.on('action', (action) => {
        // Action event (not logged to avoid clutter)
      });
      // Note: thought listeners are now handled via emit interception above
    }
    
    // Note: thought listeners are now handled via emit interception above
    
    // Verify that the browser agent is focused on the correct tab
    try {
      const currentPage = browserAgent.page;
      if (currentPage) {
        const currentUrl = currentPage.url();
        const currentTitle = await currentPage.title();
        console.log(`🔍 FOCUS VERIFICATION: Agent ${taskId} active tab - URL: ${currentUrl}, Title: ${currentTitle}`);
      } else {
        console.log(`⚠️  FOCUS WARNING: Agent ${taskId} has no active page!`);
      }
    } catch (error) {
      console.log(`⚠️  FOCUS ERROR: Could not verify agent ${taskId} focus: ${error.message}`);
    }
    
    // Browser agent created with new tab
    // Track pages this agent has controlled to surface UI glows in the browser
    try {
      // Maintain a Set of URLs the agent touched
      const controlled = new Set();
      const recordUrl = (u) => {
        try {
          const url = (u || '').toString();
          if (!url || url === 'about:blank') return;
          controlled.add(url);
        } catch (_) {}
      };
      // Seed with the current page URL if available
      if (browserAgent && browserAgent.page && typeof browserAgent.page.url === 'function') {
        recordUrl(browserAgent.page.url());
      }
      // Listen to agent navigation events
      try {
        if (browserAgent && browserAgent.browserAgentEvents && typeof browserAgent.browserAgentEvents.on === 'function') {
          browserAgent.browserAgentEvents.on('nav', (url) => {
            recordUrl(url);
          });
        }
      } catch (_) {}
      // Best-effort: observe new pages in the context while the agent is running
      try {
        const ctx = browserAgent && browserAgent.page && typeof browserAgent.page.context === 'function' ? browserAgent.page.context() : null;
        if (ctx && typeof ctx.on === 'function') {
          ctx.on('page', (p) => {
            try {
              // Record when page finishes loading
              p.once('load', async () => {
                try { recordUrl(p.url()); } catch (_) {}
              });
            } catch (_) {}
          });
        }
      } catch (_) {}
      browserAgent.controlledUrls = controlled;
    } catch (_) {}
    return browserAgent;
  } catch (error) {
    console.error(`Failed to create browser agent for task ${taskId}:`, error);
    throw error;
  }
}

// Simplified helper function to add narrator events
function addNarratorEvent(type, message) {
  const event = {
    type,
    message,
    timestamp: new Date().toISOString()
  };
  narratorEvents.push(event);
  console.log(`[Narrator] ${type}: ${message}`);
  
  // Keep only last 100 events
  if (narratorEvents.length > 100) {
    narratorEvents = narratorEvents.slice(-100);
  }
  
  // Extract task ID from message and add to task-specific queue
  const taskIdMatch = message.match(/\[Task (\d+)\]/);
  if (taskIdMatch) {
    const taskId = parseInt(taskIdMatch[1]);
    const taskQueue = taskEventQueues.get(taskId);
    if (taskQueue) {
      // Don't double-add events that are already being added directly to the queue
      // Only add narrator-specific events here
      if (!['task_start', 'act', 'extract', 'check', 'navigate', 'task_complete', 'error', 'task_stopped'].includes(type)) {
        taskQueue.addEvent(type, message);
      }
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeTasks: browserAgents.size,
    cdpUrl: FIXED_CDP_URL,
    originalCdpUrl: CDP_URL,
    port: PORT
  });
});

// MCP health check endpoint (for C++ integration)
app.get('/mcp/health', (req, res) => {
  res.json({
    status: 'ok',
    activeTasks: browserAgents.size,
    cdpUrl: FIXED_CDP_URL,
    originalCdpUrl: CDP_URL
  });
});

// Automation-only endpoint (no LLM agent): automation/:service/:tool
// Example: POST /automation/linkedin/search_people_in_company { company_slug: "acme-inc" }
// NOTE: Register the generic runner BEFORE the :tool route so '/run' does not get captured by ':tool'.

// Generic tool runner with optional uploaded code execution
// POST /automation/:service/run
// Body: { tool_name: string, args?: object, code?: string (ESM), browser_instance_id?: string }
app.post('/automation/:service/run', async (req, res) => {
  const service = (req.params.service || '').toLowerCase();
  const { tool_name: raw_tool_name, args = {}, code, browser_instance_id } = req.body || {};

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey || apiKey !== getSecret('MCP_API_KEY')) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }

  if (!raw_tool_name) {
    return res.status(400).json({ error: 'tool_name is required' });
  }

  try {
    // Normalize tool name: strip redundant service_ prefix if present (e.g., linkedin_save_top_n_jobs → save_top_n_jobs)
    const tool_name = (() => {
      try {
        const s = String(service || '');
        const t = String(raw_tool_name || '');
        const pref = s + '_';
        return t.toLowerCase().startsWith(pref.toLowerCase()) ? t.slice(pref.length) : t;
      } catch (_) { return raw_tool_name; }
    })();

    console.log(`[Automation] REQUEST ${service}.run tool=${tool_name} raw_tool=${raw_tool_name} code=${!!code} argsKeys=[${Object.keys(args || {}).join(',')}] browser_instance_id=${browser_instance_id || ''}`);
    // Resolve a function to execute
    let fn = null;

    // First: handle inline uploaded code (requires a page)
    if (code && typeof code === 'string' && code.trim().length > 0) {
      const base64 = Buffer.from(code).toString('base64');
      const dataUrl = `data:text/javascript;base64,${base64}`;
      const mod = await import(dataUrl);
      fn = mod && mod[tool_name] ? mod[tool_name] : null;
      if (fn) {
        console.log(`[Automation] EXECUTE path=inline_code service=${service} tool=${tool_name}`);
        const { context } = await getPersistentContext(browser_instance_id);
        const page = await context.newPage();
        try {
          const result = await fn(page, ...Object.values(args || {}));
          return res.json({ ...(typeof result === 'undefined' ? { success: true } : { success: true, result }), meta: { execution_path: 'inline_code', service, tool_name } });
        } catch (toolErr) {
          return res.status(500).json({ success: false, error: toolErr?.message || String(toolErr) });
        }
      }
    }

    // Direct import of tools module (requires a page)
    try {
      const toolsPath = new URL(`./services/${service}_tools.js`, import.meta.url);
      const toolsMod = await import(toolsPath);
      fn = toolsMod && toolsMod[tool_name] ? toolsMod[tool_name] : null;
    } catch (_) {
      // ignore
    }

    if (!fn) {
      return res.status(404).json({ error: `Tool not found: ${service}/${tool_name}` });
    }

    const { context } = await getPersistentContext(browser_instance_id);
    const page = await context.newPage();
    try {
      console.log(`[Automation] EXECUTE path=dynamic_module service=${service} tool=${tool_name}`);
      const result = await fn(page, ...Object.values(args || {}));
      return res.json({ ...(typeof result === 'undefined' ? { success: true } : { success: true, result }), meta: { execution_path: 'dynamic_module', service, tool_name } });
    } catch (toolErr) {
      return res.status(500).json({ success: false, error: toolErr?.message || String(toolErr) });
    }
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

// Browser registration endpoint for secure CDP connections
// Enhanced browser registration with protocol negotiation
app.post('/register-browser', (req, res) => {
  const authHeader = req.headers.authorization;
  
  // Handle case where secrets haven't been initialized from AWS (beta users)
  let browserApiKey;
  try {
    browserApiKey = getSecret('BROWSER_API_KEY');
  } catch (error) {
    // If secrets not initialized, use default for registration validation
    browserApiKey = 'default-browser-key';
    console.log('[Security] Using default BROWSER_API_KEY for registration validation (secrets not initialized)');
  }
  
  // Extract protocol version from request
  const protocolVersion = req.headers['x-protocol-version'] || "1.0";
  const clientCapabilities = req.headers['x-capabilities'] ? 
    req.headers['x-capabilities'].split(',').map(c => c.trim()) : [];
  
  console.log(`[Protocol] Registration request - Version: ${protocolVersion}, Capabilities: [${clientCapabilities.join(', ')}]`);
  
  // For legacy compatibility, allow registration without authentication in degraded mode
  // This enables the key exchange flow for clients that fail initial registration
  let authenticationMode = 'secure';
  if (!authHeader || !authHeader.startsWith('Bearer ') || 
      authHeader.substring(7) !== browserApiKey) {
    
    // Check if this is a protocol negotiation request
    if (req.headers['x-protocol-negotiation'] === 'true') {
      console.log('[Protocol] Allowing unauthenticated registration for key exchange');
      authenticationMode = 'key_exchange_only';
    } else {
      return res.status(401).json({ 
        error: 'Invalid browser API key',
        protocol_version: PROTOCOL_VERSION,
        supported_capabilities: SUPPORTED_CAPABILITIES,
        hint: 'Try protocol negotiation mode for key exchange'
      });
    }
  }
  
  const { cdp_port, cdp_token, token_expiry, browser_instance_id, encryption_key, auth_key } = req.body;
  
  console.log(`[Security] Browser registration received - Mode: ${authenticationMode}`);
  
  if (!browser_instance_id) {
    return res.status(400).json({ error: 'Missing browser_instance_id' });
  }
  
  // For key exchange mode, only require browser instance ID
  if (authenticationMode === 'key_exchange_only') {
    // Generate temporary connection for key exchange
    const tempConnectionInfo = {
      browser_instance_id: browser_instance_id,
      registered_at: new Date(),
      mode: 'key_exchange_only',
      expires_at: new Date(Date.now() + 30000), // 30 second window
      key_exchange_pending: true
    };
    
    browserConnections.set(browser_instance_id, tempConnectionInfo);
    
    console.log(`[Protocol] Temporary registration for key exchange: ${browser_instance_id}`);
    return res.json({ 
      success: true, 
      message: 'Temporary registration for key exchange',
      browser_instance: browser_instance_id,
      mode: 'key_exchange_only',
      expires_in: 30,
      next_step: '/exchange-keys'
    });
  }
  
  // Full registration mode - require all fields
  if (!cdp_port || !cdp_token) {
    return res.status(400).json({ error: 'Missing required fields for full registration' });
  }
  
  // Validate encryption keys are provided for secure IPC
  if (!encryption_key || !auth_key) {
    return res.status(400).json({ error: 'Missing encryption keys for secure IPC' });
  }
  
  console.log(`[Security] Received encryption keys for browser ${browser_instance_id}`);
  console.log(`  Encryption key length: ${encryption_key.length}`);
  console.log(`  Auth key length: ${auth_key.length}`);
  
  // Validate encryption keys with enhanced validation
  const keyValidation = validateEncryptionKeys(encryption_key, auth_key);
  if (!keyValidation.valid) {
    console.error(`[Security] Key validation failed: ${keyValidation.error}`);
    
    // Determine if this is a protocol negotiation request
    const use_protocol_negotiation = (authenticationMode === 'key_exchange_only');
    
    // Offer key recovery if this is a retry attempt
    if (use_protocol_negotiation) {
      console.log(`[Security] Attempting key recovery for protocol negotiation`);
      const fallbackKeys = generateFallbackKeys();
      
      return res.status(400).json({
        error: 'Invalid encryption keys - key recovery offered',
        key_validation_error: keyValidation.error,
        recovery_option: {
          message: 'Server can provide fallback keys for this session',
          fallback_keys: fallbackKeys,
          warning: 'Fallback keys are temporary and should be replaced'
        }
      });
    }
    
    return res.status(400).json({ 
      error: 'Invalid encryption keys format',
      details: keyValidation.error
    });
  }
  
  const encryptionKeyBuffer = keyValidation.encBuffer;
  const authKeyBuffer = keyValidation.authBuffer;
  
  // Store browser connection info with encryption keys
  browserConnections.set(browser_instance_id, {
    port: cdp_port,
    token: cdp_token,
    expiry: null,
    cdp_url: `http://localhost:${cdp_port}?token=${cdp_token}`,
    registered_at: new Date(),
    updated_at: new Date(),  // Track token updates
    encryptionKey: encryptionKeyBuffer,  // AES-256-GCM key
    authKey: authKeyBuffer,               // HMAC-SHA256 key
    mode: 'full_registration',
    protocol_version: protocolVersion,
    capabilities: clientCapabilities
  });
  
  console.log(`[Security] Browser registered: ${browser_instance_id} on port ${cdp_port}`);
  metrics.security.registered_browsers++;
  
  // Configure SecureIPC client with encryption keys if available
  if (secureIPCClient && encryptionKeyBuffer && authKeyBuffer) {
    secureIPCClient.setEncryptionKeys(encryptionKeyBuffer, authKeyBuffer);
    console.log(`[Security] SecureIPC client configured with encryption keys for browser ${browser_instance_id}`);
  }
  
  res.json({ 
    success: true, 
    browser_instance: browser_instance_id,
    message: 'Browser registered successfully',
    protocol_version: PROTOCOL_VERSION,
    server_capabilities: SUPPORTED_CAPABILITIES 
  });
});

// Separate key exchange endpoint for protocol negotiation
app.post('/exchange-keys', (req, res) => {
  const { browser_instance_id, encryption_key, auth_key } = req.body;
  
  if (!browser_instance_id || !encryption_key || !auth_key) {
    return res.status(400).json({ 
      error: 'Missing required fields: browser_instance_id, encryption_key, auth_key' 
    });
  }
  
  // Check if there's a temporary registration for this browser
  const connectionInfo = browserConnections.get(browser_instance_id);
  if (!connectionInfo) {
    return res.status(404).json({ 
      error: 'Browser instance not found. Please register first with protocol negotiation mode.' 
    });
  }
  
  // Check if this is a key exchange only registration
  if (connectionInfo.mode !== 'key_exchange_only') {
    return res.status(400).json({ 
      error: 'Key exchange not allowed for this registration mode.' 
    });
  }
  
  // Do not enforce temporary registration expiry
  
  // Validate encryption keys with enhanced validation
  const keyValidation = validateEncryptionKeys(encryption_key, auth_key);
  if (!keyValidation.valid) {
    console.error(`[Protocol] Key validation failed for ${browser_instance_id}: ${keyValidation.error}`);
    
    // For key exchange, offer recovery with fallback keys
    console.log(`[Protocol] Offering key recovery for ${browser_instance_id}`);
    const fallbackKeys = generateFallbackKeys();
    
    // Update the temporary connection with fallback keys
    connectionInfo.fallback_keys_offered = true;
    connectionInfo.fallback_keys = fallbackKeys;
    browserConnections.set(browser_instance_id, connectionInfo);
    
    return res.status(400).json({
      error: 'Invalid encryption keys - key recovery available',
      key_validation_error: keyValidation.error,
      recovery_option: {
        message: 'Server has generated fallback keys for this session',
        fallback_keys: fallbackKeys,
        warning: 'These are temporary keys - consider regenerating client keys',
        next_step: 'Use fallback keys or regenerate client keys and retry'
      }
    });
  }
  
  const encryptionKeyBuffer = keyValidation.encBuffer;
  const authKeyBuffer = keyValidation.authBuffer;
  console.log(`[Protocol] Encryption keys validated for ${browser_instance_id}`);
  
  // Update connection info with encryption keys
  connectionInfo.encryptionKey = encryptionKeyBuffer;
  connectionInfo.authKey = authKeyBuffer;
  connectionInfo.key_exchange_pending = false;
  connectionInfo.key_exchange_completed_at = new Date();
  connectionInfo.mode = 'encryption_established';
  
  browserConnections.set(browser_instance_id, connectionInfo);
  
  // Configure SecureIPC client with encryption keys
  if (secureIPCClient) {
    secureIPCClient.setEncryptionKeys(encryptionKeyBuffer, authKeyBuffer);
    console.log(`[Protocol] SecureIPC client configured with encryption keys for ${browser_instance_id}`);
  }
  
  console.log(`[Protocol] Key exchange completed for ${browser_instance_id}`);
  
  res.json({ 
    success: true, 
    message: 'Encryption keys exchanged successfully',
    browser_instance: browser_instance_id,
    protocol_version: PROTOCOL_VERSION,
    encryption_status: 'established',
    next_step: 'Secure communication now available'
  });
});

// Connection validation endpoint to test encryption setup
app.post('/validate-connection', (req, res) => {
  const { browser_instance_id, test_message } = req.body;
  
  if (!browser_instance_id) {
    return res.status(400).json({ error: 'Missing browser_instance_id' });
  }
  
  const connectionInfo = browserConnections.get(browser_instance_id);
  if (!connectionInfo) {
    return res.status(404).json({ 
      error: 'Browser instance not found',
      browser_instance_id: browser_instance_id
    });
  }
  
  // Check if encryption keys are available
  if (!connectionInfo.encryptionKey || !connectionInfo.authKey) {
    return res.status(400).json({
      error: 'No encryption keys available for this browser instance',
      suggestion: 'Complete key exchange first'
    });
  }
  
  try {
    // Test encryption/decryption round trip
    const testData = test_message || 'connection_validation_test';
    const nonce = crypto.randomBytes(12);
    
    // Encrypt
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', connectionInfo.encryptionKey, iv);
    cipher.setAAD(Buffer.from('validation_test'));
    let encrypted = cipher.update(testData, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', connectionInfo.encryptionKey, iv);
    decipher.setAAD(Buffer.from('validation_test'));
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    if (decrypted !== testData) {
      throw new Error('Decryption validation failed');
    }
    
    console.log(`[Validation] Connection validation successful for ${browser_instance_id}`);
    
    res.json({
      success: true,
      message: 'Connection validation successful',
      browser_instance_id: browser_instance_id,
      test_result: {
        original_message: testData,
        encrypted_length: encrypted.length,
        decrypted_message: decrypted,
        validation_passed: true
      },
      encryption_status: 'operational'
    });
    
  } catch (error) {
    console.error(`[Validation] Connection validation failed for ${browser_instance_id}: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: 'Connection validation failed',
      details: error.message,
      browser_instance_id: browser_instance_id,
      suggestion: 'Key exchange may be required'
    });
  }
});

// Get registered browsers (for monitoring)
app.get('/registered-browsers', (req, res) => {
  const browsers = [];
  for (const [id, info] of browserConnections) {
    browsers.push({
      browser_instance: id,
      port: info.port,
      registered_at: info.registered_at,
      expires_at: null,
      is_expired: false
    });
  }
  res.json({ browsers });
});

// Token refresh endpoint (fallback when Secure IPC fails)
app.post('/refresh-token/:browserInstanceId', (req, res) => {
  const browserInstanceId = req.params.browserInstanceId;
  
  const connectionInfo = browserConnections.get(browserInstanceId);
  if (!connectionInfo) {
    return res.status(404).json({ 
      error: 'Browser instance not found',
      browser_instance_id: browserInstanceId 
    });
  }
  
  // Check if token is getting stale (older than 20 seconds)
  const now = new Date();
  const tokenAge = connectionInfo.updated_at ? 
    (now - connectionInfo.updated_at) : 
    (now - connectionInfo.registered_at);
  
  if (tokenAge < 20000) {
    return res.json({ 
      message: 'Token is still fresh',
      token_age_seconds: Math.round(tokenAge / 1000),
      refresh_needed: false
    });
  }
  
  // Return current token info and mark that refresh is needed
  res.json({
    message: 'Token refresh recommended',
    browser_instance_id: browserInstanceId,
    token_age_seconds: Math.round(tokenAge / 1000),
    refresh_needed: true,
    // Note: In a full implementation, this would trigger a fresh token request
    // For now, we recommend browser restart for fresh tokens
    recommendation: 'Consider browser restart if connection issues persist'
  });
});

// Disable expiry-based cleanup; keep connections until explicit unregister

// Unregister browser endpoint
app.post('/unregister-browser', (req, res) => {
  const authHeader = req.headers.authorization;
  const browserApiKey = getSecret('BROWSER_API_KEY');
  
  if (!authHeader || !authHeader.startsWith('Bearer ') || 
      authHeader.substring(7) !== browserApiKey) {
    return res.status(401).json({ error: 'Invalid browser API key' });
  }
  
  const { browser_instance_id } = req.body;
  
  if (!browser_instance_id) {
    return res.status(400).json({ error: 'Missing browser_instance_id' });
  }
  
  if (browserConnections.has(browser_instance_id)) {
    browserConnections.delete(browser_instance_id);
    console.log(`[Security] Browser unregistered: ${browser_instance_id}`);
    res.json({ 
      success: true, 
      message: 'Browser unregistered successfully'
    });
  } else {
    res.status(404).json({ 
      error: 'Browser instance not found',
      browser_instance: browser_instance_id
    });
  }
});

// Get narrator events (polling endpoint - kept for backward compatibility)
app.get('/mcp/events', (req, res) => {
  // Return a copy of events without removing them
  // This allows multiple clients to poll for events
  res.json({ events: [...narratorEvents] });
});

// Fixed SSE endpoint for real-time event streaming
app.get('/mcp/events/stream/:taskId', (req, res) => {
  const taskId = parseInt(req.params.taskId);
  console.log(`[SSE] Client connected for task ${taskId}`);
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // Send initial connection event (minimal)
  res.write(`data: ${JSON.stringify({ type: 'connected', message: '', taskId })}\n\n`);
  
  // Get task queue
  const taskQueue = taskEventQueues.get(taskId);
  if (!taskQueue) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Task not found' })}\n\n`);
    res.end();
    return;
  }
  
  // Send any unacknowledged events
  const unacknowledged = taskQueue.getUnacknowledged();
  console.log(`[SSE] Task ${taskId}: replaying ${unacknowledged.length} queued events on connect`);
  unacknowledged.forEach(event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  
  // Track last sent event to avoid duplicate consecutive thoughts, but with timestamp check
  let lastSent = { type: null, message: null, timestamp: 0 };
  
  // Event listener for new events
  const sendEvent = (event) => {
    // Debug logging for all events
    console.log(`[SSE] Attempting to send event: type=${event?.type}, message=${event?.message?.substring(0, 50)}...`);
    
    // Check if this is an action pattern event (starts with action symbols)
    const actionPatterns = ['⛓︎', '⊙', '📝', '✓', '🔍', '⏸', '📷'];
    const isActionPattern = event && event.type === 'thought' && event.message && 
                           actionPatterns.some(pattern => event.message.trim().startsWith(pattern));
    
    // Only suppress if it's the exact same thought within 100ms (true duplicate) AND not an action pattern
    const now = Date.now();
    if (!isActionPattern && 
        event && event.type === 'thought' &&
        lastSent.type === 'thought' && 
        lastSent.message === event.message &&
        (now - lastSent.timestamp) < 100) {
      console.log(`[SSE] Suppressing duplicate thought: ${event.message?.substring(0, 30)}...`);
      return; // suppress only rapid-fire duplicate thoughts
    }
    
    // Always send action patterns
    if (isActionPattern) {
      console.log(`[SSE] Sending action pattern event: ${event.message?.substring(0, 50)}...`);
    }
    
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    lastSent = { 
      type: event?.type || null, 
      message: event?.message || null,
      timestamp: now
    };
    console.log(`[SSE] Event sent successfully`);
  };
  
  // Subscribe to new events
  taskQueue.eventEmitter.on('event', sendEvent);
  
  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);
  
  // Cleanup on disconnect
  req.on('close', () => {
    console.log(`[SSE] Client disconnected for task ${taskId}`);
    clearInterval(heartbeat);
    taskQueue.eventEmitter.off('event', sendEvent);
  });
});

// Acknowledge events endpoint
app.post('/mcp/events/acknowledge/:taskId', express.json(), (req, res) => {
  const taskId = parseInt(req.params.taskId);
  const { eventIds } = req.body;
  
  const taskQueue = taskEventQueues.get(taskId);
  if (!taskQueue) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  
  if (Array.isArray(eventIds)) {
    eventIds.forEach(id => taskQueue.acknowledge(id));
  }
  
  res.json({ success: true, acknowledged: eventIds });
});

// Report the currently active agent page (URL + DevTools targetId) to enable glow
app.get('/mcp/agent/active', async (req, res) => {
  try {
    // Find the most recent task that still has an agent with a page
    let active = null;
    for (const [taskId, agent] of Array.from(browserAgents.entries()).reverse()) {
      if (!agent) continue;
      // Ignore agents that have completed, been stopped, or errored
      const status = (agent.status || '').toLowerCase();
      if (status === 'completed' || status === 'stopped' || status === 'error') {
        continue;
      }
      if (agent.page && typeof agent.page.url === 'function') {
        const url = agent.page.url();
        // Best-effort: target id may be available via playwright's CDP session
        let targetId = undefined;
        try {
          if (agent.page.context && agent.page.context()._browser && agent.page.context()._browser._connection) {
            // Avoid deep introspection; leave targetId undefined
          }
        } catch (_e) {}
        active = { url, targetId };
        break;
      }
    }
    // If no active running agent, explicitly return empty so the browser clears glow
    res.json(active || { url: '', targetId: '' });
  } catch (e) {
    res.json({ url: '', targetId: '' });
  }
});

// Fixed Execute endpoint with proper event handling
app.post('/mcp/execute', async (req, res) => {
  const { task, mode = 'act', url, data, schema, browser_instance_id, search_history, enhance_prompt } = req.body;
  const taskId = taskIdCounter++;

  // Create task event queue BEFORE responding so SSE can attach immediately without race
  const taskQueue = new TaskEventQueue(taskId);
  taskEventQueues.set(taskId, taskQueue);
  console.log(`[EnhancePrompt] Task ${taskId}: queue created (pre-response), size=${taskQueue.events.length}`);

  // Return immediately with task ID
  res.json({
    success: true,
    taskId,
    message: 'Task started in new tab'
  });

  // Execute task asynchronously
  (async () => {
    // Queue already created above; continue with diagnostics
    // Diagnostics: track last thought/action to aid error debugging
    let __lastThought = null;
    let __lastAction = null;
    
    // Define console restoration function at the top level
    const originalLog = console.log;
    let consoleRestored = false;
    const restoreConsole = () => {
      if (!consoleRestored) {
        console.log = originalLog;
        consoleRestored = true;
      }
    };
    
    try {
      // Optionally compute an enhanced prompt before starting the agent
      let enhancedPrompt = '';
      const doEnhance = (enhance_prompt !== false); // default true
      console.log(`[EnhancePrompt] Task ${taskId}: doEnhance=${doEnhance} history_present=${Array.isArray(search_history)} hist_count=${Array.isArray(search_history)?search_history.length:0}`);
      if (doEnhance) {
        try {
          // Derive a background-context search query from the user task
          const webQuery = await generateSearchQueryFromTask(task);
          try {
            // Emit an early planning status so UI can show pills before enhancement completes
            const safeQ = (webQuery || '').toString().replace(/\n/g, ' ').slice(0, 300);
            if (typeof safeQ === 'string') {
              taskQueue.addEvent('status', `planning_query:${safeQ}`);
            } else {
              taskQueue.addEvent('status', 'planning_query:');
            }
            // Also schedule the planning thought 1s later so it appears under the planning node
            setTimeout(() => {
              try {
                const safeTask = (task ?? '').toString();
                const planningThought = `The user wants me to perform \"${safeTask}\". I need to carefully plan out next steps to perform a thorough and personalized automation specific to our user.`;
                taskQueue.addEvent('thought', planningThought);
              } catch (_) {}
            }, 1000);
          } catch (_) {}
          const braveSources = await braveSearchTop(webQuery || task, { count: 12, timeoutMs: 3000 });
          try {
            // Emit top 12 deduped sources for planning UI (domain-deduped)
            const top = [];
            const seen = new Set();
            for (const s of Array.isArray(braveSources) ? braveSources : []) {
              try {
                const urlStr = (s && typeof s.url === 'string') ? s.url : '';
                if (!urlStr) continue;
                const u = new URL(urlStr);
                const domain = (u.hostname || '').replace(/^www\./, '');
                if (!domain || seen.has(domain)) continue;
                seen.add(domain);
                top.push({ url: urlStr, domain });
                if (top.length >= 12) break;
              } catch (_) {}
            }
            if (top.length) {
              try {
                // Fetch favicons via backend (data URIs) with small concurrency
                const withIcons = [];
                const maxConc = 4;
                let idx = 0;
                const worker = async () => {
                  while (idx < top.length) {
                    const i = idx++;
                    const entry = top[i];
                    const pageUrl = entry.url;
                    const dataUri = await fetchFaviconDataUri(pageUrl).catch(() => null);
                    if (dataUri && typeof dataUri === 'string' && dataUri.startsWith('data:')) {
                      withIcons[i] = { ...entry, favicon_url: dataUri };
                    } else {
                      withIcons[i] = { ...entry };
                    }
                  }
                };
                const runners = Array.from({ length: Math.min(maxConc, top.length) }, () => worker());
                await Promise.all(runners);
                taskQueue.addEvent('planning_sources', JSON.stringify(withIcons));
              } catch (_e) {
                taskQueue.addEvent('planning_sources', JSON.stringify(top));
              }
            }
          } catch (_) {}
          enhancedPrompt = await synthesizeEnhancedPrompt({ task, searchHistory: search_history, braveSources, webQuery });
          console.log(`[EnhancePrompt] Task ${taskId}: enhancedPrompt chars=${enhancedPrompt.length}`);
        } catch (e) {
          console.warn(`[EnhancePrompt] Task ${taskId}: enhancement failed: ${e && e.message ? e.message : String(e)}`);
          enhancedPrompt = '';
        }
      }

      // Schedule the planning thought 1s after planning node creation (post-planning_query)
      try {
        setTimeout(() => {
          try {
            const safeTask = (task ?? '').toString();
            const planningThought = `The user wants me to perform "${safeTask}". I need to carefully plan out next steps to perform a thorough and personalized automation specific to our user.`;
            taskQueue.addEvent('thought', planningThought);
          } catch (_) {}
        }, 1000);
      } catch (_) {}

      // Create a new browser agent for this task (opens new tab), passing enhanced prompt
      const browserAgent = await createBrowserAgentForTask(taskId, browser_instance_id, enhancedPrompt);
      browserAgents.set(taskId, browserAgent);
      
      // Detect an explicit "done" signal and immediately surface a task_complete node once
      let doneEventSent = false;
      const maybeEmitDoneEvent = (text) => {
        try {
          if (doneEventSent) return;
          const t = (text ?? '').toString().trim();
          if (/^✓\s*done$/i.test(t) || /^done$/i.test(t) || /task\s*completed/i.test(t)) {
            taskQueue.addEvent('task_complete', 'Task completed successfully');
            doneEventSent = true;
            // Mark agent as completed immediately so /mcp/agent/active stops reporting it
            try { if (browserAgent && typeof browserAgent === 'object') browserAgent.status = 'completed'; } catch (_) {}
            removeCursorFromAllPagesForAgent(browserAgent).catch(() => {});
          }
        } catch (_) {}
      };
      
      // Simplified thought capture - only capture thoughts from one event source to avoid duplicates
      // Check which event emitter exists and use only that one
      const eventSource = browserAgent.browserAgentEvents || browserAgent.events;
      
      // Track recent thoughts to prevent duplicates
      const recentThoughts = new Map();
      const THOUGHT_DEDUP_WINDOW = 500; // milliseconds
      
      if (eventSource) {
        eventSource.on('thought', (thought) => {
          const thoughtStr = String(thought);
          const now = Date.now();
          __lastThought = thoughtStr;
          
          // Check for duplicate thought within time window
          if (recentThoughts.has(thoughtStr)) {
            const lastTime = recentThoughts.get(thoughtStr);
            if (now - lastTime < THOUGHT_DEDUP_WINDOW) {
              console.log(`[Dedup] Skipping duplicate thought within ${THOUGHT_DEDUP_WINDOW}ms`);
              return;
            }
          }
          
          // Track this thought
          recentThoughts.set(thoughtStr, now);
          
          // Clean up old entries
          if (recentThoughts.size > 20) {
            const oldestAllowed = now - THOUGHT_DEDUP_WINDOW * 2;
            for (const [key, time] of recentThoughts) {
              if (time < oldestAllowed) {
                recentThoughts.delete(key);
              }
            }
          }
          
          // Just the thought directly, no task prefix
          taskQueue.addEvent('thought', thoughtStr);
          maybeEmitDoneEvent(thought);
        });
        
        if (browserAgent.browserAgentEvents) {
          browserAgent.browserAgentEvents.on('navigate', (url) => {
            if (typeof url === 'string') taskQueue.addEvent('navigate', url);
          });
          browserAgent.browserAgentEvents.on('action', (action) => {
            try {
              const name = (action && (action.name || action.type || action.id)) ? String(action.name || action.type || action.id) : '';
              if (name) taskQueue.addEvent('action', name);
              if (name) __lastAction = name;
            } catch (_) {}
          });
          // Detect explicit task:done action to surface completion immediately
          browserAgent.browserAgentEvents.on('action', (action) => {
            try {
              const name = (action && (action.name || action.type || action.id)) ? String(action.name || action.type || action.id) : '';
              if (name) __lastAction = name;
              if (!doneEventSent && name.toLowerCase() === 'task:done') {
                taskQueue.addEvent('task_complete', 'Task completed successfully');
                doneEventSent = true;
                // Mark agent as completed immediately so /mcp/agent/active stops reporting it
                try { if (browserAgent && typeof browserAgent === 'object') browserAgent.status = 'completed'; } catch (_) {}
                removeCursorFromAllPagesForAgent(browserAgent).catch(() => {});
              }
            } catch (_) {}
          });
        }
      }
      
      // Enhanced console.log override to capture both thoughts and action patterns
      const thoughtPatterns = [
        /I need to/i, /I will/i, /I should/i, /Let me/i, 
        /I can/i, /I'm /i, /Looking at/i, /Checking/i
      ];
      
      // Action pattern indicators (with optional leading whitespace)
      const actionPatterns = [
        { pattern: /^\s*⛓︎\s*/, type: 'navigate' },
        { pattern: /^\s*⊙\s*/, type: 'click' },
        { pattern: /^\s*📝\s*/, type: 'extract' },
        { pattern: /^\s*✓\s*/, type: 'check' },
        { pattern: /^\s*◴\s*/, type: 'wait' }
      ];
      
      // Track recent console thoughts to prevent duplicates from console.log
      const recentConsoleThoughts = new Map();
      const CONSOLE_DEDUP_WINDOW = 500; // milliseconds
      
      console.log = function(...args) {
        const text = args.join(' ');
        
        // Filter out debug messages and SSE messages
        const isDebugMessage = text.includes('[Task') || 
                              text.includes('💭') || 
                              text.includes('[SSE]') || 
                              text.includes('[DEBUG]') ||
                              text.includes('[Dedup]') ||
                              text.includes('[TokenFailure]') ||
                              text.includes('[TIMING]');
        
        // Check if this looks like a thought or action (not our own debug messages)
        if (text && !isDebugMessage) {
          const now = Date.now();
          
          // Check for duplicate from console within time window
          if (recentConsoleThoughts.has(text)) {
            const lastTime = recentConsoleThoughts.get(text);
            if (now - lastTime < CONSOLE_DEDUP_WINDOW) {
              // Skip duplicate - don't even log it
              return originalLog.apply(console, args);
            }
          }
          
          // Track this console thought
          recentConsoleThoughts.set(text, now);
          
          // Clean up old entries
          if (recentConsoleThoughts.size > 20) {
            const oldestAllowed = now - CONSOLE_DEDUP_WINDOW * 2;
            for (const [key, time] of recentConsoleThoughts) {
              if (time < oldestAllowed) {
                recentConsoleThoughts.delete(key);
              }
            }
          }
          
          // First check for action patterns (including those with leading whitespace)
          let isAction = false;
          for (const actionPattern of actionPatterns) {
            if (actionPattern.pattern.test(text)) {
              // This is an action indicator - add it as a thought so it reaches frontend
              originalLog(`[DEBUG] Detected action pattern: ${text.substring(0, 50)}`);
              taskQueue.addEvent('thought', text);
              isAction = true;
              break;
            }
          }
          
          // If not an action, check if it's a regular thought
          if (!isAction) {
            const isThought = thoughtPatterns.some(pattern => pattern.test(text));
            if (isThought) {
              // Just the thought directly, no task prefix
              taskQueue.addEvent('thought', text);
              __lastThought = text;
            }
          }
          
          // Also detect explicit done signal and surface completion node
          maybeEmitDoneEvent(text);
        }
        
        return originalLog.apply(console, args);
      };
      
      let result;
      
      // Navigate to URL if provided (but don't emit navigation events)
      if (url) {
        await browserAgent.nav(url);
      }
      
      // Execute based on mode (no action event messages)
      switch (mode) {
        case 'act':
          result = await browserAgent.act(task, { data, prompt: enhancedPrompt || undefined });
          break;
          
        case 'extract':
          const zSchema = schema ? createZodSchemaFromObject(schema) : z.any();
          result = await browserAgent.extract(task, zSchema);
          break;
          
        case 'verify':
        case 'check':
          // Runtime BrowserAgent does not implement check; return graceful error
          throw new Error('verify/check not supported in runtime agent');
          break;
          
        default:
          throw new Error(`Unknown mode: ${mode}`);
      }
      
      // Restore console
      restoreConsole();
      
      // Store the result for later retrieval
      if (!browserAgents.has(taskId)) {
        browserAgents.set(taskId, {});
      }
      const agentData = browserAgents.get(taskId);
      agentData.result = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      agentData.status = 'completed';
      // Mark the running agent (if present) as no longer active so /mcp/agent/active stops returning it
      try {
        const runningAgent = browserAgents.get(taskId);
        if (runningAgent && typeof runningAgent === 'object') {
          runningAgent.status = 'completed';
        }
      } catch (_) {}
      // Ensure a task_complete node is emitted if it wasn't already
      try {
        if (!doneEventSent) {
          taskQueue.addEvent('task_complete', 'Task completed successfully');
          doneEventSent = true;
        }
      } catch (_) {}
      // Request backend to summarize this task with objective and timeline
      try {
        const summaryPrompt = buildSummaryRequestMessage(task, taskQueue, 'completed');
        taskQueue.addEvent('summary_request', summaryPrompt);
      } catch (_) {}
      // Remove any cursor overlays from all pages now that the task is complete
      try {
        await removeCursorFromAllPagesForAgent(browserAgent);
      } catch (_) {}
      
    } catch (error) {
      // Restore console on error
      restoreConsole();
      
      // Check if this is a stop-related error
      if (error && typeof error.message === 'string' &&
          (error.message.includes('Target page, context or browser has been closed') ||
           error.message.includes('Target page has been closed') ||
           error.message.includes('Execution context was destroyed') ||
           error.message.includes('Protocol error') && error.message.includes('Target closed'))) {
        console.log(`Task ${taskId} stopped due to target closure (treating as stop)`);
        taskQueue.addEvent('task_stopped', 'Task stopped');
        
        // Store stopped status
        if (browserAgents.has(taskId)) {
          const agentData = browserAgents.get(taskId);
          agentData.status = 'stopped';
          agentData.message = 'Task stopped';
        }
        // Ensure cursor overlay is removed on stop
        try {
          const agentToClean = browserAgents.get(taskId);
          await removeCursorFromAllPagesForAgent(agentToClean);
        } catch (_) {}
      } else {
        console.error(`Error executing task ${taskId}:`, error);
        try {
          const lt = __lastThought ? __lastThought.replace(/\n/g, ' ').slice(0, 400) : '(none)';
          const la = __lastAction ? __lastAction.toString() : '(none)';
          console.error(`[Diagnostics] Task ${taskId} last thought: ${lt}`);
          console.error(`[Diagnostics] Task ${taskId} last action: ${la}`);
        } catch (_) {}
        taskQueue.addEvent('error', error.message);
        
        // Check if this is a token-related error
        if (error.message.includes('Unexpected status 500') || 
            error.message.includes('hard expiry')) {
          
          console.log(`[TokenFailure] Detected token-related error for task ${taskId}`);
          
          // In static-token mode, preserve registration; otherwise cleanup stale connections
          console.log('[TokenFailure] Static-token mode: preserving existing browser registrations (no rotation, no staleness cleanup)');
        }
        
        // Store error status
        if (browserAgents.has(taskId)) {
          const agentData = browserAgents.get(taskId);
          agentData.status = 'error';
          agentData.error = error.message;
        }
        // Best-effort: clean up cursor if present even on error
        try {
          const agentToClean = browserAgents.get(taskId);
          await removeCursorFromAllPagesForAgent(agentToClean);
        } catch (_) {}
      }
    }
  })();
});

// Clean up a specific task's browser agent
app.post('/mcp/cleanup/:taskId', async (req, res) => {
  const taskId = parseInt(req.params.taskId);
  
  // Clean up browser agent
  if (browserAgents.has(taskId)) {
    try {
      const agent = browserAgents.get(taskId);
      
      // Emit stop event first to signal agent should stop
      console.log(`■ [stop] agent stopped`);
      addNarratorEvent('task_stop', `[Task ${taskId}] Stopping task...`);
      
      // Mark agent as stopped to prevent /mcp/agent/active from reporting it
      try { if (agent && typeof agent === 'object') agent.status = 'stopped'; } catch (_) {}

      // Remove any cursor overlays from all pages before closing
      try {
        await removeCursorFromAllPagesForAgent(agent);
      } catch (_) {}
      
      // Do not summarize on stop; only summarize on successful completion
      
      // Try to stop gracefully if stop method exists (preferred); leave page/tab open for user
      if (agent && typeof agent.stop === 'function') {
        try { await agent.stop(); } catch (e) { console.log(`agent.stop() failed: ${e && e.message ? e.message : e}`); }
      } else if (agent && agent.page) {
        // Fallback: if no stop method, close the page to halt automation
        try { await agent.page.close(); } catch (_) { console.log(`Page already closed for task ${taskId}`); }
      }
      
      browserAgents.delete(taskId);
    } catch (error) {
      // This error is expected when browser is closed mid-action
      if (error.message && error.message.includes('Target page, context or browser has been closed')) {
        console.log(`Task ${taskId} browser was closed (expected during stop)`);
      } else {
        console.error(`Error stopping browser agent ${taskId}:`, error);
      }
    }
  }
  
  // Clean up event queue
  if (taskEventQueues.has(taskId)) {
    taskEventQueues.get(taskId).destroy();
    taskEventQueues.delete(taskId);
  }
  
  res.json({ success: true, message: `Task cleaned up` });
});

// List available tools (MCP standard endpoint)
app.get('/mcp/tools', (req, res) => {
  const tools = [
    {
      name: 'magnitude_act',
      description: 'Execute a high-level browser action using AI in a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Natural language description of the task to perform'
          },
          url: {
            type: 'string',
            description: 'Optional URL to navigate to before performing the task'
          },
          data: {
            type: 'object',
            description: 'Optional data to use in the task'
          }
        },
        required: ['task']
      }
    },
    {
      name: 'magnitude_extract',
      description: 'Extract structured data from the current page in a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: {
            type: 'string',
            description: 'What data to extract'
          },
          schema: {
            type: 'object',
            description: 'JSON schema for the extracted data'
          }
        },
        required: ['instructions']
      }
    },
    {
      name: 'magnitude_check',
      description: 'Check if a condition is met on the page in a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Description of what to check'
          }
        },
        required: ['description']
      }
    },
    // {
    //   name: 'magnitude_request_intervention',
    //   description: 'Ask the user to perform a required action (e.g., login or consent) and wait for their response',
    //   inputSchema: {
    //     type: 'object',
    //     properties: {
    //       message: {
    //         type: 'string',
    //         description: 'What you need the user to do'
    //       },
    //       context: {
    //         type: 'string',
    //         description: 'Optional additional context'
    //       },
    //       taskId: {
    //         type: 'number',
    //         description: 'Task identifier to associate the intervention with'
    //       }
    //     },
    //     required: ['message']
    //   }
    // }
  ];
  
  res.json({ tools });
});

// Helper function to create Zod schema from object
function createZodSchemaFromObject(schemaObj) {
  if (!schemaObj || !schemaObj.type) {
    return z.any();
  }
  
  if (schemaObj.type === 'array') {
    const itemSchema = createZodSchemaFromObject(schemaObj.items);
    return z.array(itemSchema);
  } else if (schemaObj.type === 'object') {
    const shape = {};
    for (const [key, value] of Object.entries(schemaObj.properties || {})) {
      shape[key] = createZodSchemaFromObject(value);
    }
    return z.object(shape);
  } else if (schemaObj.type === 'string') {
    return z.string();
  } else if (schemaObj.type === 'number') {
    return z.number();
  } else if (schemaObj.type === 'boolean') {
    return z.boolean();
  }
  
  return z.any();
}

// Remove visual cursor overlays from all pages in an agent's context
async function removeCursorFromAllPagesForAgent(agent) {
  try {
    if (!agent || !agent.page || typeof agent.page.context !== 'function') return;
    const context = agent.page.context();
    const pages = context && typeof context.pages === 'function' ? context.pages() : [];
    await Promise.all(pages.map(async (p) => {
      try {
        await p.evaluate(() => {
          const ids = ['action-visual-indicator', 'custom-cursor'];
          for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.remove();
          }
        });
      } catch (_) {
        // Ignore per-page errors (page may be closed or cross-origin)
      }
    }));
  } catch (e) {
    console.log(`[VisualCleanup] Failed to remove cursor overlays: ${e.message}`);
  }
}

// Obtain a persistent Playwright context over the existing CDP connection (no LLM agent)
async function getPersistentContext(browserInstanceId = null) {
  // Prefer secure CDP with token when available; otherwise use configured CDP URL
  let cdpUrl;
  const cdpUrlObj = new URL(FIXED_CDP_URL);
  const token = cdpUrlObj.searchParams.get('token');
  if (token) {
    cdpUrl = await resolveWsEndpoint(FIXED_CDP_URL);
  } else if (process.env.USE_SECURE_CDP === 'true') {
    const info = await waitForRegisteredConnection(browserInstanceId, 3000);
    cdpUrl = await resolveWsEndpoint(info.cdp_url);
  } else {
    cdpUrl = FIXED_CDP_URL;
  }
  const browser = await chromium.connectOverCDP(cdpUrl);
  let context = browser.contexts()[0];
  if (!context) {
    for (let i = 0; i < 10 && !context; i++) {
      await new Promise(r => setTimeout(r, 100));
      context = browser.contexts()[0];
    }
  }
  if (!context) throw new Error('Persistent Playwright context not available over CDP');
  return { browser, context };
}

// Playwright helper: Open LinkedIn company's People tab
async function open_company_people_tab(page, company_slug) {
  const slug = (company_slug || '').toString().trim();
  if (!slug) throw new Error('company_slug is required');
  await page.goto(`https://www.linkedin.com/company/${slug}`, { waitUntil: 'domcontentloaded' });
  const orgNav = page.getByRole('navigation', { name: "Organization's page navigation" });
  await orgNav.waitFor({ state: 'visible' });
  const peopleLink = orgNav.getByRole('link', { name: 'People' });
  await peopleLink.waitFor({ state: 'visible' });
  await peopleLink.click();
  const searchBox = page.getByRole('textbox', { name: 'Search employees by title, keyword or school' });
  await searchBox.waitFor({ state: 'visible' });
  const employeeItems = page.getByRole('listitem');
  await employeeItems.first().waitFor({ state: 'visible', timeout: 10000 });
  const count = await employeeItems.count();
  if (count === 0) {
    throw new Error('People tab rendered but no employee entries were found.');
  }
  return { count };
}



// Build a summarization request message for the backend, including objective and timeline
function buildSummaryRequestMessage(taskText, taskQueue, status = 'completed') {
  try {
    const events = Array.isArray(taskQueue?.events) ? taskQueue.events : [];
    // Keep last 40 events max to bound the prompt size
    const recent = events.slice(-40);
    // Build timeline lines with type tags; trim messages
    const lines = [];
    for (const ev of recent) {
      if (!ev || typeof ev.message !== 'string') continue;
      const type = ev.type || 'event';
      let msg = ev.message.trim();
      if (!msg) continue;
      if (msg.length > 300) msg = msg.slice(0, 297) + '…';
      lines.push(`[${type}] ${msg}`);
    }
    const statusLine = status === 'completed' ? 'completed' : 'stopped';
    const objective = (taskText || '').toString().trim();
    const timeline = lines.join('\n');
    const prompt = [
      'Please write a concise summary of the browser agent task outcome.',
      `Objective: ${objective || '(unspecified)'}`,
      `Task status: ${statusLine}`,
      '',
      'Focus on:',
      '- the current achieved state/result,',
      '- any key outcome the user should know.',
      '- if the task was a research task provide all the relevant information the user should know.',
      'Do NOT list step-by-step actions. Do NOT narrate clicks or navigation. Be direct about current state. These are actions you took.',
      '',
      'Timeline (for context):',
      timeline || '(no timeline available)'
    ].join('\n');
    return prompt;
  } catch (_e) {
    const objective = (taskText || '').toString().trim();
    return `Please summarize the outcome for: ${objective}. Focus on current state, not steps.`;
  }
}

// Start server with enhanced initialization
async function startServer() {
  try {
    // Hardcoded keys are already initialized - no additional setup needed
    console.log('🔑 Using hardcoded API keys - ready immediately');
    
    // Apply API key validation middleware AFTER secrets are initialized
    app.use(validateApiKey);
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`Enhanced Magnitude MCP Server (New Tab Mode) starting on port ${PORT}`);
      console.log(`CDP URL: ${CDP_URL}`);
      if (CDP_URL !== FIXED_CDP_URL) {
        console.log(`Fixed CDP URL: ${FIXED_CDP_URL} (hostname compatibility fix)`);
      }
      
      // Check API key status and determine source
      const anthropicKeyStatus = cachedSecrets.ANTHROPIC_API_KEY ? 'Yes' : 'No';
      console.log(`API Key loaded: ${anthropicKeyStatus}`);
      
      // Keys are always hardcoded now
      console.log(`Secrets source: Hardcoded keys`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
      console.log('\n✨ Each task will open in a new tab in your browser');
      console.log('\n🔑 Using hardcoded keys - system ready for immediate use');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Security monitoring endpoint
app.get('/mcp/security/status', (req, res) => {
  const now = new Date();
  const stats = {
    server_mode: process.env.USE_SECURE_CDP === 'true' ? 'secure' : 'development',
    security: {
      cdp_token_validation: process.env.USE_SECURE_CDP === 'true',
      api_key_required: true,
      browser_api_key_configured: !!getSecret('BROWSER_API_KEY'),
      mcp_api_key_configured: !!getSecret('MCP_API_KEY')
    },
    registered_browsers: browserConnections.size,
    active_tasks: browserAgents.size,
    connections: [],
    metrics: {
      unauthorized_attempts: metrics.security.unauthorized_attempts,
      expired_tokens: metrics.security.expired_tokens,
      registered_browsers_total: metrics.security.registered_browsers
    }
  };
  
  // Include basic connection info (no sensitive data)
  for (const [id, info] of browserConnections) {
    const expiresIn = Math.floor((info.expiry - now) / 60000);
    stats.connections.push({
      browser_instance: id,
      port: info.port,
      expires_in_minutes: expiresIn,
      is_expired: expiresIn <= 0,
      registered_at: info.registered_at
    });
  }
  
  res.json(stats);
});

// Metrics endpoint
app.get('/mcp/metrics', (req, res) => {
  const uptime = Math.floor((new Date() - metrics.startTime) / 1000);
  
  // Convert Maps to objects for JSON serialization
  const endpointStats = {};
  for (const [endpoint, count] of metrics.requests.byEndpoint) {
    endpointStats[endpoint] = count;
  }
  
  const statusStats = {};
  for (const [status, count] of metrics.requests.byStatus) {
    statusStats[status] = count;
  }
  
  res.json({
    uptime_seconds: uptime,
    requests: {
      total: metrics.requests.total,
      by_endpoint: endpointStats,
      by_status: statusStats,
      rate_per_minute: uptime > 0 ? (metrics.requests.total / uptime * 60).toFixed(2) : 0
    },
    tasks: {
      ...metrics.tasks,
      success_rate: metrics.tasks.total > 0 
        ? ((metrics.tasks.successful / metrics.tasks.total) * 100).toFixed(2) + '%'
        : 'N/A'
    },
    security: {
      ...metrics.security,
      registered_browsers: browserConnections.size
    },
    system: {
      memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      active_connections: browserConnections.size,
      active_tasks: browserAgents.size,
      pending_events: narratorEvents.length
    }
  });
});

// Report all tabs currently controlled by running agents
// Returns a union across tasks: { tabs: [{ url, taskId }] }
app.get('/mcp/agent/controlled-tabs', (req, res) => {
  try {
    const tabs = [];
    for (const [taskId, agent] of browserAgents) {
      try {
        const status = (agent && agent.status) ? String(agent.status).toLowerCase() : '';
        if (status === 'completed' || status === 'stopped' || status === 'error') {
          continue;
        }
        const set = agent && agent.controlledUrls ? agent.controlledUrls : null;
        if (set && typeof set.forEach === 'function') {
          set.forEach((url) => {
            try {
              if (url && url !== 'about:blank') {
                tabs.push({ url, taskId });
              }
            } catch (_) {}
          });
        }
        // Include current page URL best-effort
        if (agent && agent.page && typeof agent.page.url === 'function') {
          const u = agent.page.url();
          if (u && u !== 'about:blank') {
            tabs.push({ url: u, taskId });
          }
        }
      } catch (_) {}
    }
    // Deduplicate by URL
    const seen = new Set();
    const deduped = [];
    for (const t of tabs) {
      if (!t || !t.url) continue;
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      deduped.push(t);
    }
    res.json({ tabs: deduped });
  } catch (e) {
    res.json({ tabs: [] });
  }
});

// -------------------- Human Intervention Endpoints (disabled) --------------------
// app.post('/mcp/intervention/request', (req, res) => { ... });
// app.get('/mcp/intervention/pending', (req, res) => { ... });
// app.get('/mcp/intervention/status/:taskId', (req, res) => { ... });
// app.post('/mcp/intervention/respond/:taskId', (req, res) => { ... });

// Connection pooling - get least loaded browser
app.get('/mcp/browser/recommend', (req, res) => {
  let recommendedBrowser = null;
  let minTasks = Infinity;
  
  // Count tasks per browser
  const taskCounts = new Map();
  for (const [browserId, info] of browserConnections) { taskCounts.set(browserId, 0); }
  
  // Count active tasks per browser
  for (const [taskId, agent] of browserAgents) {
    const browserId = agent.browserInstanceId;
    if (browserId && taskCounts.has(browserId)) {
      taskCounts.set(browserId, taskCounts.get(browserId) + 1);
    }
  }
  
  // Find browser with least tasks
  for (const [browserId, count] of taskCounts) {
    if (count < minTasks) {
      minTasks = count;
      recommendedBrowser = browserId;
    }
  }
  
  if (recommendedBrowser) {
    res.json({
      browser_instance_id: recommendedBrowser,
      current_tasks: minTasks,
      connection_info: {
        port: browserConnections.get(recommendedBrowser).port,
        expires_at: null
      }
    });
  } else {
    res.status(404).json({
      error: 'No available browsers',
      message: 'Please register a browser first'
    });
  }
});

// Enhanced graceful shutdown with recovery
let isShuttingDown = false;
const shutdownTimeout = 5000; // 5 second timeout for graceful shutdown

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('Already shutting down, forcing exit...');
    process.exit(1);
  }
  
  isShuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  
  // Set a timeout to force exit if graceful shutdown takes too long
  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, shutdownTimeout);
  
  try {
    // Clean up connection cleanup interval
    cleanupExpiredConnections();
    
    // Disconnect secure IPC client
    if (secureIPCClient) {
      secureIPCClient.disconnect();
      console.log('Disconnected secure IPC client');
    }
    
    // Stop all browser agents
    const stopPromises = [];
    for (const [taskId, agent] of browserAgents) {
      stopPromises.push(
        agent.stop()
          .then(() => console.log(`Stopped agent for task ${taskId}`))
          .catch(error => console.error(`Error stopping agent ${taskId}:`, error))
      );
    }
    
    // Wait for all agents to stop with a timeout
    await Promise.race([
      Promise.all(stopPromises),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    
    // Clean up all event queues
    for (const [taskId, queue] of taskEventQueues) {
      queue.destroy();
      console.log(`Cleaned up event queue for task ${taskId}`);
    }
    
    clearTimeout(forceExitTimer);
    console.log('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

// Register signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle uncaught errors to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  metrics.errors.uncaught_exceptions++;
  
  // Don't exit on uncaught exceptions, try to recover
  // But log it for monitoring
  if (!isShuttingDown) {
    console.error('Server continuing despite uncaught exception');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  metrics.errors.unhandled_rejections++;
  
  // Don't exit on unhandled rejections, try to recover
  if (!isShuttingDown) {
    console.error('Server continuing despite unhandled rejection');
  }
});

// Heartbeat mechanism to detect stalled server
let lastHeartbeat = Date.now();
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastHeartbeat;
  
  if (elapsed > 60000) { // If no heartbeat for 60 seconds
    console.error('Server appears stalled, restarting...');
    gracefulShutdown('STALL');
  }
  
  lastHeartbeat = now;
  
  // Disable zombie cleanup: long-running agents are allowed
}, 10000); // Check every 10 seconds

// Clear heartbeat on shutdown
process.on('exit', () => {
  clearInterval(heartbeatInterval);
});