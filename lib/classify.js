/**
 * 工具层失败信号识别。
 *
 * 依据阶段一实测（PHASE1-RUNTIME-REPORT.md §4 / 发现 1）：
 *   - 23 次工具调用中 isError=true 的样本为 0
 *   - exit 7 / exit 1 全部 isError=false
 *   - error.name / error.code / error.reason 从未有值
 *
 * 所以失败必须多信号合并，不能只看 isError。
 *
 * 本模块刻意保持「识别信号」，不做「归类错误」：
 * 后者属于元认知语义判断，留给模型。
 */

const EXIT_CODE_RE = /\[exit code:\s*(-?\d+)\]/i;
const TIMEOUT_RE = /\[timed out after\s*(\d+)\s*ms\]/i;
const SIGNAL_RE = /\[killed by signal:\s*([A-Z0-9+]+)\]/i;
const SANDBOX_DENY_RE = /\[sandbox:[^\]]*\]/i;
const STOPPED_RE = /\[stopped:\s*([a-z0-9_-]+)\]/i;
const EXIT_MARKER_COUNT_RE = /\[exit code:/i;

/** 仅取文本块，reasoning/image/tool 块不含可解析状态。 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** 从工具结果文本里挖结构化信号。无匹配的字段为 undefined。 */
export function parseToolText(content) {
  const text = textOfContent(content);
  const out = { textBytes: text.length };
  if (!text) return out;

  const exit = EXIT_CODE_RE.exec(text);
  if (exit) out.exitCode = Number(exit[1]);

  const to = TIMEOUT_RE.exec(text);
  if (to) {
    out.timedOut = true;
    out.timeoutMs = Number(to[1]);
  }

  const sig = SIGNAL_RE.exec(text);
  if (sig) out.signal = sig[1];

  if (SANDBOX_DENY_RE.test(text)) out.sandboxDenied = true;

  const stopped = STOPPED_RE.exec(text);
  if (stopped) out.stopped = stopped[1];

  // exit=0 时框架不写标记；区分「无标记」与「标记为0」
  out.hasExitMarker = EXIT_MARKER_COUNT_RE.test(text);
  return out;
}

/**
 * 判定一次工具调用是否在「工具层」失败，并给出触发信号。
 *
 * 注意：非零退出码 != 工作方法错误。这里只回答「工具层是否失败」，
 * 是否值得反思由后续阶段交给模型判断。
 *
 * @param {object} exec  tools/result 的 exec
 * @param {object} result tools/result 的 result
 * @returns {{ failed: boolean, signals: string[], detail: object }}
 */
export function classifyToolOutcome(exec, result) {
  const signals = [];
  const detail = {};

  const isError = result?.isError === true;
  if (isError) signals.push("isError");

  if (result?.error) {
    detail.errorName = result.error.name;
    detail.errorCode = result.error.code;
    detail.errorReason = result.error.reason;
    signals.push("error-object");
  }

  const parsed = parseToolText(result?.content);
  detail.parsed = parsed;

  if (parsed.exitCode !== undefined && parsed.exitCode !== 0) {
    signals.push("nonzero-exit");
    detail.exitCode = parsed.exitCode;
  }
  if (parsed.timedOut) signals.push("timeout");
  if (parsed.signal !== undefined) signals.push("signal");
  if (parsed.sandboxDenied) signals.push("sandbox-denied");

  const aborted = exec?.signal?.aborted === true;
  if (aborted) signals.push("caller-aborted");

  return { failed: signals.length > 0, signals, detail };
}
