# Agent instructions

## What this server is

**overhang-mcp** is a lightweight broker that connects the Prompt Lab web UI to a Claude Code agent running prompt optimisation loops. It holds workspace state (system prompt, test cases, results, suggestions) and exposes it via HTTP (to the UI) and MCP (to the agent).

No LLM calls happen here. The agent (you) owns all LLM work.

---

## Session startup — do this first

**MANDATORY. Do not skip. Do not defer. Do not wait to be reminded.**

### Step 1 — Scan for templates (ALWAYS, no exceptions)

Run these two commands immediately at the start of every session:

```
ls prompt-lab/templates/
ls prompt-lab/system-prompts/
```

Even if you think there are no templates, run the commands. Even if you were just connected and think you already know the state, run the commands.

### Step 2 — If files exist, ALWAYS ask before pushing to the UI

If you find any `.json` files in `prompt-lab/templates/` or `.txt` files in `prompt-lab/system-prompts/`, **STOP and ask the user**:

> "I found N test suite template(s): [list names] and M system prompt template(s): [list names].
> Should I push all of them to the UI?"

Do NOT push anything without asking first. Pushing takes time — wait for confirmation.

### Step 3 — If user says yes, push ALL of them to the UI

Push **every file** — not just the one the user wants to work with. All of them.

**Test suite templates** — for every `.json` file:
```
save_template(name=<file.name field or filename without extension>, testCases=<file.testCases>)
```

**System prompt templates** — for every `.txt` file:
```
save_system_prompt_template(name=<filename without extension>, content=<file contents>)
```

Call `save_template` / `save_system_prompt_template` once per file. All pushed templates appear in the UI dropdowns. The question of *which one to work with* comes after pushing, not instead of it.

After pushing, confirm: "Pushed N test suite(s) and M system prompt template(s) to the UI — all visible in the dropdowns."

### Step 4 — Ask which one to start with

Only after the push is complete, ask: "Which test suite and system prompt would you like to start with, and do you want to optimize or run regression?"

---

## Workspace folder structure

Every workspace has a local folder. Maintain it throughout the session.

```
prompt-lab/
  templates/          ← test suite templates (JSON)
  system-prompts/     ← system prompt templates (TXT)
  workspaces/
    <workspaceId>/
      current.json    ← live snapshot of current session state (see below)
      <YYYYMMDD-HHmmss>_ui_history.json    ← archived UI history (from pull_ui_history)
      <YYYYMMDD-HHmmss>_optimization.json  ← saved after a completed optimization loop
      <YYYYMMDD-HHmmss>_regression.json    ← saved after a completed regression run
```

### current.json format

Update this file whenever any of these fields changes:

```json
{
  "workspaceId": "abc123",
  "updatedAt": "2026-06-13T12:00:00.000Z",
  "query": "current query the user is working on",
  "target": "current target answer",
  "systemPrompt": "current system prompt",
  "model": "claude-haiku-4-5-20251001",
  "testCases": 3,
  "currentIteration": 2,
  "notes": "optional: what was tried, what worked"
}
```

Write `current.json` after: set_system_prompt, add_test_cases, apply_suggestion, set_test_model, and at the start of each optimization/regression loop.

---

## Optimization vs. regression — pick the right mode

| The user has… | Use |
|---------------|-----|
| 1 query + 1 target, wants to improve the prompt | `loop_optimization` |
| Many query-target pairs, wants to verify nothing broke | `loop_regression` |
| 1 query + 1 target, wants one pass only | `start_optimization_session` |
| Many pairs, wants a spot-check without a loop | `run_regression_testsuite` |

If unsure, ask: "Is this a new optimization (1 query, improve the prompt) or a regression check (many queries, verify the prompt still works)?"

---

## Complete tool reference

### Setup & workspace

| Tool | What it does | Natural next step |
|------|-------------|-------------------|
| `start_web_app(workspaceId?)` | Returns the UI URL; creates a workspace if none provided | Share URL with user; ask for query + target or test suite |
| `register_api_key(workspaceId, apiKey, provider?)` | Registers an API key for test runs | Set system prompt or add test cases |
| `list_models(workspaceId)` | Lists available models (based on registered keys) | Call `set_test_model` if user wants non-default |
| `set_test_model(workspaceId, model)` | Sets the model for test runs; syncs to UI selector | Update current.json; run test cases |
| `delete_session(workspaceId)` | Deletes a workspace and all its state — irreversible | Only call if user explicitly requests it |

### Templates (global, no workspace needed)

