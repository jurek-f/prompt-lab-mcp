import { randomUUID } from 'node:crypto';
import { persistWorkspace, removeWorkspace, persistTemplates, persistSystemPromptTemplates } from './persistence.js';
import type {
  ActionPrompt,
  PromptRecord,
  BuildStatus,
  ProjectContext,
  Workspace,
  LabTestCase,
  LabTestResult,
  LabPromptSuggestion,
  LabState,
  LabCommandType,
  LabTutorMessage,
  LabHistoryEntry,
  QueryType,
} from './types.js';

// ── Global state ─────────────────────────────────────────────────────────────

const prompts = new Map<string, PromptRecord>();
const statuses = new Map<string, BuildStatus>();
let project: ProjectContext | null = null;

// ── Global template store ─────────────────────────────────────────────────────
// Multiple named templates; survive across workspaces within a server session.
// Agent calls save_template or save_template_suite; GET /templates returns all.

interface GlobalTemplate {
  name: string;
  savedAt: string;
  testCases: { label?: string; query: string; targetAnswer?: string; passThreshold?: number; queryType?: QueryType }[];
}

const globalTemplates = new Map<string, GlobalTemplate>();

function persistAll() {
  persistTemplates(Array.from(globalTemplates.values()));
}

export function saveTemplate(
  name: string,
  testCases: { label?: string; query: string; targetAnswer?: string; passThreshold?: number; queryType?: string }[],
): GlobalTemplate {
  const tpl: GlobalTemplate = {
    name,
    savedAt: new Date().toISOString(),
    testCases: testCases.map(({ label, query, targetAnswer, passThreshold, queryType }) => ({
      ...(label ? { label } : {}),
      query,
      ...(targetAnswer ? { targetAnswer } : {}),
      ...(passThreshold !== undefined ? { passThreshold } : {}),
      ...(queryType ? { queryType: queryType as QueryType } : {}),
    })),
  };
  globalTemplates.set(name, tpl);
  persistAll();
  return tpl;
}

export function saveGlobalTemplate(workspaceId: string, name?: string): GlobalTemplate | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  return saveTemplate(name ?? (session.label ?? workspaceId), session.lab.testCases);
}

