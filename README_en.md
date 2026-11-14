# DSH Task Reflection Plugin (`dsh-lessons`)
*(Effectiveness has not been experimentally proven; I can only guarantee it is useful in theory.)*

(translated by Gemini)

[中文](README.md)

> Have the Agent reflect after a task ends, distill reusable lessons, and inject them into subsequent tasks by scope.
>
> Runtime environment: DeepSeek Harness `0.2.1-rc.5`

---

## 1. The Problem This Plugin Solves

An Agent may repeat the same mistakes across different tasks. Once the current session ends, relevant context is not necessarily preserved, and in a new session the Agent may not be able to leverage prior experience.

Simply adding prompt instructions only provides static rules; it cannot naturally record issues that actually occurred during a task, how they were corrected, or whether those lessons were later verified again.

This plugin attempts to establish a closed loop:

```text
Task Start → Decisions → Task End → Agent Reflection → Structured Memory
   ↑                                                           │
   └──────────── Subsequent tasks read and apply lessons ──────┘
```

The question this plugin tries to answer is: can lessons formed in one task transfer to subsequent, independent tasks?

> See Section 4 for experimental data.

---

## 2. How the Plugin Works

### 2.1 Four Tools

| Tool | Purpose |
|---|---|
| `task_start(goal, expected_result)` | Declare the task goal and expected result, and create a task record |
| `task_end(task_id, status, result)` | Declare the task outcome, close the task, and generate reflection materials |
| `task_reflect(task_id, assessment, source, lessons[])` | Save the Agent's reflection and lessons from the task |
| `lessons_lookup(lesson_id)` | Trace the full origin of a lesson **on demand** (read-only) |

`task_end` compiles materials within the task's time window into a **decision trajectory**, primarily consisting of user requests and corrections, the Agent's external statements, and a bounded excerpt of reasoning when external statements are lacking. It does not collect a full tool-call inventory; tool failure counts are included only as an auxiliary signal.

The target of reflection here is the Agent's **work decisions**, not tool-calling mechanics—tool-call logs and task decision trajectories are handled separately.

Task statuses include `succeeded`, `failed`, `abandoned`, and `aborted`.

#### `lessons_lookup`: On-Demand Traceability Instead of Pre-Stuffing

Every entry in the decision environment carries an `id`, but the full origin of each lesson is **not** stuffed in upfront. The Agent decides for itself whether to look it up when needed.

Design trade-offs:

| | Proactive Injection | On-Demand Query (Current) |
|---|---|---|
| Context cost | Paid on every reflection | **Paid only when actually queried** |
| Judgment authority | Program pre-decides "what is relevant" | **Agent decides for itself** |
| Traceability completeness | Limited by material length | **Full chain** (goal → result → event window → other lessons in force at the time) |

`timeline` provides the session event range so you can trace back to the original conversation; `OTHER LESSONS` comes from the environment snapshot taken when the task started, showing "whether this was the only lesson in effect at the time."

The snapshot itself is stored in two parts: `lessons[]` (the first 12 entries, including approach and applicability conditions) and `omitted[]` (the remaining entries, with only `id` + problem description). Both parts are **counted during queries**, so `(N total)` matches the total number of entries recorded in the snapshot. Up to 10 entries are expanded in detail; any beyond that are listed by `id` via `(+N more in force, not expanded: id, id, …)`—keeping the output compact without losing traceability for any `id`.

### 2.2 Three-Tier Memory

| Tier | Primary Purpose | Default Scope |
|---|---|---|
| `global` | Cross-task general methodology | All sessions |
| `session` | Constraints or lessons tied to a specific session/project context | Specified session |
| `reflection` | Lessons generated from reflecting on a specific task | The session that produced the lesson |

The three tiers distinguish semantic categories and scopes of memory; content granularity is not judged automatically by the program. The model is responsible for deciding which tier a lesson belongs to, while the program only checks structure and reference integrity.

Injection rules are determined by scope: `global` is visible to all sessions; `session` is visible to the specified `session_id`; `reflection` takes effect in its source session by default. Lessons can be promoted to `global` or a specified `session` scope. Promotion does not duplicate an active memory; instead, it changes the injection path and the effective status of the source entry.

All three tiers are currently rendered in the same system prompt section (`## Accumulated Lessons`), grouped by tier.

### 2.3 Memory Governance

- **Four classifications**: When writing, the model declares the relationship to existing lessons: `new` (newly added) / `repeat` (reoccurred; only accumulates evidence) / `revise` (modifies the same lesson; the old version is no longer injected) / `none` (no new information; not persisted). The program simply executes the declaration.
- **Promotion is a state transition, not a copy**: The source reflection is retained as origin and historical evidence, and injection paths covered by the derived entry no longer inject the source entry redundantly. Promoting to `global` overrides the source injection path across all sessions; promoting to a specific `session` overrides only that session's path without affecting other sessions.
- **Conflicts are surfaced, not resolved**: Memories can declare four relationship types: `condition` (different applicability conditions), `goal` (different goal requirements), `contradiction` (direct contradiction under the same condition), and `apparent` (general rule vs. specific exception). When rendered, they are presented side by side with a note that the system has made no ruling—the Agent judges the applicability conditions and states its reasoning.
- **Lifecycle**: `active`, `superseded` (replaced by a newer version or lesson), `deprecated` (no longer recommended, but body and historical basis are preserved), `deleted` (no longer injected as an active memory).
- **Structural checker**: Validates `conflicts` / `promoted_from` references, consistency between `scope` and `subject`/`session_id`, and whether non-`reflection` entries declare a `boundary`.
- **Separation of source and subject**: `source` is self-reported by the Agent to describe where the lesson originally came from, while machine-side fields such as `task_id`, `session_id`, and timestamps are recorded independently. `source_text` is used for provenance and does not participate in memory injection.

