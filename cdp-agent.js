const core = require('./packages/magnitude-core/dist/index.cjs');
const { WorkflowRecorder, WorkflowPlayer } = core;
const path = require('node:path');
const fs = require('node:fs');

async function getWsUrl() {
  const res = await fetch('http://localhost:9222/json/version');
  if (!res.ok) throw new Error(`Failed to fetch CDP version: ${res.status}`);
  const v = await res.json();
  if (!v.webSocketDebuggerUrl) throw new Error('Missing webSocketDebuggerUrl from /json/version');
  return v.webSocketDebuggerUrl; // e.g., ws://localhost:9222/devtools/browser/...
}

(async () => {
  const ws = await getWsUrl();

  const agent = await core.startBrowserAgent({
    browser: {
      cdp: ws,
      contextOptions: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
      },
    },
    url: 'https://google.com',
    narrate: true,
    llm: {
      provider: 'anthropic',
      options: {
        model: 'claude-sonnet-4-20250514',
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    },
  });

  // Record the exact workflow for this act() run
  const recorder = new WorkflowRecorder({
    name: 'demo-workflow',
    startUrl: 'https://google.com',
    browser: { mode: 'cdp', cdpUrl: ws, contextOptions: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } },
    virtualScreenDimensions: { width: 1024, height: 768 },
  });

  // Subscribe to harness steps
  const harness = agent.require(core.BrowserConnector).getHarness();
  const onStep = (step) => recorder.record(step);
  harness.events.on('stepRecorded', onStep);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('Warning: ANTHROPIC_API_KEY is not set; act() will fail to plan actions.');
  }

  try {
    await agent.act('Write down one S25 batch YC company name to a Google Sheets file.');
  } finally {
    // Workflow is only useful after a successful run; if planning failed, we still save but skip enrichment.
    const saved = await recorder.save(path.resolve(__dirname, 'workflows'));
    console.log('Saved workflow to:', saved);
    harness.events.off('stepRecorded', onStep);

    // Save agent memory for post-run enrichment context (thoughts)
    try {
      const mem = await agent.memory.toJSON();
      const memPath = saved.replace(/\.workflow\.json$/, '.memory.json');
      fs.writeFileSync(memPath, JSON.stringify(mem, null, 2), 'utf8');
      console.log('Saved memory to:', memPath);
    } catch (e) {
      console.warn('[post] could not save memory:', e.message);
    }
    await agent.stop();

    // // Kick off post-run enrichment pipeline (prepare prompts only). Downstream Sonnet + merge can be run separately.
    // try {
    //   const { spawnSync } = require('node:child_process');
    //   const taskDesc = 'find the cheapest headphones on Amazon';
    //   console.log('[post] preparing enrichment prompts...');
    //   const prep = spawnSync('node', [path.resolve(__dirname, 'prepare-enrichment.cjs'), saved, taskDesc], { stdio: 'inherit' });
    //   if (prep.status !== 0) {
    //     console.warn('[post] prepare-enrichment failed, you can rerun it manually later');
    //   } else {
    //     console.log('[post] enrichment prompts prepared');
    //   }
    // } catch (e) {
    //   console.warn('[post] enrichment preparation skipped:', e.message);
    // }
  }
})();
