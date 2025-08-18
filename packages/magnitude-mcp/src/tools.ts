import { executeCliCommand, handleError, watchProcessForUrls } from './utils/cliUtils.js';
import { logger } from './utils/logger.js';
import { InitializeProjectInput, RunTestsInput, BuildTestsInput } from './schemas.js';


const configureInstructions = `
NOW: Make sure the url in tests/magnitude/magnitude.config.ts uses the same port as the user's development server, and adjust it if not.
Check ALL OF THE appropriate files (e.g. package.json, .env, webpack.config.js, server.js, app.js, index.js, angular.json, vue.config.js, nuxt.config.js, next.config.js, svelte.config.js, ember-cli-build.js, astro.config.mjs, quasar.conf.js, gatsby-config.js, vite.config.js, remix.config.js, snowpack.config.js) until you are confident what the developement port is.
ALWAYS check at least package.json to see what their dev command is. If you are unsure what the port is, ask the user.
`

/**
 * Initialize a new Magnitude project
 * @param args Arguments for initializing project
 * @returns MCP response
 */
export async function initProject(args: InitializeProjectInput): Promise<any> {
    const { projectDir } = args;
    logger.info('[Setup] Initializing Magnitude project...');

    try {
        // Use the Magnitude CLI with spawn approach
        const installOutput = await executeCliCommand('npm', ['install', 'magnitude-test'], { cwd: projectDir });
        const initOutput = await executeCliCommand('npx', ['magnitude', 'init'], { cwd: projectDir });

        logger.info('[Setup] Magnitude project initialized successfully');

        return {
            content: [
                {
                    type: 'text',
                    text: `${installOutput}\n\n${initOutput}\nMagnitude project initialized successfully.${configureInstructions}`,
                },
            ],
        };
    } catch (error) {
        return handleError('Failed to initialize project', error);
    }
}

const runTestsInstructions = `
Run tests for the user by executing 'npx magnitude'

Usage: npx magnitude [options] [command] [filter]

Run Magnitude test cases

Arguments:
  filter                  glob pattern for test files (quote if contains spaces or wildcards)

Options:
  -w, --workers <number>  number of parallel workers for test execution (default: "1")
  -p, --plain             disable pretty output and use logs
  -l, --local             run agent locally (requires Playwright and LLM provider configuration)
  -t, --tunnel            (remote mode only) force enable HTTP tunneling regardless of whether
                          target URL appears local/private
  -r, --remote <url>      specify a custom remote runner
  -k, --key <apiKey>      provide API key
  -h, --help              display help for command

Run tests according to the user's query using this CLI and appropriate options.

When using directly after a build_tests tool call, run just the new or updated test files using a glob pattern.
`

/**
 * Run Magnitude tests and collect URLs from stdout
 * @param args Arguments for running tests
 * @returns MCP response with collected URLs
 */
export async function runTests(args: RunTestsInput): Promise<any> {
    return {
        content: [
            {
                type: 'text',
                text: runTestsInstructions
            }
        ]
    };
}

const buildTestInstructions = `
The following instructions will guide you on how to build effective test cases in Magnitude.

Magnitude is a test framework for writing test cases in *natural language*.

## Syntax
Example test case:
\`\`\`ts
import { test } from 'magnitude-test';

test('can log in', { url: 'https://example.com/login' }, async ({ ai }) => {
  await ai.step('Enter login credentials', {
    data: { email: "foo@bar.com", password: "foo" }
  });
  await ai.check('Dashboard is visible');
});
\`\`\`

Tests are now defined using an \`async\` function.

Every test case begins with \`test('<what it is testing>', async ({ ai, page, context }) => { ... })\`.
- An optional second argument to \`test\` can provide configuration, such as \`{ url: 'your-target-url' }\`.
- The \`async\` function receives an object typically containing \`ai\` (for Magnitude steps/checks). It can also include Playwright's \`page\` and \`context\` objects if needed for advanced scenarios.

Inside the async function:
- Define natural language steps using \`await ai.step('<description of what to do in the browser>')\`.
    - Data for the step, if any, is passed as a second argument in an options object:
        - \`await ai.step('description', { data: '<freeform description of data>' })\`
        - \`await ai.step('description', { data: { arbitraryKey: 'arbitraryValue' } })\`
- Define natural language checks using \`await ai.check('<visual assertion>')\`.

\`ai.check\`s typically verify the outcome of a preceding \`ai.step\`.
If needed, you can intermingle Playwright calls using the \`page\` and \`context\` objects for tasks like network mocking or direct browser interaction.

## Style
Use standard TypeScript/JavaScript indentation within the \`async\` test function.
\`await ai.step(...)\` and \`await ai.check(...)\` calls are typically at the same indentation level.
Example:
\`\`\`ts
test('example style', async ({ ai }) => {
  await ai.step('Do something', {
    data: { info: 'details' }
  });
  await ai.check('Verify something');

  await ai.step('Do another thing');
  await ai.check('Verify another thing');
});
\`\`\`

## Test Management
Put the test cases in a **new** .mag.ts file if building a fresh page/feature, or edit the relevant **existing** .mag.ts file if expanding on an existing page/feature.

Put related tests in a test.group like this:
\`\`\`ts
import { test } from 'magnitude-test';

test.group('authentication tests', () => {
    test('can log in', async ({ ai }) => {
        await ai.step('Log in', {
            data: { email: "foo@bar.com", password: "foo" }
        });
        await ai.check('Dashboard is visible');
    });
    
    test('can sign up', async ({ ai }) => {
        await ai.step('Sign up for a new account', {
            data: { email: "another@example.com", password: "securePassword123" }
        });
        await ai.check('Profile page is visible');
    });
});
\`\`\`

Unless otherwise specified by the user, only cover the main flows of the page or feature.
Tests should be minimalistic.

## Designing tests
- Keep tests short (a few \`ai.step\`s and \`ai.check\`s).
- Group related tests with test.group.
- \`ai.check\`s should be simple and direct.
- Do not add more \`ai.check\`s than necessary, only enough to generally verify functionality.
- Every test MUST have at least one \`ai.step\`.
- Each \`ai.check\` should logically verify the application state after preceding actions (e.g., an \`ai.step\` or intermingled custom Playwright code).

Now comply with the user's instructions using these building principles.
`;

/**
 * Build test cases by fetching documentation on how to design proper Magnitude test cases
 * @returns MCP response with formatted documentation
 */
export async function buildTests(args: BuildTestsInput): Promise<any> {
    logger.info('[Build] Fetching Magnitude test case documentation');

    return {
        content: [
            {
                type: 'text',
                text: buildTestInstructions
            }
        ]
    }
}
