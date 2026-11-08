/**
 * 反思模型（步骤 1：反思生成）
 *
 * 任务关闭时，Agent 拿到决策轨迹并要求复盘；复盘结论通过 task_reflect 结构化后交回。
 * 这里只负责：校验、构造记忆文档、渲染。
 *
 * 设计原则（沿用 v0.2.0）：
 *   - 反思对象是「工作决策」，不是工具使用
 *   - 一条 lesson 只描述一个**可迁移**的模式，不写本次任务的具体细节
 *   - 允许空 lessons：没有可迁移结论时，如实记录「无需调整」，而不是硬凑
 */

export const CONFIDENCE = Object.freeze(["low", "medium", "high"]);

/** 实际结果与预期结果的关系。 */
import { CONFLICT_KINDS } from "./lessons.js";

export const ASSESSMENT = Object.freeze(["aligned", "partial", "diverged"]);

/**
 * 四分类：本条 lesson 与已有记忆的关系（MEMORY-GOVERNANCE.md §2.1）。
 * new     新经验
 * repeat  同一经验再次出现（只累加证据）
 * revise  修正同一经验（旧条目被新 revision 取代）
 * none    无新增信息（不记录）
 */
export const RELATIONS = Object.freeze(["new", "repeat", "revise", "none"]);

const MAX_LESSONS = 3;
const MAX_TEXT = 600;

function str(v, limit = MAX_TEXT) {
  return typeof v === "string" ? v.trim().slice(0, limit) : "";
}

/**
 * 校验 task_reflect 参数。
 * @returns {{ok:true, taskId:string, assessment:string, lessons:Array}|{ok:false,error:string}}
 */
export function validateReflect(args) {
  if (!args || typeof args !== "object") return { ok: false, error: "task_reflect requires an object argument" };

  const taskId = str(args.task_id, 200);
  if (!taskId) return { ok: false, error: "task_id is required" };

  const assessment = str(args.assessment, 40);
  if (!ASSESSMENT.includes(assessment)) {
    return { ok: false, error: `assessment must be one of ${ASSESSMENT.join(", ")}; got ${JSON.stringify(assessment)}` };
  }

  const raw = args.lessons;
  if (raw !== undefined && !Array.isArray(raw)) return { ok: false, error: "lessons must be an array" };
  const list = raw ?? [];
  if (list.length > MAX_LESSONS) {
    return { ok: false, error: `at most ${MAX_LESSONS} lessons per call; got ${list.length}` };
  }

  const lessons = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || typeof it !== "object") return { ok: false, error: `lessons[${i}] must be an object` };

    // ── 问题与实际做法拆开记 ────────────────────────────────────────────
    // problem  发生了什么（可观察的现象）
    // attempted 当时怎么处理的（做法，不是评价）
    //
    // 为什么拆：把两者混在一个 pattern 里，会写出「问题+做法」的复合句，
    // 而 correction 又比它更窄 —— 语义上自相矛盾（做法比结论还长，
    // 但结论才是要采纳的东西）。
    const problem = str(it.problem);
    const attempted = str(it.attempted);
    // 兼容：旧字段 pattern 视为 problem（历史记录只有这一个）
    const pattern = str(it.pattern);
    const mergedProblem = problem || pattern;
    if (!mergedProblem) {
      return { ok: false, error: `lessons[${i}].problem is required (what happened)` };
    }

    const correction = str(it.correction);
    const appliesWhen = str(it.applies_when);
    const confidence = str(it.confidence, 20) || "medium";
    if (!CONFIDENCE.includes(confidence)) {
      return { ok: false, error: `lessons[${i}].confidence must be one of ${CONFIDENCE.join(", ")}` };
    }

    // 四分类：与已有记忆的关系（治理规范 §2.1）
    const relation = str(it.relation, 20) || "new";
    if (!RELATIONS.includes(relation)) {
      return { ok: false, error: `lessons[${i}].relation must be one of ${RELATIONS.join(", ")}` };
    }
    const target = str(it.target, 200);
    if ((relation === "repeat" || relation === "revise") && !target) {
      return { ok: false, error: `lessons[${i}].target is required when relation is ${relation}` };
    }
    // 显式关系：只声明张力，不裁决（治理规范 §3）
    const conflicts = [];
    if (it.conflicts !== undefined) {
      if (!Array.isArray(it.conflicts)) return { ok: false, error: `lessons[${i}].conflicts must be an array` };
      for (const c of it.conflicts) {
        if (!c || typeof c.with !== "string" || !c.with) {
          return { ok: false, error: `lessons[${i}].conflicts[].with is required` };
        }
        if (!CONFLICT_KINDS.includes(c.kind)) {
          return { ok: false, error: `lessons[${i}].conflicts[].kind must be one of ${CONFLICT_KINDS.join(", ")}` };
        }
        conflicts.push({ with: c.with, kind: c.kind, note: str(c.note, 300) });
      }
    }
    // repeat / none 不需要内容
    if (relation === "repeat" || relation === "none") {
      lessons.push({ relation, target, conflicts, problem: mergedProblem, attempted, correction, appliesWhen, confidence });
      continue;
    }
    if (!mergedProblem) return { ok: false, error: `lessons[${i}].problem is required` };
    if (!correction) return { ok: false, error: `lessons[${i}].correction is required` };
    if (!appliesWhen) return { ok: false, error: `lessons[${i}].applies_when is required` };
    lessons.push({ relation, target, conflicts, problem: mergedProblem, attempted, correction, appliesWhen, confidence });
  }

  return { ok: true, taskId, assessment, source: str(args.source, 300), lessons };
}

/** 供本地 tasks.jsonl 落盘的反思记录。 */
export function buildReflectionRecord({ taskId, sessionId, assessment, source, lessons, offset = 0 }) {
  return {
    ev: "task_reflect",
    record_type: "reflection",
    task_id: taskId,
    session_id: sessionId ?? null,
    assessment,
    ...(source ? { source_text: source } : {}),
    lessons: lessons.map((l, i) => {
      const relation = l.relation ?? "new";
      // 修订必须产生**新** id，用 target 指向被取代的旧条目。
      //
      // 不能沿用 target 当自己的 id：lib/lessons.js 的规则是「同 id 后写覆盖」，
      // 那样新旧会折叠成同一条，`applyRevisions` 拿到 old === neo，
      // 结果是「修订成自己」——旧内容被覆盖、版本链断裂、历史依据丢失。
      const base = `${taskId}#${offset + i}`;
      return {
        // 稳定身份：修改/删除都以它为准
        lesson_id: base,
        relation,
        ...(l.target ? { target: l.target } : {}),
        ...(Array.isArray(l.conflicts) && l.conflicts.length > 0 ? { conflicts: l.conflicts } : {}),
        ...(relation === "repeat" || relation === "none"
          ? {}
          : {
              problem: l.problem,
              ...(l.attempted ? { attempted: l.attempted } : {}),
              correction: l.correction,
              applies_when: l.appliesWhen,
              confidence: l.confidence,
            }),
      };
    }),
    recorded_at: Date.now(),
  };
}

export const internals = { MAX_LESSONS, MAX_TEXT };
