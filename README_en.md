# DSH Metacognition Plugin (`metacog-task`)
[简体中文](README.md)
> Effectiveness is not guaranteed — see Section 4 for what was actually measured.
>
> Enables the Agent to conduct post-task retrospectives, distill reusable lessons, and inject them into subsequent tasks by scope. Tool and failure events are also persisted for later analysis.
>
> Runtime Environment: DeepSeek Harness `0.2.1-rc.5` · Single-package installation

---

## 1. Problem Statement

An Agent may repeat the same mistakes across different tasks. Once the current session ends, relevant context is not necessarily preserved, and in a new session the Agent may not be able to draw on prior experience.

Simply expanding the system prompt only provides static rules; it cannot naturally capture the concrete issues encountered during a specific task, how they were corrected, or whether those lessons were subsequently validated again.

This plugin attempts to establish a closed loop:

```text
Task Start → Decisions → Task End → Agent Reflection → Structured Memory
    ↑                                                         │
    └────────── Subsequent tasks read and apply lessons ──────┘
```

The core question this plugin tries to answer is: **Can lessons formed during one task transfer to subsequent, independent tasks?**

> See Section 4 for experimental data.

---

## 2. How It Works

### 2.1 Three Tools to Bound and Review a Task

| Tool | Purpose |
|---|---|
| `task_start(goal, expected_result)` | Declares the task goal and expected outcome, creating a task record |
| `task_end(task_id, status, result)` | Declares the task outcome, closes the task, and generates retrospective material |
| `task_reflect(task_id, assessment, source, lessons[])` | Saves the Agent's reflection and lessons learned from the task |

`task_end` compiles the material within the task's time window into a **decision trajectory**, consisting primarily of user requests and corrections, the Agent's external responses, and—when external responses are absent—a bounded sample of reasoning excerpts. It does not collect a full list of tool calls; the tool failure count serves only as an auxiliary signal.

The target of reflection here is the Agent's **working decisions** rather than tool-calling mechanics. Tool call logs and task decision trajectories are handled separately.

Task statuses include `succeeded`, `failed`, `abandoned`, and `aborted`.

### 2.2 Three-Tier Memory

| Tier | Primary Use | Default Scope |
|---|---|---|
| `global` | Cross-task general methodology | All sessions |
| `session` | Constraints or lessons tied to a specific session/project context | Specified session |
| `reflection` | Lessons generated from reflecting on a specific task | The session where the lesson originated |

The three tiers distinguish the semantic category and scope of a memory; content granularity is not automatically determined by code. The model is responsible for deciding which tier a lesson belongs to, while the program only validates structure and reference integrity.

Injection rules are governed by scope: `global` is visible to all sessions; `session` is visible to the specified `session_id`; `reflection` takes effect within its originating session by default. Lessons can be promoted to `global` or a specified `session` scope. Promotion does not duplicate an active memory entry; instead, it changes the injection path and the active state of the source entry.

All three tiers are currently rendered within the same system prompt section (`## Accumulated Lessons`), grouped by tier.

### 2.3 Memory Governance

- **Four Classifications**: At write time, the model declares the relationship to existing lessons: `new` (newly added) / `repeat` (recurrence; only accumulates evidence) / `revise` (revises the same lesson; the older version is no longer injected) / `none` (no new information; not persisted to disk). The program simply executes the declaration.
- **Promotion as State Migration, Not Duplication**: The source reflection is retained as provenance and historical evidence, while the injection path covered by the derived entry no longer injects the source entry redundantly. Promoting to `global` overrides the source injection path across all sessions; promoting to a specific `session` only overrides the path for that session without affecting others.
- **Conflicts Are Surfaced, Not Auto-Resolved**: Memories can declare four types of conflict relationships: `condition` (different applicable conditions), `goal` (different target requirements), `contradiction` (direct contradiction under the same conditions), and `apparent` (general rule vs. specific exception). At render time, both sides are presented side by side with a note that the system has not adjudicated between them; the Agent is expected to evaluate the applicable conditions and state its reasoning.
- **Lifecycle**: `active`, `superseded` (replaced by a newer revision or lesson), `deprecated` (no longer recommended, but body text and historical evidence are retained), and `deleted` (tombstoned; no longer injected as active memory).
- **Structural Checker**: Validates `conflicts` / `promoted_from` references, consistency between `scope` and `subject`/`session_id`, and whether non-`reflection` entries declare a `boundary`.
- **Separation of Provenance and Subject**: `source` is the Agent's self-reported account of where the lesson originally came from, while machine-side fields such as `task_id`, `session_id`, and timestamps are recorded independently. `source_text` is kept for traceability and is excluded from memory injection.

### 2.4 Event Storage

