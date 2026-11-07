#!/usr/bin/env node
/**
 * 记忆维护工具（手动迁移 / 删除 / 导入导出）。
 *
 * 三类作用域：
 *   global      跨任务工作方法 —— 所有会话可见
 *   session     会话背景       —— 仅指定会话可见
 *   reflection  任务反思       —— 仅产生它的会话可见（由 task_reflect 写入 tasks.jsonl）
 *
 * 两种形态（kind）：
 *   lesson      经验：给出模式与纠正，由模型判断是否适用
 *   directive   明确方法：直接要求执行
 *
 * 用法：
 *   node tools/lessons.mjs list [--session <id>] [--scope <s>] [--kind <k>] [--json]
 *   node tools/lessons.mjs show <id>
 *   node tools/lessons.mjs add  --scope global|session --session <id>
 *                               --pattern <p> --correction <c> --applies-when <a>
 *                               [--confidence low|medium|high] [--kind lesson|directive]
 *   node tools/lessons.mjs move <id> --to global | --to session:<id>
 *   node tools/lessons.mjs copy <id> --to global | --to session:<id>
 *   node tools/lessons.mjs remove <id> [<id> ...]
 *   node tools/lessons.mjs export --session <id> [--out <file>] [--scope <s>]
 *   node tools/lessons.mjs import <file> --to global | --to session:<id>
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseLessons,
  parseLessonEntries,
  collectLessons,
  renderLessonsSection,
  inspectMemoryGraph,
} from "../lib/lessons.js";

const DATA = process.env.LESSONS_DATA ?? join(process.cwd(), "data");
const TASK_FILE = join(DATA, "tasks.jsonl");
const LESSON_FILE = join(DATA, "lessons", "lessons.jsonl");

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const appendLine = (p, obj) => {
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify(obj)}\n`);
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function allMemories() {
  return [...parseLessons(readText(TASK_FILE)), ...parseLessonEntries(readText(LESSON_FILE))];
}

/** 该条记忆存放在哪个文件：反思在 tasks.jsonl，其余在 lessons.jsonl */
function homeOf(mem) {
  return mem.scope === "reflection" ? TASK_FILE : LESSON_FILE;
}

/** 生成目标作用域里的下一个 id。 */
function nextId(target, sessionId) {
  const existing = allMemories();
  if (target === "global") {
    return `global#${existing.filter((l) => l.scope === "global").length + 1}`;
  }
  // 去掉 "session-" 前缀再截断，否则 id 会写成 session:session-xxxx#1
  const short = String(sessionId).replace(/^session-/, "").slice(0, 8);
  const n = existing.filter((l) => l.scope === "session" && l.session_id === sessionId).length + 1;
  return `session:${short}#${n}`;
}

/** 解析 --to 的目标。 */
function parseTarget(args) {
  const to = args.to;
  if (typeof to !== "string") return undefined;
  if (to === "global") return { scope: "global", sessionId: null };
  if (to.startsWith("session:")) {
    const sid = to.slice("session:".length);
    if (!sid) return undefined;
    return { scope: "session", sessionId: sid };
  }
  return undefined;
}

function tombstone(mem) {
  if (mem.scope === "reflection") {
    appendLine(TASK_FILE, {
      ev: "task_reflect",
      record_type: "reflection",
      task_id: mem.task_id,
      session_id: mem.session_id, // 必须保留归属，否则墓碑不生效
      assessment: mem.assessment,
      lessons: [{ lesson_id: mem.id, deleted: true }],
      recorded_at: Date.now(),
    });
  } else {
    appendLine(LESSON_FILE, { lesson_id: mem.id, deleted: true });
  }
}

function writeEntry({ target, mem, origin }) {
  const id = nextId(target.scope, target.sessionId);
  appendLine(LESSON_FILE, {
    lesson_id: id,
    scope: target.scope,
    ...(target.scope === "session" ? { session_id: target.sessionId } : {}),
    kind: mem.kind ?? "lesson",
    pattern: mem.pattern,
    correction: mem.correction,
    applies_when: mem.applies_when,
    confidence: mem.confidence,
    ...(origin ? { promoted_from: origin } : {}),
  });
  return id;
}

