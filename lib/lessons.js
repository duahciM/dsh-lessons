/**
 * 经验记忆的来源、分域与渲染（步骤 3）
 *
 * 三类记忆，作用域不同：
 *
 *   global      跨任务适用的工作方法。所有会话共享。
 *               例：「修改完目标要检查一次」
 *   session     与当前会话背景高度绑定，不跨会话。
 *               例：「在修改 A 之前先检查 A 的耦合」
 *   reflection  具体任务中的经验与错误，相关性最低，不跨会话。
 *               例：「修改 A 会导致 B 失效」
 *
 * 注入规则（每次装配按当前会话求值）：
 *
 *   inject = global  ∪  (session | reflection 中 session_id 等于当前会话的)
 *
 * 数据来源：
 *   <taskDir>/tasks.jsonl              反思记录（record_type: reflection，含 session_id）
 *   <taskDir>/lessons/lessons.jsonl    手工/晋升写入的 global 与 session 条目
 *
 * 语义：
 *   - 身份：lesson_id；缺失时回退 `<task_id>#<序号>`（反思）或 `<scope>#<序号>`
 *   - 修改：同 lesson_id 的后写记录覆盖前者（last-wins）
 *   - 删除：后写记录带 `deleted: true`（墓碑）
 *
 * 缓存：按两个文件的 mtime+size 以及 sessionId 失效。
 */
import { readFileSync, statSync } from "node:fs";

export const SCOPES = Object.freeze(["global", "session", "reflection"]);

/**
 * tasks.jsonl 里由插件自己写入、但不是「记忆条目」的记录类型。
 * 解析 lessons 时必须跳过，否则会占用 seq 序号、影响无 lesson_id 条目的命名。
 */
const NON_LESSON_RECORD_TYPES = new Set([
  "reflection", // 反思记录，由 parseLessons 处理
  "commit", // 攒批水位
  "open", // 任务开始
  "close", // 任务结束
  "orphan", // 任务被中断
  "nudge", // 漏开提醒计数
]);

const MAX_TITLE_CHARS = 120;

/** 各作用域在渲染时的标题与说明。顺序即输出顺序。 */
const SCOPE_HEADINGS = {
  global: {
    title: "## Global working methods",
    note: "Cross-task methods that were found to generalize.",
  },
  session: {
    title: "## Session context",
    note: "Facts and constraints bound to this session's work.",
  },
  reflection: {
    title: "## Task reflections",
    note: "Lessons recorded from earlier tasks in this session.",
  },
};

function oneLine(s, limit) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 计算一条 lesson 的稳定身份。 */
export function lessonIdOf(record, index) {
  const explicit = record?.lesson_id ?? record?.lessons?.[index]?.lesson_id;
  if (typeof explicit === "string" && explicit) return explicit;
  const taskId = typeof record?.task_id === "string" ? record.task_id : "unknown";
  return `${taskId}#${index}`;
}

/** 生效状态：只有 active 会被注入（见 MEMORY-GOVERNANCE.md 第四节）。 */
export const STATUS = Object.freeze([
  "active",
  "superseded",
  "deprecated",
  "promoted",
  "deleted",
  /**
   * 自我反对后的撤回：写这条经验时，对抗性论证推翻了它。
   *
   * 与 deprecated 的区别：deprecated 是「事后被判定不再成立」（外部动作）；
   * withdrawn 是「它从没通过自己的检验」（写入时就被否决）。
   * 两者都不注入；都保留在 tasks.jsonl 里供事后审计。
   */
  "withdrawn",
]);

/**
 * 条目类型。
 *
 *   lesson    经验（需要模型判断是否适用）
 *   directive 明确方法（直接要求执行，不判断）
 *   failure   失败经验：只在触发条件下「禁止某个动作」，不是可权衡的启发式
 *
 * failure 与 lesson 的差别不是程度而是种类：
 *   lesson  说「这样做更好」——模型要判断适用性
 *   failure 说「这样不行」  ——触发即排除，属于否定性约束
 * 因此 correction 在 failure 下不是必填（可能确实不知道替代方案），
 * 改用 avoid（不要做什么）+ 可选 instead（已知的替代）。
 */
export const KINDS = Object.freeze(["lesson", "directive", "failure"]);

/** 自我反对的结论。 */
export const VERDICTS = Object.freeze([
  "holds", // 反方论证不成立，原结论维持
  "narrowed", // 成立但要收窄适用条件
  "withdrawn", // 反方论证成立，撤回这条经验
]);

/**
 * 记忆之间显式关系的类型（MEMORY-GOVERNANCE.md 第三节）。
 * 只表达「存在张力」，不表示谁正确；程序不裁决。
 */
export const CONFLICT_KINDS = Object.freeze([
  "condition", // 条件冲突：适用环境不同
  "goal", // 目标冲突：要求不同的行为
  "contradiction", // 直接矛盾：同一条件下要求相反
  "apparent", // 表面冲突：一般规则 vs 具体例外
]);


/**
 * 解析生效状态。
 *
 * 自我反对的 verdict 可以直接决定状态，不需要模型再单独填 status：
 *   verdict: withdrawn → status: withdrawn（写进来时就已否决，永不注入）
 * 其余情况沿用显式 status，缺省 active。
 */
function resolveStatus(l) {
  if (l?.critique?.verdict === "withdrawn") return "withdrawn";
  return STATUS.includes(l?.status) ? l.status : "active";
}

