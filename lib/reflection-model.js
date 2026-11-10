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

/** 条目类型：经验 / 明确方法 / 失败经验（否定性约束）。 */
export const KINDS = Object.freeze(["lesson", "directive", "failure"]);

/** 自我反对的结论。 */
export const VERDICTS = Object.freeze(["holds", "narrowed", "withdrawn"]);

const MAX_LESSONS = 3;
const MAX_TEXT = 600;

function str(v, limit = MAX_TEXT) {
  return typeof v === "string" ? v.trim().slice(0, limit) : "";
}

/**
 * 校验 task_reflect 参数。
 *
 * @param {object} args task_reflect 的入参
 * @param {object} [opts]
 * @param {boolean} [opts.adversarialReview=true] 是否强制每条 lesson 附 critique
 * @param {boolean} [opts.precedentGate=true]     是否强制 revise 附 evidence_task_ids
 * @returns {{ok:true, taskId:string, assessment:string, lessons:Array}|{ok:false,error:string}}
 */
export function validateReflect(args, opts = {}) {
  const adversarialReview = opts.adversarialReview !== false;
  const precedentGate = opts.precedentGate !== false;

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

    // 条目类型：失败经验用 avoid/instead 表达否定性约束，correction 可不填
    const kind = KINDS.includes(str(it.kind, 20)) ? str(it.kind, 20) : "lesson";
    const avoid = str(it.avoid);
    const instead = str(it.instead);
    if (kind === "failure") {
      if (!mergedProblem && !avoid) {
        return { ok: false, error: `lessons[${i}]: a failure lesson needs problem (what happened) or avoid (what not to do)` };
      }
    } else if (!mergedProblem) {
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
    // 先例闸门：挑战一条已生效的经验必须举证（证据本身在 index.js 里机械校验）
    const evidenceIds = Array.isArray(it.evidence_task_ids)
      ? it.evidence_task_ids.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
      : [];
    if (precedentGate && relation === "revise" && evidenceIds.length === 0) {
      return {
        ok: false,
        error:
          `lessons[${i}].evidence_task_ids is required when relation is "revise": ` +
          `name at least one failed task that started while the lesson "${target}" was in force. ` +
          `Changing a working precedent needs evidence; a success does not count as one.`,
      };
    }

    // 自我反对：一份可追溯的论证，不是一个 verdict 加两句感想
    const critique = normalizeCritique(it.critique);
    if (critique === "invalid") {
      return {
        ok: false,
        error:
          `lessons[${i}].critique must be an object with verdict (holds|narrowed|withdrawn) ` +
          `and the argument fields (${CRITIQUE_KEYS.join(", ")}). ` +
          `A single free-text self-criticism is not accepted: each field answers one question, ` +
          `and fields with no answer must be explicitly marked (n/a, unknown, 无).`,
      };
    }
    // 开启时必填：这个字段如果可选，就会像 conflicts 一样永远为空。
    if (adversarialReview && relation !== "repeat" && relation !== "none" && critique === null) {
      return {
        ok: false,
        error:
          `lessons[${i}].critique is required. Fill the argument fields ` +
          `(claim, premises, evidence, inference, conclusion, steelman, counterexamples, ` +
          `scope, alternatives, revision_conditions, unresolved). ` +
          `Fields you genuinely cannot answer must be marked n/a or unknown — ` +
          `do not invent content to fill them.`,
      };
    }
    // 论证的最低完整性：只有结论、没有对反方与边界的交代，等于没有论证。
    if (adversarialReview && critique && relation !== "repeat" && relation !== "none") {
      const missing = [];
      if (!critique.claim && !critique.markers?.claim) missing.push("claim");
      if (!critique.conclusion && !critique.markers?.conclusion) missing.push("conclusion");
      // 没有 revision_conditions 就不具备可证伪性。
      if (!critique.revision_conditions && !critique.markers?.revision_conditions) {
        missing.push("revision_conditions");
      }
      if (missing.length > 0) {
        return {
          ok: false,
          error:
            `lessons[${i}].critique is incomplete: missing ${missing.join(", ")}. ` +
            `revision_conditions is what new evidence would make you change your mind — ` +
            `a claim that cannot be revised is not falsifiable. ` +
            `Mark a field n/a only when the question genuinely does not apply.`,
        };
      }

      // ── 反方补强：不能只反驳一次就收工 ────────────────────────────────
      // 单个 steelman 字段的实际写法几乎总是一次性的：写一段看起来很强的反对意见，
      // 立刻反驳掉，然后宣布通过。所以要求迭代补强，且每一轮指向不同的论证环节。
      const rounds = critique.steelman_rounds ?? [];
      const hasSingleSteelman = !!(critique.steelman && !critique.markers?.steelman);
      const count = rounds.length > 0 ? rounds.length : hasSingleSteelman ? 1 : 0;
      if (count < MIN_STEELMAN_ROUNDS) {
        return {
          ok: false,
          error:
            `lessons[${i}].critique.steelman_rounds needs at least ${MIN_STEELMAN_ROUNDS} rounds; got ${count}. ` +
            `A single pass is a formality: strengthen the opposing case, defeat it, then strengthen ` +
            `what survived and attack that. Each round states which part of your argument it threatens ` +
            `(threatens), the strengthened case (argument), your response (response), and what still ` +
            `survives it (survives). Then fill opposition_residual with whatever you could not refute.`,
        };
      }
      // 各轮必须打不同环节，否则「深入」只是换措辞。
      const attacked = rounds.map((r) => r.threatens).filter(Boolean);
      if (attacked.length >= MIN_STEELMAN_ROUNDS && new Set(attacked).size < attacked.length) {
        return {
          ok: false,
          error:
            `lessons[${i}].critique.steelman_rounds must attack different parts of the argument; ` +
            `got repeated targets: ${attacked.join(", ")}. Repeating the same attack with new wording ` +
            `is not the same as going deeper.`,
        };
      }
      // 残余反方：即使赢了也要说清哪部分没被驳倒——这是「真的思考过」的证据。
      if (!critique.opposition_residual && !critique.markers?.opposition_residual) {
        return {
          ok: false,
          error:
            `lessons[${i}].critique.opposition_residual is required: after your rebuttals, what part of ` +
            `the opposing case still stands? "Nothing" is almost never true — if it is, say why explicitly ` +
            `with an n/a marker and a reason elsewhere.`,
        };
      }

      // 前提真实性：论证形式再有效，前提没有依据也不算通过。
      // 这里只要求「表态」，不判断内容——语义仍归模型。
      if (!critique.validity?.premise_truth) {
        return {
          ok: false,
          error:
            `lessons[${i}].critique must state validity.premise_truth ` +
            `(established|partial|assumed|unresolved). A valid inference from unsupported ` +
            `premises proves nothing; recording how well the premises are supported keeps that visible.`,
        };
      }
      if (critique.validity.premise_truth === "unresolved" && !critique.unresolved && !critique.markers?.unresolved) {
        return {
          ok: false,
          error: `lessons[${i}]: premise_truth is "unresolved", so critique.unresolved must say which questions remain open`,
        };
      }
    }
    if (critique && critique.verdict === "narrowed" && !appliesWhen) {
      return {
        ok: false,
        error: `lessons[${i}]: verdict "narrowed" means the counterexample succeeded in part — applies_when must be filled to mark where the lesson stops applying`,
      };
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
    const base = {
      relation,
      target,
      conflicts,
      kind,
      problem: mergedProblem,
      attempted,
      correction,
      avoid,
      instead,
      appliesWhen,
      confidence,
      evidenceIds,
      critique,
    };
    // repeat / none 不需要内容
    if (relation === "repeat" || relation === "none") {
      lessons.push(base);
      continue;
    }
    // 失败经验：correction 可缺，但必须说清「不要做什么」
    if (kind === "failure") {
      if (!appliesWhen) return { ok: false, error: `lessons[${i}].applies_when is required` };
      if (!avoid && !correction) {
        return { ok: false, error: `lessons[${i}]: a failure lesson needs avoid (what not to do) or correction` };
      }
      // 自我反对撤回的条目不落盘
      if (critique?.verdict === "withdrawn") {
        lessons.push(base);
        continue;
      }
      lessons.push(base);
      continue;
    }
    if (!mergedProblem) return { ok: false, error: `lessons[${i}].problem is required` };
    if (!correction) return { ok: false, error: `lessons[${i}].correction is required` };
    if (!appliesWhen) return { ok: false, error: `lessons[${i}].applies_when is required` };
    lessons.push(base);
  }

  return { ok: true, taskId, assessment, source: str(args.source, 300), lessons };
}

/**
 * 规范化自我反对结果。
 *
 * 这是一份**可追溯的论证**，不是一个 verdict 加两句话。十一个字段各自回答一个
 * 具体问题，缺一项就少一处可检查的位置。
 *
 * 三条规则：
 *   1. 允许留空 —— 但必须用显式标记（n/a / unknown / 无 / 不适用），
 *      不能靠编造内容来"填满"。标记与正文分开，事后能区分「没写」和「写了但没有」。
 *   2. 三项有效性分开记（演绎 / 归纳 / 前提真实性）：
 *      否则会出现「前提为真则结论必然为真」但前提本身毫无依据的论证，
 *      形式上无懈可击，实际上没有信息。
 *   3. 兼容旧形状（opposition / why_adopt / falsifier / still_better_when）。
 *
 * 返回 null 表示未提供；返回 "invalid" 表示提供了但形状不对。
 */
export const CRITIQUE_KEYS = Object.freeze([
  "claim",
  "premises",
  "evidence",
  "inference",
  "conclusion",
  "steelman",
  "counterexamples",
  "scope",
  "alternatives",
  "revision_conditions",
  "unresolved",
]);

/**
 * 反方补强的最少轮数。
 *
 * 为什么需要「轮」而不是一个 steelman 字段：
 * 单个字段的实际写法几乎总是一次性的 —— 模型写一段看起来很强的反对意见，
 * 然后立刻反驳掉它，然后宣布自己通过了检验。这不是对抗性论证，是走过场。
 *
 * 真正的补强是**迭代**的：每一轮都要针对上一轮反驳之后**仍然站得住**的那部分
 * 继续加固。所以这里要求：
 *   · 至少 2 轮；
 *   · 每轮的 `threatens` 必须指向它攻击的具体一环，且与前几轮不同
 *     （同一环反复加固 = 没有深入，只是换措辞）；
 *   · 最后一轮之后必须留下 `opposition_residual`：
 *     即使你赢了，反方还有哪部分是你没能真正驳倒的。
 *
 * 这三条都是机械可查的。内容质量仍归模型——程序只保证
 * 「它不能只反驳一次就收工」。
 */
export const MIN_STEELMAN_ROUNDS = 2;

const VALIDITY_KEYS = Object.freeze({
  deductive: Object.freeze(["valid", "invalid", "not_applicable", "unresolved"]),
  inductive: Object.freeze(["strong", "moderate", "weak", "not_applicable", "unresolved"]),
  premise_truth: Object.freeze(["established", "partial", "assumed", "unresolved"]),
});

const EMPTY_MARKERS = new Set([
  "n/a",
  "na",
  "none",
  "unknown",
  "not applicable",
  "no information",
  "不适用",
  "无",
  "未知",
  "没有",
]);

function critiqueField(v, limit) {
  const s = str(v, limit);
  if (!s) return null;
  if (EMPTY_MARKERS.has(s.toLowerCase())) return { marker: s.toLowerCase() };
  return { text: s };
}

/**
 * 规范化反方补强的迭代轮次。
 *
 * 每一轮回答三个问题：
 *   round           第几轮（从 1 开始）
 *   threatens       这一轮攻击的是论证的哪一环（claim/premises/evidence/… 之一）
 *   argument        针对那一环加固后的反方论证
 *   response        你对这一轮的反驳
 *   survives        反驳之后，反方还剩下什么没被驳倒
 *
 * 程序只检查结构（轮数、是否指向不同环节、是否留下残余），
 * 论证质量归模型。这样即使它想走过场，也至少要走两遍不同的环节。
 */
function normalizeSteelmanRounds(raw) {
  if (!Array.isArray(raw)) return { rounds: [], error: raw === undefined ? null : "steelman_rounds must be an array" };
  const rounds = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return { rounds: [], error: `steelman_rounds[${i}] must be an object` };
    }
    const threatens = str(r.threatens, 40).toLowerCase().replace(/\s+/g, "_");
    const argument = str(r.argument, 600);
    if (!argument) return { rounds: [], error: `steelman_rounds[${i}].argument is required` };
    rounds.push({
      round: i + 1,
      threatens,
      argument,
      response: str(r.response, 600),
      survives: str(r.survives, 400),
    });
  }
  return { rounds, error: null };
}

