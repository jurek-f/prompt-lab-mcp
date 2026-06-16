export interface ActionPrompt {
  module: string;
  branch: string;
  scope: string;
  handoff: string;
  constraints: string[];
  prompt: string;
  type?: 'stage' | 'direct';
}

export interface PromptRecord extends ActionPrompt {
  id: string;
  status: 'pending' | 'in-progress' | 'done' | 'failed';
  createdAt: number;
  acknowledgedAt?: number;
  result?: string;
}

export type Readiness = 'planned' | 'in-progress' | 'done' | 'blocked';

export interface BuildStatus {
  module: string;
  summary: string;
  readiness: Readiness;
  blockers: string[];
  decisions: string[];
  interfaces: string[];
  constraints: string[];
  updatedAt: number;
}

export interface ProjectContext {
  goal: string;
  stack: string[];
  stage: 'design' | 'mvp' | 'production' | 'refactor';
  updatedAt: number;
}

export interface LabHistoryEntry {
  id: string;
  type: 'session' | 'regression';
  exportedAt: string;
  source: 'ui';
  data: unknown;
}

export interface Workspace {
  id: string;
  label?: string;
  createdAt: number;
  project: ProjectContext | null;
  prompts: PromptRecord[];
  buildStatuses: BuildStatus[];
  lab?: LabState;
  uiSessionHistory: LabHistoryEntry[];
  uiRegressionHistory: LabHistoryEntry[];
}

// ── Prompt lab types ──────────────────────────────────────────────────────────

export type QueryType = 'explain' | 'generate' | 'transform' | 'extract' | 'compare' | 'reason' | 'classify';

export interface LabTestCase {
  id: string;
  query: string;
  targetAnswer?: string;
  queryType?: QueryType;
  source?: 'ui' | 'agent';
  createdAt: number;
}

export interface LabTestResult {
  id: string;
  testCaseId: string;
  response: string;
  score: number;        // 0–100
  reasoning: string;
  iteration: number;
  model: string;
  createdAt: number;
}

export interface LabPromptSuggestion {
  id: string;
  prompt: string;
  reasoning: string;
  expectedGain?: string;
  status: 'pending' | 'applied' | 'rejected';
  iteration: number;
  createdAt: number;
}

export type LabCommandType = 'send' | 'loop' | 'run-regression' | 'loop-regression'

export interface LabPendingCommand {
  command: LabCommandType
  query?: string
  targetAnswer?: string
  createdAt: number
}

export interface LabTutorMessage {
  id: string
  role: 'tutor' | 'user'
  content: string
  createdAt: number
}

export interface LabState {
  systemPrompt: string;          // agent's canonical prompt — set only by agent tools
  uiSystemPrompt?: string;       // UI's current prompt — set by PATCH /lab/system-prompt
  agentHasWrittenSystemPrompt?: boolean; // true once agent explicitly sets systemPrompt
  uiActiveQuery?: string;        // UI's current query (debounced push on edit)
  uiActiveTarget?: string;       // UI's current target (debounced push on edit)
  agentActiveQuery?: string;     // agent's most recently run query (auto-set from post_test_result)
  agentActiveTarget?: string;    // agent's most recently run target
  testCases: LabTestCase[];
  testResults: LabTestResult[];
  suggestions: LabPromptSuggestion[];
  currentIteration: number;
  optimizationGoal?: { targetScore: number; maxIterations: number };
  availableModels: string[];
  selectedModel: string;
  pendingCommand?: LabPendingCommand;
  tutorMessages: LabTutorMessage[];
  apiKey?: string;
  apiKeys?: Record<string, string>; // provider → key: anthropic | google | openai
  updatedAt: number;
}