function normalize(l, ctx) {
  // 三字段拆分：
  //   problem   发生了什么（可观察的现象）
  //   attempted 当时怎么处理的（做法本身，不含评价）
  //   correction 应当怎么做
  // 兼容旧记录：只有 pattern 时视为 problem。
  const problem = String(l.problem ?? l.pattern ?? "").trim();
  const attempted = String(l.attempted ?? "").trim();
  const correction = String(l.correction ?? "").trim();
  // 失败经验：否定性约束。avoid = 不要做什么，instead = 已知替代（可缺）
  const avoid = String(l.avoid ?? "").trim();
  const instead = String(l.instead ?? "").trim();
  const kind = KINDS.includes(l.kind) ? l.kind : "lesson";
  // 正文完整性：普通经验必须 problem+correction；失败经验必须 problem+avoid
  if (kind === "failure") {
    if (!problem && !avoid && !correction) return undefined;
  } else if (!problem && !correction) {
    return undefined;
  }
  const scope = l.scope ?? ctx.scope;
  const sessionId = l.session_id ?? ctx.sessionId ?? null;
  return {
    id: ctx.id,
    scope,
    session_id: sessionId,
    kind,
    problem,
    ...(attempted ? { attempted } : {}),
    ...(correction ? { correction } : {}),
    // 失败经验的两个专属字段；普通经验上出现时也保留，便于事后转换类型
    ...(avoid ? { avoid } : {}),
    ...(instead ? { instead } : {}),
    applies_when: String(l.applies_when ?? "").trim(),
    confidence: String(l.confidence ?? "medium").trim() || "medium",
    assessment: ctx.assessment,
    task_id: ctx.taskId,

    // ── 治理字段（MEMORY-GOVERNANCE.md）──────────────────────────────────
    /** 生效状态；非 active 一律不注入 */
    status: resolveStatus(l),
    /** 修订号：同 id 取最高 revision（last-wins 的显式记录） */
    revision: Number.isSafeInteger(l.revision) && l.revision > 0 ? l.revision : 1,
    /** 被复现的次数：repeat 关系累加 */
    hits: Number.isSafeInteger(l.hits) && l.hits > 0 ? l.hits : 1,
    /** 来源：谁产生了这条记忆 */
    source: {
      task_id: l.source?.task_id ?? ctx.taskId ?? null,
      session_id: l.source?.session_id ?? sessionId,
      workspace: l.source?.workspace ?? l.workspace ?? null,
      at: l.source?.at ?? ctx.at ?? null,
    },
    /** 主体：这条记忆对谁有效（与来源解耦） */
    subject:
      l.subject && typeof l.subject === "object" && typeof l.subject.kind === "string"
        ? { kind: l.subject.kind, id: l.subject.id ?? null }
        : scope === "global"
          ? { kind: "global", id: null }
          : { kind: "session", id: sessionId },
    /** 晋升来源（promote 时写入） */
    promoted_from: typeof l.promoted_from === "string" ? l.promoted_from : null,
    /**
     * 显式关系：这条记忆与其它记忆存在张力。
     * 只是「声明」，不含胜负判断；详见 §3。
     */
    conflicts: Array.isArray(l.conflicts)
      ? l.conflicts
          .filter((c) => c && typeof c.with === "string" && c.with)
          .map((c) => ({
            with: c.with,
            kind: CONFLICT_KINDS.includes(c.kind) ? c.kind : "contradiction",
            note: String(c.note ?? "").trim(),
          }))
      : [],
    /** agent 自述的来源（人类可读，仅作溯源，不注入） */
    source_text: typeof l.source_text === "string" ? l.source_text : (ctx.sourceText ?? null),
    /**
     * 边界声明：为什么这条属于该层（由模型/人写，程序不判断其内容对错）。
     * 程序只校验「有没有写」，不校验「写得对不对」。
     */
    boundary: typeof l.boundary === "string" ? l.boundary.trim() : null,
    /**
     * 自我反对（结构化对抗论证）的压缩结果。
     *
     * 只存结论，不存论证过程 —— 论证过程在反思的思维链里完成，
     * 落库的这份是「当时反对了什么、为什么仍然成立」，用于事后审计。
     * 与 source_text 同级：都不注入 system prompt。
     */
    critique: normalizeCritique(l.critique),
    /**
     * 先例证据：这条经验「验证有效」的计数（可机械计算，不需要模型自评）。
     * 只统计「该经验生效期间、任务成功」的次数，用来量化或然性的验证强度。
     */
    precedent: l.precedent && typeof l.precedent === "object" ? l.precedent : null,
  };
}

/** 自我反对结论的规范化。
 *
 * 这里存的是一份**可追溯的论证过程**，不是一段自我批评。
 * 十一个字段按「结论 → 前提 → 证据 → 推理 → 反方 → 边界 → 不确定」排列，
 * 每一项都必须回答一个具体问题，避免写成看起来完整但无法检验的段落。
 *
 * 关键设计：
 *   · 不强制填满全部字段 —— 没有信息时用显式标记（n/a / unknown），
 *     而不是编造内容。标记与正文分开存，事后能看出「当时这里就是空的」。
 *   · 三项有效性分开记（演绎 / 归纳 / 前提真实性）：
 *     否则会出现「形式有效但前提毫无依据」的论证，而它看起来无懈可击。
 */
const CRITIQUE_FIELDS = Object.freeze([
  "claim", // 正在论证什么
  "premises", // 依赖哪些前提
  "evidence", // 前提有什么证据支持
  "inference", // 如何从前提推出结论
  "conclusion", // 得出了什么结论
  "steelman", // 最强反方论证
  "counterexamples", // 哪些反例能挑战结论
  "scope", // 适用条件与边界
  "alternatives", // 其他同样能解释现象的原因
  "revision_conditions", // 什么情况会改变结论
  "unresolved", // 还有什么无法确定
]);

