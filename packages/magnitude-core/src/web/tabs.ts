// Keeps track of current tab, enables describing open tabs, and switching between open tabs
import logger from "@/logger";
import EventEmitter from "eventemitter3";
import { BrowserContext, Page } from "playwright";
import { retryOnErrorIsSuccess } from "@/common";

export interface TabEvents {
  tabChanged: (page: Page) => void;
}

export interface TabState {
  activeTab: number;
  tabs: {
    title: string;
    url: string;
    // causes issues with circular references, and we don't need it
    // page: Page
  }[];
}

export interface TabManagerOptions {
  /** Whether to automatically switch tabs when user activity is detected */
  switchOnActivity?: boolean;
}

export class TabManager {
  /**
   * Page / tab manager
   */
  private context: BrowserContext;
  private activePage!: Page; // the page the agent currently sees and acts on
  public readonly events: EventEmitter<TabEvents>;

  // Track pages the agent should control (never auto-hijack user tabs)
  private agentControlledPages: Set<Page>;

  private options: TabManagerOptions;
  private pollInterval?: NodeJS.Timeout;

  constructor(context: BrowserContext, options: TabManagerOptions = {}) {
    this.context = context;
    this.options = {
      switchOnActivity: true,
      ...options,
    };
    this.events = new EventEmitter();
    this.agentControlledPages = new Set();

    // Track new pages
    this.context.on("page", this.onPageCreated.bind(this));
  }

  async initialize() {
    await this.initializeExistingPages();
  }

  private async initializeExistingPages() {
    const pages = this.context.pages();
    logger.debug(`initializeExistingPages: found ${pages.length} existing pages`);

    // Set up existing pages (skip chat/system UI pages)
    for (const page of pages) {
      if (this.isChatPage(page)) continue;
      logger.debug(`Setting up page: ${safeUrl(page)}`);
      await this.onPageCreated(page);
    }

    // Start polling for activity if enabled
    if (this.options.switchOnActivity && !this.pollInterval) {
      logger.debug("Starting activity polling");
      this.startActivityPolling();
    }
  }

  private async onPageCreated(page: Page) {
    // Skip chrome://chat pages - these are system UI elements
    if (this.isChatPage(page)) return;

    logger.debug(`onPageCreated called for: ${safeUrl(page)}`);

    // Only set as active if this is an agent-controlled page OR if we have no active page yet
    // (Also treat first real page as active for bootstrapping)
    if (
      this.agentControlledPages.has(page) ||
      !this.activePage ||
      this.context.pages().filter((p) => !this.isChatPage(p)).length === 1
    ) {
      this.setActivePage(page);
    }

    // Only set up tracking if switchOnActivity is enabled
    if (this.options.switchOnActivity) {
      // Set up activity tracking immediately
      await this.setupPageTracking(page);

      // Re-inject tracking after navigation
      page.on("load", async () => {
        await this.setupPageTracking(page);

        // If this is the active page and it navigated from about:blank, re-emit tabChanged
        if (this.activePage === page && page.url() !== "about:blank") {
          logger.debug(`Re-emitting tabChanged after navigation to: ${safeUrl(page)}`);
          this.events.emit("tabChanged", page);
        }
      });

      // Also inject on DOMContentLoaded for faster setup
      page.on("domcontentloaded", async () => {
        await this.setupPageTracking(page);
      });
    }

    // Clean up when page closes
    page.on("close", () => {
      if (this.activePage === page) {
        const candidates = this.context
          .pages()
          .filter((p) => !this.isChatPage(p) && !p.isClosed());
        if (candidates.length > 0) {
          this.setActivePage(candidates[0]);
        }
      }
    });

    // Start polling if this is the first page and switchOnActivity is enabled
    if (
      this.context.pages().filter((p) => !this.isChatPage(p)).length === 1 &&
      this.options.switchOnActivity &&
      !this.pollInterval
    ) {
      logger.debug("Starting activity polling from onPageCreated (first page)");
      this.startActivityPolling();
    }
  }

