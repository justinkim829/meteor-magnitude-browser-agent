import { AgentError } from "@/agent/errors";
import { ActionDefinition, ActionPayload, createAction } from ".";
import { z } from "zod";

// Node 18+ provides global fetch at runtime; declare for TS type compatibility
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const fetch: any;

export const doneAction = createAction({
    name: 'task:done',
    description: "ONLY once you have seen sufficient evidence of the task's completion, mark it as done",//Use once sure that task is finished',//'Designate current task as finished',// Do not use until you can verify the task is completed.
    schema: z.object({
        evidence: z.string().describe(`Specific observed evidence that verifies the task's completion. Do NOT predict this evidence.`)
    }),
    resolver: async ({ agent }) => {
        agent.queueDone();
    },
    render: () => `✓ done`
});

export const failAction = createAction({
    name: 'task:fail',
    description: 'Use if task was attempted but does not seem possible. Use common sense',//'Designate current task as infeasible',
    schema: z.object({}),
    resolver: async ({ agent }) => {
        throw new AgentError(`Task failed: ${agent.memory.getLastThoughtMessage() ?? "No thought recorded"}`);
    },
    render: () => `✕ fail`
});

export const requestInterventionAction = createAction({
    name: 'task:request_intervention',
    description: 'Request the user to intervene (e.g., log in, fill sensitive info), then resume when they continue.',
    schema: z.object({
        message: z.string().describe('What you need the user to do'),
        context: z.string().optional().describe('Optional extra context')
    }),
    resolver: async ({ input: { message, context }, agent }) => {
        // Read task id injected by host (MCP server) when creating the agent
        const taskId = (agent as any).taskId ?? 0;
        const port = process.env.MAGNITUDE_MCP_PORT || process.env.MAGNITUDE_PORT || '9123';
        const baseUrl = `http://localhost:${port}`;
        const apiKey = process.env.MCP_API_KEY || 'default-mcp-key';

        try {
            // Register the intervention request
            const resp = await fetch(`${baseUrl}/mcp/intervention/request`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey
                },
                body: JSON.stringify({ taskId, message, context })
            });
            if (!resp?.ok) {
                throw new Error(`Failed to register intervention (status ${resp?.status})`);
            }

            // Poll for completion
            const timeoutMs = 5 * 60 * 1000; // 5 minutes
            const start = Date.now();
            // Small initial delay to allow overlay to render
            await new Promise(r => setTimeout(r, 500));

            while (Date.now() - start < timeoutMs) {
                const statusResp = await fetch(`${baseUrl}/mcp/intervention/status/${taskId}`, {
                    method: 'GET',
                    headers: { 'X-API-Key': apiKey }
                });
                if (statusResp?.ok) {
                    const data = await statusResp.json();
                    if (data && data.resolved) {
                        if (data.action === 'continue') {
                            return; // resume execution
                        } else if (data.action === 'stop') {
                            throw new AgentError(data.message || 'Task stopped by user', { variant: 'cancelled' });
                        }
                    }
                }
                // Wait before next poll
                await new Promise(r => setTimeout(r, 1500));
            }

            throw new AgentError('User intervention timed out', { variant: 'cancelled' });
        } catch (e: any) {
            throw new AgentError(`Intervention failed: ${e?.message || String(e)}`, { variant: 'unknown', adaptable: true });
        }
    },
    render: ({ message }) => `⏸ request user intervention: ${message}`
});

export const taskActions = [
    doneAction,
    failAction,
    requestInterventionAction
] as const;