/** 显式「没有内容」的标记词。命中即视为空白，而不是编造了一段文字。 */
const EMPTY_MARKERS = Object.freeze([
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

const VALIDITY = Object.freeze({
  deductive: ["valid", "invalid", "not_applicable", "unresolved"],
  inductive: ["strong", "moderate", "weak", "not_applicable", "unresolved"],
  premise_truth: ["established", "partial", "assumed", "unresolved"],
});

function critiqueField(raw, limit) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { text: "", marker: "" };
  if (EMPTY_MARKERS.includes(s.toLowerCase())) return { text: "", marker: s.toLowerCase() };
  return { text: s.slice(0, limit), marker: "" };
}

function normalizeCritique(c) {
  if (!c || typeof c !== "object") return null;
  const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const verdict = VERDICTS.includes(c.verdict) ? c.verdict : null;

  const fields = {};
  const markers = {};
  const limits = {
    claim: 200,
    premises: 320,
    evidence: 320,
    inference: 320,
    conclusion: 240,
    steelman: 400,
    counterexamples: 320,
    scope: 240,
    alternatives: 280,
    revision_conditions: 240,
    unresolved: 240,
  };
  for (const k of CRITIQUE_FIELDS) {
    const { text, marker } = critiqueField(c[k], limits[k] ?? 240);
    // 兼容旧字段名：opposition ≈ steelman，why_adopt ≈ inference 的一部分
    if (!text && !marker) continue;
    if (text) fields[k] = text;
    if (marker) markers[k] = marker;
  }
  // 旧形状兼容（本字段上线很短，但历史记录不能因此变成"没有论证"）
  if (!fields.steelman && c.opposition) fields.steelman = clip(c.opposition, 400);
  if (!fields.inference && c.why_adopt) fields.inference = clip(c.why_adopt, 320);
  if (!fields.scope && c.still_better_when) fields.scope = clip(c.still_better_when, 240);
  if (!fields.revision_conditions && c.falsifier) fields.revision_conditions = clip(c.falsifier, 240);
  if (!fields.claim && c.claim) fields.claim = clip(c.claim, 200);

  // 三项有效性：分开记，避免"形式有效但前提无依据"被当成通过
  const validity = {};
  for (const [k, allowed] of Object.entries(VALIDITY)) {
    const v = clip(c[k] ?? c.validity?.[k], 24).toLowerCase().replace(/\s+/g, "_");
    if (allowed.includes(v)) validity[k] = v;
  }

  const hasAny = Object.keys(fields).length > 0 || Object.keys(markers).length > 0;
  if (!verdict && !hasAny) return null;
  return {
    verdict,
    ...fields,
    /** 显式标记为「此处没有内容」的字段：用于区分「没写」与「写了但没有」 */
    markers,
    /** 演绎有效性 / 归纳支持度 / 前提真实性 */
    validity,
    /** 是否已经做过反方补强（steelman 非空即视为补强过） */
    steelmanned: Boolean(fields.steelman),
  };
}


/**
 * 解析 tasks.jsonl 里的反思记录。
 * @returns {Array} 未过滤作用域的条目（scope 固定为 reflection）
 */
export function parseLessons(text) {
  const map = new Map();
  const repeats = [];
  const revisions = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过，不让一行脏数据毁掉整段注入
    }
    if (!rec || rec.record_type !== "reflection") continue;

    const lessons = Array.isArray(rec.lessons) ? rec.lessons : [];
    if (rec.deleted === true && lessons.length === 0) continue;

    for (let i = 0; i < lessons.length; i++) {
      const l = lessons[i] ?? {};
      const id = lessonIdOf(l.lesson_id ? { ...rec, lesson_id: l.lesson_id } : rec, i);

      // 复现：不新增条目，只累加证据（治理规范 §2.1）
      if (l.relation === "repeat" || rec.relation === "repeat") {
        const target = typeof l.target === "string" ? l.target : id;
        repeats.push(target);
        continue;
      }
      // 修正：新条目取代旧条目，但不删除旧条目（历史依据必须保留）。
      //
      // 语义：
      //   · 旧条目 status 变为 superseded → 不再注入，但仍可用 inspect/show 查到；
      //   · 新条目通过 revised_from 指回旧条目，形成可追溯的版本链；
      //   · 旧条目若已被删除（墓碑），target 无法解析，此时当作新条目处理。
      //
      // 注意：superseded 与 deleted 不同 —— 前者是「被更好的版本取代」，后者是「不再成立」。
      if (l.relation === "revise" || rec.relation === "revise") {
        const target = typeof l.target === "string" && l.target.trim() ? l.target.trim() : null;
        if (target) revisions.push({ target, from: id });
      }
      if (l.relation === "none" || rec.relation === "none") continue;

      if (l.deleted === true || rec.deleted === true) {
        map.set(id, null);
        continue;
      }
      const entry = normalize(l, {
        id,
        scope: "reflection",
        sessionId: rec.session_id,
        assessment: rec.assessment,
        taskId: rec.task_id,
        at: rec.recorded_at,
        sourceText: rec.source_text,
      });
      // 同一 id 的第 N 次写入即第 N 版（修正由折叠体现，写入侧无需计数）
      if (entry) entry.revision = ((map.get(id)?.revision ?? 0) + 1) || 1;
      // 记下修订关系本身，交给 collectLessons 跨文件统一应用：
      // 这里只能看到 reflection 文件，target 可能指向手工维护的条目。
      if (entry && (l.relation === "revise" || rec.relation === "revise") && typeof l.target === "string" && l.target) {
        entry.__revises = l.target;
      }
      map.set(id, entry ?? null);
    }
  }
  applyRepeats(map, repeats);
  applyRevisions(map, revisions);
  return [...map.values()].filter((l) => l && l.status === "active");
}