#### Field Structure of a Lesson

| Field | Question Answered | Example |
|---|---|---|
| `problem` | **What happened** (observable phenomenon) | "Declared completion right after editing code, leaving an immediately visible defect in the change" |
| `attempted` | **What was done at the time** (the approach itself, without evaluation) | "Reported completion directly and skipped verification; 3 out of 4 test cases failed on a 4-line pagination function" |
| `correction` | **What should be done instead** | "Run a minimal test that can expose failure paths before delivering" |
| `applies_when` | **When it applies** | "When preparing to deliver after modifying code" |
| `confidence` | Self-assessed confidence (`low`/`medium`/`high`) | `high` |

**Why `pattern` was split into `problem` + `attempted`**:

The old schema only had `pattern`, which in practice easily turned into a compound sentence of "problem + approach", while `correction` ended up narrower than `pattern`—creating a semantic contradiction where the approach was longer than the conclusion, even though the conclusion is what should be adopted. Splitting them gives each field a distinct job:

- `problem` describes only the phenomenon (without "so you should do X")
- `attempted` records the approach (making "reverted to the old approach" observable)
- `correction` must be a usable alternative approach and **cannot be narrower than `problem`**—if the fix says less than the problem, one of the two must be wrong.

> Compatibility: Legacy records that only have `pattern` treat it as `problem`, requiring no historical data migration.

#### Three Entry Types: Lesson / Directive / Failure

`kind` determines whether a memory "should be weighed by judgment":

| `kind` | Semantics | Render Location | Required Fields |
|---|---|---|---|
| `lesson` (default) | Heuristic: "doing this is better"; model judges whether it applies | Per-scope lists | `problem` + `correction` |
| `directive` | Explicit method: required directly without judgment | `Required method:` | `correction` |
| `failure` | Failure experience: excluded on trigger; **not** a heuristic to weigh | Separate `## Known failures` block | `problem` + `avoid` |

**Why `failure` needs its own category**: The existing schema makes `correction` mandatory and stipulates that it "must not be narrower than `problem`." This rule effectively **forbids writing constraints in negative form**. Yet the natural form of a failure lesson is often purely negative:

> Do not modify code before verifying.

A failure lesson does not necessarily have a known positive alternative. Forcing it into `correction` would either fabricate a fix you do not believe in or lose the information that "I don't know the alternative yet, but this path does not work." `failure` is expressed with `avoid` (what not to do) + an optional `instead` (known alternative), so `correction` is no longer required.

In rendering, it is also not listed alongside ordinary lessons: when injected, it forms its own block with an explicit header:

```text
Known failures
Actions that produced a bad outcome. When the trigger matches, do not do this.
Unlike a lesson, this is not a heuristic to weigh — it is a constraint.
```

—Otherwise, a "hard prohibition" would be treated on par with a "weighable heuristic" and diluted into a mere suggestion.

> Compatibility: Legacy records without `kind` default to `lesson`, preserving existing behavior.

#### Structured Self-Opposition (`adversarialReview`, off by default)

The goal is not to have the model write a paragraph of self-criticism, but to require it to **submit a traceable argument** before persisting to storage, and **strengthen the counter-argument first until it is no longer an easily defeated strawman**.

##### Eleven Fields of the Argument

| Field | Question Answered | Purpose |
|---|---|---|
| `claim` | What is being argued? | Clarify the target claim |
| `premises` | What facts, assumptions, and conditions does it rely on? | Expose hidden assumptions |
| `evidence` | What observable information supports the premises? | Check premise reliability |
| `inference` | How do the premises lead to the conclusion? | Check logical validity |
| `conclusion` | What is the final assertion? | Consolidate the argument |
| `steelman` | What is the strongest counter-argument? | Counter confirmation bias |
| `counterexamples` | What observations would challenge the conclusion? | Check applicability boundaries |
| `scope` | Under what conditions does the conclusion hold? | Prevent overgeneralization |
| `alternatives` | What else could equally explain the phenomenon? | Avoid premature attribution |
| `revision_conditions` | What would make me change the conclusion? | **Preserve falsifiability** |
| `unresolved` | What remains uncertain? | Preserve uncertainty |

##### The Counter-Argument Must Be Iteratively Strengthened, Not Rebutted Once (Subject to Taste, Modifiable)

In practice, a single `steelman` field almost always becomes a one-shot formality: write an objection that looks strong, rebut it immediately, and declare the test passed. Hence, **rounds** are required here:

