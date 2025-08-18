import { retryOnError, retryOnErrorIsSuccess } from "@/common";
import logger from "@/logger";
import { Page } from "playwright";

export class CursorVisual {
    /**
     * Manages the visual indicator for actions on a page
     */
    private page!: Page;
    private visualElementId: string = 'action-visual-indicator';
    private lastPosition: { x: number; y: number } | null = null;

    constructor() {
        //this.page = page;
    }

    async setActivePage(page: Page) {
        this.page = page;

        page.on('load', async () => {
            await retryOnErrorIsSuccess(
                this.setupOnPage.bind(this),
                { mode: 'retry_all', delayMs: 200, retryLimit: 10 }
            );
        });

        await retryOnErrorIsSuccess(
            this.setupOnPage.bind(this),
            { mode: 'retry_all', delayMs: 200, retryLimit: 5 }
        );
    }

    async move(x: number, y: number): Promise<void> {
        // Store the position
        this.lastPosition = { x, y };
        // Create or update the mouse pointer visual
        await this._drawVisual(x, y);
        // The pointer visual takes 0.3s on the transition, but awaiting script evaluation does not wait for this to complete.
        // So we wait 300ms manually.
        await this.page.waitForTimeout(300);
    }

    async setupOnPage(): Promise<void> {
        if (this.lastPosition) {
            // Redraw the visual
            await this._drawVisual(this.lastPosition.x, this.lastPosition.y);
        }
    }

    // Internal method to handle the actual drawing logic
    private async _drawVisual(x: number, y: number): Promise<void> {
        try {
            await this.page.evaluate(
                ({ x, y, id }) => {
                    // Adjust coordinates for scroll position
                    const docX = x + window.scrollX;
                    const docY = y + window.scrollY;

                    // --- Pointer Logic (Always runs) ---
                    // Check if the visual indicator already exists
                    let pointerElement = document.getElementById(id);
                    
                    // If it doesn't exist, create it with all necessary styling
                    if (!pointerElement) {
                        pointerElement = document.createElement('div');
                        pointerElement.id = id;
                        pointerElement.style.position = 'absolute';
                        pointerElement.style.zIndex = '1000000100';
                        pointerElement.style.pointerEvents = 'none'; // Don't interfere with actual clicks
                        // Notice that transition is 300ms
                        pointerElement.style.transition = 'left 0.3s cubic-bezier(0.25, 0.1, 0.25, 1), top 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)';

                        // Set the innerHTML to the Meteor purple arrow cursor
                        pointerElement.innerHTML = `<svg id="ai-cursor" xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" style="position: relative; pointer-events: none;">
  <defs>
    <filter id="drop-shadow">
      <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.25"/>
    </filter>
  </defs>
  
  <!-- Main cursor shape -->
  <polygon points="4.5,0.79 4.5,23.21 11.06,16.64 20.35,16.64" 
           fill="#6B1ECA" 
           filter="url(#drop-shadow)"/>
  
  <!-- Border/outline -->
  <polygon points="4.5,0.79 4.5,23.21 11.06,16.64 20.35,16.64" 
           fill="transparent" 
           stroke="#fff" 
           stroke-width="1" 
           style="pointer-events: none;"/>
</svg>`;

                        document.body.appendChild(pointerElement);
                    }
                    
                    //pointerElement.style.display = 'none'; 
                    
                    // Update position - position cursor so the tip (4.5, 0.79) is at the click point
                    pointerElement.style.left = `${docX}px`;
                    pointerElement.style.top = `${docY}px`;
                    pointerElement.style.transform = 'translate(-4.5px, -0.79px)';
                },
                { x, y, id: this.visualElementId }
            );
        } catch (error: unknown) {
            // For example when:
            // TypeError: Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.
            logger.trace(`Failed to draw visual: ${(error as Error).message}`);
        }
    }

    async hide(): Promise<void> {
        try {
            await this.page.evaluate((id) => {
                const element = document.getElementById(id);
                if (element) {
                    element.style.display = 'none';
                }
            }, this.visualElementId);
        } catch {
            logger.trace(`Failed to hide pointer`);
        }
    }

    async show(): Promise<void> {
        try {
            await this.page.evaluate((id) => {
                const element = document.getElementById(id);
                if (element) {
                    // Revert to the default display value (usually 'block' for a div)
                    element.style.display = ''; 
                }
            }, this.visualElementId);
        } catch {
            logger.trace(`Failed to show pointer`);
        }
    }

    // async removeActionVisuals(): Promise<void> {
    //     // Remove the visual indicator
    //     await this.page.evaluate((id) => {
    //         const element = document.getElementById(id);
    //         if (element) {
    //             element.remove();
    //         }
    //     }, this.visualElementId);
    // }
}
