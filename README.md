# Prompt Lab MCP Server

Prompt optimization loops and regression test suites for Claude Code, with a companion web UI.

The agent runs inside your Claude Code session and owns all LLM work — scoring responses, proposing improved prompts, applying suggestions. The server holds workspace state and keeps the agent and the [Prompt Lab UI](https://github.com/jurek-f/prompt-lab) in sync.

---

## Quick start

Copy `mcp-connect.json` from this repo into your project as `.mcp.json`:

```json
{
  "mcpServers": {
    "prompt-lab": {
      "type": "http",
      "url": "https://prompt-lab-mcp.up.railway.app/mcp"
    }
  }
}
```

Claude Code connects automatically on next start. Verify with `/mcp`.

---

## Example session

```
# 1. Open a workspace — agent shares the UI URL
start_web_app()
→ "Open https://prompt-lab-mcp.vercel.app?s=abc123 to follow along."

# 2. Register an API key
register_api_key(workspaceId, "sk-ant-...")

# 3. Set a system prompt and a test case
set_system_prompt(workspaceId, "You are a concise customer support agent...")
add_test_cases(workspaceId, [{
  query: "How do I reset my password?",
  targetAnswer: "Click 'Forgot password' on the login page and follow the email link."
}])

# 4. Run the optimization loop
loop_optimization(workspaceId, threshold=85)
→ Iteration 1 — score 58: response too long, no mention of email link
→ Iteration 2 — score 74: better, but missing the exact step
→ Iteration 3 — score 91: SUCCESS — prompt updated to require step-by-step answers
```

The UI shows each iteration's score, the agent's reasoning, and the revised system prompt in real time.

---

## How it works

```
Prompt Lab UI (github.com/jurek-f/prompt-lab)
  ↕  HTTP
Prompt Lab MCP Server (Railway)
  ↕  MCP
Claude Code (your machine)
```

---

## API keys

API keys are never stored in the MCP server config. Instead, pass them to Claude Code as environment variables — the agent reads them and registers them with the server at the start of each session using `register_api_key`.

Set the key(s) for the provider(s) you want to use. The agent auto-detects the provider from the key prefix when calling `register_api_key`.

If they're already in your system environment, Claude Code inherits them automatically — nothing else to do. Otherwise add them to `~/.claude/env` or your shell profile:

```bash
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...
OPENAI_API_KEY=sk-...
```

---

## MCP tools

### Setup

| Tool | Description |
|---|---|
| `start_web_app(workspaceId?)` | Creates a workspace and returns the Prompt Lab UI URL. |
| `register_api_key(workspaceId, apiKey, provider?)` | Registers an API key for test runs. Provider is auto-detected from the key prefix. |
| `list_models(workspaceId)` | Lists available models based on registered keys. |
| `set_test_model(workspaceId, model)` | Sets the model for test runs. Syncs to the UI model selector. |
| `delete_session(workspaceId)` | Deletes a workspace and all its state. Irreversible. |

### Templates

Templates are global and appear in the UI dropdowns as soon as they are pushed.

| Tool | Description |
|---|---|
| `save_template(name, testCases)` | Saves a test suite template. Appears in the UI "Load test suite…" dropdown. |
| `save_system_prompt_template(name, content)` | Saves a system prompt template. Appears in the UI "Load template…" dropdown. |

### Workspace state

| Tool | Description |
|---|---|
| `get_workspace_state(workspaceId)` | Reads the full workspace: system prompt, test cases, results, suggestions, model. |
| `set_system_prompt(workspaceId, systemPrompt)` | Sets the system prompt without incrementing the iteration counter. |
| `add_test_cases(workspaceId, testCases, replace?)` | Adds test cases. `replace=true` overwrites all existing ones. |
| `post_test_result(workspaceId, testCaseId, response, score, reasoning, model)` | Stores one scored test result. |
| `post_prompt_suggestion(workspaceId, prompt, reasoning, expectedGain?)` | Queues a revised prompt for review in the UI. |
| `apply_suggestion(workspaceId, suggestionId)` | Applies a pending suggestion and increments the iteration counter. |
| `get_regression_status(workspaceId, threshold?)` | Pass/fail summary across all test cases for the current system prompt. |

### Optimization

Requires a workspace with at least one test case.

| Tool | Description |
|---|---|
| `start_optimization_session(workspaceId, threshold?, maxIterations?)` | Single pass — scores test cases, posts one suggestion, then waits for user review in the UI. |
| `loop_optimization(workspaceId, threshold?, maxIterations?)` | Automated loop — iterates until all scores meet the threshold or max iterations is reached. |

### Regression

| Tool | Description |
|---|---|
| `run_regression_testsuite(workspaceId, threshold?)` | Single pass — scores all test cases, no prompt changes. |
| `loop_regression(workspaceId, threshold?)` | Automated loop — repeats until every individual score meets the threshold. A high average that masks one failing case is not a pass. |

### Archive

| Tool | Description |
|---|---|
| `pull_ui_history(workspaceId)` | Fetches all session summaries and regression runs pushed by the UI. |

---

## Self-hosting

Deploy to Railway and set these environment variables:

| Variable | Description |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL for persistence |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis token |
| `PROMPT_LAB_UI_URL` | URL of your Prompt Lab UI deployment |

```bash
npm install
npm run dev    # starts on :3000
```

MCP endpoint: `http://localhost:3000/mcp`

---

## License

MIT — see [LICENSE](LICENSE).

© 2026 Jurek Föllmer