/**
 * 把 revise 折叠成版本链。
 *
 * 旧条目保持存在但状态置为 superseded —— 这样：
 *   1. 注入只看 active，所以新版立即生效、旧版立即停止；
 *   2. 记录仍然保留，`show <id>` 能查到它原本写了什么；
 *   3. 新条目带 `revised_from`，可从新版反查历史依据。
 */
function applyRevisions(map, revisions) {
  for (const { target, from } of revisions) {
    const old = map.get(target);
    if (!old) continue; // target 不存在（可能已删除），无从取代
    old.status = "superseded";
    old.superseded_by = from;
    old.superseded_at = Date.now();
    const neo = map.get(from);
    if (neo) {
      neo.revised_from = target;
      // 修订继承原有的复现证据，避免「改一次就清零」
      neo.hits = (neo.hits ?? 1) + (old.hits ?? 1) - 1;
    }
  }
}

/** 把 repeat 证据折叠到目标条目上。 */
function applyRepeats(map, repeats) {
  for (const target of repeats) {
    const hit = map.get(target);
    if (hit) {
      hit.hits += 1;
      hit.last_seen = Date.now();
    }
  }
}

/**
 * 先例强度：一条经验「被验证有效」的或然性计数。
 *
 * 定义（按用户裁定）：
 *   「验证有效」是或然性的 —— 一条经验哪怕只成功过一次，也算验证有效，
 *     只是或然性不高。所以这里不判断「是否已被证明」，只数次数。
 *
 * 口径：一个任务算一次「该经验的暴露」，当且仅当它在任务开始时的
 * 决策环境快照里（lessons[] 或 omitted[]）。任务成功即一次 verified，
 * 失败即一次 counter。
 *
 * 为什么可机械计算：task_open.environment 已经冻结了每个任务当时生效
 * 的经验集合，task_close 记录了成败。两者 join 即得，不需要模型自评，
 * 也不需要对照组。
 *
 * @returns {Map<string, {exposures:number, verified:number, counter:number, last_verified:number|null}>}
 */
export function computePrecedents(taskText) {
  const opens = new Map();
  const closes = new Map();
  for (const line of String(taskText ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (rec.record_type === "open" && typeof rec.task_id === "string") opens.set(rec.task_id, rec);
    else if (rec.record_type === "close" && typeof rec.task_id === "string") closes.set(rec.task_id, rec);
  }

  const out = new Map();
  const bump = (id, field, when) => {
    if (typeof id !== "string" || !id) return;
    const cur = out.get(id) ?? { exposures: 0, verified: 0, counter: 0, last_verified: null };
    cur[field] += 1;
    if (field === "verified" && typeof when === "number") {
      cur.last_verified = Math.max(cur.last_verified ?? 0, when);
    }
    out.set(id, cur);
  };

  for (const [taskId, open] of opens) {
    const close = closes.get(taskId);
    const env = open.environment;
    if (!env) continue;
    const ids = [
      ...(env.lessons ?? []).map((l) => l?.id),
      ...(env.omitted ?? []).map((l) => l?.id),
    ].filter(Boolean);
    if (ids.length === 0) continue;
    const status = close?.status ?? null;
    for (const id of ids) {
      bump(id, "exposures");
      if (status === "succeeded") bump(id, "verified", close?.end_time ?? null);
      else if (status === "failed" || status === "diverged") bump(id, "counter");
    }
  }
  return out;
}

/**
 * 先例闸门：挑战一条已生效的先例时必须举证。
 *
 * 用户裁定：「挑战一条已经生效的先例，必须引用至少一个在该先例生效期间
 * 发生、且与其适用条件匹配的失败任务。」
 *
 * 程序能机械验证的部分：
 *   1. 引用的任务 id 真实存在，且有 close 记录；
 *   2. 该任务确实是失败（status = failed / aborted / abandoned 不等于成功）；
 *   3. 该任务开始时，被挑战的这条经验确实在它的决策环境快照里
 *      （= 「在该先例生效期间」）。
 *
 * 程序不能验证「与其适用条件匹配」—— 那是语义判断，留给模型。
 * 这一段的职责只是让「我挑战它」必须挂在一个真实的失败事实上。
 *
 * @returns {{ok:true, evidence:Array}|{ok:false, error:string}}
 */
export function validateRevisionEvidence({ taskText, target, evidenceIds }) {
  const ids = Array.isArray(evidenceIds) ? evidenceIds.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
  if (ids.length === 0) {
    return {
      ok: false,
      error:
        `relation "revise" on "${target}" requires evidence_task_ids: at least one failed task ` +
        `that was started while this lesson was in force. Prove the precedent failed before changing it.`,
    };
  }

  const opens = new Map();
  const closes = new Map();
  for (const line of String(taskText ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (rec.record_type === "open" && typeof rec.task_id === "string") opens.set(rec.task_id, rec);
    else if (rec.record_type === "close" && typeof rec.task_id === "string") closes.set(rec.task_id, rec);
  }

  const accepted = [];
  const problems = [];
  for (const id of ids) {
    const open = opens.get(id);
    const close = closes.get(id);
    if (!open) {
      problems.push(`"${id}": no such task (never opened)`);
      continue;
    }
    if (!close) {
      problems.push(`"${id}": task has no recorded outcome yet`);
      continue;
    }
    if (close.status === "succeeded") {
      problems.push(`"${id}": task succeeded — a success does not challenge the precedent`);
      continue;
    }
    const env = open.environment;
    const inForce = [
      ...(env?.lessons ?? []).map((l) => l?.id),
      ...(env?.omitted ?? []).map((l) => l?.id),
    ].includes(target);
    if (!inForce) {
      problems.push(`"${id}": this lesson was not in force when that task started`);
      continue;
    }
    accepted.push({ task_id: id, status: close.status });
  }

  if (accepted.length === 0) {
    return {
      ok: false,
      error:
        `relation "revise" on "${target}" needs usable evidence. ` +
        `Rejected: ${problems.join("; ")}`,
    };
  }
  return { ok: true, evidence: accepted };
}

/**
 * 解析手工维护的 lessons.jsonl（global / session 条目）。
 * 支持整条删除：{ lesson_id, deleted: true }
 */
export function parseLessonEntries(text) {
  const map = new Map();
  const repeats = [];
  let seq = 0;
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    // 任务生命周期与攒批/提醒记录不是记忆条目；跳过以免占用 seq 序号。
    if (NON_LESSON_RECORD_TYPES.has(rec.record_type)) continue;

    const scope = SCOPES.includes(rec.scope) && rec.scope !== "reflection" ? rec.scope : "global";
    const id = typeof rec.lesson_id === "string" && rec.lesson_id ? rec.lesson_id : `${scope}#${seq++}`;

    // 复现：只累加证据
    if (rec.relation === "repeat") {
      repeats.push(typeof rec.target === "string" ? rec.target : id);
      continue;
    }
    if (rec.relation === "none") continue;

    if (rec.deleted === true) {
      map.set(id, null);
      continue;
    }
    // 补丁记录（无正文、非墓碑）：由 parsePatches 处理，不在此覆盖条目
    const hasBody =
      (typeof rec.pattern === "string" && rec.pattern.trim()) ||
      (typeof rec.correction === "string" && rec.correction.trim());
    if (!hasBody) continue;
    const entry = normalize(rec, { id, scope, sessionId: rec.session_id ?? null, at: rec.recorded_at });
    if (entry) entry.revision = ((map.get(id)?.revision ?? 0) + 1) || 1;
    map.set(id, entry ?? null);
  }
  applyRepeats(map, repeats);
  return [...map.values()].filter((l) => l && l.status === "active");
}

/**
 * 抽取「复现」证据：relation=repeat 的记录不产生可注入条目，
 * 只用于给目标条目累加 hits（可跨层、跨会话）。
 * @returns {Array<{target:string, session_id:string|null}>}
 */
export function parseEvidence(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec) continue;
    const lessons = Array.isArray(rec.lessons) ? rec.lessons : [];
    for (const l of lessons) {
      if (!l || (l.relation !== "repeat" && rec.relation !== "repeat")) continue;
      const target = typeof l.target === "string" ? l.target : null;
      if (target) out.push({ target, session_id: rec.session_id ?? null });
    }
  }
  return out;
}

