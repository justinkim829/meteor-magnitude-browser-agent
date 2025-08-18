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
    private agentControlledPages: Set<Page>; // Track pages the agent should control

    constructor(context: BrowserContext) {
        this.context = context;
        this.events = new EventEmitter();
        this.agentControlledPages = new Set();

        // Only set pages as active if the agent explicitly controls them
        // Don't automatically hijack user-created tabs
        this.context.on('page', this.onPageCreated.bind(this));
    }

    private async onPageCreated(page: Page) {
        // Skip chrome://chat pages - these are system UI elements
        if (this.isChatPage(page)) {
            return;
        }
        
        // Only set as active if this is an agent-controlled page or if we have no active page yet
        if (this.agentControlledPages.has(page) || !this.activePage) {
            this.setActivePage(page);
        }
    }

    private isChatPage(page: Page): boolean {
        try {
            const url = page.url();
            return url.includes('chrome://chat') || url.includes('Meteor AI Chat');
        } catch (error) {
            // If we can't get the URL, assume it's not a chat page
            return false;
        }
    }

    public markPageAsAgentControlled(page: Page) {
        // Don't allow chat pages to be marked as agent controlled
        if (this.isChatPage(page)) {
            logger.info(`TabManager: Refusing to mark chat page as agent-controlled: ${page.url()}`);
            return;
        }
        this.agentControlledPages.add(page);
    }

    public unmarkPageAsAgentControlled(page: Page) {
        this.agentControlledPages.delete(page);
    }

    public setActivePage(page: Page) {
        logger.info(`TabManager: Setting active page to ${page.url()}`);
        this.activePage = page;
        this.events.emit('tabChanged', page);
        logger.info(`TabManager: Active page set successfully`);
    }

    async switchTab(index: number) {
        // Get filtered pages (non-chat pages only)
        const allPages = this.context.pages();
        const filteredPages = allPages.filter(page => !this.isChatPage(page));
        
        if (index < 0 || index >= filteredPages.length) {
            throw new Error(`Invalid tab index: ${index} (${filteredPages.length} non-chat tabs available)`);
        }
        
        const page = filteredPages[index];
        
        // When agent explicitly switches to a tab, mark it as controlled
        this.markPageAsAgentControlled(page);
        // Do not bring the tab to front; keep user focus on their tab.
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
        let visibleTabIndex = 0; // Index in the filtered tab list
        
        for (const [i, page] of this.context.pages().entries()) {
            // Skip chat pages - don't include them in the tab state
            if (this.isChatPage(page)) {
                continue;
            }
            
            if (page == this.activePage) {
                activeIndex = visibleTabIndex;
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
            visibleTabIndex++;
        }
        return {
            activeTab: activeIndex,
            tabs: tabs
        };
    }
}