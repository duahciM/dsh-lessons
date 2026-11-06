/**
 * 元认知插件 · 任务边界层
 *
 * 只暴露两个模型可调用的工具：
 *   task_start  声明一个任务（目标 + 预期结果）
 *   task_end    声明该任务的结果，并触发事后反思材料注入
 *
 * 设计约束：
 *   1. 任务事件写到独立文件 tasks.jsonl（反思结束可删，符合规格）
 *   2. 不复制工具事件；用 [start_seq, end_seq] 圈选既有 tool-events / error-events
 *   3. 反思材料通过 exec.deferContext() 进入下一步，不做任何阻塞式调用
 *   4. 若新任务开始时旧任务未结束，旧任务标记 closed_by=superseded + abandoned
 */
import { join } from "node:path";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildTaskRecord, newTaskId, TASK_STATUS, validateEnd, validateStart } from "./lib/task-model.js";
import { renderReflectionBrief, sliceDecisionTrail } from "./lib/task-context.js";
import { buildReflectionRecord, validateReflect } from "./lib/reflection-model.js";
import { createLessonStore, renderLessonsSection, parseLessons, parseLessonEntries } from "./lib/lessons.js";
import { classifyToolOutcome } from "./lib/classify.js";
import { createDurableWriter } from "./lib/writer.js";

export const name = "lessons";

/**
 * 硬依赖 tools：本插件的核心价值就是三个工具。
 *
 * 之前写成空数组，导致插件可能先于 `tools` 服务激活——那样
 * `ctx.get("tools")` 返回 undefined，工具注册被静默跳过，
 * 而 systemPrompt 段（在工具注册之前执行）却已经注册成功，
 * 于是出现「系统提示里有 Task boundaries，但模型手上没有 task_start」。
 *
 * 声明 inject 后，Cordis 会等 tools 就绪才调用 apply，与激活顺序无关。
 */
export const inject = ["tools"];

/**
 * 任务边界提示段的静态正文。
 *
 * 位置很关键：放在工具文档之前（order 700），否则会被 8k 字符的
 * 工具说明淹没——实测放在末尾时合规率只有 1/2。
 *
 * 这里只给判定规则；完整定义在 task_start 的工具描述里，不重复。
 */
const TASK_BOUNDARY_TEXT = [
  "## Task boundaries",
  "",
  "A task is a unit of work with a clear goal or expected result that takes one or more steps.",
  "Work the user asks for counts; so do investigation, analysis, verification, edits, and",
  "generation. Success is not required, and tool use is not required. When it is unclear",
  "whether a unit of work is a task, treat it as one rather than excluding it.",
  "",
  "You MUST call task_start as the FIRST action of a task — before reading files, running",
  "commands, searching, or editing anything. Never do the work first and declare the task",
  "afterwards; a task declared after the fact has no decision record.",
  "Call task_end once that result exists, whether or not it succeeded.",
].join("\n");

/**
 * 漏开任务时的提醒正文。
 *
 * 措辞必须与上面的判定保持一致——否则模型会拿到两套「什么算任务」的标准。
 * 这里只陈述事实（做了多少工作）+ 复述判定 + 给出补救动作。
 */
function missedTaskText(calls, edits) {
  const work = [`${calls} 次工具调用`];
  if (edits > 0) work.push(`${edits} 次文件改动`);
  return [
    "<lessons_task_missing>",
    `这一回合做了实际工作（${work.join("、")}），但没有声明任何任务。`,
    "",
    "按任务的定义：一个具有明确目标或预期结果、需要一个或多个工作步骤才能完成的工作单元。",
    "用户要求完成的工作算任务；不确定是否属于任务时，优先把它当作任务。",
    "",
    "如果这一回合构成这样的工作单元，请现在用 task_start 声明、用 task_end 结束，",
    "让它被记录下来，然后用 task_reflect 写下你的结论。",
    "</lessons_task_missing>",
  ].join("\n");
}