```text
steelman_rounds:
  - threatens   Which link of the argument this round attacks (claim/premises/evidence/inference/…)
    argument    The strengthened counter-argument targeting that link (must raise points the original author missed)
    response    Your rebuttal
    survives    What remains unrefuted in this round after the rebuttal
  - threatens   ← Must target a different link
    ...
opposition_residual   After all rounds end, what part of the opposition you still have not refuted
```

The program mechanically enforces three checks that the model cannot talk its way around:

| Check | Rationale |
|---|---|
| At least **2 rounds** | One round is not adversarial; it is going through the motions |
| Each round's `threatens` must be distinct | Re-strengthening the same spot is just rewording, not deepening |
| `opposition_residual` must be filled | Evidence of "actually having thought it through" is admitting what remains of the opposition, not declaring total victory |

Keeping `opposition_residual` is key: if allowed to be left blank, models will write "the counter-argument is completely invalid," which is almost never true.

##### Three Types of Validity Evaluated Separately

```text
validity:
  deductive        valid / invalid / not_applicable / unresolved   —— Whether the conclusion necessarily follows if premises are true
  inductive        strong / moderate / weak / …                    —— To what degree the evidence supports the conclusion
  premise_truth    established / partial / assumed / unresolved    —— Whether the premises themselves have a basis
```

The three must be separated; otherwise you get arguments that are **formally valid but built on baseless premises**—looking airtight while carrying zero information. `premise_truth` is required; if set to `unresolved`, the unresolved questions must be stated in `unresolved`.

##### Leaving Fields Empty Is Allowed, but Must Be Explicitly Marked

Filling every field every time is not required. When something is genuinely not applicable or lacks information, write `n/a` / `unknown` / `无` / `不适用`, and the program stores it in `markers` separately from the body:

```text
critique.alternatives  = omitted
critique.markers       = { "alternatives": "n/a" }
critique.unresolved_keys = ["alternatives"]
```

This makes it possible afterward to distinguish **"not written"** from **"written as none."** Fabricating content just to fill fields—such as writing a true-sounding but vacuous sentence for `alternatives`—is precisely the behavior we most want to avoid.

##### Three Mandatory Rules for `verdict`

| `verdict` | Outcome |
|---|---|
| `holds` | Written normally |
| `narrowed` | Must fill `applies_when` (marking where this lesson stops applying), otherwise rejected |
| `withdrawn` | **Not written**, `lessons_recorded: 0` |

**Mandatory rather than optional** (by design): an optional `conflicts` field (for declaring tension between two lessons) was previously placed in the same position, and the result was **0 uses across 55 lessons**—optional quality-control fields are equivalent to nonexistent in practice. Precisely because it is mandatory and costly, it is **off by default**: this is not "think one more time," it is requiring the argument to be written out item by item.

##### Argued Boundaries Enter the Prompt

`critique.scope` does not need a second lesson as an opponent (the opponent is the "old approach" itself), so it renders as an independent boundary section instead of crowding into pairwise `[CONFLICTS]`:

```text
[BOUNDARIES] Each lesson below was checked against the strongest case for the old way of working.
The old way is still better under the stated condition — prefer it there, and apply the lesson only outside it.
- task-xxx#0: When error output is very long and unrelated to the edited location, guessing first and verifying is cheaper
```

The remaining fields (full argument, strengthening rounds, residual opposition, validity) **do not enter the system prompt**; they can be expanded via `lessons_lookup`.

#### Precedent Principle (`precedentGate` + `precedentInPrompt`)

> An effective method should be reused until there is a compelling reason to change it.
> The standard of evidence required to change a method already verified as effective should be much higher than the standard used when adopting it initially.

**"Verified as effective" is probabilistic**: even if a lesson has succeeded only once, it counts as verified, just with low probability (otherwise the bar would be too strict). Therefore, no judgment of "has it been proven?" is made here—only counts are tracked:

| Count | Source |
|---|---|
| `verified` | Number of tasks where the lesson was in the decision environment snapshot at task start and the task `succeeded` |
| `counter` | Same as above, but the task failed |
| `exposures` | Total number of exposures |

Both are joins between `task_open.environment` and `task_close.status`, **requiring neither model self-assessment nor a control group**. Rendered as `Precedent: verified 19x, 1 counterexample(s)`.

**Challenging a precedent requires evidence.** `relation: "revise"` requires `evidence_task_ids`, and the program mechanically validates three conditions:

1. The referenced task actually exists and has a `close` record;
2. That task is **not** `succeeded`—a single success does not constitute a challenge to precedent;
3. The decision environment snapshot at the start of that task **actually contained** the challenged lesson (= it was in effect at the time).

The 4th condition—"matching its applicability conditions"—is a semantic judgment; the program does not validate it and leaves it to the model.

This gate solves the problem of "`revise` being too easy": before the fix, it had actually been used only 2 times, yet any model could rewrite a precedent verified 19 times on a whim.

---

### 2.4 Decision Environment Recording

Reflection materials cannot record only **behavior**; they must also record the **environment/constraints** in effect when the behavior occurred. Otherwise, the model is asked to judge "how well did I do?" without seeing "what I was instructed to follow at the time."

