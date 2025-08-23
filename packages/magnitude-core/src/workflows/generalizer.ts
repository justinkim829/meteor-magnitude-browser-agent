import { z } from 'zod';
import { Agent } from '@/agent';
import { BrowserConnector } from '@/connectors/browserConnector';
import { Workflow } from '@/workflows/types';
import { AgentMemory, SerializedAgentMemory } from '@/memory/agentMemory';
import { jsonToObservableData } from '@/memory/serde';
import { Image } from '@/memory/image';
import { GroundingService } from '@/ai/grounding';
// Removed truncated replay dependencies; we rely on pre-step screenshots captured during exploration

type GeneralizationsMap = Record<string, any>;

interface StepContext {
    stepIndex: number;
    screenshot: Image | null;
    thought: string | null;
    actionName: string; // e.g. 'mouse:click'
    actionPayload: any; // parsed JSON if possible; otherwise string
}

// Ask model to return JSON as a string; we'll parse and validate ourselves
const OutputSchema = z.string();

async function normalizeWithLLM(agent: Agent, raw: string): Promise<any | null> {
    const system = [
        'You receive a JSON-like object (it may omit quotes on keys/strings or use single quotes).',
        'Convert it into STRICT JSON that matches this schema:',
        '{',
        '  "generalizable": boolean,',
        '  "control"?: {',
        '    "category": "dropdown|menu|combobox|tab|radio|checkbox|pagination",',
        '    "paramName": string,',
        '    "allowedValues": string[],',
        '    "selectionRule": { "by": "visible_label_equals" | "visible_label_contains" | "regex", "pattern"?: string, "caseSensitive"?: boolean },',
        '    "whySafe": string,',
        '    "confidence": number',
        '  },',
        '  "reason"?: string,',
        '  "explanation"?: string',
        '}',
        'Return STRICT JSON only. Use double quotes for all keys and string values.'
    ].join('\n');
    const user = `Fix to strict JSON (no prose):\n${raw}`;
    const text = await agent.models.query(
        { instructions: system, observationContent: [{ role: 'user', cacheControl: false, content: [user] }], connectorInstructions: [] },
        'Convert to strict JSON only. No prose.',
        z.string()
    );
    try { return JSON.parse(text); } catch { return null; }
}

function mapActionToWorkflowKind(actionName: string): Workflow['steps'][number]['kind'] | null {
    switch (actionName) {
        case 'mouse:click': return 'click';
        case 'mouse:double_click': return 'doubleClick';
        case 'mouse:right_click': return 'rightClick';
        case 'mouse:drag': return 'drag';
        case 'mouse:scroll': return 'scroll';
        case 'keyboard:type': return 'type';
        case 'keyboard:enter': return 'enter';
        case 'keyboard:tab': return 'tab';
        case 'keyboard:backspace': return 'backspace';
        case 'keyboard:select_all': return 'selectAll';
        case 'browser:nav': return 'navigate';
        case 'browser:nav:back': return 'goBack';
        case 'browser:tab:switch': return 'switchTab';
        case 'browser:tab:new': return 'newTab';
        default: return null;
    }
}