| Tool | What it does | Natural next step |
|------|-------------|-------------------|
| `save_template(name, testCases)` | Saves a test suite template; appears in UI "Load test suite…" dropdown | Load it in a session via `add_test_cases` |
| `save_system_prompt_template(name, content)` | Saves a system prompt template; appears in UI "Load template…" dropdown | Use in optimization sessions |

### Workspace state

| Tool | What it does | Natural next step |
|------|-------------|-------------------|
| `get_workspace_state(workspaceId)` | Reads full state: system prompt, test cases, results, suggestions, model | Use before any optimization/regression run |
| `set_system_prompt(workspaceId, systemPrompt)` | Sets the system prompt without incrementing iteration counter | Add test cases and run |
| `add_test_cases(workspaceId, testCases, replace?)` | Adds or replaces test cases | Set system prompt; run optimization or regression |
| `post_test_result(workspaceId, testCaseId, response, score, reasoning, model)` | Stores one scored test run | Call for each test case; then `get_regression_status` |
| `post_prompt_suggestion(workspaceId, prompt, reasoning, expectedGain?)` | Queues a revised prompt for user review | Auto-mode: call `apply_suggestion`; gated mode: wait for user |
| `apply_suggestion(workspaceId, suggestionId)` | Applies a pending suggestion; increments iteration counter | Update current.json; run test cases again |
| `get_regression_status(workspaceId, threshold?)` | Pass/fail summary across all test cases | Decide to iterate or stop |

### Optimization

| Tool | What it does | Natural next step |
|------|-------------|-------------------|
| `start_optimization_session(workspaceId, threshold?, maxIterations?)` | Sets optimization goal; single pass — stops after posting suggestion | Wait for user to approve or reject the suggestion in UI |
| `loop_optimization(workspaceId, threshold?, maxIterations?)` | Auto-loop: improve prompt until threshold or max iterations | Summary + save optimization JSON when done |

**Prerequisite:** workspace must exist and have at least one test case. If not, call `start_web_app` first and ask the user to add test cases.

### Regression

| Tool | What it does | Natural next step |
|------|-------------|-------------------|
| `run_regression_testsuite(workspaceId, threshold?)` | Single regression pass — scores all test cases, no prompt change | Review by-test-case results; decide if prompt needs work |
| `loop_regression(workspaceId, threshold?)` | Auto-loop: runs regression repeatedly until ALL scores meet threshold | Summary + save regression JSON when done |

**Stop condition for `loop_regression`:** BOTH the mean pass rate AND every individual test case score must meet the threshold. A high average that masks one failing case is not a pass.

### Archive

| Tool | What it does | Natural next step |
|------|-------------|-------------------|
| `pull_ui_history(workspaceId)` | Fetches history the UI pushed (session summaries + regression runs) | Save to `prompt-lab/workspaces/<id>/<timestamp>_ui_history.json` |

---

## UI ↔ Agent function map

Every user-facing capability has an equivalent on both sides. Use this to verify nothing is missing.

| UI element / action | Agent tool | Notes |
|---------------------|-----------|-------|
| "Connect" MCP button | — | Connection is automatic via `.mcp.json` |
| Workspace ID field | `start_web_app` | Agent creates workspace; ID passed to UI |
| API key input + provider tab | `register_api_key` | Same data; provider auto-detected from key prefix |
| Model selector dropdown | `set_test_model` | Bidirectional — agent sets, UI reflects |
| System prompt textarea | `set_system_prompt` | UI also has PATCH /lab/system-prompt; both write same field |
| "Load template…" dropdown (system prompt) | `save_system_prompt_template` | Agent writes; UI reads on 5-second poll |
| Query field | — | UI syncs to server via active-input; agent reads from `get_workspace_state` |
| Target answer field | — | Same as query |
| "Send" button (single test run) | `post_test_result` + `get_regression_status` | UI makes direct API call to /api/ask |
| "Optimize" button | `start_optimization_session` | Gated: one suggestion, user approves |
| "Optimize (loop)" | `loop_optimization` | Auto: iterates until threshold |
| "Load test suite…" dropdown | `save_template` | Agent writes; UI reads on 5-second poll |
| Test case list (add/remove) | `add_test_cases` | replace=true to overwrite all |
| "Run Regression" button | `run_regression_testsuite` | Single pass |
| "Run Regression (loop)" | `loop_regression` | Auto: stops when ALL scores pass |
| Suggestions list (approve/reject) | `apply_suggestion` | UI PATCH /lab/suggestions/:id; agent uses `apply_suggestion` |
| Session history / results view | `get_workspace_state`, `get_regression_status` | Agent reads; UI shows |
| "Summarize & new" button | `pull_ui_history` | UI pushes to server; agent archives locally |
| History JSON download | local file | Agent saves JSON at end of each loop |

---

## Standard workflow (natural order)