/**
 * 解析攒批水位。
 *
 * tasks.jsonl 里的提交记录形如：
 *   {"record_type":"commit","committed_at":1793500000000,"count":8}
 *
 * 取**最后一条**提交记录的 committed_at 作为水位：只有 recorded_at <= 水位
 * 的反思才进入 system prompt。这样每条新反思不会立刻改变 section，
 * 攒够后一次性推进水位，只付一次缓存重算。
 *
 * @returns {number} 水位毫秒时间戳；**没有提交记录时返回 Infinity**
 *          （向后兼容：既有安装视为全部已提交，行为不变）
 */
export function parseCommitState(text) {
  let committedAt = Number.POSITIVE_INFINITY;
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || rec.record_type !== "commit") continue;
    const at = Number(rec.committed_at);
    if (Number.isFinite(at) && at >= 0) committedAt = at;
  }
  return committedAt;
}

/**
 * 取某会话「已写入但尚未提交」的反思条目。
 *
 * 直接从文件推导，不用内存态：插件重载/进程重启后 pending 不会丢。
 */
export function pendingReflections({ taskText, sessionId, committedAt }) {
  if (!sessionId) return [];
  return parseLessons(taskText).filter(
    (l) =>
      l.session_id === sessionId &&
      typeof l.source?.at === "number" &&
      l.source.at > committedAt
  );
}

/**
 * 合并三类记忆并按当前会话过滤。
 *
 * @param {object} p
 * @param {string} p.taskText    tasks.jsonl 内容
 * @param {string} p.lessonText  lessons.jsonl 内容
 * @param {string|null} p.sessionId 当前会话
 * @param {object} [p.scopes]    各作用域开关，用于对照实验
 * @param {number} [p.committedAt] 攒批水位；未提交的反思不进 system prompt
 */
