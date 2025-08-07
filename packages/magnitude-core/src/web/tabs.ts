// Keeps track of current tab, enables describing open tabs, and switching between open tabs

import logger from "@/logger";
import EventEmitter from "eventemitter3";
import { BrowserContext, Page } from "playwright";

export interface TabEvents {
    'tabChanged': (page: Page) => void
}

export interface TabState {
    activeTab: number,
    tabs: {
        title: string,
        url: string,
        // causes issues with circular references, and we don't need it
        //page: Page
    }[]
}

export class TabManager {
    /**
     * Page / tab manager
     */
    //private state!: TabState;
    private context: BrowserContext;
    private activePage!: Page; // the page the agent currently sees and acts on
    public readonly events: EventEmitter<TabEvents>;

    constructor(context: BrowserContext) {
        this.context = context;
        this.events = new EventEmitter();

        // By default when a new page is created
        // (for any reason - just started, agent clicked something, user did new page), set it to active
        this.context.on('page', this.onPageCreated.bind(this));
    }

    private async onPageCreated(page: Page) {
        // set active page immediately since agent and helpers expect it to exist
        this.setActivePage(page);
    }

    public setActivePage(page: Page) {
        logger.info(`TabManager: Setting active page to ${page.url()}`);
        this.activePage = page;
        this.events.emit('tabChanged', page);
        logger.info(`TabManager: Active page set successfully`);
    }

    async switchTab(index: number) {
        const pages = this.context.pages();
        if (index < 0 || index >= pages.length) {
            throw new Error(`Invalid tab index: ${index}`);
        }
        const page = pages[index];
        await page.bringToFront();
        this.setActivePage(page);
    }

    getActivePage() {
        return this.activePage;
    }

    getPages(): Page[] {
        return this.context.pages();
    }
    
    async retrieveState(): Promise<TabState> {
        //return this.state;
        let activeIndex = -1;
        let tabs = [];
        for (const [i, page] of this.context.pages().entries()) {
            if (page == this.activePage) {
                activeIndex = i;
            }
            // may need retries
            let title: string;
            try {
                title = await page.title();
            } catch {
                logger.warn('Could not load page title while retrieving tab state');
                title = '(could not load title)';
            }
            
            const url = page.url();
            tabs.push({ title, url });//, page });
        }
        return {
            activeTab: activeIndex,
            tabs: tabs
        };
    }
}