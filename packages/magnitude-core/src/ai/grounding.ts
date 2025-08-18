import { ClickWebAction, PixelCoordinate, ScrollWebAction, TypeWebAction, WebAction } from '@/web/types';
import { ActionIntent, CheckIntent, ClickIntent, Intent, ScrollIntent, TypeIntent } from '@/actions/types';
import logger from "@/logger";
import { Logger } from 'pino';
import { vl as MoondreamClient } from 'moondream';
import { GroundingClient } from './types';
import { retryOnError } from '@/common/util';
import { Image } from '@/memory/image';


interface GroundingServiceConfig {
    // only supported executor client rn is moondream
    client?: GroundingClient;
}

// TODO: if provider moondream, have default options e.g.
// executor: {
//     provider: 'moondream',
//     options: {
//         apiKey: process.env.MOONDREAM_API_KEY || "YOUR_MOONDREAM_API_KEY"
//     }
// } as GroundingClient,

const DEFAULT_CLIENT: GroundingClient = {
    provider: 'moondream',
    options: {
        baseUrl: "https://api.moondream.ai/v1",
        apiKey: process.env.MOONDREAM_API_KEY
    }
}

export interface GroundingServiceInfo {
    provider: string,
    numCalls: number
}

export const moondreamTargetingInstructions = `
Targets descriptions must be carefully chosen to be accurately picked up by Moondream, a small vision model.
Build a "minimal unique identifier" - a description that is as brief as possible that uniquely identifies the target on the page.
Use only the information needed, and prioritize in this order:
- specific text
- specific shapes and colors
- positional information
- high level information (Moondream cannot always understand high level concepts)
`;

export class GroundingService {
    /**
     * Small, fast, vision agent to translate high level web actions to precise, executable actions.
     * Uses Moondream for pixel precision pointing.
     */
    private config: Required<GroundingServiceConfig>;
    private info: GroundingServiceInfo;
    private logger: Logger;
    private moondream: MoondreamClient;

    constructor(config: GroundingServiceConfig) {
        //const clientOptions = { ...DEFAULT_CLIENT_OPTIONS, ...config.client };
        const clientOptions = { ...DEFAULT_CLIENT.options, ...(config.client?.options ?? {}) };
        const client = { ...DEFAULT_CLIENT, ...(config.client ?? {}), options: clientOptions };
        this.config = {...config, client: client };
        this.info = { provider: 'moondream', numCalls: 0 };
        this.logger = logger.child({ name: 'agent.grounding' });
        this.moondream = new MoondreamClient({ apiKey: this.config.client.options.apiKey, endpoint: this.config.client.options.baseUrl });
    }

    getInfo(): GroundingServiceInfo {
        return this.info;
    }

    async locateTarget(screenshot: Image, target: string): Promise<PixelCoordinate> {
        return await retryOnError(
            async () => this._locateTarget(screenshot, target),
            { mode: 'retry_on_partial_message', errorSubstrings: ['429', '503', '524'], retryLimit: 20, delayMs: 1000, showWarnOnRetry: false }
        );
    }

    async _locateTarget(screenshot: Image, target: string): Promise<PixelCoordinate> {
        //console.log("_locateTarget dims:", await screenshot.getDimensions());
        const start = Date.now();

        const response = await this.moondream.point({
            image: { imageUrl: await screenshot.toBase64() },
            object: target
        });
        this.info.numCalls++;
        // Point API can return multiple, which we don't really want. We want one clear target.
        // todo: actually handle these errors appropriately in caller
        if (response.points.length > 1) {
            logger.warn({ points: response.points }, "Moondream returned multiple points for locateTarget");
            throw new Error(`Moondream returned multiple points (${response.points.length}), target '${target}' unclear`);
        }
        if (response.points.length === 0) {
            logger.warn("Moondream returned no points");
            throw new Error(`Moondream returned no points, target unclear`);
        }
        const relCoords = response.points[0];
        this.logger.trace(`locateTarget took ${Date.now()-start}ms`);

        // Convert from [0,1] to screen space
        const { width, height } = await screenshot.getDimensions();
        const pixelCoords = {
            x: relCoords.x * width,
            y: relCoords.y * height
        }

        // console.log("Screenshot dims:", { width, height });
        // console.log("Relative coords:", relCoords);
        // console.log("Pixel coords:", pixelCoords);

        return pixelCoords;
    }
}