export function getGlobalTemplates(): GlobalTemplate[] {
  return Array.from(globalTemplates.values()).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function getGlobalTemplate(): GlobalTemplate | null {
  return getGlobalTemplates()[0] ?? null;
}

export function hydrateGlobalTemplate(data: unknown): void {
  const tpl = data as GlobalTemplate;
  if (tpl?.name) globalTemplates.set(tpl.name, tpl);
}

export function hydrateGlobalTemplates(data: unknown[]): void {
  for (const item of data) hydrateGlobalTemplate(item);
}

// ── System prompt template store ──────────────────────────────────────────────

interface SystemPromptTemplate {
  name: string;
  savedAt: string;
  content: string;
}

const systemPromptTemplates = new Map<string, SystemPromptTemplate>();

export function saveSystemPromptTemplate(name: string, content: string): SystemPromptTemplate {
  const tpl: SystemPromptTemplate = { name, savedAt: new Date().toISOString(), content };
  systemPromptTemplates.set(name, tpl);
  persistSystemPromptTemplates(Array.from(systemPromptTemplates.values()));
  return tpl;
}

export function getSystemPromptTemplates(): SystemPromptTemplate[] {
  return Array.from(systemPromptTemplates.values()).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function hydrateSystemPromptTemplates(data: unknown[]): void {
  systemPromptTemplates.clear();
  for (const item of data) {
    const t = item as Partial<SystemPromptTemplate>;
    if (t.name && t.content) {
      systemPromptTemplates.set(t.name, {
        name: t.name,
        savedAt: t.savedAt ?? new Date().toISOString(),
        content: t.content,
      });
    }
  }
}

export function addPrompt(input: ActionPrompt): PromptRecord {
  const record: PromptRecord = {
    ...input,
    id: randomUUID(),
    status: 'pending',
    createdAt: Date.now(),
  };
  prompts.set(record.id, record);
  return record;
}

export function getNextPrompt(): PromptRecord | null {
  for (const record of prompts.values()) {
    if (record.status === 'pending') return record;
  }
  return null;
}

export function acknowledgePrompt(id: string): boolean {
  const record = prompts.get(id);
  if (!record || record.status !== 'pending') return false;
  record.status = 'in-progress';
  record.acknowledgedAt = Date.now();
  return true;
}

export function postBuildStatus(input: Omit<BuildStatus, 'updatedAt'>): BuildStatus {
  const record: BuildStatus = { ...input, updatedAt: Date.now() };
  statuses.set(input.module, record);
  return record;
}

export function getAllStatuses(): BuildStatus[] {
  return Array.from(statuses.values());
}

export function getStatusByModule(module: string): BuildStatus | null {
  return statuses.get(module) ?? null;
}

export function setProjectContext(input: Omit<ProjectContext, 'updatedAt'>): ProjectContext {
  project = { ...input, updatedAt: Date.now() };
  return project;
}

export function getProjectContext(): ProjectContext | null {
  return project;
}

export function getContext() {
  const all = getAllStatuses();
  return {
    project,
    modules: all,
    allConstraints: [...new Set(all.flatMap((s) => s.constraints))],
    allInterfaces: [...new Set(all.flatMap((s) => s.interfaces))],
    readiness: {
      done: all.filter((s) => s.readiness === 'done').map((s) => s.module),
      inProgress: all.filter((s) => s.readiness === 'in-progress').map((s) => s.module),
      blocked: all.filter((s) => s.readiness === 'blocked').map((s) => s.module),
      planned: all.filter((s) => s.readiness === 'planned').map((s) => s.module),
    },
  };
}

// ── Workspace state ───────────────────────────────────────────────────────────

const workspaceStore = new Map<string, Workspace>();

export function hydrateWorkspaces(workspaces: Workspace[]): void {
  for (const w of workspaces) {
    workspaceStore.set(w.id, w);
  }
}

export function createWorkspace(label?: string): { session: Workspace; url?: string } {
  const session: Workspace = {
    id: randomUUID(),
    label,
    createdAt: Date.now(),
    project: null,
    prompts: [],
    buildStatuses: [],
    uiSessionHistory: [],
    uiRegressionHistory: [],
  };
  workspaceStore.set(session.id, session);
  persistWorkspace(session.id, session);
  const voiceUrl = process.env.OVERHANG_VOICE_URL;
  const url = voiceUrl ? `${voiceUrl}?s=${session.id}` : undefined;
  return { session, url };
}

export function createWorkspaceWithId(id: string, label?: string): Workspace {
  const session: Workspace = {
    id,
    label,
    createdAt: Date.now(),
    project: null,
    prompts: [],
    buildStatuses: [],
    uiSessionHistory: [],
    uiRegressionHistory: [],
  };
  workspaceStore.set(id, session);
  persistWorkspace(id, session);
  return session;
}

export function getWorkspace(id: string): Workspace | null {
  return workspaceStore.get(id) ?? null;
}

export function setWorkspaceProject(
  id: string,
  input: Omit<ProjectContext, 'updatedAt'>
): ProjectContext | null {
  const session = workspaceStore.get(id);
  if (!session) return null;
  const record: ProjectContext = { ...input, updatedAt: Date.now() };
  session.project = record;
  persistWorkspace(id, session);
  return record;
}

export function addWorkspacePrompt(id: string, input: ActionPrompt): PromptRecord | null {
  const session = workspaceStore.get(id);
  if (!session) return null;
  const record: PromptRecord = {
    ...input,
    id: randomUUID(),
    status: 'pending',
    createdAt: Date.now(),
  };
  session.prompts.push(record);
  persistWorkspace(id, session);
  return record;
}

export function getWorkspacePrompts(
  id: string,
  status: 'pending' | 'in-progress' | 'done' | 'failed' | 'all' = 'all'
): PromptRecord[] | null {
  const session = workspaceStore.get(id);
  if (!session) return null;
  if (status === 'all') return session.prompts;
  return session.prompts.filter((p) => p.status === status);
}

export function updateSessionPromptStatus(
  workspaceId: string,
  promptId: string,
  status: 'in-progress' | 'done' | 'failed',
  result?: string
): PromptRecord | null {
  const session = workspaceStore.get(workspaceId);
  if (!session) return null;
  const prompt = session.prompts.find((p) => p.id === promptId);
  if (!prompt) return null;
  prompt.status = status;
  if (status === 'in-progress') prompt.acknowledgedAt = Date.now();
  if (result !== undefined) prompt.result = result;
  persistWorkspace(workspaceId, session);
  return prompt;
}

export function getWorkspaceSummary(id: string) {
  const session = workspaceStore.get(id);
  if (!session) return null;
  const p = session.prompts;
  return {
    workspaceId: id,
    promptCount: p.length,
    pending: p.filter((x) => x.status === 'pending').length,
    inProgress: p.filter((x) => x.status === 'in-progress').length,
    done: p.filter((x) => x.status === 'done').length,
    failed: p.filter((x) => x.status === 'failed').length,
  };
}

// ── Prompt lab state ──────────────────────────────────────────────────────────

export function initLabWorkspace(
  workspaceId: string,
  systemPrompt: string,
  optimizationGoal?: { targetScore: number; maxIterations: number }
): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session) return null;
  const lab: LabState = {
    systemPrompt,
    uiSystemPrompt: systemPrompt,
    testCases: [],
    testResults: [],
    suggestions: [],
    currentIteration: 0,
    optimizationGoal,
    availableModels: [],
    selectedModel: '',
    tutorMessages: [],
    updatedAt: Date.now(),
  };
  session.lab = lab;
  persistWorkspace(workspaceId, session);
  return lab;
}