const DEFAULTS = {
  taskDir: join(process.cwd(), "dsh-lessons-data"),
  fsyncEvery: 32,
  /** 反思材料注入开关，便于对照测试 */
  injectReflection: true,
  /** 事件落盘（工具调用/失败），只记录不注入 */
  recordEvents: true,
  /** 任务边界提示段（告诉模型何时调用 task_start / task_end） */
  taskBoundaryHints: true,
  taskBoundarySectionName: "lessons:task-boundaries",
  // 700 = 在 PLAN_POLICY(500)/TEAM_POLICY(600) 之后、所有工具段(1000+) 之前。
  // 放在末尾时实测被工具文档淹没，合规率只有 1/2。
  taskBoundaryOrder: 700,
  /**
   * 漏开任务的提醒：一个回合做了实质工作却从未声明任务时，在回合收尾注入一次提示。
   * mode: "inject" 只进下一次输入（不唤醒，零额外成本）；
   *       "wake"   立刻唤醒 Agent 跑一个补录回合（会产生额外回合）。
   */
  missedTaskNudge: true,
  missedTaskNudgeMode: "inject",
  missedTaskMinCalls: 3,
  missedTaskMaxPerSession: 2,
  /** 步骤 3：把积累的经验注入 system prompt */
  lessons: {
    enabled: true,
    sectionName: "lessons:accumulated",
    /** 排在所有既有段落之后：前缀尽量复用，只有尾部随记忆变化 */
    order: 10500,
    /** 0 = 不截断（按当前阶段要求：每条记忆都进上下文） */
    maxLessons: 0,
    /** 每次装配产出的内容变化时记一条诊断 */
    diagnostics: true,
    /**
     * 三域开关。默认全开；对照实验可按域关闭。
     *   global     跨任务工作方法（所有会话）
     *   session    会话背景（仅本会话）
     *   reflection 任务反思（仅本会话）
     */
    scopes: { global: true, session: true, reflection: true },
    /** 手工/晋升写入的 global 与 session 条目；默认 <taskDir>/lessons/lessons.jsonl */
    lessonFile: undefined,
  },
};