Therefore, `task_start` **freezes the lessons actually in effect at that moment into a snapshot** and writes it to the `task_open` record:

```json
{"record_type":"open","task_id":"task-…","environment":{
  "taken_at": 1794…, "committed_at": 1794…, "count": 3, "truncated": false,
  "lessons":[{"id":"t1#0","scope":"global","confidence":"high",
              "problem":"…","attempted":"…","correction":"…","applies_when":"…"}]}}
```

**Why snapshot at the start instead of recomputing at reflection time**:

| Problem with Post-Hoc Recomputation | Guarantee of Snapshotting |
|---|---|
| Editing a lesson later rewrites the constraints historical tasks saw at the time | Edits do not affect already-frozen snapshots |
| `deprecated` entries disappear from history | Still appears in the records of tasks it participated in |
| Cannot distinguish "injected at the time" from "added afterward" | `taken_at` / `committed_at` mark the boundary |
| Cannot trace a lesson's impact on decisions | `task_close` records carry `environment_ids` for reverse lookup by `id` |

Presentation in reflection materials:

```text
DECISION ENVIRONMENT (lessons in effect when this task started; 2 total):
  [E1] (global, high) Read the full file before editing
        do instead: Read first, then edit
        applies when: When editing an unread file
  [E2] ...

These were the rules in force when you started. Judge whether any of them applied,
and whether you actually followed them — not whether they still seem right now.
```

> This is the responsibility of the **decision trajectory layer**, not the memory governance layer: the issue was not how lessons were stored or classified, but that the constraints in force at the time were missing during reflection.

#### Truncation Strategy When Exceeding the Limit

When lessons exceed the detailed limit (12 by default), you cannot simply "take the first N"—testing showed that doing so **systematically drops the newest and highest-confidence entries**, because reflections are ordered by write time and newer ones appear later.

The current strategy has two tiers:

| Tier | Content | Limit |
|---|---|---|
| **Detailed** | `id` / `scope` / `confidence` / `problem` / `attempted` / `correction` / `applies_when` | 12 entries, sorted `high → medium → low`, newer first within the same level |
| **Brief** | `id` / `confidence` / `problem` (one line) | Unlimited, all listed |

In other words, **every `id` can be listed at all times**, with those beyond 12 shown only as a one-line summary:

```text
DECISION ENVIRONMENT (lessons in effect when this task started; 20 total, 12 detailed):
  [E1] (reflection, high) Declared completion right after editing code…
        do instead: Run a minimal test before delivering
  …(12 detailed)

  Also in effect, listed without detail (8):
  [task-abc#0] (low) Some low-confidence lesson
  …
```

This ensures "whether a given lesson participated in this decision" is always traceable—even if the full text was not expanded in the materials at the time.

#### Recording and Rendering Are Separate Concerns

| | Controlled by Toggle? | Cost |
|---|---|---|
| **Recording** (`task_open.environment`) | No, **always written** | ~4.3 KB/task (disk only, zero context cost) |
| **Rendering** (`DECISION ENVIRONMENT` section in materials) | `environmentInBrief`, default `true` | ~800 tokens/reflection (measured: 11 entries ≈ 1,986 chars) |

Recording guarantees historical auditability; rendering solves "not having to scroll back hundreds of thousands of tokens to the system prompt during reflection to find constraints."

The two can be traded off independently: turning off `environmentInBrief` stops repeating these lessons in the materials (the model can still see them in the system prompt or earlier instant notices), while snapshots are still persisted to disk and remain queryable by `id`.

#### Reflection Is Thinking, Not Reporting (`silentReflection`, on by default)

Reflection materials ask the model to "reconstruct the decision process." Without constraints, models often treat this like homework to hand in: writing a long bulleted reply first, then calling `task_reflect`.

Measured data (78 `task_end` → `task_reflect` pairs in this session):

| Metric | Value |
|---|---|
| External output present at reflection step | 50% (39/78) |
| Output length | Avg 784 chars, max 6,660 |

This output **is not a write channel**: `buildReflectionRecord` only accepts parameters from `task_reflect`; nothing the model says outside the tool has any code path into the record (verified field-by-field by `test-silent.mjs`). Yet it is not zero-cost:

| Impact | Explanation |
|---|---|
| Output tokens | Paying twice for the same analysis—once in prose, once in the structured fields of `task_reflect` |
| Decision trajectory pollution | If the model starts a new task first and then backfills the previous task's reflection, this prose lands inside the **new task's** window and gets collected as an `ASSISTANT` entry in the new task's reflection materials |

So with `silentReflection` enabled, the end of the reflection materials instead instructs:

```text
Do this as internal reasoning, not as a visible reply. The six questions above are
prompts for your own thinking; do not answer them in your response text.

Call task_reflect directly, with <task_id> as the task_id.
After that, reply with at most one short line saying whether the task succeeded —
no restatement of the analysis, no per-question section, no bullet summary.
If something genuinely needs the user's attention (a decision only they can make,
a risk they must know), say just that one thing and nothing else.
```

An escape hatch is preserved: anything that genuinely requires the user's decision still gets communicated rather than hidden for the sake of silence. Disabling this toggle restores the original "speak first, then record" phrasing.

