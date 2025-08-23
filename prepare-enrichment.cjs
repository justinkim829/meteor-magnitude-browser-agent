const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const core = require('./packages/magnitude-core/dist/index.cjs');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function getViewportFromMeta(meta) {
  const vp = meta.browser?.contextOptions && meta.browser.contextOptions.viewport;
  if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') return { width: vp.width, height: vp.height };
  return undefined;
}

function getDprFromMeta(meta) {
  const dpr = meta.browser?.contextOptions && meta.browser.contextOptions.deviceScaleFactor;
  if (typeof dpr === 'number') return dpr;
  return undefined;
}

async function applyEmulationToPage(harness, viewport, deviceScaleFactor) {
  if (!viewport && typeof deviceScaleFactor !== 'number') return;
  const page = harness.page;
  if (!page) return;
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport?.width ?? 0,
      height: viewport?.height ?? 0,
      deviceScaleFactor: deviceScaleFactor ?? 0,
      mobile: false,
      screenWidth: viewport?.width ?? 0,
      screenHeight: viewport?.height ?? 0,
      positionX: 0,
      positionY: 0,
      screenOrientation: { angle: 0, type: 'portraitPrimary' }
    });
  } catch {}
}

function transformFromVirtual(x, y, virtual, viewport) {
  if (!virtual) return { x, y };
  return {
    x: x * (viewport.width / virtual.width),
    y: y * (viewport.height / virtual.height),
  };
}