function readConfig(raw) {
  const cfg = { ...DEFAULTS, lessons: { ...DEFAULTS.lessons, scopes: { ...DEFAULTS.lessons.scopes } } };
  if (raw && typeof raw === "object") {
    if (typeof raw.taskDir === "string" && raw.taskDir) cfg.taskDir = raw.taskDir;
    if (Number.isSafeInteger(raw.fsyncEvery) && raw.fsyncEvery > 0) cfg.fsyncEvery = raw.fsyncEvery;
    if (typeof raw.injectReflection === "boolean") cfg.injectReflection = raw.injectReflection;
    if (typeof raw.recordEvents === "boolean") cfg.recordEvents = raw.recordEvents;
    if (typeof raw.taskBoundaryHints === "boolean") cfg.taskBoundaryHints = raw.taskBoundaryHints;
    if (typeof raw.taskBoundarySectionName === "string" && raw.taskBoundarySectionName) {
      cfg.taskBoundarySectionName = raw.taskBoundarySectionName;
    }
    if (Number.isFinite(raw.taskBoundaryOrder)) cfg.taskBoundaryOrder = raw.taskBoundaryOrder;
    if (typeof raw.missedTaskNudge === "boolean") cfg.missedTaskNudge = raw.missedTaskNudge;
    if (raw.missedTaskNudgeMode === "inject" || raw.missedTaskNudgeMode === "wake") {
      cfg.missedTaskNudgeMode = raw.missedTaskNudgeMode;
    }
    if (Number.isSafeInteger(raw.missedTaskMinCalls) && raw.missedTaskMinCalls > 0) {
      cfg.missedTaskMinCalls = raw.missedTaskMinCalls;
    }
    if (Number.isSafeInteger(raw.missedTaskMaxPerSession) && raw.missedTaskMaxPerSession >= 0) {
      cfg.missedTaskMaxPerSession = raw.missedTaskMaxPerSession;
    }
    if (raw.lessons && typeof raw.lessons === "object") {
      const l = raw.lessons;
      if (typeof l.enabled === "boolean") cfg.lessons.enabled = l.enabled;
      if (typeof l.sectionName === "string" && l.sectionName) cfg.lessons.sectionName = l.sectionName;
      if (Number.isFinite(l.order)) cfg.lessons.order = l.order;
      if (Number.isSafeInteger(l.maxLessons) && l.maxLessons >= 0) cfg.lessons.maxLessons = l.maxLessons;
      if (typeof l.diagnostics === "boolean") cfg.lessons.diagnostics = l.diagnostics;
      if (typeof l.lessonFile === "string" && l.lessonFile) cfg.lessons.lessonFile = l.lessonFile;
      if (l.scopes && typeof l.scopes === "object") {
        for (const k of ["global", "session", "reflection"]) {
          if (typeof l.scopes[k] === "boolean") cfg.lessons.scopes[k] = l.scopes[k];
        }
      }
    }
  }
  return cfg;
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function apply(ctx, rawConfig) {
  const cfg = readConfig(rawConfig);
  const logger = safe(() => ctx.logger, undefined);
  const warn = (m) => safe(() => logger?.warn?.(m));
  const info = (m) => safe(() => logger?.info?.(m));

  const writer = createDurableWriter(join(cfg.taskDir, "tasks.jsonl"), {
    fsyncEvery: cfg.fsyncEvery,
    onError: (phase, e) => warn(`[lessons] tasks ${phase}: ${String(e)}`),
  });

  const taskFile = join(cfg.taskDir, "tasks.jsonl");
  const lessonFile = cfg.lessons.lessonFile ?? join(cfg.taskDir, "lessons", "lessons.jsonl");

  // ── 步骤 3：把积累的反思注入 system prompt ──────────────────────────────
  const lessonStore = createLessonStore({ taskFile, lessonFile });

  // ── 事件储存（原事件储存模块，已并入本插件）──────────────────────────
  // 只落盘，不做任何注入：工具计数注入会污染实验条件，已废弃。
  let toolWriter;
  let errorWriter;
  if (cfg.recordEvents) {
    toolWriter = createDurableWriter(join(cfg.taskDir, "tool-events.jsonl"), {
      fsyncEvery: cfg.fsyncEvery,
      onError: (phase, e) => warn(`[lessons] tool-events ${phase}: ${String(e)}`),
    });
    errorWriter = createDurableWriter(join(cfg.taskDir, "error-events.jsonl"), {
      fsyncEvery: cfg.fsyncEvery,
      onError: (phase, e) => warn(`[lessons] error-events ${phase}: ${String(e)}`),
    });

    ctx.on("tools/result", (exec, result) => {
      try {
        const outcome = classifyToolOutcome(exec, result);
        const agent = safe(() => exec?.agent, undefined);
        const record = {
          ev: "tool",
          ts: Date.now(),
          sessionId: sessionIdOf(agent),
          agentId: safe(() => agent?.id, undefined),
          cwd: safe(() => agent?.session?.header?.cwd, undefined),
          callId: safe(() => exec?.callId, undefined),
          tool: safe(() => exec?.name, undefined),
          failed: outcome.failed === true,
          signals: Array.isArray(outcome.signals) ? outcome.signals : [],
        };
        toolWriter.append(`${JSON.stringify(record)}\n`);
        if (record.failed) {
          errorWriter.append(`${JSON.stringify({ ...record, ev: "error", detail: outcome.detail ?? null })}\n`);
        }
      } catch (e) {
        warn(`[lessons] tools/result handler swallowed: ${String(e)}`);
      }
    });

    ctx.effect(
      () => () => {
        safe(() => toolWriter.close());
        safe(() => errorWriter.close());
      },
      "lessons: event writers",
    );
  }

  let lastRenderedHash = "";
  let hintRendered = false;
  let renderCount = 0;

  function diagnostics(entry) {
    if (!cfg.lessons.diagnostics) return;
    try {
      appendFileSync(join(cfg.taskDir, "lessons-render.jsonl"), `${JSON.stringify(entry)}\n`);
    } catch {
      /* 诊断失败不影响注入 */
    }
  }

  /**
   * 每次装配都会被调用；读盘走 mtime 缓存，只有内容变化才写诊断。
   * context 由 Agent 循环传入（{ agent, scope }），用于按会话/工作区分域。
   */
  /**
   * 从装配上下文解析当前会话。
   *
   * 当前 DSH 的 AssembleContext 只有 { scope, signal }，没有 agent。
   * scope 就是 Agent 对象本身（ScopeKey），因此：
   *   1. 优先读 scope.id（Agent.id 即 SessionId）
   *   2. 回退到 agents.get(scope) —— 覆盖 scope 为其它 carrier 的情况
   * 两者都拿不到时返回 null，此时只注入 global 层。
   */
  function resolveSessionId(context) {
    const scope = context?.scope;
    if (scope === undefined || scope === null) return null;
    const direct = safe(() => scope.id, null);
    if (typeof direct === "string" && direct) return direct;
    const agents = safe(() => ctx.get("agents"), undefined);
    if (agents !== undefined) {
      const found = safe(() => agents.list?.()?.find((a) => a === scope || a?.id === scope), undefined);
      const id = safe(() => found?.id, null);
      if (typeof id === "string" && id) return id;
    }
    const viaGet = safe(() => agents?.get?.(scope), undefined);
    const id2 = safe(() => viaGet?.id, null);
    return typeof id2 === "string" && id2 ? id2 : null;
  }

  function renderSectionText(context) {
    try {
      // 分域求值：global 全局可见；session/reflection 只对所属会话可见
      const sessionId = resolveSessionId(context);
      const { lessons } = lessonStore.read(sessionId, cfg.lessons.scopes);
      const text = renderLessonsSection(lessons, { maxLessons: cfg.lessons.maxLessons });
      renderCount += 1;
      const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
      if (hash !== lastRenderedHash) {
        lastRenderedHash = hash;
        const byScope = { global: 0, session: 0, reflection: 0 };
        for (const l of lessons) byScope[l.scope] = (byScope[l.scope] ?? 0) + 1;
        diagnostics({
          ts: Date.now(),
          lessons: lessons.length,
          byScope,
          chars: text.length,
          hash,
          ids: lessons.map((l) => l.id).slice(0, 50),
          renders: renderCount,
          // 诊断：区分「带 agent 的装配」与「不带 agent 的装配」
          ctxKeys: Object.keys(context ?? {}).sort().join(","),
          hasScope: context?.scope !== undefined,
          session: sessionId,
          cwd: null, // 当前 AssembleContext 不提供 cwd
        });
      }
      return text;
    } catch (e) {
      warn(`[lessons] lesson section render failed: ${String(e)}`);
      return "";
    }
  }

  const systemPrompt = safe(() => ctx.get("systemPrompt"), undefined);
  if (systemPrompt === undefined) {
    if (cfg.lessons.enabled || cfg.taskBoundaryHints) {
      warn("[lessons] systemPrompt service unavailable; prompt sections will not be injected");
    }
  } else {
    // 任务边界提示：静态文本，告诉模型「什么时候」用这两个工具。
    // 「怎么用」在工具定义里，不在这里重复。
    if (cfg.taskBoundaryHints) {
      const disposeHints = systemPrompt.section({
        name: cfg.taskBoundarySectionName,
        order: cfg.taskBoundaryOrder,
        interpolate: false,
        // 内容是常量；用函数形式只为记录一次「确实被装配过」的证据
        text: () => {
          if (!hintRendered) {
            hintRendered = true;
            diagnostics({
              ts: Date.now(),
              section: cfg.taskBoundarySectionName,
              kind: "task-boundaries",
              chars: TASK_BOUNDARY_TEXT.length,
            });
          }
          return TASK_BOUNDARY_TEXT;
        },
      });
      ctx.effect(() => () => safe(() => disposeHints?.()));
      info(`[lessons] task-boundary section "${cfg.taskBoundarySectionName}" registered at order ${cfg.taskBoundaryOrder}`);
    }

    if (cfg.lessons.enabled) {
      const dispose = systemPrompt.section({
        name: cfg.lessons.sectionName,
        // 放在所有既有段落之后：前缀尽量复用，只让尾部随记忆变化
        order: cfg.lessons.order,
        interpolate: false,
        text: renderSectionText,
      });
      ctx.effect(() => () => safe(() => dispose?.()));
      info(`[lessons] lessons section "${cfg.lessons.sectionName}" registered at order ${cfg.lessons.order}`);
    }
  }

  // ── 漏开任务提醒 ────────────────────────────────────────────────────────
  /** 曾经开过任务的会话：开过一次就不再提醒。 */
  const everOpened = new Set();
  /** 已经扫描过历史、确认没有 task_start 的会话（避免每回合重扫）。 */
  const scannedNoTask = new Set();
  /** 每个会话已提醒的次数。 */
  const nudgeCount = new Map();

  /**
   * 该会话是否曾经开过任务。
   *
   * 不能只靠内存集合：插件重载或进程重启会清空它，于是「两天前开过任务」
   * 的会话会被误判成从未开过、收到误报。所以首次判断时回扫一次会话日志，
   * 之后靠集合（task_start 也会即时写入集合）与「已扫描」标记短路。
   */
  async function sessionEverOpenedTask(agent, sessionId) {
    if (everOpened.has(sessionId)) return true;
    if (scannedNoTask.has(sessionId)) return false;
    const events = await readEvents(sessionIdOf(agent) ?? sessionId);
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e?.type === "tool/call" && e.data?.name === "task_start") {
          everOpened.add(sessionId);
          return true;
        }
      }
    }
    scannedNoTask.add(sessionId);
    return false;
  }

  /**
   * 回合收尾时检查：本回合做了实质工作，但整个会话从未声明任务。
   *
   * 事件是 serial（无框架兜底），所以整体 try/catch，且绝不做耗时操作。
   */
  ctx.on("agent/turn-stopping", async (payload) => {
    try {
      if (!cfg.missedTaskNudge) return;
      const agent = payload?.agent;
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return;
      if (await sessionEverOpenedTask(agent, sessionId)) return;

      const used = nudgeCount.get(sessionId) ?? 0;
      if (used >= cfg.missedTaskMaxPerSession) return;

      const events = await readEvents(sessionIdOf(agent) ?? sessionId);
      if (!Array.isArray(events) || events.length === 0) return;

      // 只看当前回合：从最后一个 turn/start 起算
      let turnStart = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === "turn/start") {
          turnStart = i;
          break;
        }
      }
      if (turnStart < 0) return;

      let calls = 0;
      let edits = 0;
      for (let i = turnStart; i < events.length; i++) {
        const e = events[i];
        if (e?.type !== "tool/call") continue;
        const name = e.data?.name;
        // task_start 的在场与否已由 sessionEverOpenedTask 统一判断
        if (name === "task_start") continue;
        calls += 1;
        if (name === "edit" || name === "write") edits += 1;
      }
      if (calls < cfg.missedTaskMinCalls && edits === 0) return;

      nudgeCount.set(sessionId, used + 1);
      const message = makeNoticeMessage(missedTaskText(calls, edits), `missed task in turn ${payload?.turn ?? "?"}`);
      if (cfg.missedTaskNudgeMode === "wake") safe(() => agent.followup(message));
      else safe(() => agent.inject(message));
      info(`[lessons] missed-task nudge #${used + 1} for ${sessionId} (calls=${calls}, edits=${edits})`);
    } catch (e) {
      warn(`[lessons] missed-task nudge failed: ${String(e)}`);
    }
  });

  /**
   * 每个 session 至多一个「进行中」的任务。
   * 之所以按 session 分：一个 DSH 进程可能服务多个会话，任务不能串。
   */
  const open = new Map(); // sessionId -> { task }
  /**
   * 最近关闭的任务，供 task_reflect 校验 task_id。
   * 有界：只留最近 20 条，避免长会话无限增长。
   */
  const closed = new Map(); // taskId -> { record, lessonsWritten }
  function rememberClosed(record) {
    closed.set(record.task_id, { record, lessonsWritten: 0 });
    while (closed.size > 20) {
      const oldest = closed.keys().next().value;
      closed.delete(oldest);
    }
  }
  let lastLine = "";

  function writeRecord(rec) {
    lastLine = JSON.stringify(rec);
    return writer.append(`${lastLine}\n`);
  }

  /**
   * Agent 在当前 DSH 里只有 `id`（即 SessionId），没有 `session` 属性。
   * 会话内容一律通过 sessionQuery 读取。
   */
  function sessionIdOf(agent) {
    const id = safe(() => agent?.id, undefined);
    return typeof id === "string" && id ? id : undefined;
  }

  /**
   * 当前会话的实时 seq；用于划定任务区间右端。
   * 经 sessionQuery 异步读取（Agent 只有 id，没有 live Session 句柄）。
   */
  async function currentSeq(agent) {
    const id = sessionIdOf(agent);
    if (!id) return null;
    const events = await readEvents(id);
    const last = events.length > 0 ? events[events.length - 1]?.seq : null;
    return typeof last === "number" ? last : null;
  }

  /** 读某会话的完整事件序列（异步，经 sessionQuery）。 */
  async function readEvents(sessionId) {
    if (!sessionId) return [];
    const q = safe(() => ctx.get("sessionQuery"), undefined);
    if (q === undefined) return [];
    const events = await safeAsync(() => q.listEvents(sessionId), []);
    const last = Array.isArray(events) && events.length > 0 ? events[events.length - 1]?.seq : null;

    return Array.isArray(events) ? events : [];
  }

  async function safeAsync(fn, fallback) {
    try {
      const v = await fn();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  async function* noop() {}

  // ── 工具注册 ─────────────────────────────────────────────────────────────
  const tools = safe(() => ctx.get("tools"), undefined);
  if (tools === undefined) {
    warn("[lessons] tools service unavailable; task tools not registered");
    return;
  }

  const START_OUTPUT = {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "goal", "expected_result"],
      properties: {
        task_id: { type: "string" },
        goal: { type: "string" },
        expected_result: { type: "string" },
      },
    },
    render: (_args, value) => [
      {
        type: "text",
        text: `Task opened: ${value.task_id}\nGoal: ${value.goal}\nExpected result: ${value.expected_result}\nCall task_end when — and only when — that result exists (or it becomes clear it cannot).`,
      },
    ],
  };

  const END_OUTPUT = {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "status", "review_pending", "tool_failures"],
      properties: {
        task_id: { type: "string" },
        status: { type: "string" },
        review_pending: { type: "boolean" },
        tool_failures: { type: "number" },
      },
    },
    render: (_args, value) => [
      {
        type: "text",
        text:
          `Task closed: ${value.task_id} (${value.status}).` +
          (value.tool_failures > 0 ? ` ${value.tool_failures} tool-level failure(s) noted as auxiliary evidence.` : "") +
          (value.review_pending ? " A review brief for this task follows." : ""),
      },
    ],
  };

  const REFLECT_OUTPUT = {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "lessons_recorded"],
      properties: {
        task_id: { type: "string" },
        lessons_recorded: { type: "number" },
      },
    },
    render: (_args, value) => [
      {
        type: "text",
        text:
          value.lessons_recorded === 0
            ? `Reflection recorded for ${value.task_id}: nothing generalizable beyond this task.`
            : `Reflection recorded for ${value.task_id}: ${value.lessons_recorded} lesson(s).`,
      },
    ],
  };

  tools.register({
    name: "task_start",
    description:
      "Open a task before starting it. A task is a unit of work with a clear goal or expected result that takes one or more steps: work the user asks you to do, work you decide to do, a stage split out of a larger goal, or any request to investigate, analyze, verify, change, organize, or produce something. Do not decide by counting tool calls or steps — when it is unclear whether something is a task, treat it as one. A plain conversational reply, or a single step with no goal of its own, is not a task. Call task_end when the result exists.",
    // 原生注册：parameters 必须是完整 JSON Schema 对象
    // （ctx.tools.register 只做结构校验，不编译 ParameterSchemaSpec）。
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["goal", "expected_result"],
      properties: {
        goal: {
          type: "string",
          description: "What you are about to achieve, in one or two sentences.",
        },
        expected_result: {
          type: "string",
          description:
            "A checkable definition of done: what must be true for this task to count as finished, whether it succeeds or fails.",
        },
        parent_task_id: {
          type: "string",
          description: "Optional: the task_id of the parent task when this is a staged sub-task.",
        },
      },
    },
    output: START_OUTPUT,
    async execute(args, exec) {
      const v = validateStart(args);
      if (!v.ok) throw new Error(v.error);

      const sessionId = sessionIdOf(exec?.agent);
      if (!sessionId) throw new Error("task_start requires an owning agent session");

      // 该会话从此不再需要「漏开任务」提醒
      everOpened.add(sessionId);
      // 旧任务未结束 → 标记 superseded，而不是静默丢弃
      const prev = open.get(sessionId);
      if (prev) {
        const endSeq = await currentSeq(exec.agent);
        const prevTrail = sliceDecisionTrail({
          events: await readEvents(sessionId),
          startSeq: prev.task.start_seq,
          endSeq,
        });
        const prevRecord = buildTaskRecord({
          taskId: prev.task.task_id,
          sessionId,
          goal: prev.task.goal,
          expectedResult: prev.task.expected_result,
          startTime: prev.task.start_time,
          endTime: Date.now(),
          status: TASK_STATUS.ABANDONED,
          result: "(superseded by a new task_start; no result was reported)",
          startSeq: prev.task.start_seq,
          endSeq,
          toolFailures: prevTrail.failureCount,
          parentTaskId: prev.task.parent_task_id,
          closedBy: "superseded",
        });
        writeRecord({ ...prevRecord, ev: "task_close", record_type: "close" });
        rememberClosed(prevRecord);
      }

      const taskId = newTaskId();
      const task = {
        task_id: taskId,
        goal: v.goal,
        expected_result: v.expected,
        start_time: Date.now(),
        start_seq: await currentSeq(exec.agent),
        parent_task_id: typeof args.parent_task_id === "string" && args.parent_task_id.trim() ? args.parent_task_id.trim() : null,
      };
      open.set(sessionId, { task });

      writeRecord({
        ev: "task_open",
        record_type: "open",
        task_id: taskId,
        session_id: sessionId,
        goal: v.goal,
        expected_result: v.expected,
        start_time: task.start_time,
        start_seq: task.start_seq,
        parent_task_id: task.parent_task_id,
      });

      return { task_id: taskId, goal: v.goal, expected_result: v.expected };
    },
  });

  tools.register({
    name: "task_end",
    description:
      "Declare that the task's expected result now exists — or that it cannot be reached — and record what actually happened. Ends the task and returns a review brief over the work done between task_start and this call. Call it for every task you opened, whether it succeeded or not.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "status", "result"],
      properties: {
        task_id: {
          type: "string",
          description: "The task_id returned by task_start.",
        },
        status: {
          type: "string",
          enum: ["succeeded", "failed", "abandoned", "aborted"],
          description:
            "succeeded: the expected result exists. failed: it does not, and you know why. abandoned: you stopped pursuing it. aborted: it was interrupted.",
        },
        result: {
          type: "string",
          description: "What actually happened: the concrete outcome, including what was verified.",
        },
      },
    },
    output: END_OUTPUT,
    async execute(args, exec) {
      const v = validateEnd(args);
      if (!v.ok) throw new Error(v.error);

      const sessionId = sessionIdOf(exec?.agent);
      if (!sessionId) throw new Error("task_end requires an owning agent session");

      const state = open.get(sessionId);
      if (!state) throw new Error("no open task for this session; call task_start first");
      if (state.task.task_id !== args.task_id) {
        throw new Error(
          `task_id mismatch: open task is "${state.task.task_id}", got "${args.task_id}"`
        );
      }

      const endSeq = await currentSeq(exec.agent);
      // 以「决策轨迹」为主：对话、纠正、回合；工具失败只计数
      const trail = sliceDecisionTrail({
        events: await readEvents(sessionId),
        startSeq: state.task.start_seq,
        endSeq,
      });

      const record = buildTaskRecord({
        taskId: state.task.task_id,
        sessionId,
        goal: state.task.goal,
        expectedResult: state.task.expected_result,
        startTime: state.task.start_time,
        endTime: Date.now(),
        status: v.status,
        result: v.result,
        startSeq: state.task.start_seq,
        endSeq,
        toolFailures: trail.failureCount,
        parentTaskId: state.task.parent_task_id,
        closedBy: "manual",
      });
      // 与 task_open 对齐：关闭记录也带 record_type，便于按类型筛选
      writeRecord({ ...record, ev: "task_close", record_type: "close" });
      rememberClosed(record);

      // 关闭任务，避免重复结束
      open.delete(sessionId);

      // 反思材料只挂在本轮，通过 additionalContexts 进入下一步
      const brief =
        cfg.injectReflection && trail.stats.events > 0
          ? renderReflectionBrief({ task: record, trail })
          : undefined;
      if (brief) {
        safe(() => exec.deferContext?.(makeContextMessage(brief, record.task_id)));
      }
      writer.sync();

      return {
        task_id: record.task_id,
        status: record.status,
        review_pending: Boolean(brief),
        tool_failures: record.tool_failures,
      };
    },
  });

  tools.register({
    name: "task_reflect",
    description:
      "Record what you concluded from reviewing a closed task. Each lesson describes a reusable pattern in how you worked and the adjustment it calls for — not what a specific tool did. If nothing generalizes beyond this task, pass an empty lessons array.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "assessment"],
      properties: {
        task_id: {
          type: "string",
          description: "The task_id of the closed task you reviewed.",
        },
        assessment: {
          type: "string",
          enum: ["aligned", "partial", "diverged"],
          description:
            "How the actual result compared to the expected result: aligned, partial, or diverged.",
        },
        source: {
          type: "string",
          description:
            "Where this experience came from, in your own words: the situation or mistake that produced it (e.g. 'npx 拉错了同名包' or '修 cart 别名 bug 时才发现的'). Keep it factual and short; it is kept as provenance, not injected.",
        },
        lessons: {
          type: "array",
          description: "At most three; omit or pass an empty array when nothing transfers to future work.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pattern", "correction", "applies_when"],
            properties: {
              pattern: {
                type: "string",
                description: "The recurring working-method issue the timeline actually shows.",
              },
              correction: {
                type: "string",
                description: "What to do differently next time.",
              },
              applies_when: {
                type: "string",
                description: "The situation that should trigger this correction.",
              },
              confidence: {
                type: "string",
                enum: ["low", "medium", "high"],
                description: "Defaults to medium.",
              },
              relation: {
                type: "string",
                enum: ["new", "repeat", "revise", "none"],
                description:
                  "How this lesson relates to what is already recorded: new (not seen before), repeat (the same lesson again — counts as evidence, no new entry), revise (this replaces the existing lesson named by target), none (adds nothing, not stored). Defaults to new.",
              },
              target: {
                type: "string",
                description:
                  "The lesson_id being repeated or revised. Required when relation is repeat or revise.",
              },
              conflicts: {
                type: "array",
                description:
                  "Explicit tension with another memory you can already see. This declares a relationship; it does not resolve it. Both memories stay in force and the reviewer decides per situation.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["with", "kind"],
                  properties: {
                    with: {
                      type: "string",
                      description: "The lesson_id this one is in tension with.",
                    },
                    kind: {
                      type: "string",
                      enum: ["condition", "goal", "contradiction", "apparent"],
                      description:
                        "condition: they apply in different environments. goal: they demand different behaviors. contradiction: opposite demands under the same condition. apparent: one is a general rule and the other a specific exception.",
                    },
                    note: {
                      type: "string",
                      description: "Optional one-line explanation of the tension.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    output: REFLECT_OUTPUT,
    async execute(args, exec) {
      const v = validateReflect(args);
      if (!v.ok) throw new Error(v.error);

      const entry = closed.get(v.taskId);
      if (!entry) {
        const known = [...closed.keys()].slice(-5);
        throw new Error(
          `unknown or expired task_id "${v.taskId}"; recently closed tasks: ${known.length ? known.join(", ") : "(none)"}`
        );
      }

      const sessionId = sessionIdOf(exec?.agent);
      const offset = entry.lessonsWritten;

      // `none` 不落盘：无新增信息的反思不占用后续注入预算（治理规范 §2.1）
      const written = v.lessons.filter((l) => l.relation !== "none");
      entry.lessonsWritten += written.length;
      if (written.length > 0) {
        writeRecord(buildReflectionRecord({
          taskId: v.taskId,
          sessionId,
          assessment: v.assessment,
          source: v.source,
          lessons: written,
          offset,
        }));
      }

      return { task_id: v.taskId, lessons_recorded: written.length };
    },
  });

  const END_MARK = "lessons_task_closed";
  let ctxSeq = 0;
  /** 构造一条注给模型看的通知消息（role=user + 插件 source）。 */
  function makeNoticeMessage(text, summary) {
    ctxSeq += 1;
    return {
      id: `plugin:lessons:${Date.now().toString(36)}:${ctxSeq}`,
      role: "user",
      content: [{ type: "text", text }],
      source: {
        kind: "plugin:lessons",
        form: "notice",
        summary: String(summary ?? "").slice(0, 120),
      },
    };
  }
  function makeContextMessage(text, taskId) {
    return makeNoticeMessage(text, `task closed: ${taskId}`);
  }

  // 卸载：落盘并封存仍开着的任务（会话结束时它们没有结果）
  ctx.effect(
    () => () => {
      try {
        for (const [sessionId, state] of open) {
          writeRecord({
            ev: "task_orphaned",
            record_type: "orphan",
            task_id: state.task.task_id,
            session_id: sessionId,
            goal: state.task.goal,
            expected_result: state.task.expected_result,
            start_time: state.task.start_time,
            start_seq: state.task.start_seq,
            closed_by: "session-end",
          });
        }
        open.clear();
      } catch {
        /* ignore */
      }
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    },
    "lessons.writer"
  );

  info(`[lessons] mounted; tasks -> ${join(cfg.taskDir, "tasks.jsonl")}`);
}

export const internals = { readConfig, validateStart, validateEnd };