```
1. STARTUP
   ls prompt-lab/templates/ && ls prompt-lab/system-prompts/
   → save_template() for each JSON
   → save_system_prompt_template() for each TXT
   → Tell user what was found

2. OPEN WORKSPACE
   start_web_app() → share URL with user

3. SETUP
   register_api_key(workspaceId, key)  — if no key registered yet
   list_models(workspaceId)            — if user wants to pick a model
   set_test_model(workspaceId, model)  — if not using the default

4. PREPARE
   set_system_prompt(workspaceId, prompt)
   add_test_cases(workspaceId, cases)
   → Write prompt-lab/workspaces/<id>/current.json

5A. OPTIMIZATION (1 query, improve prompt)
    loop_optimization(workspaceId)
    → After each iteration: update current.json
    → At end: save <timestamp>_optimization.json
    → Summarize: initial score → final score, what changed

5B. REGRESSION (many queries, verify prompt)
    loop_regression(workspaceId)
    → At end: save <timestamp>_regression.json
    → Summarize: pass rate, which cases failed and why

6. ARCHIVE (optional)
   pull_ui_history(workspaceId)
   → Save to <timestamp>_ui_history.json
```

---

## Optimization routine (step-by-step)

```
1. get_workspace_state(workspaceId)
   → read testCases, systemPrompt, currentIteration, optimizationGoal, hasApiKeys, selectedModel

2. Choose model:
   a. If selectedModel set → use it.
   b. One provider key set → use that provider's default fast model.
   c. Multiple provider keys → STOP and ask the user which to use.

   Default fast models:
     Anthropic : claude-haiku-4-5-20251001
     Google    : gemini-2.5-flash-lite
     OpenAI    : gpt-4o-mini

3. For each test case, write + run a temp Node.js script:

   Anthropic:
     import Anthropic from '@anthropic-ai/sdk';
     const msg = await new Anthropic().messages.create({
       model: selectedModel, max_tokens: 1024,
       system: systemPrompt, messages: [{ role: 'user', content: query }],
     });
     console.log(msg.content[0].text);

   Google:
     import { GoogleGenAI } from '@google/genai';
     const r = await new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
       .models.generateContent({ model: selectedModel,
         config: { systemInstruction: systemPrompt }, contents: query });
     console.log(r.text);

   OpenAI:
     import OpenAI from 'openai';
     const r = await new OpenAI().chat.completions.create({
       model: selectedModel,
       messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: query }],
     });
     console.log(r.choices[0].message.content);

4. Score each response (LLM-as-judge, in context):
   → post_test_result(workspaceId, testCaseId, response, score, reasoning, model)

5. get_regression_status(workspaceId)

6. Stopping conditions (optimization always runs ≥ 1 improvement cycle):
   a. currentIteration ≥ maxIterations → EXHAUSTED — report best result
   b. passRate ≥ targetScore AND currentIteration ≥ 1 → SUCCESS
   c. currentIteration ≥ 3 AND all scores ≥ 90 → SUCCESS
   Otherwise → continue to step 7.

   Do NOT stop just because scores are passing (≥ 70) — that's a baseline, not a goal.

7. Analyse results:
   - What does the prompt do well?
   - What pattern causes failures? (too vague, wrong format, missing context, over-constrained)
   - Formulate hypothesis: "The prompt lacks X, causing Y"

8. Write improved system prompt (targeted fix, not full rewrite)

9. post_prompt_suggestion(workspaceId, prompt, reasoning, expectedGain)

10. Loop mode: apply_suggestion(workspaceId, suggestionId) → go to step 1
    Gated mode: wait for user to approve in UI → next /optimize call
```

### Scoring rubric (LLM-as-judge)

| Score | Meaning |
|-------|---------|
| 90–100 | Correct, complete, well-structured — exceeds the target |
| 70–89 | Correct and complete — minor gaps or style issues |
| 50–69 | Partially correct — key points present but missing details |
| 30–49 | Mostly wrong — one or two relevant points but fundamentally off |
| 0–29 | Completely wrong, off-topic, or refused |

Default pass threshold: 70. Configurable via `optimizationGoal.targetScore`.

---

## Connecting Claude Code to this server

Copy `mcp-connect.json` from this repo into your project as `.mcp.json`.
Adjust the URL to point at your running or deployed server.

Local dev: `npm run dev` starts on port 3000. MCP endpoint: `http://localhost:3000/mcp`.

---

## Conventions

- No LLM calls in this repo — it is a broker, not an agent.
- All mutations are idempotent where practical — the agent must be able to retry safely.
- Keep the surface small. Resist adding features not listed above.
- `main` is always deployable.
- Commit messages: one line, what changed and why.