async function buildStepContextsFromMemory(workflow: Workflow, memory: SerializedAgentMemory): Promise<StepContext[]> {
    const steps: StepContext[] = [];

    let lastScreenshot: Image | null = null;
    let lastThought: string | null = null;

    // Index into workflow steps to align observations with recorded steps
    let wfIndex = 0;

    for (const obs of memory.observations) {
        const source = obs.source;
        // Track latest screenshot
        if (source.startsWith('connector:')) {
            // Try to extract screenshot image from observation content
            try {
                const data = await jsonToObservableData(obs.data);
                if (data instanceof Image) {
                    lastScreenshot = data;
                } else if (Array.isArray(data)) {
                    // Sometimes screenshot comes alongside tab info; find first Image
                    const img = (data as any[]).find((p) => p instanceof Image) as Image | undefined;
                    if (img) lastScreenshot = img;
                } else if (typeof data === 'object' && data !== null) {
                    // Object with fields that may include an image
                    for (const value of Object.values(data as Record<string, unknown>)) {
                        if (value instanceof Image) { lastScreenshot = value; break; }
                    }
                }
            } catch {}
            continue;
        }

        if (source === 'thought') {
            try {
                const thoughtData = await jsonToObservableData(obs.data);
                lastThought = typeof thoughtData === 'string' ? thoughtData : JSON.stringify(thoughtData);
            } catch {
                lastThought = null;
            }
            continue;
        }

        if (source.startsWith('action:taken:')) {
            const actionName = source.replace('action:taken:', '');
            const mappedKind = mapActionToWorkflowKind(actionName);
            if (!mappedKind) continue;

            // Advance wfIndex to next step with matching kind
            while (wfIndex < workflow.steps.length && workflow.steps[wfIndex].kind !== mappedKind) {
                wfIndex++;
            }
            if (wfIndex >= workflow.steps.length) break;

            // Parse payload if possible
            let actionPayload: any = null;
            try {
                const raw = await jsonToObservableData(obs.data);
                actionPayload = typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch {
                // Fallback to raw string if not JSON
                try {
                    const raw = await jsonToObservableData(obs.data);
                    actionPayload = raw;
                } catch {}
            }

            steps.push({
                stepIndex: wfIndex,
                screenshot: lastScreenshot,
                thought: lastThought,
                actionName,
                actionPayload
            });

            // Move past this matched step for subsequent alignment
            wfIndex++;
        }
    }

    return steps;
}

function buildPrompt(stepThought: string | null, actionSummary: string, anchor?: { x: number, y: number }): { system: string, user: string } {
    const thought = stepThought ? stepThought : '';
    const system = [
        'You are analyzing ONE recorded step from a vision-driven web exploration.',
        'Return a SINGLE STRICT JSON object matching this schema and NOTHING ELSE (no code fences, no prose):',
        '{',
        '  "generalizable": boolean,',
        '  "control"?: {',
        '    "category": "dropdown|menu|combobox|tab|radio|checkbox|pagination",',
        '    "paramName": string,',
        '    "allowedValues": string[],',
        '    "selectionRule": { "by": "visible_label_equals" | "visible_label_contains" | "regex", "pattern"?: string, "caseSensitive"?: boolean },',
        '    "whySafe": string,',
        '    "confidence": number',
        '  },',
        '  "reason"?: string,',
        '  "explanation"?: string',
        '}',
        'Formatting rules: use DOUBLE QUOTES for all keys and string values; arrays MUST be arrays of DOUBLE-QUOTED strings; do NOT include trailing commas.',
        'If not generalizable, set generalizable=false and include a brief "reason" and optional "explanation" (your thinking).',
    ].join('\n');
    const userLines = [
        'Decide if this step can be generalized into a parameter with a finite set of VISIBLE alternatives while keeping all later steps identical and meaningful.',
        '',
        'Inputs:',
        '- Full step screenshot (attached)',
        `- Thought after seeing this screenshot: "${thought}"`,
        `- Action performed after seeing this screenshot: ${actionSummary}`,
        ...(anchor ? [ `- Anchor: The click performed after seeing this screenshot was at (${Math.round(anchor.x)}, ${Math.round(anchor.y)}). The relevant control and its visible options are near this point.` ] : []),
        '',
        'Rules:',
        '- Consider only controls with enumerated, labeled options visible now: dropdown/menu/combobox, tabs, radio, checkbox, pagination.',
        '- Do NOT generalize content picks (e.g., “click 2nd product”), free-form typing, or hidden/non-visible alternatives.',
        '- Resolve allowedValues by the visible options for the SAME control near the anchor point; ignore duplicate labels elsewhere on the page.',
        '',
        'Examples (STRICT JSON):',
        '{"generalizable": true, "control": {"category": "dropdown", "paramName": "sortOption", "allowedValues": ["Featured", "Price: Low to High"], "selectionRule": {"by": "visible_label_equals"}, "whySafe": "Sorting preserves downstream steps", "confidence": 0.85}, "explanation": "Visible dropdown with stable options"}',
        '{"generalizable": false, "reason": "This is a positional content selection without a finite labeled alternative set.", "explanation": "Clicking content tile #1"}',
    ];
    const user = userLines.join('\n');
    return { system, user };
}

const PointSchema = z.object({ x: z.number(), y: z.number() });

async function computeClickPointsForValues(agent: Agent, screenshot: Image, values: string[], anchor?: { x: number, y: number }): Promise<{ label: string, x: number, y: number }[]> {
    // Mirror exploration: if BrowserConnector has grounding, use it (Moondream). Otherwise, ask the planning LLM (e.g., Sonnet) to return pixel coords.
    const connector = agent.getConnector(BrowserConnector);
    let grounding: GroundingService | null = null;
    if (connector) {
        try { grounding = connector.requireGrounding(); } catch { grounding = null; }
    }

    const points: { label: string, x: number, y: number }[] = [];
    const dims = await screenshot.getDimensions();

    for (const label of values) {
        try {
            if (grounding) {
                const { x, y } = await grounding.locateTarget(screenshot, label);
                points.push({ label, x, y });
            } else {
                const prompt = [
                    'Given the attached screenshot, return the pixel coordinates (x,y) of the UI control visibly labeled exactly as follows.',
                    `Label: "${label}"`,
                    `Image size: width=${dims.width}, height=${dims.height}.`,
                    ...(anchor ? [
                        `Anchor: The relevant control is near (${Math.round(anchor.x)}, ${Math.round(anchor.y)}). Prefer the option within the menu/popup/list near this anchor point (ignore duplicate labels elsewhere).`
                    ] : []),
                    'Return JSON only with shape { "x": number, "y": number } where x,y are pixel coordinates within the image bounds.'
                ].join('\n');
                const bimg = await screenshot.toBaml();
                const resp = await agent.models.query(
                    { instructions: null, observationContent: [{ role: 'user', cacheControl: false, content: [bimg] }], connectorInstructions: [] },
                    prompt,
                    PointSchema
                );
                if (typeof resp.x === 'number' && typeof resp.y === 'number') {
                    points.push({ label, x: resp.x, y: resp.y });
                }
            }
        } catch {
            // Skip labels that fail to resolve
        }
    }

    return points;
}

// Type-step naming prompt
function buildTypePrompt(stepThought: string | null, typedText: string, pageHint?: string): { system: string, user: string } {
    const thought = stepThought ? stepThought : '';
    const system = [
        'You are naming an API parameter for a type action in a web workflow.',
        'Return a SINGLE STRICT JSON object and NOTHING ELSE:',
        '{',
        '  "variable": { "name": string, "description": string },',
        '  "defaultStringValue": string',
        '}',
        'Formatting rules: use DOUBLE QUOTES for all keys and strings; no trailing commas; no prose; no code fences.'
    ].join('\n');
    const user = [
        ...(pageHint ? [ `Context: ${pageHint}` ] : []),
        `Thought after seeing this screenshot: "${thought}"`,
        `Action performed after seeing this screenshot: keyboard:type "${typedText}"`,
        'Name should be concise, snake_case, and specific to this field/site but reusable across runs.',
        'Example: {"variable":{"name":"search_amazon_product","description":"Query typed into Amazon’s global search bar"},"defaultStringValue":"headphones"}'
    ].join('\n');
    return { system, user };
}

async function normalizeTypeWithLLM(agent: Agent, raw: string): Promise<any | null> {
    const system = [
        'You receive a JSON-like object for a type action variable definition.',
        'Convert it into STRICT JSON with this schema and NOTHING ELSE:',
        '{',
        '  "variable": { "name": string, "description": string },',
        '  "defaultStringValue": string',
        '}',
        'Use DOUBLE QUOTES for all keys and strings; no code fences; no prose.'
    ].join('\n');
    const user = `Fix to strict JSON (no prose):\n${raw}`;
    const text = await agent.models.query(
        { instructions: system, observationContent: [{ role: 'user', cacheControl: false, content: [user] }], connectorInstructions: [] },
        'Convert to strict JSON only. No prose.',
        z.string()
    );
    try { return JSON.parse(text); } catch { return null; }
}

// Build natural-language context for a type variable by scanning all prior steps' screenshots
async function buildVariableContextText(
    agent: Agent,
    workflow: Workflow,
    memory: SerializedAgentMemory,
    typeStepIndex: number,
    varName: string,
    varDesc: string,
    defaultValue: string,
    taskHint?: string | null
): Promise<string> {
    // Collect screenshots from steps 0..typeStepIndex (pre-step images captured during exploration)
    // We reuse buildStepContextsFromMemory to align thoughts/screenshots; then take those with index <= typeStepIndex
    const contexts = await buildStepContextsFromMemory(workflow, memory);
    const relevant = contexts.filter(c => c.stepIndex <= typeStepIndex && c.screenshot);
    const snippets: string[] = [];
    for (const c of relevant) {
        try {
            const bimg = await (c.screenshot as Image).toBaml();
            const system = [
                'Return NATURAL LANGUAGE TEXT ONLY. No JSON. No code fences. No boilerplate.',
                'Goal: capture ONLY information relevant to supplying a value for a specific variable.',
                'Rules:',
                '- If THIS screenshot clearly shows a consolidated list/table/menu or details relevant to the variable, ENUMERATE EVERY visible candidate item (one per line, use exact visible names/labels). More is better for this case.',
                '- If THIS screenshot does not contain candidate items or details relevant to the variable, return an EMPTY string (do NOT describe generic UI, placeholders, galleries, or instructions).',
                '- Do NOT include unrelated page sections or generic interface descriptions.'
            ].join('\n');
            const user = [
                `Variable: ${varName} — ${varDesc}`,
                `Default used in run: "${defaultValue}"`,
                ...(taskHint ? [ `Task (if relevant): "${String(taskHint)}"` ] : []),
                'From THIS screenshot only, write concise text containing ONLY what helps select a value for this variable (e.g., the candidate names/labels/items).',
                'If this screenshot clearly lists candidates for this variable, enumerate EVERY visible candidate (one per line, exact strings).',
                'If nothing relevant is visible, return an EMPTY string.'
            ].join('\n');
            const text = await agent.models.query(
                { instructions: system, observationContent: [{ role: 'user', cacheControl: false, content: [user, bimg] }], connectorInstructions: [] },
                'Summarize relevant context as plain text only.',
                z.string()
            );
            const cleaned = String(text || '').trim();
            if (cleaned.length > 0) {
                snippets.push(`Step ${c.stepIndex}:\n${cleaned}`);
            }
        } catch {}
    }
    if (snippets.length === 0) return '';
    // Prefer the longest snippet (likely the consolidated page), then add only novel lines from others
    const sorted = snippets.toSorted((a, b) => b.length - a.length);
    const base = sorted[0];
    const seen = new Set<string>();
    const outLines: string[] = [];
    for (const line of base.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        outLines.push(t);
        if (outLines.join('\n').length > 1800) break;
    }
    for (let i = 1; i < sorted.length && outLines.join('\n').length < 2000; i++) {
        for (const line of sorted[i].split('\n')) {
            const t = line.trim();
            if (!t) continue;
            const key = t.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            outLines.push(t);
            if (outLines.join('\n').length > 2000) break;
        }
    }
    return outLines.join('\n');
}

export async function generateGeneralizations(agent: Agent, workflow: Workflow): Promise<GeneralizationsMap> {
    const memJson = await agent.memory.toJSON();
    let stepContexts = await buildStepContextsFromMemory(workflow, memJson);

    const generalizations: GeneralizationsMap = {};

    // Process sequentially
    for (const ctx of stepContexts) {
        // Handle type-step generalization
        if (ctx.actionName === 'keyboard:type') {
            const typed = (typeof ctx.actionPayload === 'string') ? ctx.actionPayload : (ctx.actionPayload?.content ?? '');
            const typedStr = typeof typed === 'string' ? typed : '';
            const dims = ctx.screenshot ? await ctx.screenshot.getDimensions() : { width: 0, height: 0 };
            console.log(`[generalizer] step ${ctx.stepIndex}: TYPE generalization, img=${!!ctx.screenshot} dims=${dims.width}x${dims.height} thoughtLen=${(ctx.thought||'').length} contentLen=${typedStr.length}`);
            try {
                const { system, user } = buildTypePrompt(ctx.thought, typedStr);
                const raw = await agent.models.query(
                    { instructions: system, observationContent: [{ role: 'user', cacheControl: false, content: [user] }], connectorInstructions: [] },
                    'Name a string variable for this type action. Strict JSON only.',
                    z.string()
                );
                let obj: any = null;
                try { obj = JSON.parse(raw); } catch {}
                if (!obj) obj = await normalizeTypeWithLLM(agent, raw);
                if (obj && obj.variable && typeof obj.variable.name === 'string') {
                    const varName = obj.variable.name;
                    const varDesc = typeof obj.variable.description === 'string' ? obj.variable.description : undefined;
                    console.log(`[generalizer] step ${ctx.stepIndex}: type variable name='${varName}' default='${obj.defaultStringValue ?? typedStr}'`);
                    generalizations[String(ctx.stepIndex)] = {
                        gate: { source: 'vision', category: 'type' },
                        control: {
                            variable: { name: varName, kind: 'string', ...(varDesc ? { description: varDesc } : {}), ...(obj.defaultStringValue ? { defaultStringValue: obj.defaultStringValue } : {}) },
                            options: []
                        }
                    };

                    // Build natural-language variable context by scanning all prior steps (1..k) with separate LLM calls per image
                    try {
                        const contextText = await buildVariableContextText(agent, workflow, memJson, ctx.stepIndex, varName, varDesc ?? '', obj.defaultStringValue ?? typedStr, (agent as any)._lastTaskDescription ?? null);
                        if (contextText && contextText.trim().length > 0) {
                            (generalizations[String(ctx.stepIndex)].control.variable as any).context = contextText.trim();
                            console.log(`[generalizer] step ${ctx.stepIndex}: variable context attached (len=${contextText.length})`);
                        }
                    } catch (e) {
                        console.warn(`[generalizer] step ${ctx.stepIndex}: failed to build variable context: ${(e as Error).message}`);
                    }
                } else {
                    console.log(`[generalizer] step ${ctx.stepIndex}: type naming failed; skipping`);
                }
            } catch (e) {
                console.warn(`[generalizer] step ${ctx.stepIndex}: error during type generalization; skipping (${(e as Error).message})`);
            }
            continue;
        }

        // Only consider click-like steps for control generalization
        if (!['mouse:click', 'mouse:right_click', 'mouse:double_click'].includes(ctx.actionName)) {
            continue;
        }
        // Use pre-step screenshot from memory captured during exploration
        const stepImage: Image | null = ctx.screenshot;
        if (!stepImage) {
            console.warn(`[generalizer] step ${ctx.stepIndex}: no screenshot available; skipping`);
            continue;
        }

        // Build action summary string for the prompt
        let actionSummary = '';
        try {
            actionSummary = typeof ctx.actionPayload === 'string' ? ctx.actionPayload : JSON.stringify(ctx.actionPayload);
        } catch {
            actionSummary = String(ctx.actionPayload ?? '');
        }

        try {
            // Use current step's action as anchor when available (click-like)
            let anchor: { x: number, y: number } | undefined;
            try {
                const act = typeof ctx.actionPayload === 'string' ? JSON.parse(ctx.actionPayload) : ctx.actionPayload;
                if (act && typeof act.x === 'number' && typeof act.y === 'number') {
                    anchor = { x: act.x, y: act.y };
                }
            } catch {}
            const prompt = buildPrompt(ctx.thought, actionSummary, anchor);

            // Build a minimal AgentContext with screenshot (BAML image) + text parts
            const dims = await stepImage.getDimensions();
            console.log(`[generalizer] step ${ctx.stepIndex}: kind=${workflow.steps[ctx.stepIndex]?.kind ?? 'unknown'}, screenshotPresent=true dims=${dims.width}x${dims.height}`);
            const thoughtPreview = (ctx.thought || '').slice(0, 160).replace(/\s+/g, ' ');
            console.log(`[generalizer] step ${ctx.stepIndex}: thoughtPreview="${thoughtPreview}"`);
            const actionPreview = (actionSummary || '').slice(0, 200).replace(/\s+/g, ' ');
            console.log(`[generalizer] step ${ctx.stepIndex}: actionPreview=${actionPreview}`);

            const bamlImage = await stepImage.toBaml();
            const content = [bamlImage, `Thought: ${ctx.thought ?? ''}`, `Action: ${actionSummary}`];
            console.log(`[generalizer] step ${ctx.stepIndex}: inputs -> img=true, thoughtLen=${(ctx.thought||'').length}, actionLen=${actionSummary.length}`);
            const raw = await agent.models.query(
                { instructions: prompt.system, observationContent: [{ role: 'user', cacheControl: false, content: [prompt.user, ...content] }], connectorInstructions: [] },
                'Decide generalizability for the attached step. Return JSON only per schema in system.',
                OutputSchema
            );
            console.log(`[generalizer] step ${ctx.stepIndex}: model raw len=${(raw || '').length}`);
            const head = String(raw || '').slice(0, 200).replace(/\s+/g, ' ');
            console.log(`[generalizer] step ${ctx.stepIndex}: rawHead="${head}"`);
            let queryResp: any = null;
            try { queryResp = JSON.parse(raw); } catch {}
            if (!queryResp) {
                // Use LLM normalization to avoid fragile heuristics
                const normalizedObj = await normalizeWithLLM(agent, raw);
                if (normalizedObj) {
                    queryResp = normalizedObj;
                    console.log(`[generalizer] step ${ctx.stepIndex}: normalization via LLM succeeded`);
                } else {
                    console.log(`[generalizer] step ${ctx.stepIndex}: invalid JSON from model after LLM normalization`);
                }
            }
            if (!queryResp || typeof queryResp !== 'object') {
                console.log(`[generalizer] step ${ctx.stepIndex}: invalid JSON from model`);
                continue;
            }
            const explanation = typeof queryResp.explanation === 'string' ? queryResp.explanation : '';
            if (!queryResp.generalizable || !queryResp.control || !Array.isArray(queryResp.control.allowedValues) || queryResp.control.allowedValues.length === 0) {
                const reason = typeof queryResp.reason === 'string' ? queryResp.reason : '';
                console.log(`[generalizer] step ${ctx.stepIndex}: not generalizable reason="${reason}" explain="${explanation.slice(0,200)}"`);
                continue;
            }
            console.log(`[generalizer] step ${ctx.stepIndex}: generalizable=true category=${queryResp.control.category} param=${queryResp.control.paramName} values=${queryResp.control.allowedValues.length} explain="${explanation.slice(0,200)}"`);

            // Compute click points for allowed values on the same screenshot
            const points = await computeClickPointsForValues(agent, stepImage, queryResp.control.allowedValues, anchor);
            if (points.length === 0) {
                console.log(`[generalizer] step ${ctx.stepIndex}: no clickPoints resolved; skipping`);
                continue;
            }
            console.log(`[generalizer] step ${ctx.stepIndex}: clickPoints resolved for ${points.length}/${queryResp.control.allowedValues.length}`);

            const variableName = queryResp.control.paramName && queryResp.control.paramName.trim() !== ''
                ? queryResp.control.paramName
                : `param_step_${ctx.stepIndex}`;

            const options = points.map(p => ({ id: p.label, displayLabel: p.label, clickPoint: { x: p.x, y: p.y } }));

            generalizations[String(ctx.stepIndex)] = {
                gate: { source: 'vision', category: queryResp.control.category ?? null },
                control: {
                    variable: { name: variableName, kind: 'string' },
                    options,
                    imageSize: { width: dims.width, height: dims.height }
                }
            };
            console.log(`[generalizer] step ${ctx.stepIndex}: generalization recorded`);
        } catch (e) {
            // Skip this step on any error
            console.warn(`[generalizer] step ${ctx.stepIndex}: error during generalization; skipping (${(e as Error).message})`);
            continue;
        }
    }
    return generalizations;
}

export function attachGeneralizationsToWorkflow(workflow: Workflow, generalizations: GeneralizationsMap): Workflow {
    return Object.assign({}, workflow, { generalizations });
}

// No longer needed since we capture pre-step screenshots during exploration