Independently of memory, the plugin listens on `tools/result` and appends one JSON line per
tool call to `tool-events.jsonl`, plus a duplicate record to `error-events.jsonl` when the call
is classified as failed.

Failure classification is multi-signal, because `isError` alone is unreliable: real runs showed
non-zero exit codes reported with `isError: false`. The classifier combines the framework's
`isError` flag, `[exit code: N]` markers parsed out of the result text, timeout markers, and
signal termination.

Recording is **write-only**: nothing from these files is injected into the prompt. An earlier
version injected a per-turn tool-count summary, which turned out to contaminate experiments, so
that path was removed. Set `recordEvents: false` to disable recording entirely.

### 2.5 Division of Responsibilities

> The plugin handles recording, structural validation, and the injection pipeline; the model handles semantic classification, conflict judgment, and task reflection.

The program does not guess whether a lesson is abstract enough or whether it belongs in `global`. Non-`reflection` entries must provide a `boundary` explaining why they belong to that scope; the program only checks that the declaration is present, not whether it is semantically valid. This ensures that boundary drift can at least be inspected and audited rather than remaining completely invisible.

---

## 3. Limitations

| # | Limitation | Impact |
|---|---|---|
| 1 | Task boundaries still rely on the model following prompt instructions and calling `task_start` / `task_end` | The current prompt requires `task_start` to be the very first action of a task, but this is not enforced programmatically; forgetting to open a task still results in a missing decision trajectory |
| 2 | Semantic judgment is delegated to the model | The model may still assign a lesson to the wrong tier, write a vague `boundary`, or misdeclare duplicates/conflicts; the structural checker cannot detect these semantic flaws |
| 3 | All three tiers share a single system prompt section | Any change to injected content in any tier alters that section and triggers a full prompt cache recomputation — roughly 690k tokens in a single measurement — before subsequent requests resume cache hits |
| 4 | No automatic conflict resolution | Both conflicting entries continue to be injected for the Agent to evaluate based on context; this is intentional by design |
| 5 | No semantic similarity deduplication | Whether an entry represents the same lesson is declared by the model via `repeat` / `revise`; the program executes strictly by entry ID and declaration |
| 6 | No `workspace` dimension | Lessons cannot currently be shared across sessions automatically by project; they must be explicitly promoted to `global` or a specific `session` scope |
| 7 | No UI anymore | The client bundle failed to load in the current environment, so the UI was dropped; maintenance is limited to config files and the CLI |
| 8 | Persistent records are the source of truth | Task/reflection records and memory entries are stored in JSONL files; deleting those files permanently destroys the historical evidence behind every lesson. They are **not** a cache. |
| 9 | Writer keeps file handles open | Disable the plugin before rotating logs or manipulating data files |

---

## 4. Experimental Data

The following experiments observe whether memory can transfer to independent sessions, rather than measuring long-term training effects. All core experiments were conducted in workspaces with incomplete dependencies (missing `tsc` / `eslint`).

### 4.1 Toolchain Lesson (`npx`)

Criterion: Whether the model runs `tsc` via `npx` without first checking `.bin`.

| Group | Sessions | Used `npx` | Did Not Use `npx` |
|---|---:|---:|---:|
| Without Memory | 8 | 5 | 3 |
| With Memory | 6 | **0** | **6** |

In the With Memory group, all 6 sessions checked `node_modules/.bin` first and skipped execution when it was missing. However, after adding two later Without Memory samples, the rate of `npx` usage in the Without Memory group dropped from an earlier 5/6 to 5/8, indicating that the model itself can sometimes act cautiously—in one session, it proactively ran `npx --no-install`, failing fast without fetching remote packages.

> Tentative conclusion: 6/6 sessions in the memory group checked `.bin` first; memory reliably front-loaded the correct behavior.

### 4.2 Bug-Fix Methodology Lesson (`coupons`)

This experiment tested a lesson unrelated to `npx`: when diagnosing mutable fields inside a shared default object, first prove reference equality using a `===` probe, then clone the mutable fields inside the factory function, and freeze the default object as a guardrail.

In an independent session, all three concrete actions were reproduced:

```text
1. Prove shared reference before fixing using a === probe
2. Clone mutable fields inside the factory function
3. Retain Object.freeze(DEFAULT_COUPONS) as a regression guardrail
```

Running the probe again after the fix yielded `false` for both reference-equality checks. This is currently the stronger piece of transfer evidence: the lesson is unrelated to the `npx` case, and all three concrete actions were reproduced in full within an independent session.

### 4.3 Task Boundary Reminders and Prompt Changes

The legacy reminder mechanism checked at the end of a turn: if no task had ever been opened in the current session, yet substantive work was performed during the turn, it injected a reminder. Across four recorded instances, the reminder prompted the Agent to retroactively open a task on the spot and perform reflection.