export function getLabState(workspaceId: string): LabState | null {
  return workspaceStore.get(workspaceId)?.lab ?? null;
}

export function setLabSystemPrompt(workspaceId: string, prompt: string): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  session.lab.systemPrompt = prompt;
  session.lab.agentHasWrittenSystemPrompt = true;
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return session.lab;
}

export function setUiSystemPrompt(workspaceId: string, prompt: string): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  session.lab.uiSystemPrompt = prompt;
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return session.lab;
}

export function addLabTestCases(
  workspaceId: string,
  cases: { query: string; targetAnswer?: string; queryType?: QueryType; source?: 'ui' | 'agent' }[],
  replace = false
): LabTestCase[] | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const created: LabTestCase[] = cases.map((c) => ({
    ...c,
    id: randomUUID(),
    createdAt: Date.now(),
  }));
  if (replace) session.lab.testCases = created;
  else session.lab.testCases.push(...created);
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return created;
}

export function setLabActiveInput(
  workspaceId: string,
  uiActiveQuery?: string,
  uiActiveTarget?: string
): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  if (uiActiveQuery !== undefined) session.lab.uiActiveQuery = uiActiveQuery || undefined;
  if (uiActiveTarget !== undefined) session.lab.uiActiveTarget = uiActiveTarget || undefined;
  session.lab.updatedAt = Date.now();
  // not persisted — high-frequency, transient
  return session.lab;
}

export function addLabTestResult(
  workspaceId: string,
  input: { testCaseId: string; response: string; score: number; reasoning: string; model: string }
): LabTestResult | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const result: LabTestResult = {
    ...input,
    id: randomUUID(),
    iteration: session.lab.currentIteration,
    createdAt: Date.now(),
  };
  session.lab.testResults.push(result);
  const testCase = session.lab.testCases.find(tc => tc.id === input.testCaseId);
  if (testCase) {
    session.lab.agentActiveQuery = testCase.query;
    session.lab.agentActiveTarget = testCase.targetAnswer;
  }
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return result;
}

export function addLabSuggestion(
  workspaceId: string,
  input: { prompt: string; reasoning: string; expectedGain?: string }
): LabPromptSuggestion | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const suggestion: LabPromptSuggestion = {
    ...input,
    id: randomUUID(),
    status: 'pending',
    iteration: session.lab.currentIteration,
    createdAt: Date.now(),
  };
  session.lab.suggestions.push(suggestion);
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return suggestion;
}

export function updateLabSuggestion(
  workspaceId: string,
  suggestionId: string,
  status: 'applied' | 'rejected'
): LabPromptSuggestion | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const suggestion = session.lab.suggestions.find((s) => s.id === suggestionId);
  if (!suggestion) return null;
  suggestion.status = status;
  if (status === 'applied') {
    session.lab.systemPrompt = suggestion.prompt;
    session.lab.agentHasWrittenSystemPrompt = true;
    session.lab.currentIteration += 1;
  }
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return suggestion;
}

export function setLabPendingCommand(
  workspaceId: string,
  command: LabCommandType,
  query?: string,
  targetAnswer?: string
): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  session.lab.pendingCommand = { command, query, targetAnswer, createdAt: Date.now() };
  session.lab.updatedAt = Date.now();
  // not persisted — transient signal cleared immediately after read
  return session.lab;
}

export function clearLabPendingCommand(workspaceId: string): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  session.lab.pendingCommand = undefined;
  session.lab.updatedAt = Date.now();
  // not persisted — transient
  return session.lab;
}

export function addLabTutorMessage(
  workspaceId: string,
  role: 'tutor' | 'user',
  content: string
): LabTutorMessage | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const msg: LabTutorMessage = { id: randomUUID(), role, content, createdAt: Date.now() };
  session.lab.tutorMessages.push(msg);
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return msg;
}

export function pushUiSessionHistory(workspaceId: string, data: unknown): LabHistoryEntry | null {
  const session = workspaceStore.get(workspaceId);
  if (!session) return null;
  const entry: LabHistoryEntry = {
    id: randomUUID(),
    type: 'session',
    exportedAt: new Date().toISOString(),
    source: 'ui',
    data,
  };
  session.uiSessionHistory.push(entry);
  persistWorkspace(workspaceId, session);
  return entry;
}

