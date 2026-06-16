import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import * as state from './state.js';


const app = new Hono();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Overhang-Token'],
}));

app.use('*', async (c, next) => {
  await next();
});

// ── Template store ────────────────────────────────────────────────────────────

app.get('/templates', (c) => {
  return c.json({ templates: state.getGlobalTemplates() });
});

app.get('/system-prompt-templates', (c) => {
  return c.json({ templates: state.getSystemPromptTemplates() });
});

// ── Workspace management ──────────────────────────────────────────────────────

app.post('/workspaces', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const label = typeof body?.label === 'string' ? body.label : undefined;
  const { session, url } = state.createWorkspace(label);
  const response: Record<string, unknown> = {
    workspaceId: session.id,
    createdAt: session.createdAt,
  };
  if (label) response.label = label;
  if (url) response.url = url;
  return c.json(response, 201);
});

app.delete('/workspaces/:id', (c) => {
  const deleted = state.deleteWorkspace(c.req.param('id'));
  if (!deleted) return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ ok: true });
});

// ── Prompt lab ────────────────────────────────────────────────────────────────

const LabInitSchema = z.object({
  systemPrompt: z.string().default(''),
  optimizationGoal: z
    .object({
      targetScore: z.number().min(0).max(100),
      maxIterations: z.number().int().positive(),
    })
    .optional(),
});

const LabTestCaseSchema = z.object({
  query: z.string(),
  targetAnswer: z.string().optional(),
  queryType: z
    .enum(['explain', 'generate', 'transform', 'extract', 'compare', 'reason', 'classify'])
    .optional(),
  source: z.enum(['ui', 'agent']).optional(),
});

const LabTestResultSchema = z.object({
  testCaseId: z.string(),
  response: z.string(),
  score: z.number().min(0).max(100),
  reasoning: z.string(),
  model: z.string(),
});

// Init or reinit lab state on a workspace
app.post('/workspaces/:id/lab', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = LabInitSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: 'Invalid request', details: result.error.flatten() }, 400);
  }
  const workspaceId = c.req.param('id');
  if (!state.getWorkspace(workspaceId)) state.createWorkspaceWithId(workspaceId);
  const lab = state.initLabWorkspace(workspaceId, result.data.systemPrompt, result.data.optimizationGoal);
  if (!lab) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(lab, 201);
});

// Get full lab state (API keys stripped — never sent to browser)
app.get('/workspaces/:id/lab', (c) => {
  const lab = state.getLabState(c.req.param('id'));
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  const { apiKey: _k1, apiKeys: _k2, ...safe } = lab;
  const keys = state.getLabApiKeys(c.req.param('id')) ?? {};
  return c.json({
    ...safe,
    hasApiKey: Object.keys(keys).length > 0,
    hasApiKeys: {
      anthropic: !!keys.anthropic,
      google: !!keys.google,
      openai: !!keys.openai,
    },
  });
});

// Get all API keys for server-side use by Vercel /api/ask (never exposed to browser via relay)
app.get('/workspaces/:id/lab/api-key', (c) => {
  const keys = state.getLabApiKeys(c.req.param('id'));
  if (!keys) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json(keys);
});

const PROVIDER_MODELS: Record<string, string[]> = {
  google: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
};
const MODEL_PRIORITY = ['gemini-2.5-flash-lite', 'claude-haiku-4-5-20251001', 'gpt-4o-mini'];

function detectProvider(apiKey: string): string {
  if (apiKey.startsWith('AIza') || apiKey.startsWith('ya29.')) return 'google';
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-')) return 'openai';
  return 'anthropic';
}

// Register an API key — provider auto-detected from key prefix if not supplied
app.post('/workspaces/:id/lab/api-key', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ apiKey: z.string(), provider: z.string().optional() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
  const { apiKey, provider } = parsed.data;
  const resolvedProvider = provider ?? detectProvider(apiKey);
  const id = c.req.param('id');
  const lab = state.setLabApiKey(id, apiKey, resolvedProvider);
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  // Auto-populate available models from all registered keys
  const keys = state.getLabApiKeys(id) ?? {};
  const models: string[] = [];
  if (keys.anthropic) models.push(...PROVIDER_MODELS.anthropic);
  if (keys.google) models.push(...PROVIDER_MODELS.google);
  if (keys.openai) models.push(...PROVIDER_MODELS.openai);
  if (models.length > 0) {
    // Always recompute default by priority — don't preserve a stale selectedModel
    const defaultModel = MODEL_PRIORITY.find(m => models.includes(m)) ?? models[0];
    state.setLabModels(id, models, defaultModel);
  }
  return c.json({ ok: true, provider: resolvedProvider });
});