The limitation is that the reminder arrives too late: a retroactively opened task can only capture events occurring after the reminder, failing to recover the earlier decision trajectory. As a result, one session's retrospective material contained only 5 events.

On `2026-11-04`, the task boundary section in the system prompt was updated to mandatory wording: requiring `task_start` to be the very first action of a task—prior to reading files, running commands, searching, or editing—and requiring `task_end` to be called once the task outcome is reached, regardless of success or failure.

**Note: This prompt change has not yet been empirically validated.**

### 4.4 Accounting Criteria for Tool Failure Counts

Raw "tool failure" counts contain a high volume of false positives: for example, `grep` finding no matches or `ls` checking a non-existent path both return non-zero exit codes as part of normal query results. The experimental logs distinguish between:

- `P`: Precondition failure — the benchmark/test suite was already failing prior to the fix
- `A`: Accounting false positive — statistical distortion, deducted when calculating the adjusted effective count
- `M`: True model-side error or failure discovered during the model's own self-testing, retained as-is

Both the raw count and the adjusted effective count are preserved. Looking only at the raw count overestimates the number of failures. The `tool_failures` metric in the plugin currently still relies on non-zero exit codes.

---

## 5. Usage

### 5.1 Installation

```bash
# Install in DSH (target points to the package directory)
plugin_manager install_bundle target=<absolute_path_to_this_directory>
```

Dependencies: No external services required.

### 5.2 Configuration

`cordis.patch.yml`:

```yaml
- insert:
    - id: metacog-task
      name: '@local/dsh-metacog-task'
      config:
        taskDir: '<your-data-dir>/metacog-task-data'  # Where task records and memory live
        fsyncEvery: 16                                 # fsync every N records
        taskBoundaryHints: true                        # Inject task boundary hints
        injectReflection: true                         # Inject retrospective material on task_end
        recordEvents: true                             # Persist tool/failure events (no injection)
        lessons:
          enabled: true
          maxLessons: 0                        # 0 = inject all
          diagnostics: true                    # Write lessons-render.jsonl when content changes
          scopes:                              # Toggles for the three tiers
            global: true
            session: true
            reflection: true
```

### 5.3 Daily Workflow

The system prompt guides the Agent to call `task_start` before starting a task and `task_end` once an outcome is reached. The current prompt explicitly requires `task_start` as the first action of a task; the retrospective material generated by `task_end` instructs the Agent to call `task_reflect`.

This still relies on the model following the prompt and actually invoking the tools. If a task is opened retroactively after work has already begun, the plugin cannot recover the decision trajectory prior to `task_start`.

Manual memory maintenance:

```bash
node tools/lessons.mjs list --session <session_id>  # Inspect what a specific session actually sees
node tools/lessons.mjs check                        # Structural check (references / status / boundaries)
node tools/lessons.mjs add --scope global --pattern "…" --correction "…" \
     --applies-when "…" --boundary "Why it belongs to this tier"
node tools/lessons.mjs move <id> --to global        # Promote (state migration, no duplication)
node tools/lessons.mjs remove <id>                  # Tombstone deletion
node tools/deprecate.mjs <id> --reason "…"         # Deprecate (no longer recommended, retains history)
node tools/deprecate.mjs --list
```

### 5.4 Testing

The test suite is not shipped with this package. It lives in the development repository and covers task boundaries, tier scoping, promotion, deduplication, conflict rendering, and the structural checker.

---

## 6. File Structure

```text
index.js                 Plugin entry point: 3 tools + system prompt injection + event recording
lib/
  task-model.js          Task record & parameter validation
  task-context.js        Decision trajectory extraction (excludes full tool call list)
  reflection-model.js    Reflection validation, 4-way classification, conflict declarations
  lessons.js             3-tier parsing / folding / promotion override / conflict rendering / structural check
  writer.js              Crash-safe writer (write + batched fsync + read-back verification)
  classify.js            Tool failure signal detection (isError / non-zero exit / timeout / signal)
tools/
  lessons.mjs            Memory maintenance CLI (list/add/move/remove/check/export/import)
  deprecate.mjs          Entry point for deprecated status
data/                    Created at runtime; not part of the repository
  tasks.jsonl            Task records + reflections
  lessons/lessons.jsonl  Maintained global / session entries + patches
  tool-events.jsonl      Tool call outcomes (append-only)
  error-events.jsonl     Failures only (append-only)
docs/
  MEMORY-GOVERNANCE.md   3-tier governance spec (responsibilities / dedup / promotion / conflicts / lifecycle)
  MEMORY-SCOPES.md       3-tier scopes & injection rules
  TASK-BOUNDARY-DESIGN.md Task boundary layer design
  REFLECTION-PIPELINE.md Reflection generation & persistence
  LESSONS-INJECTION.md   Injection implementation & Prefix Cache benchmarks
```