#### Per-Turn Reflection: Taking the Entry Point Out of the Model's Hands (`turnReflection`, off by default)

Task mode has a structural risk: **whether reflection materials exist depends on whether the model called `task_start`.** If the model forgets to open a task, that entire stretch of work has no materials at all—not "incomplete materials," but "no materials." That is the Sword of Damocles at the entry point.

`turnReflection` moves it to the runtime: **at the end of each turn, hand what happened in that turn directly to the model to reflect on once**, regardless of whether the model opened a task.

| | Task Mode | Per-Turn Mode |
|---|---|---|
| Material boundary | `task_start` → `task_end` | `turn/start` → `turn/end` |
| Who controls entry | **Model** | **Runtime** |
| No materials if model forgets? | Yes | No |
| Boundary equals decision boundary? | Yes | **No** |

**The cost must be stated clearly: a turn boundary is not a decision boundary.**

Measured across 20 analyzable tasks on this machine:

```text
Top 10 tasks spanning the most turns:
  13 turns   450 events   task-74483339…
   5 turns   119 events   task-7e32da40…
   4 turns   331 events   task-d6dd342a…
   4 turns   906 events   task-7dcd1d2e…
   2 turns   224 events   task-1ea11e3c…

Spanning >1 turn: 6/20 (30%)
Spanning >=3 turns: 4
Exactly 1 turn: 14
Median: 1
```

That means **30% of tasks span multiple turns, with the longest spanning 13 turns**. Splitting by turn slices a single decision process into multiple segments, each missing prior context when viewed alone. Thus, this feature's role is:

> It guarantees **"at least it was inspected,"** not **"it was inspected properly."**

The materials also state this explicitly to the model (`a turn boundary is not a decision boundary`) and clarify its role as a fallback rather than primary reflection.

Other design details:

| Item | Behavior |
|---|---|
| Relationship with `missedTaskNudge` | **Completely independent**. The nudge tells the model "this turn has no task boundary"; per-turn reflection generates materials without relying on the model. Disabling either does not affect the other |
| Empty turns | No dialogue, no reasoning, no failures → no materials generated, avoiding spam |
| Task already open | Materials note that the turn belongs to an open task window and instruct **not to record the same lesson twice** |
| `turnReflectionMode` | `notice` (injected in the next message, default) / `wake` (immediately wakes an extra turn, incurring additional token cost) |

#### Missed Task Nudge: Stating Facts Without Judging for the Model (`missedTaskNudge`, on by default)

When a turn does substantive work but is not covered by any task, the plugin adds a brief note at the end of the turn.

**It is a statement, not a command.** The wording explicitly states that the model has the right not to open a task, for two reasons:

1. Not all work meets the criteria for a task. Pushing too hard forces the model to open empty tasks for every casual chat or one-off Q&A, polluting task logs and turning reflection materials into noise.
2. "Whether to open a task" should be judged by the model itself. The plugin is responsible for recording, not for deciding work-unit boundaries on the model's behalf.

So the nudge only states three things: **how much work was done**, **if this meets the definition of a task it is currently unrecorded**, and **you have the option not to open one, just confirm it was a judgment call rather than an oversight**. It also explicitly **does not ask for retroactive opening** (a retroactively opened window is empty, so reflection could only fabricate based on zero evidence).

##### Detection: Per-Turn, Not Per-Session

This fixes a real bug. The old implementation asked "has a task ever been opened in this session?", so **opening a task once granted permanent immunity**—forgetting in a later turn would never trigger a nudge.

Measured evidence (session `144577dd`, 35 turns after plugin deployment):

```text
Substantive work with task declaration in that turn:                    18
No declaration, but inside an open task window (mid-turn, normal):      0
No declaration and outside any task window (genuinely missed):          4   ← turns 63/64/65/66
```

Those 4 turns made **127 / 73 / 21 / 62** tool calls respectively, all without `task_start`, yet **0** nudges were recorded—not a single reminder. From turn 63 until the end of the session, `task_start` appeared 0 times.

Current detection logic:

| Current Turn Status | Trigger Nudge? |
|---|---|
| Called `task_start` this turn | No (already using task boundaries) |
| Called `task_end` this turn | No (same as above) |
| Session currently has an open task (middle turn of a multi-turn task) | No (already in scope; should not interrupt) |
| None of the above, and substantive work was done | **Yes** |

"Substantive work" reuses the threshold: `>= missedTaskMinCalls` (default 8) tool calls, or file modifications. Task-management tools (`task_start` / `task_end` / `task_reflect`) do not count toward workload.

`missedTaskMaxPerSession` (default 2) caps how many nudges can fire per session to avoid repeated nagging.

### 2.5 Division of Labor

> The plugin handles recording, structural validation, and injection flow; the model handles semantic classification, conflict judgment, and task reflection.

The program does not guess whether a lesson is abstract enough or whether it belongs in `global`. Non-`reflection` entries must provide a `boundary` explaining why they belong to that scope; the program only checks that the declaration exists, not whether it is semantically accurate. This ensures boundary drift can at least be inspected and reviewed rather than remaining completely invisible.

