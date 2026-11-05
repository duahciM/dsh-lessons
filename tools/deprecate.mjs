#!/usr/bin/env node
/**
 * 把一条记忆置为 deprecated。
 *
 * 三个状态的边界（MEMORY-GOVERNANCE.md §4）：
 *   superseded  有更新的版本/经验替代它 —— 由 revise 自动产生
 *   deprecated  经验本身不再推荐使用，但保留历史记录 —— 本命令
 *   deleted     不再作为有效记忆保留 —— tools/lessons.mjs remove
 *
 * deprecated 会停止注入，但不删除正文、不抹掉 source 与历史证据。
 *
 * 用法：
 *   node tools/deprecate.mjs <lesson_id> --reason "为什么不再推荐" [--data <dir>]
 *   node tools/deprecate.mjs --list            # 列出当前 deprecated 的条目
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseLessonEntries, parseLessons, parsePatches } from "../lib/lessons.js";

const DATA = process.env.METACOG_DATA ?? join(process.cwd(), "data");
const LESSON_FILE = join(DATA, "lessons", "lessons.jsonl");
const TASK_FILE = join(DATA, "tasks.jsonl");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === "--list") {
  const patches = parsePatches(read(LESSON_FILE));
  const deprecated = [...patches.entries()].filter(([, p]) => p.status === "deprecated");
  if (deprecated.length === 0) {
    console.log("没有 deprecated 条目");
    process.exit(0);
  }
  console.log(`deprecated 条目 ${deprecated.length} 条：`);
  for (const [id, p] of deprecated) {
    console.log(`- ${id}`);
    console.log(`    原因: ${p.status_reason ?? "(未填写)"}`);
  }
  process.exit(0);
}

const id = argv[0];
const reason = flag("--reason");
if (!id || !reason) {
  console.error('用法: node tools/deprecate.mjs <lesson_id> --reason "为什么不再推荐"');
  process.exit(2);
}

// 必须存在（有效或已墓碑的都可，但不能凭空造）
const known = new Set([
  ...parseLessonEntries(read(LESSON_FILE)).map((l) => l.id),
  ...parseLessons(read(TASK_FILE)).map((l) => l.id),
  ...[...parsePatches(read(LESSON_FILE)).keys()],
]);
if (!known.has(id)) {
  console.error(`未找到记忆: ${id}`);
  console.error("用 node tools/lessons.mjs list 查看可用 id");
  process.exit(1);
}

appendFileSync(
  LESSON_FILE,
  JSON.stringify({ lesson_id: id, status: "deprecated", status_reason: reason, deprecated_at: Date.now() }) + "\n",
  "utf8",
);
console.log(`已置为 deprecated: ${id}`);
console.log(`原因: ${reason}`);
console.log("正文与 source 保留，停止注入。");