export function pushUiRegressionHistory(workspaceId: string, data: unknown): LabHistoryEntry | null {
  const session = workspaceStore.get(workspaceId);
  if (!session) return null;
  const entry: LabHistoryEntry = {
    id: randomUUID(),
    type: 'regression',
    exportedAt: new Date().toISOString(),
    source: 'ui',
    data,
  };
  session.uiRegressionHistory.push(entry);
  persistWorkspace(workspaceId, session);
  return entry;
}

export function getLabHistory(workspaceId: string): { sessions: LabHistoryEntry[]; regressions: LabHistoryEntry[] } | null {
  const session = workspaceStore.get(workspaceId);
  if (!session) return null;
  return {
    sessions: session.uiSessionHistory,
    regressions: session.uiRegressionHistory,
  };
}

export function deleteWorkspace(id: string): boolean {
  const deleted = workspaceStore.delete(id);
  if (deleted) removeWorkspace(id);
  return deleted;
}

export function setLabApiKey(workspaceId: string, apiKey: string, provider = 'anthropic'): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const trimmed = apiKey.trim();
  if (!isValidKey(trimmed)) return null;
  if (!session.lab.apiKeys) session.lab.apiKeys = {};
  session.lab.apiKeys[provider] = trimmed;
  if (provider === 'anthropic') session.lab.apiKey = apiKey; // backward compat
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return session.lab;
}

function isValidKey(k: string): boolean {
  return !!k && !k.startsWith('$') && k.length >= 10;
}

export function getLabApiKeys(workspaceId: string): Record<string, string> | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const raw = session.lab.apiKeys ?? {};
  if (session.lab.apiKey && !raw.anthropic) raw.anthropic = session.lab.apiKey;
  // Strip any invalid keys that may have been stored before validation was added
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => isValidKey(v)));
}

export function setLabModels(
  workspaceId: string,
  models: string[],
  selectedModel?: string
): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  session.lab.availableModels = models;
  if (selectedModel !== undefined) {
    session.lab.selectedModel = selectedModel;
  } else if (models.length > 0 && !session.lab.selectedModel) {
    session.lab.selectedModel = models[0];
  }
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return session.lab;
}

export function setLabSelectedModel(workspaceId: string, model: string): LabState | null {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  session.lab.selectedModel = model;
  session.lab.updatedAt = Date.now();
  persistWorkspace(workspaceId, session);
  return session.lab;
}

export function getLabRegressionStatus(workspaceId: string, passingThreshold = 70) {
  const session = workspaceStore.get(workspaceId);
  if (!session?.lab) return null;
  const { lab } = session;

  const byTestCase = lab.testCases.map((tc) => {
    const results = lab.testResults
      .filter((r) => r.testCaseId === tc.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    const latest = results[0] ?? null;
    const latestScore = latest?.score ?? null;
    const status =
      latestScore === null ? 'untested' : latestScore >= passingThreshold ? 'pass' : 'fail';
    return {
      testCaseId: tc.id,
      query: tc.query,
      queryType: tc.queryType,
      latestScore,
      status: status as 'pass' | 'fail' | 'untested',
    };
  });

  const tested = byTestCase.filter((t) => t.status !== 'untested');
  const passCount = byTestCase.filter((t) => t.status === 'pass').length;
  const failCount = byTestCase.filter((t) => t.status === 'fail').length;
  const scores = lab.testResults.map((r) => r.score);
  const averageScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return {
    workspaceId,
    systemPrompt: lab.systemPrompt,
    iteration: lab.currentIteration,
    totalTestCases: lab.testCases.length,
    totalRuns: lab.testResults.length,
    averageScore: Math.round(averageScore),
    passCount,
    failCount,
    untestedCount: byTestCase.length - tested.length,
    passRate: tested.length ? Math.round((passCount / tested.length) * 100) : 0,
    passingThreshold,
    optimizationGoal: lab.optimizationGoal,
    byTestCase,
  };
}

export function getWorkspaceContext(id: string) {
  const session = workspaceStore.get(id);
  if (!session) return null;
  const all = session.buildStatuses;
  return {
    project: session.project,
    modules: all,
    allConstraints: [...new Set(all.flatMap((s) => s.constraints))],
    allInterfaces: [...new Set(all.flatMap((s) => s.interfaces))],
    readiness: {
      done: all.filter((s) => s.readiness === 'done').map((s) => s.module),
      inProgress: all.filter((s) => s.readiness === 'in-progress').map((s) => s.module),
      blocked: all.filter((s) => s.readiness === 'blocked').map((s) => s.module),
      planned: all.filter((s) => s.readiness === 'planned').map((s) => s.module),
    },
  };
}