---

## 3. Plugin Limitations

| # | Limitation | Impact |
|---|---|---|
| 1 | Task boundaries still depend on the model following prompts and calling `task_start` / `task_end` | Current prompts require `task_start` to be the first action of a task, but this is unverified; missed tasks still result in missing decision trajectories |
| 2 | Semantic judgment is handled by the model | The model can still misclassify a lesson's tier, write a vague `boundary`, or misdeclare duplicates/conflicts; the checker cannot catch semantic errors |
| 3 | All three tiers share one system prompt section | Any change to injected content in any tier alters that section and triggers a full prompt-cache recalculation—measured at ~690k tokens (possibly more; sample size is small), after which subsequent requests resume cache hits (recalculated once every N turns, but still recalculated) |
| 4 | No automatic conflict resolution | Conflicting entries continue to be injected together for the Agent to judge by condition; this is by design |
| 5 | No semantic similarity deduplication | Whether entries represent the same lesson is declared by the model via `repeat` / `revise`; the program executes by entry ID and declaration |
| 6 | No workspace dimension | Lessons cannot currently be shared automatically across sessions by project; they must be explicitly promoted to `global` or a specified `session` scope |
| 7 | UI is gone | The client bundle failed to load in the current environment (suspected DSH issue), so I gave up; maintenance is now config-file and CLI only :( |
| 8 | Injected content is a view derived from persisted records | Task/reflection records and memory entries are stored in JSONL; deleting the data files loses historical basis—they are NOT a cache!!! |
| 9 | Writer holds an open file handle | You must disable the plugin before rotating logs and manipulating files |
| 10 | Self-opposition can only approximate "non-perfunctory," not guarantee it | The program enforces structure (11 fields, >=2 strengthening rounds, distinct targets per round, mandatory residual opposition); two formally distinct yet perfunctory arguments can still pass. The goal is to leave traces of perfunctoriness, not eliminate it |
| 11 | Condition 4 of the precedent gate cannot be mechanically verified | "Whether the evidence task matches the challenged lesson's applicability conditions" is a semantic judgment; the program only guarantees the task is real, failed, and had the lesson in force |
| 12 | `verified` counts have no control group | Lessons entering the active set at the same time share the same batch of tasks; counts cannot distinguish good lessons from bad ones, only reflecting exposure window length (see 4.5) |
| 13 | **Task entry depends on the model**: whether reflection materials exist depends on whether the model called `task_start` | Model forgets to open a task = zero materials for that stretch of work (not incomplete, nonexistent). `turnReflection` is the fallback for this, but it slices by turn, and 30% of tasks span multiple turns, leaving segments without prior context |
| 14 | Tasks can span turns, and materials for multi-turn tasks are only generated at `task_end` | A task spanning 13 turns has no materials until the very end, with no intermediate checkpoints. Per-turn mode adds checkpoints at the cost of slicing (see above) |

---

## 4. Experimental Data

The experiments below observe whether memories can transfer to independent sessions, rather than long-term training effects. Core experiments were conducted in workspaces with incomplete dependencies (missing `tsc` / `eslint`).

### 4.1 Toolchain Lesson (`npx`)

Criterion: Whether the model uses `npx` to run `tsc` without first checking `.bin`.

| Group | Sessions | Used `npx` | Did Not Use `npx` |
|---|---:|---:|---:|
| Without memory | 8 | 5 | 3 |
| With memory | 6 | **0** | **6** |

In the with-memory group, all 6 sessions checked `node_modules/.bin` first and skipped if missing. However, after adding two later no-memory samples, the no-memory group's `npx` usage rate dropped from 5/6 to 5/8, indicating the model itself can also act cautiously—one session proactively used `npx --no-install`, failing fast without pulling remote packages.

> Tentative conclusion: The memory group checked `.bin` first 6/6 times, consistently bringing the right practice forward. **This data is outdated as it came from v1 and has not been re-run after updates.**

### 4.2 Fix Methodology Lesson (`coupons`)

This experiment used a lesson unrelated to `npx`: when locating mutable fields in a shared default object, first use a `===` probe to prove reference equality, then copy the mutable fields in the factory function, and freeze the default object as a guardrail.

In an independent session, all three concrete actions were reproduced:

```text
1. Proved shared reference before the fix using a === probe
2. Copied mutable fields inside the factory function
3. Kept Object.freeze(DEFAULT_COUPONS) as a regression guardrail
```

Running the probe again after the fix flipped reference equality to `false`. This is the strongest transfer evidence so far: the lesson came from a different kind of task, and all three concrete actions were fully reproduced in an independent session (single-sample observation).

### 4.3 Task Boundary Nudge and Prompt Changes

The old nudge mechanism checked at the end of a turn: if no task had ever been opened in the session and substantive work was done in the current turn, inject a nudge.

**An observed flaw in this check**: it asked "has a task ever been opened in this session?", so **opening one once granted permanent immunity**. In session `144577dd`, across 35 turns after plugin deployment, the last 4 turns (turns 63/64/65/66) made 127/73/21/62 tool calls respectively—none with `task_start` and none inside any task window—yet **0** nudges were recorded. From turn 63 until session end, `task_start` appeared 0 times.

This has been changed to **per-turn detection** (see the corresponding subsection in 2.4), with 20 regression cases added in `test-nudge.mjs`, where Case 1 reproduces this exact scenario.

A limitation still remains: the nudge fires too late—a retroactively opened task can only record what happens after the nudge and cannot recover the decision trajectory that already occurred. One session's reflection materials had only 5 events for this reason. Consequently, the current wording explicitly **does not ask for retroactive opening**, instead telling the model to make `task_start` its first action at the start of the next turn.

**Note: This prompt change has not yet been verified.**

### 4.4 Tool Failure Count Methodology

Raw "tool failure" counts include many false positives: for example, `grep` finding no matches or `ls` on a nonexistent path can use non-zero exit codes to express normal query results. Experimental logs distinguish:

- `P`: Precondition failure (benchmark already failed before the fix)
- `A`: Counting false positive (statistical distortion, subtracted when computing adjusted effective counts)
- `M`: Genuine model-side mistake or failure uncovered by model self-testing (retained as-is)

Both raw counts and adjusted effective counts are preserved. Looking only at raw counts overestimates failures. `tool_failures` in the plugin currently still uses non-zero exit status.

### 4.5 Precedent Count Distribution on Real Data (For Reference Only)

Running `computePrecedents` on my `tasks.jsonl` (44 closed tasks, 32 snapshotted lessons):

```text
Computed precedent entries: 32
Top 6 most verified:
  19 verified / 1 counter  task-a08f9625…
  19 verified / 1 counter  task-28b1c958…
  19 verified / 1 counter  task-afbdb466…
  (3 more identical)
Entries with counterexamples: 11 / 32
Entries never in effect: 0
```

**What these numbers show**: 23 lessons entered the active set at the exact same moment and stayed active together ever since—**no batch of tasks ever ran in their absence**. Thus, the absolute value of `verified` cannot tell good lessons from bad ones; it only measures the length of the exposure window.

This is why the README defines "verified as effective" **probabilistically** at the start: this count can answer "how many times was this lesson used, and how many of those succeeded," not "is it a good lesson?" Treating it as a necessary condition (there must be a counterexample before rewriting) holds; treating it as a sufficient condition (high `verified` means it must be right) does not.

### 4.6 Empirical Boundaries of Three Features (For Reference Only)

| Feature | Verified | Unverified |
|---|---|---|
| Self-opposition | 11-field structure, 3 iterative strengthening rules (>=2 rounds / distinct target per round / mandatory residual opposition), `withdrawn` not persisted, `narrowed` enforces `applies_when`, `validity.premise_truth` required, `n/a` markers separated from body | **Argument quality**—the program can only guarantee "it was forced to strengthen twice and admit a residual," not whether those arguments are genuinely strong |
| Precedent gate | All 3 mechanical checks (exists / non-succeeded / in effect at the time) work; all 4 types of invalid evidence were rejected | "Matching its applicability conditions" is a semantic judgment not validated by the program |
| Failure entry type | `avoid`/`instead` persisted, rendered separately as `Known failures`, no longer mixed into `[Lesson N]` | Whether models actually treat negative constraints more strictly—requires long-term observation to tell |

**On the ceiling of the "iterative strengthening" step**: "Must strengthen until the counter-argument is no longer a strawman" is a **semantic requirement** that the program can only approximate: minimum round count, distinct attack targets per round, and mandatory unrefuted remainder. A model determined to go through the motions can still write two formally different yet substantively perfunctory arguments. True differentiation can only come from reading the full argument afterward via `lessons_lookup`—so this design aims to **leave traces of perfunctoriness**, not guarantee its absence.

**A known risk**: If the precedent gate is set too strictly, the model's reaction is not "revise more carefully," but **stop using `revise` altogether**. Before the fix, `revise` appeared only 2 times across 55 records, leaving little margin to begin with. After rollout, monitor the `relation` distribution—if `revise` drops to zero, the gate has become a de facto ban.

---

## 5. Usage

### 5.1 Installation

#### Method A: One-Click Install in the DSH UI

1. Open DSH and go to **Plugins → Add Plugin**.
2. Enter `dsh-lessons` (or the repository URL `https://github.com/duahciM/dsh-lessons`) and click **Install**.
3. Once installed, click **Enable Now**.

#### Method B: CLI Installation

```sh
dsh plugin --profile web add dsh-lessons
```

Restart `dsh web` after CLI installation. Headless users should use `--profile headless`.

Dependencies: No external services, zero npm dependencies (uses only Node built-in modules).

### 5.2 Configuration

`cordis.patch.yml`:

```yaml
- insert:
    - id: lessons
      name: 'dsh-lessons'
      config:
        taskDir: '<your-data-dir>/dsh-lessons-data'  # Storage location for task records and lessons
        fsyncEvery: 16                             # fsync every N entries
        taskBoundaryHints: true                    # Inject task boundary hints
        injectReflection: true                     # Inject reflection materials on task_end
        recordEvents: true                         # Persist tool calls and failures (not injected)
        stateFromFile: true                        # Derive task state from file (see 5.2.1)
        silentReflection: true                     # Reflect in chain-of-thought only, not as a visible reply (see 2.4)
        adversarialReview: false                   # Require full argument per lesson (high cost, off by default; see 2.3)
        precedentGate: true                        # Revising a precedent must cite a real counterexample (see 2.3)
        precedentInPrompt: true                    # Render verified/counter counts into the prompt
        turnReflection: false                      # Per-turn fallback reflection, bypassing task boundaries (see 2.4)
        turnReflectionMode: 'notice'               # notice = next message / wake = immediately trigger an extra turn
        lessons:
          enabled: true
          maxLessons: 0                            # 0 = inject all
          diagnostics: true                        # Write lessons-render.jsonl when content changes
          scopes:                                  # Three-tier toggles
            global: true
            session: true
            reflection: true
          batching: true                           # Batching (see 5.2.2)
          instantNotice: true                      # Instant notice for new reflections
          commitEvery: 8                           # Update system prompt once every N accumulated entries
          commitEveryTokens: 0                     # Or by token threshold (0 = ignored)
```

#### 5.2.1 `stateFromFile`: Derive Task State from File (On by Default)

In-progress tasks, reflectable tasks, which sessions have opened tasks, and how many nudges have fired—these were originally in-memory state and would be lost on plugin reload or process restart, causing:

- Broken in-progress tasks (`task_end` reports `no open task`, preventing reflection)
- Forgetting "a task was opened in this session" → falsely reporting "no task declared" every turn
- Nudge count resetting to zero → continuing to nudge past the cap

When enabled, these four sets of facts are rebuilt from `tasks.jsonl` on startup. Disabling it reverts to pure in-memory state (for control experiments).

#### 5.2.2 `batching` + `instantNotice`: Cache-Friendly

**Measured basis**: The median cache hit rate for `plugin:`-type injections is **99.9%**, whereas for `system/message` changes it is **0.0%** (~500k tokens recalculated per change). Caching uses prefix matching—appending at the end is nearly free, while changing the system prompt at the beginning invalidates the entire prefix.

Therefore:

```text
task_reflect → Write reflection
             → Below threshold: send a plugin notice (zero cache cost, immediately visible)
             → Threshold reached: advance "commit watermark," system prompt recalculates once
```

- `batching: false` → the section reflects all entries in real time, recalculating on every reflection
- `instantNotice` is only effective when `batching` is enabled (otherwise its content duplicates the section)

### 5.3 Daily Usage

The system prompt guides the Agent to call `task_start` before starting a task and `task_end` once an outcome is reached. Current prompts explicitly require `task_start` to be the first action of a task; reflection materials generated by `task_end` instruct the Agent to call `task_reflect`.

This still relies on the model following the prompt and actually calling the tools. If a task is opened retroactively after work has begun, the plugin cannot recover the unrecorded decision process prior to that point.

Manual memory maintenance:

```bash
node tools/lessons.mjs list --session <session_id>   # View what a session actually sees
node tools/lessons.mjs check                          # Structural check (references/statuses/boundaries)
node tools/lessons.mjs add --scope global --pattern "…" --correction "…" \
     --applies-when "…" --boundary "Why it belongs to this tier"
node tools/lessons.mjs move <id> --to global          # Promote (state transition, not a copy)
node tools/lessons.mjs remove <id>                    # Preview only, no write (exit 3 = awaiting approval)
node tools/lessons.mjs remove <id> --yes              # Actually write tombstone after confirmation
node tools/deprecate.mjs <id> --reason "…"           # Stop recommending while preserving history
node tools/deprecate.mjs --list
```

### 5.4 Structural Check

```bash
node tools/lessons.mjs check   # Reference integrity / status consistency / boundary declaration
```

---

## 6. File Structure

```text
index.js                 Plugin entry point: three tools + system prompt injection + event persistence
lib/
  task-model.js          Task records and parameter validation
  task-context.js        Decision trajectory extraction (excluding tool-call inventory)
  reflection-model.js    Reflection validation, four classifications, conflict declarations
  lessons.js             Three-tier resolution/folding/promotion override/conflict rendering/structural check
  writer.js              Crash-safe writer (write + batched fsync + read-back verification)
  classify.js            Tool failure signal detection (isError / non-zero exit / timeout / signal)
tools/
  lessons.mjs            Lesson maintenance CLI (list/add/move/remove/check/export/import)
  deprecate.mjs          Entry point for deprecated status
data/                    Created at runtime, not tracked in repo
  tasks.jsonl            Task records + reflections
  lessons/lessons.jsonl  Maintained global / session entries + patches
  tool-events.jsonl      Tool-call logs (write-only, not injected)
  error-events.jsonl     Failure logs (write-only, not injected)
docs/
  MEMORY-GOVERNANCE.md   Three-tier governance spec (responsibilities/dedup/promotion/conflicts/lifecycle)
  MEMORY-SCOPES.md       Three-scope visibility and injection rules
  TASK-BOUNDARY-DESIGN.md Task boundary layer design
  REFLECTION-PIPELINE.md Reflection generation and persistence
  LESSONS-INJECTION.md   Injection implementation and Prefix Cache benchmarks
```
