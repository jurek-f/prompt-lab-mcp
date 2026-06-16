import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as state from './state.js';

const sessions = new Map<string, StreamableHTTPServerTransport>();

const testCaseSchema = z.array(
  z.object({
    query: z.string().describe('The input to send to the model'),
    targetAnswer: z.string().optional().describe('What a correct response should contain or achieve'),
    queryType: z
      .enum(['explain', 'generate', 'transform', 'extract', 'compare', 'reason', 'classify'])
      .optional()
      .describe('Query category — used to group failures by type during analysis'),
  })
).describe('Test cases to run');

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'overhang-mcp', version: '0.1.0' });

  // ── Session / workspace ──────────────────────────────────────────────────────

  server.tool(
    'start_web_app',
    [
      'Open the prompt lab web UI. Returns the URL for the browser.',
      '',
      'If no workspaceId is given, creates a new empty workspace.',
      'If workspaceId is given, connects to that workspace (must exist).',
      '',
      'Always pass your environment API keys — they enable the UI Send button.',
      'Check each env var and pass it if set:',
      '  anthropicApiKey: process.env.ANTHROPIC_API_KEY',
      '  geminiApiKey:    process.env.GEMINI_API_KEY',
      '  openaiApiKey:    process.env.OPENAI_API_KEY',
      '',
      'After returning the URL, call list_models to register available models.',
      'Then set_system_prompt and add_test_cases before running optimization.',
    ].join('\n'),
    {
      workspaceId: z.string().optional().describe('Existing workspace ID. Omit to create a new workspace.'),
      label: z.string().optional().describe('Label for new workspace (ignored if workspaceId given)'),
      anthropicApiKey: z.string().optional(),
      geminiApiKey: z.string().optional(),
      openaiApiKey: z.string().optional(),
    },
    async ({ workspaceId, label, anthropicApiKey, geminiApiKey, openaiApiKey }) => {
      let id = workspaceId;
      if (!id) {
        const { session } = state.createWorkspace(label);
        state.initLabWorkspace(session.id, '');
        id = session.id;
      } else if (!state.getLabState(id)) {
        state.initLabWorkspace(id, '');
      }
      // Register only agent-provided keys — never clobber with server env vars
      // (server env vars may be stale/invalid; agent passes its own keys explicitly)
      if (anthropicApiKey) state.setLabApiKey(id, anthropicApiKey, 'anthropic');
      if (geminiApiKey) state.setLabApiKey(id, geminiApiKey, 'google');
      if (openaiApiKey) state.setLabApiKey(id, openaiApiKey, 'openai');
      // Auto-populate models from registered keys
      const lab = state.getLabState(id);
      if (lab && !lab.availableModels?.length) {
        const keys = state.getLabApiKeys(id) ?? {};
        const models: string[] = [];
        if (keys.google) models.push('gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro');
        if (keys.anthropic) models.push('claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8');
        if (keys.openai) models.push('gpt-4o-mini', 'gpt-4o');
        if (models.length) {
          const PRIORITY = ['gemini-2.5-flash-lite', 'claude-haiku-4-5-20251001', 'gpt-4o-mini'];
          const defaultModel = PRIORITY.find(m => models.includes(m)) ?? models[0];
          state.setLabModels(id, models, defaultModel);
        }
      }
      const url = `${process.env.PROMPT_LAB_UI_URL ?? 'https://prompt-lab-mcp.vercel.app'}?s=${id}`;
      return {
        content: [{
          type: 'text',
          text: `Prompt lab UI ready.\nURL          : ${url}\nWorkspace ID : ${id}\n\nNext: call list_models, then set_system_prompt and add_test_cases.`,
        }],
      };
    }
  );

  server.tool(
    'list_models',
    [
      'Register available AI models and API keys for this workspace.',
      '',
      'Call once after start_web_app. Scan your environment for API keys and Ollama:',
      '1. process.env.ANTHROPIC_API_KEY → add claude-haiku-4-5-20251001, claude-sonnet-4-6, claude-opus-4-8',
      '2. process.env.GEMINI_API_KEY    → add gemini-2.5-flash-lite, gemini-2.5-flash, gemini-2.5-pro',
      '3. process.env.OPENAI_API_KEY    → add gpt-4o-mini, gpt-4o',
      '4. Ollama: fetch (process.env.OLLAMA_URL ?? "http://localhost:11434") + "/api/tags"',
      '   → add each model.name; catch errors silently',
      '',
      'Default model priority (first available wins):',
      '  gemini-2.5-flash-lite → claude-haiku-4-5-20251001 → gpt-4o-mini',
    ].join('\n'),
    {
      workspaceId: z.string(),
      models: z.array(z.string()).describe('All model IDs available in your environment'),
      defaultModel: z.string().optional().describe('Override the priority-based default'),
      anthropicApiKey: z.string().optional(),
      geminiApiKey: z.string().optional(),
      openaiApiKey: z.string().optional(),
    },
    async ({ workspaceId, models, defaultModel, anthropicApiKey, geminiApiKey, openaiApiKey }) => {
      const PRIORITY = ['gemini-2.5-flash-lite', 'claude-haiku-4-5-20251001', 'gpt-4o-mini'];
      const selected = defaultModel ?? PRIORITY.find(m => models.includes(m)) ?? models[0] ?? '';
      const lab = state.setLabModels(workspaceId, models, selected);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      if (anthropicApiKey) state.setLabApiKey(workspaceId, anthropicApiKey, 'anthropic');
      if (geminiApiKey) state.setLabApiKey(workspaceId, geminiApiKey, 'google');
      if (openaiApiKey) state.setLabApiKey(workspaceId, openaiApiKey, 'openai');
      const keys = state.getLabApiKeys(workspaceId) ?? {};
      const providers = Object.keys(keys).filter(k => !!keys[k]);
      return {
        content: [{
          type: 'text',
          text: `Models registered: ${models.join(', ') || 'none'}\nDefault: ${selected}\nAPI keys: ${providers.join(', ') || 'none'}`,
        }],
      };
    }
  );

  server.tool(
    'register_api_key',
    [
      'Register a provider API key for this workspace.',
      '',
      'Use this when you need to register a key that was not passed to start_web_app.',
      'Specify provider explicitly: anthropic | google | openai.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      apiKey: z.string(),
      provider: z.enum(['anthropic', 'google', 'openai']),
    },
    async ({ workspaceId, apiKey, provider }) => {
      const lab = state.setLabApiKey(workspaceId, apiKey, provider);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      // Update model list and selected model
      const keys = state.getLabApiKeys(workspaceId) ?? {};
      const models: string[] = [];
      if (keys.google) models.push('gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro');
      if (keys.anthropic) models.push('claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8');
      if (keys.openai) models.push('gpt-4o-mini', 'gpt-4o');
      const PRIORITY = ['gemini-2.5-flash-lite', 'claude-haiku-4-5-20251001', 'gpt-4o-mini'];
      const defaultModel = PRIORITY.find(m => models.includes(m)) ?? models[0];
      if (models.length) state.setLabModels(workspaceId, models, defaultModel);
      return { content: [{ type: 'text', text: `${provider} API key registered for workspace ${workspaceId}.\nSelected model updated to: ${defaultModel ?? 'none'}` }] };
    }
  );

  // ── Templates (global, no workspace needed) ──────────────────────────────────

  server.tool(
    'save_template',
    [
      'Save a named test suite template so it appears in the UI "Load test suite…" dropdown.',
      '',
      'Call at session startup for every .json file in prompt-lab/templates/:',
      '  save_template(name=<file.name>, testCases=<file.testCases>)',
      '',
      'Template format (matches what the UI exports as a downloadable JSON):',
      '  { "name": "suite-name", "savedAt": "...", "testCases": [{ "label"?, "query",',
      '    "targetAnswer"?, "passThreshold"?, "queryType"? }] }',
      '',
      'Templates persist in Redis. Saving with the same name replaces the previous version.',
    ].join('\n'),
    {
      name: z.string().describe('Template name (shown in UI dropdown)'),
      testCases: z.array(z.object({
        label: z.string().optional().describe('Short display label'),
        query: z.string(),
        targetAnswer: z.string().optional(),
        passThreshold: z.number().min(0).max(1).optional().describe('0–1, default 0.7'),
        queryType: z.enum(['explain', 'generate', 'transform', 'extract', 'compare', 'reason', 'classify']).optional(),
      })),
    },
    async ({ name, testCases }) => {
      const tpl = state.saveTemplate(name, testCases);
      return {
        content: [{ type: 'text', text: `Test suite template "${tpl.name}" saved — ${tpl.testCases.length} test case(s) visible in UI dropdown.` }],
      };
    }
  );

  server.tool(
    'save_system_prompt_template',
    [
      'Save a named system prompt template so it appears in the UI "Load template…" dropdown.',
      '',
      'Call at session startup for every .txt file in prompt-lab/system-prompts/:',
      '  save_system_prompt_template(name=<filename without extension>, content=<file contents>)',
      '',
      'Also call after a successful optimization loop to preserve the best prompt found.',
      '',
      'Templates persist in Redis. Saving with the same name replaces the previous version.',
    ].join('\n'),
    {
      name: z.string().describe('Template name (shown in UI dropdown)'),
      content: z.string().describe('System prompt text'),
    },
    async ({ name, content }) => {
      const tpl = state.saveSystemPromptTemplate(name, content);
      return {
        content: [{ type: 'text', text: `System prompt template "${tpl.name}" saved and visible in UI dropdown.` }],
      };
    }
  );

  // ── Workspace setup ──────────────────────────────────────────────────────────

  server.tool(
    'set_system_prompt',
    [
      'Set or update the system prompt for this workspace.',
      '',
      'Does NOT increment the iteration counter — use this for initial setup',
      'or manual overrides. To record an optimization step, use apply_suggestion.',
      '',
      'Load the current prompt from current.json or ask the user before overwriting.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      systemPrompt: z.string().describe('The full system prompt text'),
    },
    async ({ workspaceId, systemPrompt }) => {
      const lab = state.setLabSystemPrompt(workspaceId, systemPrompt);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      return {
        content: [{ type: 'text', text: `System prompt set (${systemPrompt.length} chars). Iteration: ${lab.currentIteration}.` }],
      };
    }
  );

  server.tool(
    'add_test_cases',
    [
      'Add test cases to this workspace.',
      '',
      'Set replace: true to clear the existing suite and load a fresh one.',
      'Set replace: false (default) to append to the existing suite.',
      '',
      'Each test case needs at least a query. targetAnswer is required for scoring.',
      'Omit targetAnswer only for exploratory runs where you score manually.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      testCases: testCaseSchema,
      replace: z.boolean().optional().describe('Replace all existing test cases. Default false (append).'),
    },
    async ({ workspaceId, testCases, replace = false }) => {
      const created = state.addLabTestCases(workspaceId, testCases.map(tc => ({ ...tc, source: 'agent' as const })), replace);
      if (!created) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      const lab = state.getLabState(workspaceId)!;
      return {
        content: [{
          type: 'text',
          text: `Added ${created.length} test case(s). Workspace now has ${lab.testCases.length} total.\n` +
            created.map((tc, i) => `  ${i + 1}. [${tc.id}] ${tc.query.slice(0, 80)}`).join('\n'),
        }],
      };
    }
  );

  // ── Primary optimization / regression ────────────────────────────────────────

  server.tool(
    'start_optimization_session',
    [
      'Run one optimization pass on an existing workspace.',
      '',
      'Prerequisites (do these first):',
      '  1. start_web_app → workspace URL + ID',
      '  2. set_system_prompt → starting prompt',
      '  3. add_test_cases → at least one case with targetAnswer',
      '',
      'What this does:',
      '  1. Read system prompt and test cases from get_workspace_state.',
      '  2. Run each test case against the model (write + execute a temp Node.js script).',
      '  3. Score each response vs targetAnswer (LLM-as-judge, 0–100), call post_test_result.',
      '  4. Analyse failures, write improved prompt, call post_prompt_suggestion.',
      '  5. Present the suggestion — do NOT auto-apply. User reviews in the UI.',
      '',
      'This is one iteration. After the user approves or rejects the suggestion,',
      'call start_optimization_session again or switch to loop_optimization.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      threshold: z.number().min(0).max(100).optional().describe('Pass score 0–100 (default 70)'),
      maxIterations: z.number().int().positive().optional().describe('Goal iterations for tracking (default 5)'),
    },
    async ({ workspaceId, threshold = 70, maxIterations = 5 }) => {
      const lab = state.getLabState(workspaceId);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found. Call start_web_app first.` }] };
      if (lab.testCases.length === 0) return { content: [{ type: 'text', text: `No test cases in workspace ${workspaceId}. Call add_test_cases first.` }] };
      if (!lab.optimizationGoal) {
        state.initLabWorkspace(workspaceId, lab.systemPrompt, { targetScore: threshold, maxIterations });
      }
      const url = `${process.env.PROMPT_LAB_UI_URL ?? 'https://prompt-lab-mcp.vercel.app'}?s=${workspaceId}`;
      return {
        content: [{
          type: 'text',
          text: [
            `Ready. Run one optimization pass.`,
            `Workspace : ${workspaceId}`,
            `UI        : ${url}`,
            `Threshold : ${threshold}%  max: ${maxIterations} iterations`,
            `Prompt    : ${lab.systemPrompt.slice(0, 100)}${lab.systemPrompt.length > 100 ? '…' : ''}`,
            ``,
            `Test cases (${lab.testCases.length}):`,
            ...lab.testCases.map((tc, i) =>
              `  ${i + 1}. [${tc.id}] ${tc.query.slice(0, 80)}${tc.targetAnswer ? `\n     → ${tc.targetAnswer.slice(0, 60)}` : ''}`
            ),
          ].join('\n'),
        }],
      };
    }
  );

  server.tool(
    'loop_optimization',
    [
      'Run the full optimization loop until the threshold is met or max iterations reached.',
      '',
      'Like start_optimization_session but auto-applies each suggestion and repeats.',
      '',
      'Prerequisites: same as start_optimization_session.',
      '',
      'Loop:',
      '  1. Run all test cases, score responses, call post_test_result for each.',
      '  2. Call get_regression_status.',
      '  3. If ALL scores >= threshold AND iteration >= 1 → SUCCESS.',
      '  4. If iteration >= maxIterations → EXHAUSTED. Report best result.',
      '  5. Analyse failures, write improved prompt (targeted — fix pattern, keep what works).',
      '  6. Call post_prompt_suggestion then apply_suggestion (auto authorised in loop mode).',
      '  7. Go to 1.',
      '',
      'Do NOT stop after the first pass because it is passing — first pass is a baseline.',
      'Always run at least one improvement cycle.',
      '',
      'After the loop: call pull_ui_history, save optimization results locally,',
      'call save_system_prompt_template with the best prompt found.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      threshold: z.number().min(0).max(100).optional().describe('Pass score 0–100 (default 70)'),
      maxIterations: z.number().int().positive().optional().describe('Max loop iterations (default 5)'),
    },
    async ({ workspaceId, threshold = 70, maxIterations = 5 }) => {
      const lab = state.getLabState(workspaceId);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found. Call start_web_app first.` }] };
      if (lab.testCases.length === 0) return { content: [{ type: 'text', text: `No test cases in workspace ${workspaceId}. Call add_test_cases first.` }] };
      state.initLabWorkspace(workspaceId, lab.systemPrompt, { targetScore: threshold, maxIterations });
      const url = `${process.env.PROMPT_LAB_UI_URL ?? 'https://prompt-lab-mcp.vercel.app'}?s=${workspaceId}`;
      return {
        content: [{
          type: 'text',
          text: [
            `Optimization loop started. Run until ${threshold}% (all passing) or ${maxIterations} iterations.`,
            `Workspace : ${workspaceId}`,
            `UI        : ${url}`,
            `Prompt    : ${lab.systemPrompt.slice(0, 100)}${lab.systemPrompt.length > 100 ? '…' : ''}`,
            ``,
            `Test cases (${lab.testCases.length}):`,
            ...lab.testCases.map((tc, i) =>
              `  ${i + 1}. [${tc.id}] ${tc.query.slice(0, 80)}${tc.targetAnswer ? `\n     → ${tc.targetAnswer.slice(0, 60)}` : ''}`
            ),
          ].join('\n'),
        }],
      };
    }
  );

  server.tool(
    'run_regression_testsuite',
    [
      'Run all test cases against the current system prompt. Single pass — does not auto-improve.',
      '',
      'Use this to verify an already-good prompt still passes all test cases.',
      'For automatic improvement loops, use loop_regression.',
      '',
      'Steps to follow after this call:',
      '  1. Run each test case against the model, score the response, call post_test_result.',
      '  2. Call get_regression_status to see pass/fail summary.',
      '  3. Optionally: post_prompt_suggestion with an improvement (user reviews).',
    ].join('\n'),
    {
      workspaceId: z.string(),
      threshold: z.number().min(0).max(100).optional().describe('Pass score 0–100 (default 70)'),
    },
    async ({ workspaceId, threshold = 70 }) => {
      const lab = state.getLabState(workspaceId);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      if (lab.testCases.length === 0) return { content: [{ type: 'text', text: `No test cases in workspace ${workspaceId}. Load a test suite via add_test_cases first.` }] };
      const status = state.getLabRegressionStatus(workspaceId, threshold)!;
      return {
        content: [{
          type: 'text',
          text: [
            `Run regression testsuite for workspace ${workspaceId}`,
            `Iteration  : ${lab.currentIteration}`,
            `Threshold  : ${threshold}%`,
            `Prompt     : ${lab.systemPrompt.slice(0, 100)}${lab.systemPrompt.length > 100 ? '…' : ''}`,
            `Prior rate : ${status.passRate}% (${status.passCount} pass / ${status.failCount} fail / ${status.untestedCount} untested)`,
            ``,
            `Test cases (${lab.testCases.length}):`,
            ...lab.testCases.map((tc, i) =>
              `  ${i + 1}. [${tc.id}] ${tc.query.slice(0, 80)}${tc.targetAnswer ? `\n     → ${tc.targetAnswer.slice(0, 60)}` : ''}`
            ),
          ].join('\n'),
        }],
      };
    }
  );

  server.tool(
    'loop_regression',
    [
      'Run the full regression loop: test all cases → score → improve → repeat.',
      '',
      'Stops when BOTH conditions are met:',
      '  - Overall pass rate >= threshold',
      '  - Every individual test case score >= threshold',
      'Or when max iterations are exhausted.',
      '',
      'Loop:',
      '  1. Run all test cases, score responses, call post_test_result for each.',
      '  2. Call get_regression_status.',
      '  3. If pass rate >= threshold AND all individual scores >= threshold → SUCCESS.',
      '  4. If iteration >= maxIterations → EXHAUSTED. Report best result.',
      '  5. Analyse failures, write improved prompt, call post_prompt_suggestion + apply_suggestion.',
      '  6. Go to 1.',
      '',
      'After the loop: call pull_ui_history and save results locally.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      threshold: z.number().min(0).max(100).optional().describe('Pass score 0–100 (default: workspace goal or 70)'),
      maxIterations: z.number().int().positive().optional().describe('Max iterations (default: workspace goal or 5)'),
    },
    async ({ workspaceId, threshold, maxIterations }) => {
      const lab = state.getLabState(workspaceId);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      if (lab.testCases.length === 0) return { content: [{ type: 'text', text: `No test cases in workspace ${workspaceId}. Load a test suite via add_test_cases first.` }] };
      const t = threshold ?? lab.optimizationGoal?.targetScore ?? 70;
      const m = maxIterations ?? lab.optimizationGoal?.maxIterations ?? 5;
      const status = state.getLabRegressionStatus(workspaceId, t)!;
      return {
        content: [{
          type: 'text',
          text: [
            `Regression loop for workspace ${workspaceId}`,
            `Target     : ${t}% pass rate (mean AND each case), max ${m} iterations`,
            `Iteration  : ${lab.currentIteration}`,
            `Current    : ${status.passRate}% (${status.passCount} pass / ${status.failCount} fail / ${status.untestedCount} untested)`,
            `Prompt     : ${lab.systemPrompt.slice(0, 100)}${lab.systemPrompt.length > 100 ? '…' : ''}`,
            ``,
            `Test cases (${lab.testCases.length}):`,
            ...lab.testCases.map((tc, i) =>
              `  ${i + 1}. [${tc.id}] ${tc.query.slice(0, 80)}${tc.targetAnswer ? `\n     → ${tc.targetAnswer.slice(0, 60)}` : ''}`
            ),
          ].join('\n'),
        }],
      };
    }
  );

  // ── Internal building blocks ─────────────────────────────────────────────────

  server.tool(
    'get_workspace_state',
    [
      'Read the full current state of a workspace.',
      '',
      'Returns: system prompt, test cases, test results, suggestions, iteration counter,',
      'optimization goal, available models, selected model, and active query/target.',
      '',
      'Call at the start of each session to recover state after a context break.',
      'Also call before running tests to get the latest test case IDs.',
    ].join('\n'),
    {
      workspaceId: z.string(),
    },
    async ({ workspaceId }) => {
      const lab = state.getLabState(workspaceId);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      return { content: [{ type: 'text', text: JSON.stringify(lab, null, 2) }] };
    }
  );

  server.tool(
    'post_test_result',
    [
      'Store the scored result of one test case run.',
      '',
      'Call after you run a test case against the model and evaluate the response.',
      'This makes the result visible in the UI and is used by get_regression_status.',
      '',
      'Score 0–100 using this scale:',
      '  90–100: Correct, complete, well-structured — exceeds target.',
      '  70–89:  Correct and complete — minor gaps or style issues.',
      '  50–69:  Partially correct — key points present but missing important details.',
      '  30–49:  Mostly wrong — one or two relevant points but fundamentally off.',
      '  0–29:   Completely wrong, off-topic, or refused.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      testCaseId: z.string().describe('ID from get_workspace_state testCases'),
      response: z.string().describe('The full model response'),
      score: z.number().min(0).max(100).describe('Quality score 0–100'),
      reasoning: z.string().describe('Why this score — what worked, what failed'),
      model: z.string().describe('Model used, e.g. claude-haiku-4-5-20251001'),
    },
    async ({ workspaceId, testCaseId, response, score, reasoning, model }) => {
      const result = state.addLabTestResult(workspaceId, { testCaseId, response, score, reasoning, model });
      if (!result) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    'post_prompt_suggestion',
    [
      'Queue a revised system prompt for the user to review.',
      '',
      'Always explain in reasoning:',
      '  - which test cases were failing and why',
      '  - what specific change you made to the prompt',
      '  - why you expect this change to fix those cases',
      '',
      'In gated mode (start_optimization_session): user reviews in UI, then approves or rejects.',
      'In loop mode (loop_optimization, loop_regression): call apply_suggestion immediately after.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      prompt: z.string().describe('The full revised system prompt'),
      reasoning: z.string().describe('What changed and why'),
      expectedGain: z.string().optional().describe('e.g. "fixes failing classify queries by adding format instructions"'),
    },
    async ({ workspaceId, prompt, reasoning, expectedGain }) => {
      const suggestion = state.addLabSuggestion(workspaceId, { prompt, reasoning, expectedGain });
      if (!suggestion) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      return { content: [{ type: 'text', text: JSON.stringify(suggestion) }] };
    }
  );

  server.tool(
    'apply_suggestion',
    [
      'Apply a pending suggestion: sets it as the active system prompt and increments the iteration counter.',
      '',
      'Only call in fully automated loop mode (loop_optimization, loop_regression).',
      'In gated mode, wait for the user to approve via the UI.',
    ].join('\n'),
    {
      workspaceId: z.string(),
      suggestionId: z.string().describe('ID from post_prompt_suggestion response'),
    },
    async ({ workspaceId, suggestionId }) => {
      const suggestion = state.updateLabSuggestion(workspaceId, suggestionId, 'applied');
      if (!suggestion) return { content: [{ type: 'text', text: `Workspace or suggestion not found.` }] };
      const lab = state.getLabState(workspaceId)!;
      return {
        content: [{
          type: 'text',
          text: `Suggestion applied. Iteration: ${lab.currentIteration}. Run test cases again and call get_regression_status.`,
        }],
      };
    }
  );

  server.tool(
    'get_regression_status',
    [
      'Pass/fail summary across all test cases for the current system prompt.',
      '',
      'Call after running all test cases to decide: is the prompt good enough, or improve further?',
      'A test case passes if its most recent score >= threshold (default 70).',
    ].join('\n'),
    {
      workspaceId: z.string(),
      threshold: z.number().min(0).max(100).optional().describe('Minimum score to pass (default 70)'),
    },
    async ({ workspaceId, threshold = 70 }) => {
      const status = state.getLabRegressionStatus(workspaceId, threshold);
      if (!status) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      const goal = status.optimizationGoal;
      const goalMet = goal && status.passRate >= goal.targetScore;
      const summary = [
        `Regression status — iteration ${status.iteration}`,
        `Pass rate    : ${status.passRate}% (${status.passCount}/${status.passCount + status.failCount} tested)`,
        `Average score: ${status.averageScore}/100`,
        `Untested     : ${status.untestedCount}`,
        goal ? `Goal         : ${goal.targetScore}% — ${goalMet ? 'REACHED ✓' : 'not yet'} (max ${goal.maxIterations} iter)` : '',
        ``,
        `By test case:`,
        ...status.byTestCase.map(t =>
          `  [${t.status.toUpperCase()}] ${t.query.slice(0, 60)}${t.query.length > 60 ? '…' : ''} — ${t.latestScore ?? 'untested'}`
        ),
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  server.tool(
    'set_test_model',
    'Switch the model used for test cases in this workspace. Updates the UI model selector.',
    {
      workspaceId: z.string(),
      model: z.string().describe('Model ID, e.g. gemini-2.5-flash-lite or claude-haiku-4-5-20251001'),
    },
    async ({ workspaceId, model }) => {
      const lab = state.setLabSelectedModel(workspaceId, model);
      if (!lab) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      return { content: [{ type: 'text', text: `Model switched to ${model}.` }] };
    }
  );

  // ── Archive ──────────────────────────────────────────────────────────────────

  server.tool(
    'pull_ui_history',
    [
      'Fetch all history entries the UI has pushed to this workspace.',
      '',
      'The UI auto-pushes after every session summary ("Summarize & new") and every regression run.',
      'This gives you a record of what the user did in the UI between agent calls.',
      '',
      'ALWAYS save the response to a local file:',
      '  prompt-lab/workspaces/<workspaceId>/<YYYYMMDD-HHmmss>_ui_history.json',
    ].join('\n'),
    { workspaceId: z.string() },
    async ({ workspaceId }) => {
      const history = state.getLabHistory(workspaceId);
      if (!history) return { content: [{ type: 'text', text: JSON.stringify({ error: `Workspace ${workspaceId} not found` }) }] };
      const result = {
        workspaceId,
        sessions: history.sessions,
        regressions: history.regressions,
        pulledAt: new Date().toISOString(),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Utility ──────────────────────────────────────────────────────────────────

  server.tool(
    'delete_session',
    'Delete a workspace and all its state (test cases, results, suggestions, API keys). Irreversible.',
    { workspaceId: z.string() },
    async ({ workspaceId }) => {
      const deleted = state.deleteWorkspace(workspaceId);
      if (!deleted) return { content: [{ type: 'text', text: `Workspace ${workspaceId} not found.` }] };
      return { content: [{ type: 'text', text: `Workspace ${workspaceId} deleted.` }] };
    }
  );

  return server;
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId)!;
  } else if (!sessionId) {
    const newServer = createMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport); },
    });
    await newServer.connect(transport);
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid session' }));
    return;
  }

  await transport.handleRequest(req, res, body);
}
