const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const core = require('./packages/magnitude-core/dist/index.cjs');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function resolveWsFromMetadata(meta) {
  const cdp = meta?.browser?.cdpUrl;
  if (!cdp) return null;
  try {
    const u = new URL(cdp);
    const host = u.host; // e.g. localhost:9222
    const version = await fetchJson(`http://${host}/json/version`);
    return version.webSocketDebuggerUrl || cdp;
  } catch {
    return cdp;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args[0];
  let varsPath = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--vars' && args[i+1]) { varsPath = args[i+1]; i++; }
  }
  if (!fileArg) {
    console.error('Usage: node replay-workflow.cjs <path-to-workflow.json>');
    process.exit(1);
  }
  const filePath = path.resolve(fileArg);
  const workflow = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const meta = workflow.metadata || {};
  const ws = await resolveWsFromMetadata(meta);

  const provider = core.BrowserProvider.getInstance();
  console.log('[enrich] connecting to CDP and creating context...');
  let context;
  if (ws) {
    context = await provider.newContext({ cdp: ws, contextOptions: meta.browser?.contextOptions || {} });
  } else if (meta.browser?.launchOptions || meta.browser?.contextOptions) {
    context = await provider.newContext({ launchOptions: meta.browser.launchOptions || {}, contextOptions: meta.browser.contextOptions || {} });
  } else {
    context = await provider.newContext({});
  }

  const harness = new core.WebHarness(context, {
    virtualScreenDimensions: meta.virtualScreenDimensions || undefined,
  });
  console.log('[enrich] starting harness...');
  await harness.start();

  const { WorkflowPlayer } = core;
  const player = new WorkflowPlayer(harness);
  console.log('[enrich] starting replay...');
  let varsObj = undefined;
  if (varsPath) {
    try { varsObj = JSON.parse(fs.readFileSync(path.resolve(varsPath), 'utf8')); } catch {}
    console.log('[enrich] variables:', varsObj ? Object.keys(varsObj) : 'none');
  }
  await player.play(workflow, { variables: varsObj });
  console.log('[enrich] stopping harness...');
  await harness.stop();
  console.log('[enrich] closing context...');
  await context.close();
  console.log('[enrich] done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


