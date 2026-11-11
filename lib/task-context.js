/**
 * 任务上下文截取：以「决策过程」为主线，而不是以工具调用为主线。
 *
 * 设计依据（实测）：
 *   - 任务成功但过程中有工具失败；任务失败但工具层无失败。
 *     这两个组合证明：任务结果才是反思入口，工具失败只是辅助证据。
 *   - 反思要还原的是「判断与决策」，不是「工具调用序列」。
 *
 * 因此本模块：
 *   ✅ 收集：用户请求与纠正、助手对外表述、任务声明与结果、回合结束方式
 *   ✅ 必要时附一小段内部推理（仅在助手没有对外文本时）
 *   ✅ 工具层失败只保留「计数」，不保留调用清单
 *   ❌ 不收集：工具名、参数、调用顺序、每次调用的成败明细
 *
 * 产出一段可注入的文本，供模型还原决策过程。
 */

const MAX_EXCHANGES = 24;
const MAX_USER_CHARS = 1500;
const MAX_ASSISTANT_CHARS = 1200;
const MAX_REASONING = 4;
const MAX_REASONING_CHARS = 240;
const MAX_TURN_NOTES = 12;

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function reasoningOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "reasoning" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function collapse(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 截取一个任务区间的「决策轨迹」。
 *
 * @param {object} p
 * @param {readonly object[]} p.events 会话事件（seq 升序）
 * @param {number} p.startSeq 起始 seq（闭区间）
 * @param {number} p.endSeq   结束 seq（闭区间）
 * @returns 结构化轨迹
 */
export function sliceDecisionTrail({ events, startSeq, endSeq }) {
  const out = {
    exchanges: [], // { seq, role: 'user'|'assistant', kind, text }
    reasoning: [], // { seq, text }
    turns: [], // { seq, turn, reason }
    failureCount: 0,
    /**
     * 任务开启前、同一 turn 内最近的一条人类消息。
     * 任务常常在用户说完话之后才被声明，此时原始请求落在区间之外；
     * 但「目标理解是否正确」必须对照这条请求才能判断。
     */
    precedingRequest: null, // { seq, text }
    stats: { events: 0, userMessages: 0, assistantTexts: 0, reasoningOnly: 0 },
    omitted: 0,
    truncated: { reasoning: false, exchanges: false, turns: false },
  };
  if (!Array.isArray(events) || startSeq === null || endSeq === null) return out;

  // 先定位 task_start 所在的 turn 起点，用于判断「同一 turn 内」的前置请求
  let turnStartSeq = null;
  for (const e of events) {
    if (!e || typeof e.seq !== "number") continue;
    if (e.seq >= startSeq) break;
    if (e.type === "turn/start") turnStartSeq = e.seq;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || typeof e.seq !== "number" || e.seq >= startSeq) continue;
    if (turnStartSeq !== null && e.seq <= turnStartSeq) break;
    if (e.type !== "user/message") continue;
    if (e.data?.source?.kind !== "user") continue;
    const t = collapse(textOf(e.data.content));
    if (t.length === 0) continue;
    out.precedingRequest = { seq: e.seq, text: t.slice(0, MAX_USER_CHARS) };
    break;
  }

  let seenUser = 0;
  for (const e of events) {
    if (!e || typeof e.seq !== "number") continue;
    if (e.seq < startSeq || e.seq > endSeq) continue;
    out.stats.events += 1;

    switch (e.type) {
      case "user/message": {
        const d = e.data ?? {};
        // 只要真实人类输入：排除插件注入、运行时上下文、goal 轮次等
        if (d.source?.kind !== "user") break;
        const t = collapse(textOf(d.content));
        if (t.length === 0) break;
        seenUser += 1;
        out.stats.userMessages += 1;
        out.exchanges.push({
          seq: e.seq,
          role: "user",
          // 第一条是原始请求，之后的多为用户在纠偏/补充
          kind: seenUser === 1 ? "request" : "correction",
          text: t.slice(0, MAX_USER_CHARS),
        });
        break;
      }
      case "assistant/message": {
        const d = e.data ?? {};
        const content = d.message?.content ?? [];
        const text = collapse(textOf(content));
        if (text.length > 0) {
          out.stats.assistantTexts += 1;
          out.exchanges.push({
            seq: e.seq,
            role: "assistant",
            kind: "response",
            text: text.slice(0, MAX_ASSISTANT_CHARS),
          });
          break;
        }
        // 没有对外文本时，才考虑内部推理（避免把思考过程当对话倾倒）
        const reasoning = collapse(reasoningOf(content));
        if (reasoning.length > 0) {
          out.stats.reasoningOnly += 1;
          if (out.reasoning.length < MAX_REASONING) {
            const clipped = reasoning.slice(0, MAX_REASONING_CHARS);
            out.reasoning.push({
              seq: e.seq,
              text: clipped.length < reasoning.length ? `${clipped}…` : clipped,
            });
          } else out.truncated.reasoning = true;
        }
        break;
      }
      case "turn/end": {
        const d = e.data ?? {};
        if (out.turns.length < MAX_TURN_NOTES) {
          out.turns.push({ seq: e.seq, turn: d.turn, reason: d.reason?.kind });
        } else out.truncated.turns = true;
        break;
      }
      case "tool/result": {
        // 只计数，不记调用清单：工具失败仅是辅助证据
        const d = e.data ?? {};
        const frameworkError = d.message?.isError === true || d.error !== undefined;
        const text = textOf(d.message?.content);
        const exit = /\[exit code:\s*(-?\d+)\]/i.exec(text);
        const nonzero = exit ? Number(exit[1]) !== 0 : false;
        const timedOut = /\[timed out after\s*\d+\s*ms\]/i.test(text);
        const killed = /\[killed by signal:\s*[A-Z0-9+]+\]/i.test(text);
        if (frameworkError || nonzero || timedOut || killed) out.failureCount += 1;
        break;
      }
      default:
        break;
    }
  }

  // 交换过多时保留「首条请求 + 最近若干条」，中间标记省略
  if (out.exchanges.length > MAX_EXCHANGES) {
    const keepTail = MAX_EXCHANGES - 1;
    out.omitted = out.exchanges.length - MAX_EXCHANGES;
    out.exchanges = [out.exchanges[0], ...out.exchanges.slice(-keepTail)];
    out.truncated.exchanges = true;
  }

  return out;
}