// Update system prompt (from UI)
app.patch('/workspaces/:id/lab/system-prompt', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ systemPrompt: z.string() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const lab = state.setUiSystemPrompt(c.req.param('id'), parsed.data.systemPrompt);
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json(lab);
});

// Update active query and target
app.patch('/workspaces/:id/lab/active-input', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    uiActiveQuery: z.string().optional(),
    uiActiveTarget: z.string().optional(),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const lab = state.setLabActiveInput(c.req.param('id'), parsed.data.uiActiveQuery, parsed.data.uiActiveTarget);
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json({ uiActiveQuery: lab.uiActiveQuery ?? null, uiActiveTarget: lab.uiActiveTarget ?? null });
});

// Push UI session history entry
app.post('/workspaces/:id/lab/history/sessions', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request' }, 400);
  const entry = state.pushUiSessionHistory(c.req.param('id'), body);
  if (!entry) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(entry, 201);
});

// Push UI regression history entry
app.post('/workspaces/:id/lab/history/regressions', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid request' }, 400);
  const entry = state.pushUiRegressionHistory(c.req.param('id'), body);
  if (!entry) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(entry, 201);
});

// Get full UI history (sessions + regressions)
app.get('/workspaces/:id/lab/history', (c) => {
  const history = state.getLabHistory(c.req.param('id'));
  if (!history) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(history);
});

// Add test cases (accepts single object or array; ?replace=true replaces all existing)
app.post('/workspaces/:id/lab/test-cases', async (c) => {
  const body = await c.req.json().catch(() => null);
  const asArray = z.array(LabTestCaseSchema).safeParse(Array.isArray(body) ? body : [body]);
  if (!asArray.success) {
    return c.json({ error: 'Invalid request', details: asArray.error.flatten() }, 400);
  }
  const replace = c.req.query('replace') === 'true';
  const cases = state.addLabTestCases(c.req.param('id'), asArray.data, replace);
  if (!cases) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json({ added: cases.length, replace, testCases: cases }, 201);
});

// List test cases
app.get('/workspaces/:id/lab/test-cases', (c) => {
  const lab = state.getLabState(c.req.param('id'));
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json({ testCases: lab.testCases });
});

// Store a test result
app.post('/workspaces/:id/lab/test-results', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = LabTestResultSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const result = state.addLabTestResult(c.req.param('id'), parsed.data);
  if (!result) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json(result, 201);
});

// Get test results
app.get('/workspaces/:id/lab/test-results', (c) => {
  const lab = state.getLabState(c.req.param('id'));
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json({ testResults: lab.testResults });
});

// Post a suggestion
app.post('/workspaces/:id/lab/suggestions', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      prompt: z.string(),
      reasoning: z.string(),
      expectedGain: z.string().optional(),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const suggestion = state.addLabSuggestion(c.req.param('id'), parsed.data);
  if (!suggestion) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json(suggestion, 201);
});

// Get suggestions
app.get('/workspaces/:id/lab/suggestions', (c) => {
  const lab = state.getLabState(c.req.param('id'));
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  const status = c.req.query('status');
  const suggestions = status
    ? lab.suggestions.filter((s) => s.status === status)
    : lab.suggestions;
  return c.json({ suggestions });
});

// Approve or reject a suggestion
app.patch('/workspaces/:id/lab/suggestions/:sid', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ status: z.enum(['applied', 'rejected']) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const suggestion = state.updateLabSuggestion(
    c.req.param('id'),
    c.req.param('sid'),
    parsed.data.status
  );
  if (!suggestion) return c.json({ error: 'Workspace, lab, or suggestion not found' }, 404);
  return c.json(suggestion);
});

// Regression summary
app.get('/workspaces/:id/lab/regression', (c) => {
  const threshold = Number(c.req.query('threshold') ?? '70');
  const status = state.getLabRegressionStatus(c.req.param('id'), threshold);
  if (!status) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json(status);
});

// Get model state
app.get('/workspaces/:id/lab/model', (c) => {
  const lab = state.getLabState(c.req.param('id'));
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json({ availableModels: lab.availableModels, selectedModel: lab.selectedModel });
});

// Set available models and/or selected model
app.patch('/workspaces/:id/lab/model', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    models: z.array(z.string()).optional(),
    selectedModel: z.string().optional(),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { models, selectedModel } = parsed.data;
  if (models === undefined && selectedModel === undefined) {
    return c.json({ error: 'Provide models or selectedModel' }, 400);
  }
  const id = c.req.param('id');
  const lab = models !== undefined
    ? state.setLabModels(id, models, selectedModel)
    : state.setLabSelectedModel(id, selectedModel!);
  if (!lab) return c.json({ error: 'Workspace not found or lab not initialised' }, 404);
  return c.json({ availableModels: lab.availableModels, selectedModel: lab.selectedModel });
});

export default app;
