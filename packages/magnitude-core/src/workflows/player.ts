import { Workflow, WorkflowStep } from './types';
import { attachGeneralizationsToWorkflow, generateGeneralizations } from './generalizer';
import { WebHarness } from '@/web/harness';

interface ViewportSize { width: number; height: number }

function transformPointFromVirtual(
    x: number,
    y: number,
    virtual: ViewportSize | undefined,
    viewport: ViewportSize
): { x: number, y: number } {
    if (!virtual) return { x, y };
    return {
        x: x * (viewport.width / virtual.width),
        y: y * (viewport.height / virtual.height),
    };
}

function resolveViewportFromMeta(meta: Workflow['metadata']): ViewportSize | undefined {
    const vp = meta.browser?.contextOptions && (meta.browser.contextOptions as any).viewport;
    if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
        return { width: vp.width, height: vp.height };
    }
    return undefined;
}

function resolveDprFromMeta(meta: Workflow['metadata']): number | undefined {
    const dpr = meta.browser?.contextOptions && (meta.browser.contextOptions as any).deviceScaleFactor;
    if (typeof dpr === 'number') return dpr;
    return undefined;
}

async function applyEmulationToPage(harness: WebHarness, viewport?: ViewportSize, deviceScaleFactor?: number): Promise<void> {
    if (!viewport && typeof deviceScaleFactor !== 'number') return;
    const page: any = (harness as any).page;
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

export class WorkflowPlayer {
    constructor(private harness: WebHarness) {}

    async play(workflow: Workflow, options?: { variables?: Record<string, string>, autoGeneralize?: boolean, agentForGeneralize?: any }) {
        const { metadata, steps } = workflow;
        const vpMeta = resolveViewportFromMeta(metadata);
        const dprMeta = resolveDprFromMeta(metadata);

        // Apply emulation on current page and any future active pages to ensure viewport/DPR match recording
        console.log('[workflow] applying emulation from metadata');
        await applyEmulationToPage(this.harness, vpMeta, dprMeta);
        this.harness.events.on('activePageChanged', async () => {
            console.log('[workflow] active page changed -> reapplying emulation');
            await applyEmulationToPage(this.harness, vpMeta, dprMeta);
        });

        const firstIsNavigate = steps[0]?.kind === 'navigate';
        if (metadata.startUrl && !firstIsNavigate) {
            console.log(`[workflow] navigating to startUrl: ${metadata.startUrl}`);
            await this.harness.navigate(metadata.startUrl);
        }
        const total = steps.length;

        // Optional, run generalization pass before playback if requested and not already present
        if (options?.autoGeneralize && !(workflow as any).generalizations) {
            try {
                if (!options.agentForGeneralize) {
                    console.warn('[workflow] autoGeneralize requested but agentForGeneralize not provided; skipping');
                } else {
                    console.log('[workflow] generating generalizations...');
                    const gens = await generateGeneralizations(options.agentForGeneralize, workflow);
                    Object.assign(workflow as any, { generalizations: gens });
                    console.log('[workflow] generalizations attached');
                }
            } catch (e) {
                console.warn(`[workflow] generalization error: ${(e as Error).message}`);
            }
        }
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            console.log(`[workflow] step ${i + 1}/${total}: ${step.kind}`);
            const used = await this.tryExecuteGeneralizedStep(workflow, i, options?.variables);
            if (!used) {
            await this.executeStepWithPretransform(step, metadata, { workflow, variables: options?.variables });
            }
        }
        console.log('[workflow] replay completed');
    }

    private findGeneralizationForStep(workflow: Workflow, stepIndex: number) {
        const gens: any = (workflow as any).generalizations;
        if (gens && Object.prototype.hasOwnProperty.call(gens, String(stepIndex))) {
            return gens[String(stepIndex)];
        }
        return null;
    }

    private async tryExecuteGeneralizedStep(workflow: Workflow, stepIndex: number, variables?: Record<string, string>): Promise<boolean> {
        const gen = this.findGeneralizationForStep(workflow, stepIndex);
        if (!gen || !gen.gate || !gen.control) return false;
        const variable = gen.control.variable as { name: string, kind?: string } | null;
        if (!variable || !variable.name) return false;
        if (!variables || !(variable.name in variables)) return false;

        const desired = variables[variable.name];
        const options: Array<{ id: string, displayLabel: string, clickPoint?: { x: number, y: number } }> = gen.control.options || [];
        if (!options.length) return false;

        // Find matching option by id or label (case-insensitive)
        const desiredLower = String(desired).toLowerCase();
        let opt = options.find(o => String(o.id).toLowerCase() === desiredLower) ||
                  options.find(o => String(o.displayLabel).toLowerCase() === desiredLower);
        if (!opt) {
            console.warn(`[workflow] variable '${variable.name}' value '${desired}' not found among options; skipping generalization`);
            return false;
        }
        if (!opt.clickPoint) {
            console.warn(`[workflow] option '${opt.id}' missing clickPoint; skipping generalization`);
            return false;
        }

        // Map image pixel clickPoint -> viewport coords
        const imageSize = gen.control.imageSize as { width: number, height: number } | undefined;
        const vp = this.harness.page.viewportSize() || resolveViewportFromMeta((workflow as any).metadata);
        if (!vp) {
            console.warn('[workflow] viewportSize unavailable; skipping generalization');
            return false;
        }
        let vx = opt.clickPoint.x;
        let vy = opt.clickPoint.y;
        if (imageSize && imageSize.width && imageSize.height) {
            const sx = vp.width / imageSize.width;
            const sy = vp.height / imageSize.height;
            vx = opt.clickPoint.x * sx;
            vy = opt.clickPoint.y * sy;
        }

        await this.harness.click({ x: vx, y: vy }, { transform: false });
        return true;
    }

    private async executeStepWithPretransform(step: WorkflowStep, metadata: Workflow['metadata'], context?: { workflow?: Workflow, variables?: Record<string, string> }) {
        switch (step.kind) {
            case 'navigate': {
                await this.harness.navigate(step.url);
                break;
            }
            case 'click': {
                const viewport = this.harness.page.viewportSize() || resolveViewportFromMeta(metadata);
                if (!viewport) throw new Error('Viewport size unavailable for click transform');
                const { x, y } = transformPointFromVirtual(step.x, step.y, metadata.virtualScreenDimensions, viewport);
                await this.harness.click({ x, y }, { transform: false });
                break;
            }
            case 'doubleClick': {
                const viewport = this.harness.page.viewportSize() || resolveViewportFromMeta(metadata);
                if (!viewport) throw new Error('Viewport size unavailable for doubleClick transform');
                const { x, y } = transformPointFromVirtual(step.x, step.y, metadata.virtualScreenDimensions, viewport);
                await (this.harness as any).doubleClick({ x, y }, { transform: false });
                break;
            }
            case 'rightClick': {
                const viewport = this.harness.page.viewportSize() || resolveViewportFromMeta(metadata);
                if (!viewport) throw new Error('Viewport size unavailable for rightClick transform');
                const { x, y } = transformPointFromVirtual(step.x, step.y, metadata.virtualScreenDimensions, viewport);
                await this.harness.rightClick({ x, y }, { transform: false });
                break;
            }
            case 'drag': {
                const viewport = this.harness.page.viewportSize() || resolveViewportFromMeta(metadata);
                if (!viewport) throw new Error('Viewport size unavailable for drag transform');
                const p1 = transformPointFromVirtual(step.x1, step.y1, metadata.virtualScreenDimensions, viewport);
                const p2 = transformPointFromVirtual(step.x2, step.y2, metadata.virtualScreenDimensions, viewport);
                await this.harness.drag({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, { transform: false });
                break;
            }
            case 'type': {
                const wf = context?.workflow as any;
                const vars = context?.variables || {};
                const gen = wf ? this.findGeneralizationForStep(wf, (wf.steps || []).indexOf(step)) : null;
                const varName = gen && gen.control && gen.control.variable && gen.control.variable.name;
                if (gen && gen.control && gen.control.variable && gen.control.variable.kind === 'string' && varName && varName in vars) {
                    const content = String(vars[varName]);
                    await this.harness.type({ content });
                } else {
                    await this.harness.type({ content: (step as any).content });
                }
                break;
            }
            case 'scroll': {
                const viewport = this.harness.page.viewportSize() || resolveViewportFromMeta(metadata);
                if (!viewport) throw new Error('Viewport size unavailable for scroll transform');
                const { x, y } = transformPointFromVirtual(step.x, step.y, metadata.virtualScreenDimensions, viewport);
                await this.harness.scroll({ x, y, deltaX: step.deltaX, deltaY: step.deltaY }, { transform: false });
                break;
            }
            case 'switchTab': {
                await this.harness.switchTab({ index: step.index });
                break;
            }
            case 'newTab': {
                await this.harness.newTab();
                break;
            }
            case 'selectAll': {
                await this.harness.selectAll();
                break;
            }
            case 'enter': {
                await this.harness.enter();
                break;
            }
            case 'backspace': {
                await this.harness.backspace();
                break;
            }
            case 'tab': {
                await this.harness.tab();
                break;
            }
            case 'goBack': {
                await this.harness.goBack();
                break;
            }
            default:
                throw new Error(`Unhandled workflow step: ${(step as any).kind}`);
        }
    }
}


