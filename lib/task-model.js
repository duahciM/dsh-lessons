/**
 * 任务边界的数据模型与存储。
 *
 * 概念约定（与本阶段规格一致）：
 *   - 任务开始：Agent 准备执行一个有明确预期结果的目标时
 *   - 任务结束：Agent 得到该目标对应的结果时（成功或失败）
 *   - 任务大小：任意大小，但不得小到仅是一个微小操作（如单独跑一次测试）
 *   - 任务拆分：允许把用户要求拆成多个有独立结果的阶段任务
 *   - 任务标识：程序生成独立 ID
 *   - 任务归属：任务期间的工具调用/错误/纠正都关联到该 ID
 *
 * 关联策略：任务记录只存「边界 + 引用」，不重复存工具事件。
 * 工具事件留在 tool-events.jsonl / error-events.jsonl，用 [startSeq, endSeq] 圈选。
 */
import { randomUUID } from "node:crypto";

/** 任务状态。成功/失败之外保留其他结束形态，避免把「被中断」误记为失败。 */
export const TASK_STATUS = Object.freeze({
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  ABANDONED: "abandoned", // 任务未得到结果就被放弃/替换
  ABORTED: "aborted", // 会话或回合被中断
});

export const TASK_STATUSES = Object.values(TASK_STATUS);

/** 程序生成的任务 ID。 */
export function newTaskId() {
  return `task-${randomUUID()}`;
}

/**
 * 构造一条任务记录。
 *
 * 字段按规格要求：task_id / session_id / goal / expected_result /
 * start_time / end_time / status / result，外加关联与诊断字段。
 */
export function buildTaskRecord(input) {
  return {
    task_id: input.taskId,
    session_id: input.sessionId ?? null,
    // 任务目标：Agent 声明「我要做什么」
    goal: String(input.goal ?? "").trim(),
    // 预期结果：可判定的完成定义
    expected_result: String(input.expectedResult ?? "").trim(),
    start_time: input.startTime,
    end_time: input.endTime ?? null,
    status: input.status ?? null,
    // 实际结果：由 Agent 在结束时陈述
    result: input.result === undefined ? null : String(input.result).trim(),

    // ── 关联与诊断 ──
    /** 会话事件序号区间（闭区间）：任务期间的对话与回合都落在这里 */
    start_seq: input.startSeq ?? null,
    end_seq: input.endSeq ?? null,
    /**
     * 任务期间的工具层失败数。
     * 仅作「辅助证据」：任务结果才是反思入口，工具失败不构成反思主题，
     * 因此这里只留计数，不留调用清单（明细仍在 error-events.jsonl）。
     */
    tool_failures: input.toolFailures ?? 0,
    /** 父任务 ID：支撑「把用户要求拆成阶段任务」 */
    parent_task_id: input.parentTaskId ?? null,
    /** 结束方式：manual(工具显式结束) | superseded(被新任务替换) | session-end */
    closed_by: input.closedBy ?? "manual",
    /** 记录本身的写入时间 */
    recorded_at: Date.now(),
  };
}

/**
 * 校验 task_start 的参数。
 * 返回 { ok, error } —— 工具层要把错误作为 isError 返回，而不是抛。
 */
export function validateStart(args) {
  if (!args || typeof args !== "object") return { ok: false, error: "task_start requires an object argument" };
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  const expected = typeof args.expected_result === "string" ? args.expected_result.trim() : "";
  if (goal.length === 0) return { ok: false, error: "goal is required: state the objective you are about to pursue" };
  if (expected.length === 0) {
    return { ok: false, error: "expected_result is required: state a checkable definition of done" };
  }
  if (goal.length > 2000) return { ok: false, error: "goal must be <= 2000 chars" };
  if (expected.length > 2000) return { ok: false, error: "expected_result must be <= 2000 chars" };
  return { ok: true, goal, expected };
}

/** 校验 task_end 的参数。 */
export function validateEnd(args) {
  if (!args || typeof args !== "object") return { ok: false, error: "task_end requires an object argument" };
  const status = typeof args.status === "string" ? args.status.trim() : "";
  if (!TASK_STATUSES.includes(status)) {
    return {
      ok: false,
      error: `status must be one of ${TASK_STATUSES.join(", ")}; got ${JSON.stringify(status)}`,
    };
  }
  const result = typeof args.result === "string" ? args.result.trim() : "";
  if (result.length === 0) {
    return { ok: false, error: "result is required: state what actually happened" };
  }
  if (result.length > 4000) return { ok: false, error: "result must be <= 4000 chars" };
  return { ok: true, status, result };
}