export function collectLessons({ taskText, lessonText, sessionId, scopes = {}, committedAt = Number.POSITIVE_INFINITY }) {
  const on = (s) => scopes[s] !== false;
  // 反思无论是否开启注入都要解析：它可能是被派生条目引用的「来源」
  const reflections = parseLessons(taskText);
  const entries = parseLessonEntries(lessonText);

  const candidates = [];
  // 全量集合（不受 scope / 会话 / 水位过滤）：修订关系必须在这里判定。
  // 否则「当前会话看不到新版」时，旧版会重新生效 —— 语义上错误：
  // 被取代就是被取代，与谁看得见无关。
  const allById = new Map();
  for (const l of [...entries, ...reflections]) {
    if (l && l.id) allById.set(l.id, l);
  }
  for (const l of entries) {
    if (l.scope === "global") {
      if (on("global")) candidates.push(l);
    } else if (l.scope === "session") {
      if (on("session") && sessionId && l.session_id === sessionId) candidates.push(l);
    }
  }
  for (const l of reflections) {
    // 反思默认不跨会话；session_id 缺失时不注入到任何会话
    if (!(on("reflection") && sessionId && l.session_id === sessionId)) continue;
    // 攒批：水位之后的反思只走即时通知，等提交后再进 system prompt
    if (typeof l.source?.at === "number" && l.source.at > committedAt) continue;
    candidates.push(l);
  }

  // 补丁：事后补 boundary / 置 deprecated，不覆盖正文
  applyPatches(candidates, parsePatches(lessonText));

  // ── 修订：跨文件统一折叠 ────────────────────────────────────────────────
  // parseLessons 里的 applyRevisions 只能看到 reflection 文件，而 target 常常
  // 指向手工维护的 lessons.jsonl 条目。所以这里在**合并后**再做一次。
  //
  // 用 allById（全量）而不是 candidates（当前会话可见）：
  // 修订是条目之间的既成事实，不该因为「新版在另一个会话里」而失效。
  for (const l of allById.values()) {
    const target = l.__revises;
    if (!target) continue;
    delete l.__revises;
    const old = allById.get(target);
    if (!old || old === l) continue;
    old.status = "superseded";
    old.superseded_by = l.id;
    old.superseded_at = Date.now();
    l.revised_from = target;
    if (Number.isFinite(old.hits) && Number.isFinite(l.hits)) {
      l.hits = Math.max(l.hits, old.hits);
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i].status !== "active") candidates.splice(i, 1);
  }

  // ── 晋升 = 状态迁移，不是复制（MEMORY-GOVERNANCE.md §2.2）──────────────
  // 一条来源条目，只有当「由它派生的条目」在本条注入路径上可见时才停用。
  // 这样：
  //   - 派生到 global（处处可见）→ 来源在所有路径停用
  //   - 派生到 session:S2（仅 S2 可见）→ 来源在 S1 仍然生效，不误伤
  const promotedSources = new Set();
  for (const l of candidates) {
    if (typeof l.promoted_from === "string" && l.promoted_from) {
      promotedSources.add(l.promoted_from);
    }
  }

  // 复现证据：同一经验被重复观测时，只累加证据，不产生第二条注入
  const byId = new Map(candidates.map((l) => [l.id, l]));
  for (const ev of parseEvidence(taskText)) {
    const hit = byId.get(ev.target);
    if (!hit) continue;
    hit.hits = (hit.hits ?? 1) + 1;
    hit.evidence_sessions = Array.isArray(hit.evidence_sessions) ? hit.evidence_sessions : [];
    if (ev.session_id && !hit.evidence_sessions.includes(ev.session_id)) {
      hit.evidence_sessions.push(ev.session_id);
    }
  }

  // ── 先例强度：从任务快照 join 成败，不依赖模型自评 ─────────────────────
  // 「验证有效」是或然性的：成功一次算一次，失败一次算一个反例。
  // 数据来源都是已有的（task_open.environment + task_close.status），
  // 不需要新的采集，也不需要对照组。
  const precedents = computePrecedents(taskText);

  return candidates
    .filter((l) => !promotedSources.has(l.id))
    .map((l) => ({
      ...l,
      // active：当前是否仍参与注入（来源被派生条目覆盖后为 false）
      active: l.status === "active",
      // promoted：这条是从更底层晋升上来的产物
      promoted: typeof l.promoted_from === "string" && !!l.promoted_from,
      // 先例计数（只保留有意义的正数场次）
      precedent: precedents.get(l.id) ?? l.precedent ?? null,
    }));
}

