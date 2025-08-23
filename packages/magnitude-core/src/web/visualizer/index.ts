import { BrowserContext, Page } from "playwright";
import { CursorVisual } from "./cursor";
import { MouseEffectVisual } from "./mouseEffects";
import { TypeEffectVisual } from "./typeEffects";

export interface ActionVisualizerOptions {
    showCursor?: boolean,
    showHoverCircle?: boolean; // mouse effect option
    showClickRipple?: boolean; // mouse effect option
    showDragLine?: boolean; // mouse effect option
    showTypeEffects?: boolean,
}

export class ActionVisualizer {
    private options: Required<ActionVisualizerOptions>;
    private context: BrowserContext;
    private page!: Page;

    private cursor: CursorVisual;
    private mouseEffects: MouseEffectVisual;
    private typeEffects: TypeEffectVisual;
    

    constructor(context: BrowserContext, options: ActionVisualizerOptions) {
        this.context = context;
        this.options = {
<<<<<<< HEAD
            showCursor: true,
            showHoverCircle: false,
            showClickRipple: false,
            showDragLine: false,
            showTypeEffects: false
=======
            showCursor: options.showCursor ?? true,
            showHoverCircle: options.showHoverCircle ?? false,
            showClickRipple: options.showClickRipple ?? true,
            showDragLine: options.showDragLine ?? false,
            showTypeEffects: options.showTypeEffects ?? true
>>>>>>> Bremote/main
        };

        this.cursor = new CursorVisual();
        this.mouseEffects = new MouseEffectVisual(this.options);
        this.typeEffects = new TypeEffectVisual();
    }

    async setup() {
        // await this.mouseEffects.setContext(this.context);
        // if (this.options.showTypeEffects) {
        //     await this.typeEffects.setContext(this.context);
        // }
        //this.showAll();
    }

    async setActivePage(page: Page) {
        this.page = page;
<<<<<<< HEAD
        if (this.options.showCursor) {
            await this.cursor.setActivePage(page);
        }
        await this.mouseEffects.setActivePage(page);
        if (this.options.showTypeEffects) {
            await this.typeEffects.setActivePage(page);
        }
=======
        await this.cursor.setActivePage(page);
        await this.mouseEffects.setActivePage(page);
        await this.typeEffects.setActivePage(page);
>>>>>>> Bremote/main
    }

    async moveVirtualCursor(x: number, y: number) {
        // Takes like 300ms for smooth anim
<<<<<<< HEAD
        if (this.options.showCursor) {
            await this.cursor.move(x, y);
        }
    }

    async hideAll() {
        if (this.options.showCursor) {
            await this.cursor.hide();
        }
    }

    async showAll() {
        if (this.options.showCursor) {
            await this.cursor.show();
        }
=======
        await this.cursor.move(x, y);
    }

    async hideAll() {
        await this.cursor.hide();
    }

    async showAll() {
        await this.cursor.show();
>>>>>>> Bremote/main
    }
}