/**
 * 把轨迹渲染成反思材料。
 *
 * 只陈述事实；把「还原决策过程」的任务交回模型。
 *
 * @param {object} p
 * @param {boolean} [p.silent=true]
 *   是否要求复盘只在思维链里进行、不要写成对外回复。
 *   默认开启：对外复述既不会写进记录（记录只读 task_reflect 的参数），
 *   又会作为 ASSISTANT 条目落进后续任务的决策轨迹，属于重复付费。
 */
export function renderReflectionBrief({ task, trail, environment = null, silent = true }) {
  const L = [];
  L.push("<lessons_task_closed>");
  L.push("A task you declared has just been closed. Reconstruct how you worked, then judge it.");
  L.push("");
  L.push(`TASK ID: ${task.task_id}`);
  L.push(`GOAL: ${task.goal}`);
  L.push(`EXPECTED RESULT: ${task.expected_result}`);
  L.push(`REPORTED STATUS: ${task.status}`);
  if (task.result) L.push(`REPORTED RESULT: ${task.result}`);
  L.push("");

  // ── 决策环境 ─────────────────────────────────────────────────────────────
  // 反思不能只看「做了什么」，还要看「做的时候受什么约束」。
  // 这里用的是任务开启那一刻的快照，不是现在重算的结果 —— 因此：
  //   · 事后修改经验不会改写历史任务当时看到的约束
  //   · 已 deprecated 的经验仍会出现在它参与过的任务记录里
  //   · 可区分「当时注入的」与「事后新增的」
  if (environment && Array.isArray(environment.lessons)) {
    const total = Number(environment.count ?? environment.lessons.length);
    if (environment.lessons.length === 0) {
      L.push("DECISION ENVIRONMENT (lessons in effect when this task started): none.");
    } else {
      L.push(
        `DECISION ENVIRONMENT (lessons in effect when this task started; ${total} total` +
          (environment.truncated ? `, ${environment.lessons.length} detailed` : "") +
          "):"
      );
      environment.lessons.forEach((l, i) => {
        L.push(`  [E${i + 1}] (${l.scope}, ${l.confidence}) ${l.problem ?? l.pattern ?? ""}`);
        if (l.attempted) L.push(`        attempted: ${l.attempted}`);
        if (l.correction) L.push(`        do instead: ${l.correction}`);
        if (l.applies_when) L.push(`        applies when: ${l.applies_when}`);
      });

      // 超出详述上限的条目：仍列出 id 与一行摘要。
      // 目的是保证「某条经验是否参与了这次决策」永远可追溯，
      // 即便当时的材料没有展开它的全文。
      const omitted = Array.isArray(environment.omitted) ? environment.omitted : [];
      if (omitted.length > 0) {
        L.push("");
        L.push(`  Also in effect, listed without detail (${omitted.length}):`);
        for (const o of omitted) {
          // 兼容旧快照（字段拆分前只有 pattern）
          L.push(`  [${o.id}] (${o.confidence}) ${o.problem ?? o.pattern ?? "(no description recorded)"}`);
        }
      }

      L.push("");
      L.push("These were the rules in force when you started. Judge whether any of them applied,");
      L.push("and whether you actually followed them — not whether they still seem right now.");
    }
    L.push("");
  }

  L.push(`DECISION TIMELINE (session seq ${task.start_seq}..${task.end_seq}, ${trail.stats.events} events):`);
  if (trail.precedingRequest) {
    // 任务往往在用户说完话之后才被声明，这条请求落在区间外但决定了「目标是否被正确理解」
    L.push(`  [${trail.precedingRequest.seq}] REQUEST (before the task was opened): ${trail.precedingRequest.text}`);
  }
  if (trail.exchanges.length === 0) {
    L.push("  (no human messages or assistant text were recorded inside this task)");
  } else {
    for (const x of trail.exchanges) {
      const label = x.role === "user" ? (x.kind === "correction" ? "CORRECTION" : "REQUEST") : "ASSISTANT";
      L.push(`  [${x.seq}] ${label}: ${x.text}`);
      if (x === trail.exchanges[0] && trail.omitted > 0) {
        L.push(`  … ${trail.omitted} earlier exchanges omitted …`);
      }
    }
  }
  L.push("");

  if (trail.reasoning.length > 0) {
    L.push("INTERNAL REASONING (excerpts, only where no visible text was produced):");
    for (const r of trail.reasoning) L.push(`  [${r.seq}] ${r.text}`);
    if (trail.truncated.reasoning) L.push("  … further reasoning omitted …");
    L.push("");
  }

  L.push("AUXILIARY SIGNALS (evidence only, not the subject of the review):");
  L.push(`- tool-level failures during the task: ${trail.failureCount}`);
  if (trail.turns.length > 0) {
    const reasons = trail.turns.map((t) => t.reason).join(", ");
    L.push(`- turns ended inside the task: ${trail.turns.length} (${reasons})`);
  }
  L.push("");

  L.push("Reconstruct the decision process from the timeline above, and address each point:");
  L.push("1. How did you understand the goal, and what did you take the expected result to mean?");
  L.push("2. What approach did you choose, and what reason did you give or imply for it?");
  L.push("3. What new information changed your direction, and how did you respond to it?");
  L.push("4. How did you use information you already had?");
  L.push("5. How did you handle the difficulties you ran into?");
  L.push("6. Where does the actual result differ from the expected result, and why?");
  L.push("");
  L.push("Ground every claim in the timeline. If it does not show a decision, say that it is");
  L.push("not established rather than inventing one. Tool outcomes are auxiliary evidence only:");
  L.push("do not turn this into a review of tool usage.");
  L.push("");

  // ── 复盘不要说出来 ───────────────────────────────────────────────────────
  // 实测（本会话 78 次 task_end→task_reflect 配对）：50% 的复盘会先写一段对外文本，
  // 平均 784 字符、最长 6660。这段文本：
  //   · 不进入任何记录 —— buildReflectionRecord 只读 task_reflect 的参数；
  //   · 但会作为 ASSISTANT 条目进入**之后**某个任务的决策轨迹（若落在其窗口内），
  //     也就是说它会变成后续任务反思材料里的“我当时说过的话”。
  // 复盘的价值在 task_reflect 的结构化字段里，对外复述一遍只是重复付费。
  if (silent) {
    L.push("Do this as internal reasoning, not as a visible reply. The six questions above are");
    L.push("prompts for your own thinking; do not answer them in your response text.");
    L.push("");
    L.push(`Call task_reflect directly, with ${task.task_id} as the task_id.`);
    L.push("After that, reply with at most one short line saying whether the task succeeded —");
    L.push("no restatement of the analysis, no per-question section, no bullet summary.");
    L.push("If something genuinely needs the user's attention (a decision only they can make,");
    L.push("a risk they must know), say just that one thing and nothing else.");
    L.push("");
  } else {
    L.push(`Then record what you concluded with task_reflect, using ${task.task_id} as the task_id.`);
    L.push("");
  }
  // 告知能力存在，但不预先塞内容——是否查由 agent 自己决定。
  L.push("If any lesson listed above needs its origin checked (whether it really applies here,");
  L.push("or what happened when it was recorded), call lessons_lookup with that lesson id.");
  L.push("It is optional; consult it only when the answer affects your judgment.");
  L.push("</lessons_task_closed>");
  return L.join("\n");
}

