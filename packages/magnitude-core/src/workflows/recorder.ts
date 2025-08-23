import { Workflow, WorkflowMetadata, WorkflowStep } from './types';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class WorkflowRecorder {
    private steps: WorkflowStep[] = [];
    private metadata: WorkflowMetadata;

    constructor(meta: Omit<WorkflowMetadata, 'createdAt' | 'workflowVersion'>) {
        this.metadata = {
            ...meta,
            createdAt: new Date().toISOString(),
            workflowVersion: 1,
        };
    }

    record(step: WorkflowStep) {
        this.steps.push(step);
    }

    getSteps(): WorkflowStep[] { return this.steps; }

    getWorkflow(): Workflow {
        return { metadata: this.metadata, steps: this.steps };
    }

    async save(directory: string, fileName?: string): Promise<string> {
        const safeName = fileName || `${this.metadata.name || 'workflow'}-${Date.now()}.workflow.json`;
        const outDir = path.resolve(directory);
        await fs.mkdir(outDir, { recursive: true });
        const fullPath = path.join(outDir, safeName);
        await fs.writeFile(fullPath, JSON.stringify(this.getWorkflow(), null, 2), 'utf8');
        return fullPath;
    }
}


