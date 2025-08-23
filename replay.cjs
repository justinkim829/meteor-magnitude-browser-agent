#!/usr/bin/env node
// Exact workflow replay (no generalization)
// Usage: node replay.cjs <workflow.json>

const core = require('./packages/magnitude-core/dist/index.cjs');
const fs = require('node:fs');

async function getWsUrl() {
  const res = await fetch('http://localhost:9222/json/version');
  if (!res.ok) throw new Error(`Failed to fetch CDP version: ${res.status}`);
  const v = await res.json();
  if (!v.webSocketDebuggerUrl) throw new Error('Missing webSocketDebuggerUrl');
  return v.webSocketDebuggerUrl;
}

(async () => {
  const wfPath = process.argv[2];
  if (!wfPath) {
    console.error('Usage: node replay.cjs <workflow.json>');
    process.exit(1);
  }

  const ws = await getWsUrl();
  const agent = await core.startBrowserAgent({
    browser: { cdp: ws, contextOptions: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } },
    narrate: true,
    llm: { provider: 'anthropic', options: { model: 'claude-sonnet-4-20250514', apiKey: process.env.ANTHROPIC_API_KEY } }
  });

  try {
    const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    const harness = agent.require(core.BrowserConnector).getHarness();
    const player = new core.WorkflowPlayer(harness);
    await player.play(wf, { autoGeneralize: false });
  } finally {
    await agent.stop();
  }
})().catch(e => { console.error(e); process.exit(1); });


