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

// export const requestInterventionAction = createAction({
//     name: 'task:request_intervention',
//     description: '[DISABLED] Request the user to intervene ONLY when blocked by login/auth, payment, identity verification, or missing user info needed to proceed right before executing an external/committing action (e.g., before booking a flight). Keep the request short and specific.',
//     schema: z.object({
//         message: z.string().describe('What you need the user to do'),
//         context: z.string().optional().describe('Optional extra context')
//     }),
//     resolver: async ({ input: { message, context }, agent }) => {
//         // Human intervention disabled.
//         throw new AgentError('User intervention is currently disabled', { variant: 'cancelled' });
//     },
//     render: ({ message }) => `⏸ request user intervention: ${message}`
// });

export const taskActions = [
    doneAction,
    failAction,
    // requestInterventionAction // Human intervention disabled
] as const;
