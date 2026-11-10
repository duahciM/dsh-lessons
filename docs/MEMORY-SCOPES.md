# 三类记忆的作用域与注入

> 目标：把「经验」按作用范围分域，避免会话专属的内容污染其它会话。

---

## 一、三类记忆

| 类型 | `scope` | 与当前任务的关系 | 示例 | 跨会话 |
|---|---|---|---|---|
| 全局记忆 | `global` | 跨任务适用的工作方法 | 「修改完目标要检查一次」 | ✅ |
| 单会话记忆 | `session` | 与当前会话背景高度绑定 | 「在修改 A 之前先检查 A 的耦合」 | ❌ |
| 自主反思记忆 | `reflection` | 来自具体任务中的经验与错误 | 「修改 A 会导致 B 失效」 | ❌ |

---

## 二、注入规则

每次装配按**当前会话**求值：

```
inject = { l | l.scope === 'global' }
       ∪ { l | l.scope === 'session'    && l.session_id === current }
       ∪ { l | l.scope === 'reflection' && l.session_id === current }
```

三条补充：

- `session_id` 缺失的 `session`/`reflection` 条目**不注入任何会话**（宁可缺失，不可串号）
- 三个域可单独关闭（`lessons.scopes`），用于对照实验
- 渲染时按域分组，各自带标题与说明，让模型知道该条记忆的适用范围

---

## 三、数据来源

| 文件 | 内容 | 写入方 |
|---|---|---|
| `<taskDir>/tasks.jsonl` | 任务事实 + `record_type: "reflection"` 反思记录 | `task_end` / `task_reflect` |
| `<taskDir>/lessons/lessons.jsonl` | `global` 与 `session` 条目（手工/晋升） | `tools/lessons.mjs` |

两者都支持：同 `lesson_id` 后写覆盖（last-wins）、`deleted: true` 墓碑。

**为什么分两个文件**：`tasks.jsonl` 是任务过程的审计日志，追加频繁；`lessons.jsonl` 是人工维护的策展层，改动少。混在一起会让"任务日志"和"经验库"的生命周期纠缠。

---

## 四、命令行工具

```bash
# 查看当前生效的记忆
node tools/lessons.mjs list --session <id> [--scope global|session|reflection] [--json]
node tools/lessons.mjs show <id>

# 新增
node tools/lessons.mjs add --scope global \
  --pattern "…" --correction "…" --applies-when "…" --confidence high
node tools/lessons.mjs add --scope session --session <id> \
  --pattern "…" --correction "…" --applies-when "…"

# 迁移 / 复制（可在三条作用域之间任意搬）
node tools/lessons.mjs move <id> --to global
node tools/lessons.mjs move <id> --to session:<目标会话id>
node tools/lessons.mjs copy <id> --to session:<目标会话id>

# 删除（可批量）
node tools/lessons.mjs remove <id> [<id> ...]

# 导出 / 导入（给实验组播种）
node tools/lessons.mjs export --session <id> [--scope global] --out export.json
node tools/lessons.mjs import export.json --to session:<实验会话id>
```

### 迁移的语义

`move` = 在目标作用域写新条目 + 墓碑删除源条目；`copy` 只做前半步。

反思**不跨会话**，所以「让另一个会话用上这条经验」只有两条路：

| 意图 | 做法 |
|---|---|
| 它其实是通用工作方法 | `move <id> --to global` |
| 只对某个会话有用 | `move <id> --to session:<目标>` |

迁移后的条目保留来源（`promoted_from`），原始反思记录不动。

### 两种形态：经验 vs 明确方法

`--kind` 控制渲染：

| `kind` | 渲染 | 用途 |
|---|---|---|
| `lesson`（默认） | `[Lesson N]` + Pattern / Correction / Applies when | 经验：模型自行判断是否适用 |
| `directive` | `Required method:` + 短横线条目 | 明确方法：直接要求执行 |

```bash
node tools/lessons.mjs add --scope global --kind directive \
  --pattern "改动后未验证就声明完成" \
  --correction "修改完文件后，先运行能覆盖该改动的验证，再声明完成" \
  --applies-when "任何代码或配置改动之后"
```

同样的内容，`--kind directive` 是「明确告诉正确方法」，`--kind lesson` 是「只提供经验」。

---

## 五、三个实验问题怎么落地

### Q1：经验能否迁移到另一个项目（经验是否有用）？

| 步骤 | 做法 |
|---|---|
| 在项目 A 积累反思 | 正常做任务，`task_reflect` |
| 迁移到项目 B 的会话 | `move <id> --to session:<B 的会话>` 或 `move <id> --to global` |
| 在 B 做同类任务 | 对比有迁移 / 无迁移的表现 |

用 `copy` 而非 `move`，可以保留 A 的原状态，做「同一经验在两个项目各跑一次」的对照。

### Q2：全局记忆和单会话记忆分别贡献了什么？

| 组 | global | session | reflection | 回答的问题 |
|---|---|---|---|---|
| A | ✅ | ✅ | ✅ | 完整记忆的效果 |
| B | ❌ | ❌ | ❌ | 纯基线 |
| C | ✅ | ❌ | ❌ | **全局方法的单独贡献** |
| D | ❌ | ✅ | ✅ | **会话记忆的单独贡献** |

C 与 D 各自减去 B，即可分离两者。