async function main() {
  const fileArg = process.argv[2];
  const taskArg = process.argv.slice(3).join(' ') || '';
  if (!fileArg) {
    console.error('Usage: node prepare-enrichment.cjs <workflow.json> [task description]');
    process.exit(1);
  }

  const workflowPath = path.resolve(fileArg);
  console.log('[enrich] loading workflow:', workflowPath);
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const meta = workflow.metadata || {};
  // Load memory (thought process) if available
  let memory = null;
  try {
    const memPath = workflowPath.replace(/\.workflow\.json$/, '.memory.json');
    if (fs.existsSync(memPath)) {
      memory = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      console.log('[enrich] loaded memory');
    }
  } catch {}

  // CDP attach
  const version = await fetchJson('http://localhost:9222/json/version');
  const ws = version.webSocketDebuggerUrl;

  const provider = core.BrowserProvider.getInstance();
  console.log('[enrich] connecting to CDP and creating context...');
  const context = await provider.newContext({ cdp: ws, contextOptions: meta.browser?.contextOptions || {} });
  const harness = new core.WebHarness(context, { virtualScreenDimensions: meta.virtualScreenDimensions || undefined });
  console.log('[enrich] starting harness...');
  await harness.start();

  // Enforce emulation to match recording
  const vpMeta = getViewportFromMeta(meta);
  const dprMeta = getDprFromMeta(meta);
  console.log('[enrich] applying emulation...');
  await applyEmulationToPage(harness, vpMeta, dprMeta);
  harness.events.on('activePageChanged', async () => { await applyEmulationToPage(harness, vpMeta, dprMeta); });

  const outDir = path.join(path.dirname(workflowPath), 'prompts', path.basename(workflowPath, '.workflow.json'));
  ensureDir(outDir);

  const steps = workflow.steps || [];
  const firstIsNav = steps[0]?.kind === 'navigate';
  if (meta.startUrl && !firstIsNav) {
    console.log(`[enrich] navigating to startUrl: ${meta.startUrl}`);
    await harness.navigate(meta.startUrl);
  }

  // Helper to robustly capture a screenshot; if target crashed, open a fresh page and navigate
  async function safeScreenshot(preferredUrl) {
    try {
      return await harness.screenshot();
    } catch (e) {
      // Try to recover by opening a new page and navigating
      try {
        await harness.context.newPage();
        if (preferredUrl) {
          await harness.navigate(preferredUrl);
        }
        return await harness.screenshot();
      } catch (e2) {
        throw e2;
      }
    }
  }

  // For each step, capture pre-step screenshot and emit a prompt JSON
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const prev = steps[i - 1];

    // Pre-step screenshot (skip if first step is navigate and no startUrl)
    let img;
    if (i === 0 && step.kind === 'navigate' && !meta.startUrl) {
      // No meaningful pre-screen; skip capture
    } else {
      console.log(`[enrich] capturing pre-step screenshot for step ${i} (${step.kind})`);
      const preferred = (i === 0 && meta.startUrl) ? meta.startUrl : undefined;
      img = await safeScreenshot(preferred);
    }
    const imgPath = path.join(outDir, `step-${String(i).padStart(3, '0')}.png`);
    if (img) {
      const b64 = await img.toBase64();
      fs.writeFileSync(imgPath, Buffer.from(b64.split(',')[1] || b64, 'base64'));
    }

    // Prepare prompt payload (gating + extraction combined)
    // Derive hint point (for type, fall back to previous click)
    const hintPoint = step.kind === 'click' ? { x: step.x, y: step.y } : (step.kind === 'type' && prev && prev.kind === 'click' ? { x: prev.x, y: prev.y } : null);

    // Optionally create a crop centered at hintPoint
    let cropPath = null;
    if (img && hintPoint && imgPath) {
      try {
        const sharp = require('sharp');
        const { width, height } = await img.getDimensions();
        const cw = Math.min(480, width);
        const ch = Math.min(320, height);
        const left = Math.max(0, Math.min(Math.round(hintPoint.x - cw / 2), width - cw));
        const top = Math.max(0, Math.min(Math.round(hintPoint.y - ch / 2), height - ch));
        cropPath = path.join(outDir, `step-${String(i).padStart(3,'0')}-crop.png`);
        await sharp(imgPath).extract({ left, top, width: cw, height: ch }).toFile(cropPath);
      } catch {}
    }

    const prompt = {
      taskDescription: taskArg,
      pageUrlHint: harness.page.url(),
      stepIndex: i,
      recordedStep: step,
      hintPoint,
      imagePath: img ? imgPath : null,
      imageInfo: img && (await img.getDimensions ? await img.getDimensions() : undefined),
      cropPath,
      instructions: {
        system: [
          'Find a single, task-relevant control near hintPoint (dropdown/list, tabs, segmented, radio, chips).',
          'If visible alternatives are present, gate=true and enumerate only those options in that control.',
          'For type actions, gate=true and return a string variable (name it from the field label/placeholder).',
          'Coordinates: clickPoint in pixel space of imageSize. Include imageSize.',
          'Use the crop image to localize; use full image for context.'
        ],
        user: [
          'Given the attached screenshot and the next action, first answer gate: is this action part of a generalizable UI control relevant to the task? '
          + 'If yes, extract a structured control description and all visible options with click points. If no, return gate=false.',
          'Relevance criteria: Would changing among these options be a plausible future user goal given the task?',
          'If the next action is typing into a visible field, name the variable from the field’s label/placeholder/nearby text and thought context (be specific), and include defaultStringValue.',
          memory ? ('Thought context near this step (may help identify the control and intent):\n' + JSON.stringify(memory).slice(0, 4000)) : ''
        ]
      },
      responseSchema: {
        type: 'object',
        required: ['gate'],
        properties: {
          gate: { type: 'boolean', description: 'true iff action belongs to a generalizable UI control relevant to the task' },
          control: {
            type: 'object',
            nullable: true,
            properties: {
              anchorDescriptor: { type: 'string', description: 'Minimal unique textual/visual anchor for the control' },
              variable: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  kind: { type: 'string', enum: ['enum','string'] },
                  description: { type: 'string' },
                  defaultStringValue: { type: 'string' }
                }
              },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'displayLabel', 'clickPoint'],
                  properties: {
                    id: { type: 'string' },
                    displayLabel: { type: 'string' },
                    bbox: { type: 'object', nullable: true, properties: { x:{type:'number'}, y:{type:'number'}, w:{type:'number'}, h:{type:'number'} } },
                    clickPoint: { type: 'object', properties: { x:{type:'number'}, y:{type:'number'} } },
                  }
                }
              },
              defaultOptionId: { type: 'string', nullable: true },
              imageSize: { type: 'object', nullable: true, properties: { width:{type:'number'}, height:{type:'number'} } },
              confidence: { type: 'number', nullable: true }
            }
          }
        }
      }
    };

    const promptPath = path.join(outDir, `step-${String(i).padStart(3, '0')}-prompt.json`);
    fs.writeFileSync(promptPath, JSON.stringify(prompt, null, 2), 'utf8');

    console.log(`[enrich] executing step ${i} (${step.kind})`);
    await executeStepWithTransform(harness, step, meta);

    // Also capture post-step screenshot for next step (helps open-state controls)
    const next = steps[i + 1];
    if (next) {
      try {
        const postImg = await safeScreenshot();
        const postB64 = await postImg.toBase64();
        const postIdx = String(i + 1).padStart(3, '0');
        const postImgPath = path.join(outDir, `step-${postIdx}-post.png`);
        fs.writeFileSync(postImgPath, Buffer.from(postB64.split(',')[1] || postB64, 'base64'));
        const postPrompt = {
          taskDescription: taskArg,
          pageUrlHint: harness.page.url(),
          stepIndex: i + 1,
          recordedStep: next,
          hintPoint: next.kind === 'click' ? { x: next.x, y: next.y } : null,
          imagePath: postImgPath,
          imageInfo: await (postImg.getDimensions ? postImg.getDimensions() : undefined),
          instructions: prompt.instructions,
          responseSchema: prompt.responseSchema
        };
        const postPromptPath = path.join(outDir, `step-${postIdx}-post-prompt.json`);
        fs.writeFileSync(postPromptPath, JSON.stringify(postPrompt, null, 2), 'utf8');
      } catch {}
    }
  }

  console.log('[enrich] done, stopping harness');
  await harness.stop();
  console.log('[enrich] closing context...');
  await context.close();
  console.log('Enrichment prompts prepared at:', outDir);
}