function normalizeCritique(c) {
  if (c === undefined || c === null) return null;
  // 字符串/数组形式不再接受：一段自我批评正是要替换掉的东西。
  if (typeof c !== "object" || Array.isArray(c)) return "invalid";

  const verdict = str(c.verdict, 20) || null;
  if (verdict && !VERDICTS.includes(verdict)) return "invalid";

  const fields = {};
  const markers = {};
  for (const k of CRITIQUE_KEYS) {
    const hit = critiqueField(c[k], 400);
    if (!hit) continue;
    if (hit.text) fields[k] = hit.text;
    if (hit.marker) markers[k] = hit.marker;
  }
  // 旧字段名映射（本字段上线很短，但历史记录不该变成"没有论证"）
  const legacy = {
    steelman: c.opposition,
    inference: c.why_adopt,
    scope: c.still_better_when,
    revision_conditions: c.falsifier,
  };
  for (const [k, v] of Object.entries(legacy)) {
    if (!fields[k] && !markers[k]) {
      const hit = critiqueField(v, 400);
      if (hit?.text) fields[k] = hit.text;
    }
  }

  const validity = {};
  for (const [k, allowed] of Object.entries(VALIDITY_KEYS)) {
    const v = str(c[k] ?? c.validity?.[k], 24).toLowerCase().replace(/\s+/g, "_");
    if (allowed.includes(v)) validity[k] = v;
  }

  const roundsRes = normalizeSteelmanRounds(c.steelman_rounds);
  const residual = str(c.opposition_residual, 400);

  const hasAny =
    Object.keys(fields).length > 0 ||
    Object.keys(markers).length > 0 ||
    roundsRes.rounds.length > 0;
  if (!verdict && !hasAny) return null;

  return {
    verdict,
    ...fields,
    /** 反方补强的迭代轮次（可追溯，不只是一段话） */
    ...(roundsRes.rounds.length > 0 ? { steelman_rounds: roundsRes.rounds } : {}),
    ...(residual ? { opposition_residual: residual } : {}),
    ...(Object.keys(markers).length > 0 ? { markers } : {}),
    ...(Object.keys(validity).length > 0 ? { validity } : {}),
    // 补强的可检查证据：至少一轮真正加固过反方
    steelmanned: roundsRes.rounds.length > 0 || Boolean(fields.steelman),
    // 各轮攻击的环节：用来查「是不是在同一个地方反复绕」
    attacked: roundsRes.rounds.map((r) => r.threatens).filter(Boolean),
    // 哪些必答项被明确标成了「无法确定」——这是合法状态，但要可统计
    unresolved_keys: [...CRITIQUE_KEYS.filter((k) => markers[k])],
  };
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
      const content =
        relation === "repeat" || relation === "none"
          ? {}
          : {
              ...(l.kind && l.kind !== "lesson" ? { kind: l.kind } : {}),
              problem: l.problem,
              ...(l.attempted ? { attempted: l.attempted } : {}),
              ...(l.correction ? { correction: l.correction } : {}),
              // 失败经验的否定性约束
              ...(l.avoid ? { avoid: l.avoid } : {}),
              ...(l.instead ? { instead: l.instead } : {}),
              applies_when: l.appliesWhen,
              confidence: l.confidence,
            };
      return {
        // 稳定身份：修改/删除都以它为准
        lesson_id: base,
        relation,
        ...(l.target ? { target: l.target } : {}),
        ...(Array.isArray(l.evidenceIds) && l.evidenceIds.length > 0
          ? { evidence_task_ids: l.evidenceIds }
          : {}),
        ...(Array.isArray(l.conflicts) && l.conflicts.length > 0 ? { conflicts: l.conflicts } : {}),
        // 自我反对的压缩结论：只存结论，供事后审计，不注入
        ...(l.critique && typeof l.critique === "object" ? { critique: l.critique } : {}),
        ...content,
      };
    }),
    recorded_at: Date.now(),
  };
}

export const internals = { MAX_LESSONS, MAX_TEXT };