  private isChatPage(page: Page): boolean {
    try {
      const url = page.url();
      return url.includes("chrome://chat") || url.includes("Meteor AI Chat");
    } catch {
      // If we can't get the URL, assume it's not a chat page
      return false;
    }
  }

  public markPageAsAgentControlled(page: Page) {
    // Don't allow chat pages to be marked as agent controlled
    if (this.isChatPage(page)) {
      try {
        logger.info(
          `TabManager: Refusing to mark chat page as agent-controlled: ${page.url()}`
        );
      } catch {}
      return;
    }
    this.agentControlledPages.add(page);
  }

  public unmarkPageAsAgentControlled(page: Page) {
    this.agentControlledPages.delete(page);
  }

  private async setupPageTracking(page: Page) {
    // Inject the tracking script with retries
    await retryOnErrorIsSuccess(
      async () => {
        const currentUrl = safeUrl(page);
        logger.debug(`Setting up tracking for: ${currentUrl}`);

        // Inject activity tracking into the page
        await page.evaluate(() => {
          // Initialize activity tracking storage
          if (!(window as any).__tabActivityTime) {
            (window as any).__tabActivityTime = 0;
          }

          // Set initial activity time to NOW since we're setting up tracking
          // This ensures the initial page is considered active
          (window as any).__tabActivityTime = Date.now();

          // Track any user interaction
          const recordActivity = () => {
            (window as any).__tabActivityTime = Date.now();
          };

          // Remove any existing listeners to avoid duplicates
          const listeners = (window as any).__tabListeners;
          if (listeners) {
            listeners.forEach((l: any) => {
              document.removeEventListener(l.event, l.handler, true);
              window.removeEventListener(l.event, l.handler, true);
            });
          }

          // Store references to our listeners
          const newListeners: any[] = [];

          // Helper to add tracked event listener
          const addTrackedListener = (
            target: any,
            event: string,
            handler: any
          ) => {
            target.addEventListener(event, handler, true);
            newListeners.push({ event, handler });
          };

          // Throttled mouse move handler
          let lastMouseMoveTime = 0;
          const throttledMouseMove = () => {
            const now = Date.now();
            if (now - lastMouseMoveTime > 500) {
              lastMouseMoveTime = now;
              recordActivity();
            }
          };

          // Mouse events
          addTrackedListener(document, "mousedown", recordActivity);
          addTrackedListener(document, "click", recordActivity);
          addTrackedListener(document, "mousemove", throttledMouseMove);
          addTrackedListener(document, "mouseenter", recordActivity);

          // Keyboard events
          addTrackedListener(document, "keydown", recordActivity);

          // Focus events
          addTrackedListener(window, "focus", recordActivity);

          // Scroll events
          let lastScrollTime = 0;
          const throttledScroll = () => {
            const now = Date.now();
            if (now - lastScrollTime > 500) {
              lastScrollTime = now;
              recordActivity();
            }
          };
          addTrackedListener(document, "scroll", throttledScroll);

          // Visibility change
          addTrackedListener(document, "visibilitychange", () => {
            if (!document.hidden) {
              recordActivity();
            }
          });

          // Store listeners for cleanup
          (window as any).__tabListeners = newListeners;
        });
      },
      { mode: "retry_all", delayMs: 200, retryLimit: 5 }
    );
  }

  private startActivityPolling() {
    // Poll for activity every 200ms
    this.pollInterval = setInterval(async () => {
      const pages = this.context.pages();
      let mostRecentPage: Page | null = null;
      let mostRecentTime = 0;

      // Prefer restricting to agent-controlled pages if any exist
      const hasAgentControlled = this.agentControlledPages.size > 0;

      // Find the page with the most recent activity
      for (const page of pages) {
        if (page.isClosed()) continue;
        if (this.isChatPage(page)) continue;
        if (hasAgentControlled && !this.agentControlledPages.has(page)) continue;

        try {
          const lastActivity = await page.evaluate(() => {
            // Initialize if it doesn't exist (defensive programming)
            if (typeof (window as any).__tabActivityTime === "undefined") {
              (window as any).__tabActivityTime = 0;

              // If tracking wasn't set up, return -1 as a signal
              if (!(window as any).__tabListeners) {
                return -1;
              }
            }
            return (window as any).__tabActivityTime;
          });

          // If tracking isn't set up (-1), inject it now
          if (lastActivity === -1) {
            logger.debug(
              `Tracking not set up for ${safeUrl(page)}, injecting now...`
            );
            await this.setupPageTracking(page);
            continue; // Skip this page for this polling cycle
          }

          if (lastActivity > mostRecentTime) {
            mostRecentTime = lastActivity;
            mostRecentPage = page;
          }
        } catch {
          // Page might be navigating
        }
      }

      // Switch to the most recently active page if it's different and activity is recent
      if (
        mostRecentPage &&
        mostRecentPage !== this.activePage &&
        mostRecentTime > Date.now() - 1000 // Activity within last second
      ) {
        logger.trace(
          `Activity detected on ${safeUrl(mostRecentPage)}, switching...`
        );
        this.setActivePage(mostRecentPage);
      }
    }, 200);
  }