function resolveViewport(harness, meta) {
  return harness.page.viewportSize() || getViewportFromMeta(meta);
}

async function executeStepWithTransform(harness, step, meta) {
  switch (step.kind) {
    case 'navigate':
      await harness.navigate(step.url); break;
    case 'click': {
      const viewport = resolveViewport(harness, meta);
      if (!viewport) throw new Error('Viewport unavailable for click');
      const { x, y } = transformFromVirtual(step.x, step.y, meta.virtualScreenDimensions, viewport);
      await harness.click({ x, y }, { transform: false });
      break;
    }
    case 'doubleClick': {
      const viewport = resolveViewport(harness, meta);
      if (!viewport) throw new Error('Viewport unavailable for doubleClick');
      const { x, y } = transformFromVirtual(step.x, step.y, meta.virtualScreenDimensions, viewport);
      await harness.doubleClick({ x, y }, { transform: false });
      break;
    }
    case 'rightClick': {
      const viewport = resolveViewport(harness, meta);
      if (!viewport) throw new Error('Viewport unavailable for rightClick');
      const { x, y } = transformFromVirtual(step.x, step.y, meta.virtualScreenDimensions, viewport);
      await harness.rightClick({ x, y }, { transform: false });
      break;
    }
    case 'drag': {
      const viewport = resolveViewport(harness, meta);
      if (!viewport) throw new Error('Viewport unavailable for drag');
      const p1 = transformFromVirtual(step.x1, step.y1, meta.virtualScreenDimensions, viewport);
      const p2 = transformFromVirtual(step.x2, step.y2, meta.virtualScreenDimensions, viewport);
      await harness.drag({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, { transform: false });
      break;
    }
    case 'type':
      await harness.type({ content: step.content }); break;
    case 'scroll': {
      const viewport = resolveViewport(harness, meta);
      if (!viewport) throw new Error('Viewport unavailable for scroll');
      const { x, y } = transformFromVirtual(step.x, step.y, meta.virtualScreenDimensions, viewport);
      await harness.scroll({ x, y, deltaX: step.deltaX, deltaY: step.deltaY }, { transform: false });
      break;
    }
    case 'switchTab':
      await harness.switchTab({ index: step.index }); break;
    case 'newTab':
      await harness.newTab(); break;
    case 'selectAll':
      await harness.selectAll(); break;
    case 'enter':
      await harness.enter(); break;
    case 'backspace':
      await harness.backspace(); break;
    case 'tab':
      await harness.tab(); break;
    case 'goBack':
      await harness.goBack(); break;
    default:
      throw new Error(`Unhandled step: ${step.kind}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