/**
 * 渲染「按轮反思」材料。
 *
 * 与 renderReflectionBrief 的根本差别：材料来源不是 task_start/task_end 划定的窗口，
 * 而是 **turn 边界**。所以它不依赖模型是否开了任务 —— 这正是它存在的理由：
 * 任务模式下，模型忘了开任务就等于整段工作没有反思材料，
 * 而这个入口完全在模型手里。按轮模式把入口挪到运行时。
 *
 * 代价必须写在材料里，不能装作没有：
 *   turn 边界 ≠ 决策边界。一个任务可能跨多轮（本机实测 30% 跨 ≥2 轮，最多 13 轮），
 *   按轮切分会把一个决策过程切成几段，每段单独看都缺前因。
 *
 * 因此这段材料的定位是「保险」而不是「主反思」：
 *   · 不与任务模式竞争，任务模式照常；
 *   · 只在本轮确有实质工作时才产生（避免空轮刷屏）；
 *   · 明确告诉模型这是轮级的、可能不完整的一段。
 *
 * @param {object} p
 * @param {number} p.turn 回合序号
 * @param {object} p.trail sliceDecisionTrail 的结果
 * @param {string|null} p.openTaskId 该回合期间是否已有任务在开（有则说明这段已被任务模式覆盖）
 * @returns {string}
 */