### Q3：明确告诉正确方法，是否比只提供经验更有效？

同一批内容，两种 `kind`：

| 组 | 内容 |
|---|---|
| 经验组 | `--kind lesson` |
| 指令组 | `--kind directive` |

用 `export` 导出经验组，再 `import` 灌成指令组，保证**内容完全相同，只有框架不同**。

### 操作流程

```bash
# 1. 导出素材
node tools/lessons.mjs export --session <本会话> --out base.json

# 2. 给实验组播种
node tools/lessons.mjs import base.json --to session:<A 的会话>

# 3. 对照组什么都不给（新会话只能看到 global）

# 4. 回收
node tools/lessons.mjs remove session:xxx#1 session:xxx#2
```

`list --session <id>` 随时确认「这个会话到底看到了什么」——这是验证实验组配置正确的唯一可靠方式。

---

## 六、作用域开关

```yaml
lessons:
  scopes:
    global: true       # 关闭 = 无全局方法
    session: true      # 关闭 = 无会话背景
    reflection: true   # 关闭 = 无任务反思
```

B/C/D 组需要重启插件才生效（改配置 → disable/enable）。
播种方案（`import` 到指定会话）不需要重启，切换更快，**推荐优先用播种**。

**注意**：切换开关会改变 system prompt，每次切换触发一次全量重算（见 `LESSONS-INJECTION.md` 第五节）。

---

## 七、验证

离线自测 `selftest-lessons.mjs`：**40/40**

覆盖：
- 反思解析、last-wins、墓碑
- `global` / `session` 条目解析与删除
- 按会话过滤：别的会话看不到本会话的 session 与 reflection
- 无会话时只注入 global
- 三域开关逐个关闭
- 渲染分组（只有某域时不出现多余标题）
- 双文件 mtime 缓存 + 换会话不复用缓存

真实运行时（诊断记录 `data/lessons-render.jsonl`）：

```
会话 A（本会话）        lessons=7  {global:2, session:1, reflection:4}
会话 OTHER-SESSION      lessons=2  {global:2, session:0, reflection:0}
```

同一个库、同一进程，仅因当前会话不同而注入不同内容。

---

## 八、限制

| # | 限制 | 说明 |
|---|---|---|
| M1 | `session_id` 缺失的记忆永不注入 | 手写记录时必须带 `session_id`，否则静默失效（已踩过一次） |
| M2 | 无自动晋升 | 反思→全局必须人工 `promote`；这是刻意的，避免模型自我拔高 |
| M3 | 无去重 | 同一经验可能同时存在于 reflection 与 global |
| M4 | 全局条目无会话归属 | 手工添加的 global 不记录"从哪来"，仅 `promote` 保留 `promoted_from` |
| M5 | 无有效性校验 | 记忆内容不被验证，错误结论照样注入 |

> M1 是实践中最容易踩的：工具 `add --scope session` 会强制要求 `--session`，
> 但手工编辑 JSONL 时容易漏。

---

## 附录 A：渲染形态

```markdown
## Accumulated Lessons

Lessons recorded earlier, grouped by how far they apply.
Judge whether each one fits the situation in front of you; do not apply them mechanically.

## Global working methods
Cross-task methods that were found to generalize.

[Lesson 1]
Pattern: …
Correction: …
Applies when: …
Confidence: high

## Session context
Facts and constraints bound to this session's work.

[Lesson 2]
…

## Task reflections
Lessons recorded from earlier tasks in this session.

[Lesson 3]
…
```

分组的用意：让模型知道每条记忆的**可信边界**——全局方法可以直接用，会话背景要看当前是否还在这个会话里，任务反思只对同类任务成立。

---

## 附录 B：任务边界提示段

### 为什么需要

三个工具里，`task_reflect` 有明确提示（任务关闭的材料末尾点名要求），但 `task_start` 和 `task_end` **没有任何地方说什么时候该调用**。模型只能靠浏览工具列表自己想起来——经常想不起来。

不调用 `task_end`，材料就不会注入；材料不注入，反思就不会发生。整条记忆循环在不被提示时是断的。

### 文本

```
## Task boundaries

Before starting a unit of work whose result can be checked, call task_start.
When that result exists — whether it was reached or not — call task_end.
```

只讲**什么时候**用；**怎么用**在工具定义与参数说明里，不在此重复。

### 配置

```yaml
taskBoundaryHints: true          # 默认开启
taskBoundarySectionName: 'metacog:task-boundaries'
taskBoundaryOrder: 10400         # 排在记忆段（10500）之前
```

### 特性

| 项 | 说明 |
|---|---|
| 静态内容 | 永不变化，不随记忆更新触发缓存失效 |
| 独立开关 | `false` 时整段不注册，用于「有提示 vs 无提示」对照 |
| 独立于记忆 | `lessons.enabled: false` 不影响它 |

### 验证

诊断文件 `data/lessons-render.jsonl` 中带 `kind: "task-boundaries"` 的记录：

```
开启 → { section: "metacog:task-boundaries", chars: 169 }
关闭 → 无该记录（重启插件后也不再产生）
```

实测开关往返各一次，行为符合预期。

### 实验意义

不加这个提示，实验里「Agent 没记忆所以表现差」和「Agent 没被提示用工具所以没积累记忆」会混在一起，无法归因。加上之后两组的外部条件一致，唯一差别是记忆内容。