  public setActivePage(page: Page) {
    const isInitialPage = !this.activePage;

    if (this.activePage === page && !isInitialPage) {
      return;
    }

    try {
      logger.info(`TabManager: Setting active page to ${page.url()}`);
    } catch {}
    this.activePage = page;
    this.events.emit("tabChanged", page);
    logger.info(`TabManager: Active page set successfully`);

    // Replace navigation listener
    page.removeAllListeners?.("framenavigated");
    page.on("framenavigated", async (frame) => {
      if (frame === page.mainFrame()) {
        // const url = frame.url();
        // await logNavigation(url);
      }
    });
  }

  async switchTab(index: number) {
    // Get filtered pages (non-chat pages only)
    const allPages = this.context.pages();
    const filteredPages = allPages.filter((page) => !this.isChatPage(page));

    if (index < 0 || index >= filteredPages.length) {
      throw new Error(
        `Invalid tab index: ${index} (${filteredPages.length} non-chat tabs available)`
      );
    }

    const page = filteredPages[index];

    // When agent explicitly switches to a tab, mark it as controlled
    this.markPageAsAgentControlled(page);

    // Do not bring the tab to front; keep user focus on their tab.
    // await page.bringToFront();

    this.setActivePage(page);
  }

  getActivePage() {
    return this.activePage;
  }

  getPages(): Page[] {
    return this.context.pages();
  }

  async retrieveState(): Promise<TabState> {
    let activeIndex = -1;
    const tabs: { title: string; url: string }[] = [];
    let visibleIndex = 0; // index among filtered (non-chat) tabs

    for (const page of this.context.pages()) {
      // Skip chat pages - don't include them in the tab state
      if (this.isChatPage(page)) continue;

      if (page === this.activePage) {
        activeIndex = visibleIndex;
      }

      let title: string;
      try {
        title = await page.title();
      } catch {
        logger.warn("Could not load page title while retrieving tab state");
        title = "(could not load title)";
      }

      const url = page.url();
      tabs.push({ title, url });
      visibleIndex++;
    }

    return {
      activeTab: activeIndex,
      tabs,
    };
  }

  async debugVisibilityStates() {
    const states = await Promise.all(
      this.context.pages().map(async (page, i) => {
        try {
          const hasFocus = await page.evaluate(() => ({
            hasFocus: document.hasFocus(),
            hidden: document.hidden,
            visibilityState: document.visibilityState,
          }));
          return { index: i, url: page.url(), ...hasFocus };
        } catch {
          return { index: i, url: page.url(), error: true };
        }
      })
    );
    return states;
  }

  async debugFocusStates() {
    const states = await Promise.all(
      this.context.pages().map(async (page, i) => {
        try {
          const state = await page.evaluate(() => ({
            hasFocus: document.hasFocus(),
            isVisible: document.visibilityState === "visible",
            isHidden: document.hidden,
            url: window.location.href,
          }));
          return { index: i, ...state };
        } catch {
          return { index: i, url: page.url(), error: true };
        }
      })
    );
    console.log("Focus states:", states);
    return states;
  }

  // Clean up
  destroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }
}

/** Helper to safely log page.url() */
function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "(unavailable-url)";
  }
}