export function renderTurnBrief({ turn, trail, openTaskId = null }) {
  if (!trail || trail.stats.events === 0) return "";
  // 本轮既无用户消息也无助手文本、也没有失败：没有可反思的决策
  const substantive =
    trail.exchanges.length > 0 || trail.reasoning.length > 0 || trail.failureCount > 0;
  if (!substantive) return "";

  const L = [];
  L.push("<lessons_turn_closed>");
  L.push(`Turn ${turn} has ended. This material is produced by the runtime, not by a task you declared.`);
  L.push("");
  L.push("WHY THIS EXISTS: in task mode the reflection material comes from a window you open with");
  L.push("task_start and close with task_end. If you never declare a task, no material exists and the");
  L.push("work goes unexamined. This turn-level material closes that hole — it is produced whether or");
  L.push("not you declared anything, so skipping task_start no longer means skipping review.");
  L.push("");
  L.push("WHAT IT IS NOT: a turn boundary is not a decision boundary. A single task can span several");
  L.push("turns. If this turn is part of a larger piece of work, this material is one slice of it and");
  L.push("may lack the context from earlier turns. Judge it as a slice, not as the whole decision.");
  if (openTaskId) {
    L.push("");
    L.push(`NOTE: task ${openTaskId} was already open during this turn, so this same work will also`);
    L.push("appear in that task's own reflection window. Do not record the same lesson twice.");
  }
  L.push("");

  if (trail.precedingRequest) {
    L.push(`REQUEST (before this turn): ${trail.precedingRequest.text}`);
    L.push("");
  }
  L.push(`DECISION TIMELINE (this turn only, ${trail.stats.events} events):`);
  if (trail.exchanges.length === 0) {
    L.push("  (no human messages or assistant text inside this turn)");
  } else {
    for (const x of trail.exchanges) {
      const label = x.role === "user" ? (x.kind === "correction" ? "CORRECTION" : "REQUEST") : "ASSISTANT";
      L.push(`  [${x.seq}] ${label}: ${x.text}`);
    }
  }
  if (trail.reasoning.length > 0) {
    L.push("");
    L.push("INTERNAL REASONING (excerpts, only where no visible text was produced):");
    for (const r of trail.reasoning) L.push(`  [${r.seq}] ${r.text}`);
  }
  L.push("");
  L.push("AUXILIARY SIGNALS: tool-level failures in this turn: " + trail.failureCount);
  L.push("");
  L.push("Ask yourself, for this turn only:");
  L.push("1. Did anything in this turn go differently from what you intended?");
  L.push("2. Did the user have to correct you? What does that correction reveal about how you worked?");
  L.push("3. Is there anything here worth carrying into a future task?");
  L.push("");
  L.push("If the answer is yes, record it with task_reflect. Turn-level reviews need a task id,");
  L.push("so call task_start first if none is open — the task can be opened for this purpose and must");
  L.push("be closed in the same turn. If nothing here generalizes, say so in one line and move on.");
  L.push("</lessons_turn_closed>");
  return L.join("\n");
}
