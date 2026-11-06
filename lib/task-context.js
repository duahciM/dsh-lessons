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
 */
export function renderReflectionBrief({ task, trail }) {
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
  L.push(`Then record what you concluded with task_reflect, using ${task.task_id} as the task_id.`);
  L.push("</lessons_task_closed>");
  return L.join("\n");
}