/** 带 mtime 缓存的读取器。 */
export function createLessonStore({ taskFile, lessonFile }) {
  const statKey = (p) => {
    try {
      const st = statSync(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "none";
    }
  };
  const readText = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  let cache = { key: null, lessons: [] };
  return {
    read(sessionId, scopes, committedAt = Number.POSITIVE_INFINITY) {
      const key = `${statKey(taskFile)}|${statKey(lessonFile)}|${sessionId ?? ""}|${JSON.stringify(scopes ?? {})}|${committedAt}`;
      if (cache.key === key) return { lessons: cache.lessons, fromCache: true };
      const lessons = collectLessons({
        taskText: readText(taskFile),
        lessonText: readText(lessonFile),
        sessionId: sessionId ?? null,
        scopes: scopes ?? {},
        committedAt,
      });
      cache = { key, lessons };
      return { lessons, fromCache: false };
    },
    /** 供调用方读取原始文本（攒批判定需要）。 */
    readTaskText: () => readText(taskFile),
  };
}

/**
 * 渲染成 system prompt 的一段。
 * 没有记忆时返回空串 —— 上层会过滤空段，不产生空白区块。
 */
/** 四种冲突类型的可读说明。程序只标注类型，不判断谁对。 */
const CONFLICT_LABELS = {
  condition: "different environments",
  goal: "different required behaviors",
  contradiction: "opposite demands under the same condition",
  apparent: "general rule vs. specific exception",
};

/**
 * 把可见记忆之间的显式关系渲染成一段提示。
 *
 * 只做两件事：把关系摆出来、说明尚未裁决。
 * 不做：排序、择优、屏蔽任何一方 —— 所有原始记忆都保留并继续注入。
 */
function renderConflicts(lessons) {
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const pairs = new Map(); // 无序键 → { a, b, kinds:Set, note }

  for (const l of lessons) {
    for (const c of l.conflicts ?? []) {
      const other = byId.get(c.with);
      if (!other || other.id === l.id) continue;
      const key = [l.id, other.id].sort().join("|");
      if (!pairs.has(key)) pairs.set(key, { a: l, b: other, kinds: new Set(), notes: [] });
      const p = pairs.get(key);
      p.kinds.add(c.kind);
      if (c.note) p.notes.push(c.note);
    }
  }

  // ── 自我反对的产物：论证出的适用边界 ─────────────────────────────────
  // 这里不需要「另一条经验」作为对手，对手是**旧做法**本身。
  // 所以单独成段，而不是塞进上面那个两两配对的结构：
  //   pairs 表达的是「经验 A 与经验 B 的张力」（可裁决、有裁决对象）；
  //   这里表达的是「这条经验论证出的边界」（边界声明）。
  const hedged = lessons.filter((l) => l.critique?.scope);
  if (pairs.size === 0 && hedged.length === 0) return "";

  const out = [];
  if (pairs.size > 0) {
    out.push("[CONFLICTS] The lessons below pull in different directions. Nothing has been adjudicated; both remain in force.");
    out.push("State your reasoning: classify the tension first, then decide which one applies here, and say why before acting.");
    out.push("Do not assume one of them has been retired. If you believe one no longer holds, say so explicitly and explain why.");
    for (const { a, b, kinds, notes } of pairs.values()) {
      const kind = [...kinds][0];
      out.push("");
      out.push(`- ${CONFLICT_LABELS[kind]} (${kind})`);
      out.push(`  · ${oneLine(a.id, 60)}: ${oneLine(a.problem || a.correction, 90)}${a.applies_when ? ` [applies when: ${oneLine(a.applies_when, 60)}]` : ""}`);
      out.push(`  · ${oneLine(b.id, 60)}: ${oneLine(b.problem || b.correction, 90)}${b.applies_when ? ` [applies when: ${oneLine(b.applies_when, 60)}]` : ""}`);
      if (notes.length > 0) out.push(`  note: ${oneLine(notes.join("; "), 120)}`);
    }
  }

  if (hedged.length > 0) {
    out.push("");
    out.push("[BOUNDARIES] Each lesson below was checked against the strongest case for the old way of working.");
    out.push("The old way is still better under the stated condition — prefer it there, and apply the lesson only outside it.");
    for (const l of hedged) {
      out.push(`- ${oneLine(l.id, 60)}: ${oneLine(l.critique.scope, 160)}`);
    }
  }
  return out.join("\n");
}

export function renderLessonsSection(lessons, { maxLessons = 0, showPrecedent = true } = {}) {
  if (!Array.isArray(lessons) || lessons.length === 0) return "";

  const totalLessons = lessons.filter((l) => l.kind !== "directive").length;
  const byScope = new Map();
  for (const l of lessons) {
    if (!byScope.has(l.scope)) byScope.set(l.scope, []);
    byScope.get(l.scope).push(l);
  }

  const out = [];
  out.push("## Accumulated Lessons");
  out.push("");
  out.push("Lessons recorded earlier, grouped by how far they apply.");
  out.push("Judge whether each one fits the situation in front of you; do not apply them mechanically.");

  // ── 冲突显性化：只呈现关系，不裁决（治理规范 §3）────────────────────
  const conflictBlock = renderConflicts(lessons);
  if (conflictBlock) {
    out.push("");
    out.push(conflictBlock);
  }

  // ── 失败经验：否定性约束，单独成块 ───────────────────────────────────
  // 与 lesson 的区别不是程度而是种类：lesson 说「这样更好」，要判断适用性；
  // failure 说「这样不行」，触发即排除。混在同一个列表里会让两类约束等价，
  // 进而把「硬禁止」"稀释"成一条可以权衡的启发式。
  const failures = lessons.filter((l) => l.kind === "failure");
  if (failures.length > 0) {
    out.push("");
    out.push("## Known failures");
    out.push("Actions that produced a bad outcome. When the trigger matches, do not do this.");
    out.push("Unlike a lesson, this is not a heuristic to weigh — it is a constraint.");
    for (const f of failures) {
      out.push("");
      out.push(`Avoid: ${oneLine(f.avoid || f.correction || f.problem, MAX_TITLE_CHARS * 4)}`);
      if (f.instead) out.push(`Instead: ${oneLine(f.instead, MAX_TITLE_CHARS * 4)}`);
      if (f.problem && (f.avoid || f.correction)) {
        out.push(`Why: ${oneLine(f.problem, MAX_TITLE_CHARS * 3)}`);
      }
      if (f.applies_when) out.push(`Triggered by: ${oneLine(f.applies_when, MAX_TITLE_CHARS * 2)}`);
      out.push(`Confidence: ${f.confidence}`);
    }
  }

  let shown = 0;
  for (const scope of SCOPES) {
    const group = byScope.get(scope);
    if (!group || group.length === 0) continue;
    const meta = SCOPE_HEADINGS[scope];
    out.push("");
    out.push(meta.title);
    out.push(meta.note);

    // 明确方法优先于经验：直接要求执行，不需要模型再判断"这条适不适用于我"
    const directives = group.filter((l) => l.kind === "directive");
    if (directives.length > 0) {
      out.push("");
      out.push("Required method:");
      for (const d of directives) {
        const cond = d.applies_when ? `（${oneLine(d.applies_when, MAX_TITLE_CHARS)}）` : "";
        out.push(`- ${oneLine(d.correction || d.problem, MAX_TITLE_CHARS * 4)}${cond}`);
      }
    }

    // failure 已在上面的独立块渲染，这里不再重复
    const lessons = group.filter((l) => l.kind !== "directive" && l.kind !== "failure");
    if (lessons.length === 0) continue;
    out.push("");
    for (const l of lessons) {
      if (maxLessons > 0 && shown >= maxLessons) break;
      shown += 1;
      out.push(`[Lesson ${shown}]`);
      if (l.problem) out.push(`Problem: ${oneLine(l.problem, MAX_TITLE_CHARS * 4)}`);
      // 当时做法是「这次是怎么处理的」——它让模型能判断自己是否又用了旧做法
      if (l.attempted) out.push(`Attempted: ${oneLine(l.attempted, MAX_TITLE_CHARS * 4)}`);
      if (l.correction) out.push(`Correction: ${oneLine(l.correction, MAX_TITLE_CHARS * 4)}`);
      if (l.applies_when) out.push(`Applies when: ${oneLine(l.applies_when, MAX_TITLE_CHARS * 2)}`);
      out.push(`Confidence: ${l.confidence}`);
      // 先例强度：可机械计算的「验证有效」计数，用或然性而非断言的方式呈现
      if (showPrecedent && l.precedent && l.precedent.verified > 0) {
        const p = l.precedent;
        const parts = [`verified ${p.verified}x`];
        if (p.counter > 0) parts.push(`${p.counter} counterexample(s)`);
        out.push(`Precedent: ${parts.join(", ")}`);
      }
      out.push("");
    }
  }

  if (maxLessons > 0 && totalLessons > maxLessons) {
    out.push(`(${totalLessons - maxLessons} more lesson(s) omitted for length.)`);
  }

  return out.join("\n").trimEnd();
}

/**
 * 结构检查器（MEMORY-GOVERNANCE.md §1.1）。
 *
 * 只校验三类客观事实，**不判断语义**：
 *   1. 引用完整性 —— conflicts.with / promoted_from / target 是否指向存在的条目
 *   2. 状态一致性 —— scope 与 subject/session_id 是否自洽
 *   3. 声明完整性 —— 非 reflection 层是否写了 boundary（为什么属于该层）
 *
 * 「这条内容是否够抽象」属于语义判断，由模型负责；此处不做，也不拦截写入。
 *
 * @returns {{entries: Array, issues: Array<{level:"error"|"warn", code:string, lesson_id:string, detail:string}>}}
 */
export function inspectMemoryGraph({ taskText, lessonText }) {
  const entries = applyPatches(
    [...parseLessons(taskText), ...parseLessonEntries(lessonText)],
    parsePatches(lessonText),
  );
  // 墓碑集合：用于区分「来源被删除」与「来源从未存在」
  const tombstoned = new Set();
  for (const line of String(lessonText ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && rec.deleted === true && typeof rec.lesson_id === "string") tombstoned.add(rec.lesson_id);
    } catch {
      /* ignore */
    }
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const issues = [];
  const add = (level, code, lesson_id, detail) => issues.push({ level, code, lesson_id, detail });

  for (const e of entries) {
    // 1. 引用完整性
    for (const c of e.conflicts ?? []) {
      if (!byId.has(c.with)) add("warn", "dangling-conflict", e.id, `conflicts.with "${c.with}" 不存在，该关系不会渲染`);
    }
    if (e.promoted_from && !byId.has(e.promoted_from)) {
      if (tombstoned.has(e.promoted_from)) {
        add("warn", "promotion-source-deleted", e.id, `promoted_from "${e.promoted_from}" 的来源已被删除，历史链条断在此处`);
      } else {
        add("warn", "dangling-promotion", e.id, `promoted_from "${e.promoted_from}" 不存在，来源无法追溯`);
      }
    }

    // 2. 状态一致性
    if (e.scope === "global" && e.subject?.kind !== "global") {
      add("error", "scope-subject", e.id, `global 条目的 subject.kind 应为 global，实际 ${e.subject?.kind}`);
    }
    if (e.scope !== "global" && !e.session_id) {
      add("error", "missing-session", e.id, `${e.scope} 条目缺 session_id，将不注入任何会话`);
    }
    if (e.scope === "session" && e.subject?.kind !== "session") {
      add("error", "scope-subject", e.id, `session 条目的 subject.kind 应为 session，实际 ${e.subject?.kind}`);
    }

    // 3. 声明完整性（只要求「写了」，不评价内容）
    if (e.scope !== "reflection" && !e.boundary) {
      add("warn", "missing-boundary", e.id, "未声明 boundary（为什么属于该层），无法审计边界是否失控");
    }
  }

  return { entries, issues };
}

/**
 * 补丁记录：只带元数据、不带正文，用于事后补充 boundary、置为 deprecated，
 * 而不覆盖或删除原有内容。
 *
 * 判定：既无 pattern 也无 correction，且不是墓碑。
 * 支持字段：boundary / status / status_reason / promoted_from(null 清除)
 */
export function parsePatches(text) {
  const map = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || rec.record_type === "reflection") continue;
    const hasContent =
      (typeof rec.pattern === "string" && rec.pattern.trim()) ||
      (typeof rec.correction === "string" && rec.correction.trim());
    if (hasContent || rec.deleted === true) continue;
    const id = rec.lesson_id;
    if (typeof id !== "string" || !id) continue;

    const patch = map.get(id) ?? {};
    if (typeof rec.boundary === "string") patch.boundary = rec.boundary.trim();
    if (STATUS.includes(rec.status)) patch.status = rec.status;
    if (typeof rec.status_reason === "string") patch.status_reason = rec.status_reason.trim();
    if (rec.promoted_from === null) patch.promoted_from = null;
    map.set(id, patch);
  }
  return map;
}

/** 把补丁应用到条目上（就地）。 */
export function applyPatches(entries, patches) {
  for (const e of entries) {
    const p = patches.get(e.id);
    if (p) Object.assign(e, p);
  }
  return entries;
}
