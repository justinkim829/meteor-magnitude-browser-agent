export interface WorkflowMetadata {
    name?: string;
    createdAt: string; // ISO string
    startUrl?: string;
    browser?: {
        mode?: 'cdp' | 'launch' | 'instance' | 'context';
        cdpUrl?: string;
        launchOptions?: Record<string, unknown>;
        contextOptions?: Record<string, unknown>;
    };
    virtualScreenDimensions?: { width: number; height: number };
    workflowVersion: number;
}

export type WorkflowStep =
    | { kind: 'navigate'; url: string }
    | { kind: 'click'; x: number; y: number }
    | { kind: 'doubleClick'; x: number; y: number }
    | { kind: 'rightClick'; x: number; y: number }
    | { kind: 'drag'; x1: number; y1: number; x2: number; y2: number }
    | { kind: 'type'; content: string }
    | { kind: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
    | { kind: 'switchTab'; index: number }
    | { kind: 'newTab' }
    | { kind: 'selectAll' }
    | { kind: 'enter' }
    | { kind: 'backspace' }
    | { kind: 'tab' }
    | { kind: 'goBack' };

export interface Workflow {
    metadata: WorkflowMetadata;
    steps: WorkflowStep[];
}


