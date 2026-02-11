# Proposal: RLM Mode for OpenCode

## 1. What Is an RLM?

Defined by Alex Zhang and Omar Khattab, a **Recursive Language Model** (RLM) maintains two distinct context pools:

- **Tokenized context** — what's in the LLM's window (precious, subject to context rot)
- **Programmatic context** — data stored in a REPL environment, addressable via code

The LLM controls what moves from programmatic space to token space via `print()`, and delegates analysis to sub-LLM calls via `llm_query()`. This turns long-context problems into coding problems — exploiting the massive post-training investment in code reasoning. The [Breunig article](https://www.dbreunig.com/2026/02/09/the-potential-of-rlms.html) reports stable performance on 10M+ tokens, versus complete failure at 262K tokens without RLM.

Key references:

- [The Potential of RLMs](https://www.dbreunig.com/2026/02/09/the-potential-of-rlms.html) — Drew Breunig's overview
- [Alex Zhang's original RLM post](https://alexzhang13.github.io/blog/2025/rlm/) — the foundational definition
- [Context rot research](https://research.trychroma.com/context-rot) — Chroma's canonical exploration of the problem RLMs solve

## 2. What Exists on This Branch

The current implementation (2 commits, 9 files, ~400 lines of new code) provides a solid foundation:

| Component               | File(s)                                                | Implementation                                                                                           |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **RLM Agent**           | `src/agent/agent.ts`, `src/agent/prompt/rlm.txt`       | Primary mode agent, 5 steps (configurable), REPL + question tools auto-allowed                           |
| **REPL Tool**           | `src/tool/repl.ts`, `src/tool/repl.txt`                | Persistent `$` store (per-session in-memory Map), `llm_query()`, `loadSession()`, `print()`, `directory` |
| **`/rlm` Command**      | `src/command/index.ts`, `src/command/template/rlm.txt` | Template with `$ARGUMENTS` + instructions to load session via `loadSession()`                            |
| **Session Transitions** | `src/session/prompt.ts`                                | Synthetic system-reminder parts when entering/leaving RLM mode                                           |
| **Tool Registry**       | `src/tool/registry.ts`                                 | REPL tool registered alongside built-in tools                                                            |
| **Test Coverage**       | `test/agent/agent.test.ts`                             | Updated agent test to account for new primary agent                                                      |

The REPL execution model: `new Function()` with injected environment variables, wrapped in async IIFE for top-level `await`. Output captured via overridden `console.log`/`print`.

## 3. What's Well Supported by OpenCode

The implementation fits naturally into OpenCode's architecture:

- **Agent system** — RLM slots in as a primary agent alongside Build and Plan, switchable via Tab. The mode/permission/tool system is exactly what's needed.
- **Custom commands** — `/rlm` with `$ARGUMENTS` template works out of the box.
- **Tool registry** — Adding the REPL tool is a single import + array push.
- **Session infrastructure** — `Session.messages()` provides the data for `loadSession()`, and synthetic parts handle mode transitions cleanly.
- **Provider abstraction** — `Provider.getSmallModel()` gives `llm_query` a sensible default without configuration.
- **Skills** — RLM-specific patterns (e.g., "how to analyze a large codebase") could be packaged as skills that the RLM agent loads.
- **Permissions** — REPL and question tools are auto-allowed for the RLM agent; everything else inherits defaults.

## 4. Areas with Weak Support / Needing Investigation

### 4.1 Security: REPL Sandboxing (HIGH priority)

`new Function()` runs in the same V8 isolate as OpenCode itself. The agent can `await import("child_process")` or access `process.env`. This is effectively the same trust model as the bash tool, but it's not framed that way to the user. Options:

- **Accept it** — treat REPL like bash (it already has similar power). Add it to the permission system so users can set it to `ask`.
- **Sandbox it** — use a Bun worker with limited APIs. Significant engineering effort.
- **Recommendation**: Accept it and integrate with the existing permission system. The bash tool already has the same power.

### 4.2 Budget/Iteration Tracking (MEDIUM priority)

The article emphasizes budget management — models are remarkably good at pacing themselves when given a budget. The default should be 5 iterations (aligned with the article's examples), configurable via `opencode.json` using the standard agent `steps` field. The agent should be aware of its remaining budget at runtime via a `$.budget` object injected into the REPL environment.

### 4.3 No Trace Infrastructure for Agent Discovery (MEDIUM priority, long-term)

The article's most exciting claim: repeated RLM traces reveal emergent agent architectures that can be decomposed and optimized. OpenCode has no infrastructure for:

- Capturing structured RLM traces (REPL calls, reasoning, sub-LLM calls)
- Comparing traces across runs of the same task
- Extracting patterns from traces

This is the _potential_ of RLMs, not a day-one requirement. But it's worth designing the REPL tool's logging with this in mind.

### 4.4 Persistence Across Restarts (LOW priority)

The `$` store is an in-memory `Map<string, Record<string, unknown>>`. If OpenCode restarts, all programmatic context is lost. For long-running analysis tasks, this could be painful. Options:

- Serialize `$` to the session's storage on each REPL call.
- Lazy approach — accept the limitation for now (sessions are typically single-sitting).

### 4.5 TUI Visibility (LOW priority)

There's no way for the user to see what's in `$`, how much budget remains, or the REPL execution trace in a structured way. The TUI shows tool calls, which partially covers this, but a dedicated REPL state panel would improve the experience.

### 4.6 Pre-loading Context (MEDIUM priority)

The canonical RLM use case is "here's a 400MB log file, analyze it." The current implementation only provides `loadSession()` for conversation history. There's no built-in way to say "load these files into `$` before the agent starts." The agent can use `await import("fs")` to read files, but a `loadFiles()` helper or integration with `@file` references would be smoother.

### 4.7 Sub-LLM Model Configuration (LOW priority)

`llm_query` uses `Provider.getSmallModel()` with no user-facing configuration. For cost-sensitive users, being able to specify the sub-model per-agent or globally would be useful. The `options.model` parameter exists in code but isn't surfaced.

## 5. Critical Assessment

### Of the Article

**Strengths:**

- The two-context-pool framing is the key insight. It's simple, explanatory, and actionable.
- The agent discovery angle (extracting agent architectures from traces) is genuinely novel and under-explored.
- Honest about limitations: slow, requires strong models, doesn't solve all context failures.

**Weaknesses:**

- The article conflates "context rot mitigation" with "handles arbitrarily large context." RLMs don't actually _understand_ 400MB of data — they sample it. The quality of the sampling depends on the model's coding ability, not on any fundamental advance.
- The performance numbers (50-60% on RLM vs. near-zero without) need scrutiny. 50-60% accuracy is not great in absolute terms — it's just much better than the alternative of total failure.
- The DSPy framing is somewhat parochial. RLMs are a general pattern; tying them to a specific framework obscures the simplicity.
- The "next chain of thought" framing is bold but premature. CoT unlocked latent capability in all models; RLMs require strong coding ability, limiting their applicability.

### Of This Implementation

**Strengths:**

- Minimal, clean integration with OpenCode's existing architecture. 400 lines of new code is remarkably lean.
- The `loadSession()` function is a killer feature for the OpenCode use case — the agent can programmatically explore its own conversation history.
- Making RLM a primary agent (switchable via Tab) is the right UX choice. Users can fluidly move between Build, Plan, and RLM.
- The `/rlm` command with `$ARGUMENTS` template provides a natural entry point.

**Weaknesses:**

- The REPL sandbox story is unresolved (but manageable — see 4.1).
- The prompt engineering could be more sophisticated. The current prompt is good but doesn't mention budget management, doesn't suggest when to use RLM vs. normal mode, and doesn't guide the model on when to finish.
- No integration with OpenCode's existing context mechanisms (`@file` references, compaction agent). The RLM agent exists in a parallel universe from the compaction agent that also addresses context growth.
- Testing is minimal — only the agent-disabled test is updated. No tests for the REPL tool itself, `serializeMessages()`, `llm_query`, or `loadSession`.

## 6. Recommended Next Steps

1. **Log structured traces** — even before building analysis tooling, emit structured logs (REPL code, output, sub-LLM calls) that can later be used for agent discovery.
2. **Add REPL to the permission system** — treat it like bash. Users should be able to set it to `ask` or `deny`.
3. **Add budget awareness** — default 5 steps (configurable via `agent.rlm.steps` in `opencode.json`). Inject `$.budget = { total, used, remaining }` into the REPL environment. Update the prompt to reference it.
4. **Add `loadFiles()` helper** — let the REPL load files by glob pattern into `$`, complementing `loadSession()`.
5. **Write REPL tool tests** — test the execution sandbox, `serializeMessages()`, error handling, output truncation, and persistent store behavior.
6. **Improve the prompt** — add guidance on when RLM is appropriate, budget pacing, and finishing (the article notes models are good at this when guided).