function fmt(m) {
  const owner = m.scope === "global" ? "" : ` @${String(m.session_id).slice(0, 12)}`;
  return `[${m.scope}${owner}]${m.kind === "directive" ? " ⟨directive⟩" : ""} ${m.id}`;
}

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

switch (cmd) {
  case "list": {
    const sessionId = typeof args.session === "string" ? args.session : null;
    let lessons = collectLessons({
      taskText: readText(TASK_FILE),
      lessonText: readText(LESSON_FILE),
      sessionId,
      scopes: {},
    });
    if (typeof args.scope === "string") lessons = lessons.filter((l) => l.scope === args.scope);
    if (typeof args.kind === "string") lessons = lessons.filter((l) => l.kind === args.kind);

    if (args.json) {
      console.log(JSON.stringify(lessons, null, 2));
      break;
    }
    console.log(`数据目录: ${DATA}`);
    console.log(`会话: ${sessionId ?? "(未指定：只看 global)"}`);
    console.log(`生效: ${lessons.length} 条\n`);
    for (const l of lessons) {
      console.log(fmt(l));
      console.log(`  pattern   : ${l.pattern}`);
      console.log(`  correction: ${l.correction}`);
      console.log(`  applies   : ${l.applies_when}`);
      console.log(`  confidence: ${l.confidence}`);
      console.log("");
    }
    const all = allMemories();
    const stat = all.reduce((a, l) => ((a[l.scope] = (a[l.scope] ?? 0) + 1), a), {});
    console.log(`全库: ${JSON.stringify(stat)}（共 ${all.length} 条）`);
    break;
  }

  case "show": {
    const id = args._[0];
    const mem = allMemories().find((l) => l.id === id);
    if (!mem) {
      console.error(`未找到: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ...mem, home: homeOf(mem) }, null, 2));
    break;
  }

  case "add": {
    const scope = args.scope;
    if (scope !== "global" && scope !== "session") {
      console.error("--scope 必须是 global 或 session");
      process.exit(2);
    }
    if (scope === "session" && typeof args.session !== "string") {
      console.error("session 作用域必须提供 --session <id>");
      process.exit(2);
    }
    for (const k of ["pattern", "correction", "applies-when"]) {
      if (typeof args[k] !== "string" || !args[k].trim()) {
        console.error(`缺少 --${k}`);
        process.exit(2);
      }
    }
    const kind = args.kind === "directive" ? "directive" : "lesson";
    const target = { scope, sessionId: scope === "session" ? args.session : null };
    const id = writeEntry({
      target,
      mem: {
        pattern: args.pattern,
        correction: args.correction,
        applies_when: args["applies-when"],
        confidence: typeof args.confidence === "string" ? args.confidence : "medium",
        kind,
      },
    });
    console.log(`已写入 ${id} → ${LESSON_FILE}`);
    break;
  }

  case "move":
  case "copy": {
    const id = args._[0];
    if (!id) {
      console.error(`用法: ${cmd} <id> --to global|session:<id>`);
      process.exit(2);
    }
    const target = parseTarget(args);
    if (!target) {
      console.error("--to 必须是 global 或 session:<会话id>");
      process.exit(2);
    }
    const mem = allMemories().find((l) => l.id === id);
    if (!mem) {
      console.error(`未找到: ${id}`);
      process.exit(1);
    }
    const newId = writeEntry({ target, mem, origin: cmd === "move" ? id : undefined });
    if (cmd === "move") tombstone(mem);
    console.log(`${cmd === "move" ? "已迁移" : "已复制"} ${id} → ${newId}（${target.scope}${target.sessionId ? "@" + target.sessionId.slice(0, 12) : ""}）`);
    if (cmd === "move") console.log(`源条目已墓碑删除`);
    break;
  }

  case "remove": {
    const ids = args._;
    if (ids.length === 0) {
      console.error("用法: remove <id> [<id> ...] [--yes]");
      console.error("");
      console.error("  默认只预览，不写入。确认无误后加 --yes 才真正删除。");
      process.exit(2);
    }

    // 先全部解析出来，再决定是否执行：避免「删了一半才发现某个 id 不存在」
    const targets = [];
    let failed = 0;
    for (const id of ids) {
      const mem = allMemories().find((l) => l.id === id);
      if (!mem) {
        console.error(`未找到: ${id}`);
        failed++;
        continue;
      }
      targets.push(mem);
    }

    if (targets.length === 0) process.exit(1);

    // 预览：人类审批需要看到「删的是什么」，而不只是一串 id
    console.log(`将要删除以下 ${targets.length} 条记忆：`);
    for (const m of targets) {
      console.log(`  - ${m.id}  [${m.scope}/${m.status}]`);
      const body = m.pattern || m.correction || "(无正文)";
      console.log(`      ${body.slice(0, 120)}`);
    }
    console.log("");
    console.log("删除 = 写入墓碑（deleted: true），该条不再注入，历史记录仍保留可审计。");

    if (args.yes !== true) {
      console.error("");
      console.error("未删除。确认无误后加 --yes 重试：");
      console.error(`  lessons remove ${ids.join(" ")} --yes`);
      // 3 = 等待审批（区别于 1 = 执行失败）
      process.exit(failed > 0 ? 1 : 3);
    }

    for (const m of targets) {
      tombstone(m);
      console.log(`已删除 ${m.id}`);
    }
    if (failed > 0) process.exit(1);
    break;
  }

  case "export": {
    const sessionId = typeof args.session === "string" ? args.session : null;
    let lessons = collectLessons({
      taskText: readText(TASK_FILE),
      lessonText: readText(LESSON_FILE),
      sessionId,
      scopes: {},
    });
    if (typeof args.scope === "string") lessons = lessons.filter((l) => l.scope === args.scope);
    const payload = JSON.stringify(lessons, null, 2);
    if (typeof args.out === "string") {
      writeFileSync(args.out, `${payload}\n`);
      console.log(`已导出 ${lessons.length} 条 → ${args.out}`);
    } else {
      console.log(payload);
    }
    break;
  }

  case "import": {
    const file = args._[0];
    const target = parseTarget(args);
    if (!file || !target) {
      console.error("用法: import <file> --to global|session:<id>");
      process.exit(2);
    }
    let rows;
    try {
      rows = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`读取失败: ${e.message}`);
      process.exit(1);
    }
    if (!Array.isArray(rows)) {
      console.error("文件内容必须是 JSON 数组");
      process.exit(1);
    }
    let n = 0;
    for (const row of rows) {
      writeEntry({
        target,
        mem: {
          pattern: row.pattern,
          correction: row.correction,
          applies_when: row.applies_when ?? row.appliesWhen,
          confidence: row.confidence,
          kind: row.kind,
        },
        origin: row.id,
      });
      n++;
    }
    console.log(`已导入 ${n} 条 → ${target.scope}${target.sessionId ? "@" + target.sessionId.slice(0, 12) : ""}`);
    break;
  }

  case "check": {
    const { entries, issues } = inspectMemoryGraph({
      taskText: readText(TASK_FILE),
      lessonText: readText(LESSON_FILE),
    });
    console.log(`条目总数: ${entries.length}`);
    if (issues.length === 0) {
      console.log("✅ 结构检查通过（引用完整、状态自洽、边界已声明）");
      break;
    }
    const errors = issues.filter((i) => i.level === "error");
    console.log(`发现 ${errors.length} 个错误、${issues.length - errors.length} 个提示\n`);
    for (const i of issues) {
      console.log(`${i.level === "error" ? "❌" : "⚠️ "} [${i.code}] ${i.lesson_id}`);
      console.log(`     ${i.detail}`);
    }
    if (errors.length > 0) process.exit(1);
    break;
  }

  default:
    console.error("用法: node tools/lessons.mjs <list|show|add|move|copy|remove|export|import|check> [...]");
    process.exit(2);
}
