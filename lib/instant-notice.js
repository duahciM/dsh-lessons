/**
 * 反思即时注入（方案 B 的前半部分）
 *
 * 背景（2026-11-07 实测，见 cache-probe/controlled.mjs）：
 *   - plugin: 类注入 20/20 样本命中率 ≥99.6%，均值 99.9%
 *   - system/message 变更 8/8 样本命中率 ≤0.7%，多数 cached=0
 *   ⇒ 缓存是前缀匹配：开头变则全废，末尾追加几乎零代价。
 *
 * 因此把「本轮新增的 lesson」即时追加为一条 plugin 通知：
 *   - agent 立刻看到（近因），不依赖 system prompt 是否已经重算
 *   - 零缓存代价
 *   - system prompt 只按阈值攒批重算
 *
 * 设计约束：
 *   - 只注入「本轮新增」的 lesson，不回放全部（否则重复且膨胀）
 *   - 明确告知这是临时通知，权威副本在 system prompt 的 Accumulated Lessons
 *   - 已经攒批进 system prompt 的内容不再即时注入（由调用方过滤）
 */

const MAX_PATTERN = 200;
const MAX_CORRECTION = 300;
const MAX_APPLIES = 150;

function oneLine(s, limit) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 渲染一条「本轮新增 lesson」通知。
 *
 * @param {object} p
 * @param {Array} p.lessons 本轮 task_reflect 写入的 lesson（已过滤 relation=none）
 * @param {string} p.taskId
 * @param {string} p.assessment aligned | partial | diverged
 * @param {number} [p.pendingCount] 尚未攒批、仅存在于通知流里的条数
 * @returns {string} 正文；无内容时返回空串
 */
export function renderInstantNotice({ lessons, taskId, assessment, pendingCount = 0 }) {
  if (!Array.isArray(lessons) || lessons.length === 0) return "";

  const out = [];
  out.push("<lessons_just_recorded>");
  out.push(`You just recorded ${lessons.length} lesson(s) after reviewing ${taskId}.`);
  if (assessment) out.push(`Assessment: ${assessment}`);
  out.push("");
  out.push("These were added NOW because they are the most relevant to your next steps.");
  out.push("They are also queued for the next system-prompt refresh, so do not copy them forward.");
  out.push("");

  lessons.forEach((l, i) => {
    out.push(`[New lesson ${i + 1}]`);
    if (l.pattern) out.push(`Pattern: ${oneLine(l.pattern, MAX_PATTERN)}`);
    if (l.correction) out.push(`Correction: ${oneLine(l.correction, MAX_CORRECTION)}`);
    if (l.appliesWhen ?? l.applies_when) {
      out.push(`Applies when: ${oneLine(l.appliesWhen ?? l.applies_when, MAX_APPLIES)}`);
    }
    out.push(`Confidence: ${l.confidence ?? "medium"}`);
    out.push("");
  });

  if (pendingCount > 0) {
    out.push(`(${pendingCount} lesson(s) are waiting to be folded into the system prompt.)`);
  }
  out.push("</lessons_just_recorded>");
  return out.join("\n").trimEnd();
}

/**
 * 判断某条 lesson 是否已经进入 system prompt。
 *
 * 攒批语义：lessons 段只包含「已提交」的条目。
 * 这里按 lesson id 集合判断，避免重复注入。
 */
export function isCommitted(lessonId, committedIds) {
  if (!(committedIds instanceof Set)) return false;
  return committedIds.has(lessonId);
}

/**
 * 攒批判定。
 *
 * 两种阈值，任一满足即触发一次 system prompt 重算：
 *   - 条数达到 maxPending
 *   - 估算 token 达到 maxPendingTokens（按字符数 / 3 粗估）
 *
 * @returns {{due:boolean, reason:string, count:number, tokens:number}}
 */
export function shouldCommit({ pendingLessons, maxPending = 8, maxPendingTokens = 0 }) {
  const arr = Array.isArray(pendingLessons) ? pendingLessons : [];
  const count = arr.length;
  if (count === 0) return { due: false, reason: "empty", count: 0, tokens: 0 };

  const chars = arr.reduce((sum, l) => {
    const s = `${l.pattern ?? ""}${l.correction ?? ""}${l.appliesWhen ?? l.applies_when ?? ""}`;
    return sum + s.length;
  }, 0);
  const tokens = Math.ceil(chars / 3);

  if (maxPending > 0 && count >= maxPending) {
    return { due: true, reason: `count>=${maxPending}`, count, tokens };
  }
  if (maxPendingTokens > 0 && tokens >= maxPendingTokens) {
    return { due: true, reason: `tokens>=${maxPendingTokens}`, count, tokens };
  }
  return { due: false, reason: "below-threshold", count, tokens };
}
