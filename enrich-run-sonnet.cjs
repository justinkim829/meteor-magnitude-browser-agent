#!/usr/bin/env node
/*
 Runs Sonnet 4 on prepared prompts to produce per-step generalizations.
 Usage:
   node enrich-run-sonnet.cjs <promptsDir> [--concurrency 3]
 Example:
   node enrich-run-sonnet.cjs \
     "/Users/.../workflows/prompts/demo-workflow-123456789" --concurrency 3
 Requires:
   ANTHROPIC_API_KEY in environment.
*/
const fs = require('node:fs');
const path = require('node:path');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { promptsDir: undefined, concurrency: 2 };
  if (!args[0]) {
    console.error('Usage: node enrich-run-sonnet.cjs <promptsDir> [--concurrency N]');
    process.exit(1);
  }
  out.promptsDir = path.resolve(args[0]);
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--concurrency' && args[i+1]) {
      out.concurrency = parseInt(args[i+1], 10) || 2;
      i++;
    }
  }
  return out;
}

function listPromptFiles(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-prompt.json'));
  const byStep = new Map();
  for (const f of files) {
    const m = f.match(/step-(\d{3})(-post)?-prompt\.json$/);
    if (!m) continue;
    const step = m[1];
    const isPost = !!m[2];
    const prev = byStep.get(step);
    if (!prev || isPost) byStep.set(step, f);
  }
  const picked = Array.from(byStep.values());
  picked.sort();
  return picked.map(f => path.join(dir, f));
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function toBase64(pathOrNull) {
  if (!pathOrNull) return null;
  const buf = fs.readFileSync(pathOrNull);
  return buf.toString('base64');
}

async function callSonnet(promptJson) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const systemText = Array.isArray(promptJson.instructions?.system)
    ? promptJson.instructions.system.join('\n')
    : '';
  const userText = Array.isArray(promptJson.instructions?.user)
    ? promptJson.instructions.user.join('\n')
    : '';

  const imageB64 = toBase64(promptJson.imagePath);
  const cropB64 = toBase64(promptJson.cropPath);

  const content = [];
  const thoughtContext = Array.isArray(promptJson.instructions?.user)
    ? promptJson.instructions.user.find(s => s && s.startsWith('Thought context near this step')) || ''
    : '';
  if (userText) content.push({ type: 'text', text: userText + `\n\nContext:\nTask: ${promptJson.taskDescription}\nURL: ${promptJson.pageUrlHint}\nStep: ${promptJson.stepIndex}\nRecordedStep: ${JSON.stringify(promptJson.recordedStep)}\nHintPoint: ${JSON.stringify(promptJson.hintPoint || null)}\n${thoughtContext}` });
  if (cropB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: cropB64 } });
  if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } });

  const body = {
    model: MODEL,
    max_tokens: 1000,
    system: systemText,
    messages: [{ role: 'user', content }],
    // We rely on system instruction to return JSON only
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  // Extract text content
  const blocks = json?.content || [];
  const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n').trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    // Try to strip code fences
    const m = text.match(/\{[\s\S]*\}$/);
    parsed = m ? JSON.parse(m[0]) : { gate: false, _raw: text };
  }
  return { raw: json, text, parsed };
}

async function callSonnetNameTypeVariable(promptJson) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  const system = [
    'You will name a string variable for an imminent text input action seen in the screenshot. ',
    'Return JSON only with a variable name and description suitable for an API parameter. '
  ].join('');
  const user = `Task: ${promptJson.taskDescription}\nURL: ${promptJson.pageUrlHint}\nStep: ${promptJson.stepIndex}\nNext action: ${JSON.stringify(promptJson.recordedStep)}\nHintPoint: ${JSON.stringify(promptJson.hintPoint||null)}\n`;
  const thoughtContext = Array.isArray(promptJson.instructions?.user)
    ? promptJson.instructions.user.find(s => s && s.startsWith('Thought context near this step')) || ''
    : '';
  const content = [
    { type: 'text', text: user + '\n' + thoughtContext + '\nReturn schema: { "variable": { "name": string, "description": string }, "defaultStringValue": string }' }
  ];
  const imageB64 = toBase64(promptJson.imagePath);
  if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } });
  const body = { model: MODEL, max_tokens: 400, system, messages: [{ role: 'user', content }] };
  const res = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic HTTP ${res.status}: ${t}`); }
  const json = await res.json();
  const blocks = json?.content || [];
  const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n').trim();
  let parsed; try { parsed = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}$/); parsed = m ? JSON.parse(m[0]) : null; }
  return parsed || null;
}

async function run() {
  const { promptsDir, concurrency } = parseArgs();
  console.log('[sonnet] prompts dir:', promptsDir, 'concurrency:', concurrency);
  const promptFiles = listPromptFiles(promptsDir);
  if (promptFiles.length === 0) {
    console.log('[sonnet] no prompt files found');
    return;
  }

  // Output dir for results
  const outDir = promptsDir; // same folder

  let idx = 0;
  let active = 0;
  let errors = 0;
  const results = [];

  async function worker() {
    while (true) {
      let myIndex;
      if (idx >= promptFiles.length) return;
      myIndex = idx++;
      const p = promptFiles[myIndex];
      const base = path.basename(p).replace('-prompt.json', '');
      const outPath = path.join(outDir, `${base}-result.json`);
      try {
        console.log(`[sonnet] processing ${base}`);
        const prompt = readJson(p);
        const { parsed } = await callSonnet(prompt);
        let payload = { ok: true, gate: !!parsed.gate, control: parsed.control || null };
        // Fallback: if this is a type action and gating failed, name a string variable
        if ((!payload.gate || !payload.control) && prompt?.recordedStep?.kind === 'type') {
          const named = await callSonnetNameTypeVariable(prompt);
          const varName = named && named.variable && named.variable.name ? named.variable.name : `type-step-${String(prompt.stepIndex).padStart(3,'0')}`;
          const varDesc = named && named.variable && named.variable.description ? named.variable.description : '';
          const defaultStr = (named && named.defaultStringValue) || (prompt.recordedStep.content || '');
          payload = {
            ok: true,
            gate: true,
            control: {
              anchorDescriptor: '',
              variable: { name: varName, kind: 'string', description: varDesc, defaultStringValue: defaultStr },
              options: [],
              defaultOptionId: null,
              imageSize: prompt.imageInfo || null,
              confidence: 1.0
            }
          };
        }
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
        results.push({ file: base, gate: payload.gate, options: payload.control?.options?.length || 0 });
      } catch (e) {
        errors++;
        fs.writeFileSync(outPath, JSON.stringify({ ok: false, error: String(e) }, null, 2), 'utf8');
        console.warn(`[sonnet] error on ${base}:`, e.message);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  console.log('[sonnet] done. results:', results.length, 'errors:', errors);
}

run().catch(e => { console.error(e); process.exit(1); });


