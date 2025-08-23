#!/usr/bin/env node
// Auto-generate generalizations (mirrors exploration for coordinates) and replay
// Usage:
//   node autogen-replay.cjs <workflow.json> [paramName] [paramValue]
// Example:
//   node autogen-replay.cjs workflows/demo-workflow-123.workflow.json sortOption "Price: High to Low"

const path = require('node:path');
const fs = require('node:fs');
const core = require('./packages/magnitude-core/dist/index.cjs');

async function getWsUrl() {
  const res = await fetch('http://localhost:9222/json/version');
  if (!res.ok) throw new Error(`Failed to fetch CDP version: ${res.status}`);
  const v = await res.json();
  if (!v.webSocketDebuggerUrl) throw new Error('Missing webSocketDebuggerUrl from /json/version');
  return v.webSocketDebuggerUrl;
}

async function main() {
  const wfPath = process.argv[2];
  const varName = process.argv[3];
  const varValue = process.argv[4];
  if (!wfPath) {
    console.error('Usage: node autogen-replay.cjs <workflow.json> [paramName] [paramValue]');
    process.exit(1);
  }

  const absWf = path.resolve(wfPath);
  const ws = await getWsUrl();

  const agent = await core.startBrowserAgent({
    browser: {
      cdp: ws,
      contextOptions: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
      },
    },
    narrate: true,
    llm: {
      provider: 'anthropic',
      options: {
        model: 'claude-sonnet-4-20250514',
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    },
  });

  try {
    const wf = JSON.parse(fs.readFileSync(absWf, 'utf8'));
    const memPath = absWf.replace(/\.workflow\.json$/, '.memory.json');
    if (fs.existsSync(memPath)) {
      const memJson = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      await agent.memory.loadJSON(memJson);
    }

    const harness = agent.require(core.BrowserConnector).getHarness();
    const player = new core.WorkflowPlayer(harness);

    const variables = (varName && varValue) ? { [varName]: varValue } : undefined;
    await player.play(wf, { autoGeneralize: true, agentForGeneralize: agent, variables });

    // If generalizations were attached, persist a copy
    if (wf && wf.generalizations) {
      const out = absWf.replace(/\.workflow\.json$/, '.generalized.workflow.json');
      fs.writeFileSync(out, JSON.stringify(wf, null, 2), 'utf8');
      console.log('[autogen] wrote generalized workflow to:', out);
      const vars = wf.variables ? wf.variables.map(v => v.name) : Object.values(wf.generalizations || {}).map((g) => g?.control?.variable?.name).filter(Boolean);
      if (vars && vars.length) console.log('[autogen] available variables:', vars.join(', '));
    }
  } finally {
    await agent.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });


