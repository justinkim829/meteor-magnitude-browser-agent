#!/usr/bin/env node
/*
 Merges Sonnet 4 per-step results into a workflow file.
 Usage:
   node merge-generalizations.cjs <workflow.json> <promptsDir>
*/
const fs = require('node:fs');
const path = require('node:path');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function listResultFiles(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-result.json'));
  files.sort();
  return files.map(f => path.join(dir, f));
}

function normalizeClickPoint(point, imageSize) {
  // Already in pixel space of image, store as-is; caller ensures numeric
  return { x: Number(point.x), y: Number(point.y) };
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || undefined;
}

function centerOfBBox(bbox) {
  if (!bbox) return null;
  const x = Number(bbox.x) + Number(bbox.w || 0) / 2;
  const y = Number(bbox.y) + Number(bbox.h || 0) / 2;
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return null;
}

function main() {
  const wfPath = path.resolve(process.argv[2] || '');
  const dir = path.resolve(process.argv[3] || '');
  if (!wfPath || !dir) {
    console.error('Usage: node merge-generalizations.cjs <workflow.json> <promptsDir>');
    process.exit(1);
  }
  console.log('[merge] workflow:', wfPath);
  console.log('[merge] prompts dir:', dir);

  const wf = readJson(wfPath);
  const results = listResultFiles(dir);
  if (!wf.generalizations) wf.generalizations = {};

  const variables = {}; // name -> { kind, description, allowedValues?, stepBindings: [] }

  for (const resPath of results) {
    const base = path.basename(resPath).replace('-result.json', '');
    const m = base.match(/step-(\d{3})/);
    if (!m) continue;
    const stepIndex = parseInt(m[1], 10);
    const result = readJson(resPath);
    if (!result.ok || !result.gate || !result.control) continue;

    // Load prompt for image size
    const promptPath = path.join(dir, `${base}-prompt.json`);
    let imageSize = null;
    try {
      const prompt = readJson(promptPath);
      if (prompt && prompt.imageInfo && typeof prompt.imageInfo.width === 'number') {
        imageSize = { width: prompt.imageInfo.width, height: prompt.imageInfo.height };
      }
    } catch {}

    const control = result.control || {};
    const anchorDescriptor = control.anchorDescriptor || control.name || control.label || '';
    let variable = control.variable || null;
    if (!variable) {
      const varName = slugify(anchorDescriptor) || `var_${stepIndex}`;
      variable = { name: varName, kind: Array.isArray(control.options) ? 'enum' : 'string', description: control.description || anchorDescriptor || '' };
    }

    const optionsIn = Array.isArray(control.options) ? control.options : [];
    const options = optionsIn
      .map((opt, idx) => {
      const displayLabel = opt.displayLabel || opt.text || opt.label || String(opt.id || `opt_${idx}`);
      const id = opt.id || slugify(displayLabel) || `opt_${idx}`;
      const bbox = opt.bbox || null;
      const cp = opt.clickPoint || opt.coordinates || centerOfBBox(bbox);
      const clickPoint = cp && imageSize ? normalizeClickPoint(cp, imageSize) : cp || null;
        return { id, displayLabel, bbox, clickPoint };
      })
      .filter(opt => !!opt.clickPoint);

    const gen = {
      gate: true,
      control: {
        anchorDescriptor,
        variable,
        options,
        defaultOptionId: control.defaultOptionId || null,
        imageSize,
        confidence: control.confidence || null,
      }
    };
    wf.generalizations[stepIndex] = gen;

    // Update variables registry if provided
    // For enum-like controls, require 2+ options. For string (type), allow single variable.
    if (control.variable && control.variable.name && (control.variable.kind === 'string' || options.length >= 2)) {
      const name = control.variable.name;
      const entry = variables[name] || { name, kind: control.variable.kind || 'enum', description: control.variable.description || '', allowedValues: undefined, stepBindings: [] };
      if (Array.isArray(control.options)) {
        entry.allowedValues = control.options.map(o => o.id);
      }
      entry.stepBindings.push({ stepIndex, defaultOptionId: control.defaultOptionId || null });
      variables[name] = entry;
    } else if (variable && variable.name && (variable.kind === 'string' || options.length >= 2)) {
      const name = variable.name;
      const entry = variables[name] || { name, kind: variable.kind || 'enum', description: variable.description || '', allowedValues: undefined, stepBindings: [] };
      if (variable.kind !== 'string') entry.allowedValues = options.map(o => o.id);
      entry.stepBindings.push({ stepIndex, defaultOptionId: gen.control.defaultOptionId || null });
      variables[name] = entry;
    }
  }

  // Write variables registry
  wf.variables = Object.values(variables);

  // Save back to workflow (overwrite)
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
  console.log('[merge] wrote generalizations and variables to workflow');
}

main();


