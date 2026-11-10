# 反思生成与持久化（步骤 1 + 步骤 2）

> 本文第五节「记忆文档形态」与第六节「标签体系」描述的是当时的 Hindsight 写入，现已不适用。
> 现状：反思只写 `tasks.jsonl`（`record_type: "reflection"`），是唯一来源。
> 归档代码见 `attic/`。
>
> 目标：**Agent 消费任务关闭时注入的决策轨迹，产出结构化反思，并落盘。**
>
> 状态：**已跑通** —— 真实任务 → 反思工具 → 本地记录 → 注入下一次请求

---

## 一、结论

| 能力 | 状态 | 证据 |
|---|---|---|
| 关闭时注入决策轨迹 | ✅ | 材料含 REQUEST / ASSISTANT / 六问 |
| 材料指示调用反思工具 | ✅ | 末尾带 `task_reflect` 与 task_id |
| 结构化反思写入 | ✅ | `stored=1`，库中出现 `reflection-task-…-0` |
| 独立标签 | ✅ | `metacog:reflection` 过滤命中 |
| 本地可审计 | ✅ | `tasks.jsonl` 写 `record_type: "reflection"` |
| 空反思（无可迁移结论） | ✅ | `lessons: []` → 记本地、不污染记忆库 |
| 未知 task_id | ✅ | 拒绝并回显最近关闭的任务 |

---

## 二、流程

```
task_end
  ├─ 截取决策轨迹（对话/纠正/回合）
  ├─ 写 tasks.jsonl（close）
  ├─ retain 任务事实 → Hindsight（metacog:task）
  └─ deferContext(反思材料 + 六问 + 指示调用 task_reflect)
        ↓ 下一步
Agent 复盘
        ↓
task_reflect(task_id, assessment, lessons)
  ├─ 校验 task_id 属于最近关闭的任务
  ├─ retain 每条 lesson → Hindsight（metacog:reflection）
  └─ 写 tasks.jsonl（record_type: "reflection"）
```

**关键点**：反思由 **Agent 产出**，Hindsight 只做存储与检索。
我们不用 Hindsight 的 `reflect`（那需要 LLM provider，且会把判断交给另一个模型）。

---

## 三、反思 schema

```json
{
  "task_id": "task-…",
  "assessment": "aligned | partial | diverged",
  "lessons": [
    {
      "pattern": "时间线里实际出现的工作方式问题",
      "correction": "下次怎么做",
      "applies_when": "什么情况下触发",
      "confidence": "low | medium | high"
    }
  ]
}
```

### 为什么是这四个字段

| 字段 | 对应你的规格 | 作用 |
|---|---|---|
| `pattern` | 原因假设 | 描述**可复用**的模式，不是本次任务经过 |
| `correction` | 纠正方法 | 下次可执行的动作 |
| `applies_when` | 适用范围 | 决定日后能否命中（同时作为记忆的 `context`） |
| `confidence` | 置信度 | 步骤 3 的筛选依据；低置信不该强注入 |
| `assessment` | 结果与预期的差异 | 步骤 4 判断「错误泛化」的关键：`diverged` + `high` 最可疑 |

### 三条硬约束

1. **最多 3 条 lesson** —— 防止一次反思刷出十条泛泛而谈
2. **必填 `applies_when`** —— 没有适用范围的知识无法判断该不该用
3. **允许 `lessons: []`** —— 没有可迁移结论时如实记录，不硬凑

第三条很重要：如果强制每条反思都必须产出教训，模型会为了填满字段而编造。空数组是一等公民。

---

## 四、与「剔除工具调用」原则的一致性

反思材料里已经不含工具调用清单（见 v0.2.0）。反思 schema 同样：

- `pattern` 描述的是**判断与决策**层面的问题
- 没有「某个工具怎么用」的字段
- 材料末尾明确写「do not turn this into a review of tool usage」

---

## 五、记忆文档形态

每条 lesson 独立成文档，便于精确检索（而不是一个任务一大坨）：

| 项 | 值 |
|---|---|
| `document_id` | `reflection-<task_id>-<序号>` |
| `content` | 模式 / 纠正 / 适用 / 置信 / 结果判定 / 来源任务 |
| `context` | `applies_when` |
| `tags` | `metacog:reflection`、`confidence:<级>`、`assessment:<判定>`、`task:<id>` |

**为什么一条 lesson 一个文档**：检索粒度。若把三条 lesson 塞进一个文档，查到第二条也会带出另两条噪声，注入时更难压缩。

`document_id` 含序号，同一任务多次调用不会互相覆盖。

---

## 六、标签体系

```
metacog:task        任务事实（目标/预期/结果）    ← 步骤 1 接入时写入
metacog:reflection  反思结论                      ← 本步写入
```

检索时用 `tags` 过滤，两者互不污染。

---

## 七、验证证据

### 7.1 离线自测

`selftest-reflection.mjs`：**36/36 通过**

- 必填与枚举（task_id / assessment / confidence）
- lesson 字段缺失逐个报错
- 超过 3 条拒绝
- `confidence` 默认 `medium`
- 渲染内容、`document_id` 与 offset、标签组成
- 本地记录字段

全套：`selftest 53 + memory 34 + reflection 36 = 123` 用例通过。

### 7.2 真实端到端

```
task_start            → task-5fe7f374-…
task_end              → 注入材料（含 task_reflect 指示）
task_reflect          → "1 lesson(s), 1 stored for later retrieval."
recall(tags:[metacog:reflection])
  → [1.100] reflection-task-5fe7f374-…-0
  → 模式/纠正/适用/置信 全部正确回读
```

### 7.3 边界

| 场景 | 结果 |
|---|---|
| 未知 `task_id` | `Error: unknown or expired task_id "task-does-not-exist"; recently closed tasks: task-5fe7f374-…` |
| 空 `lessons` | `"nothing generalizable beyond this task."`，本地记 `lessons: []`，记忆库不写 |
| 同一任务多次调用 | 序号递增，`document_id` 不冲突 |

---

## 八、已知限制

| # | 限制 | 影响 | 缓解方向 |
|---|---|---|---|
| **R1** | 反思依赖 Agent 主动调用 `task_reflect` | 不调用 = 无反思 | 材料已明确指示；可将「未反思」记为信号 |
| **R2** | 反思质量未经校验 | 错误结论会被当作事实存下 | 步骤 4 的「错误泛化」检测 |
| **R3** | 无跨任务去重/合并 | 同类教训重复存多份 | 检索时按相似度归并，或后续引入晋升流程 |
| **R4** | `injectReflection: false` 或窗口为空时无材料 | 那时不会提示调用反思 | 已记录为配置约束 |
| **R5** | 记忆库不可达时反思只进本地 | `stored=0`，但本地有记录可重放 | 可从 `tasks.jsonl` 补写 |

> **R2 是步骤 4 的核心问题**：现在系统无条件相信 Agent 的自我判断。
> 一条 `assessment: aligned` + `confidence: high` 的教训，如果其实是错的，
> 会在步骤 3 被注入，进而影响后续行为 —— 这正是「错误泛化」。
> `assessment` 字段就是为此留的抓手。

---

## 九、下一步（步骤 3）的接口

已具备、未接线：

```js
// 检索（已实现并自测）
const { results } = await memory.recall(currentGoal, {
  tags: ["metacog:reflection"],
  maxTokens: 512,
});
```

步骤 3 需要补的两件事：

1. **渲染成短文本**（每条 lesson 压到一两行，总量受控）
2. **注入 `systemPrompt.section`** —— 需要验证两个技术点：
   - 动态 section 是否破坏 **Prefix Cache**（prompt 前缀变化 → 缓存全失效）
   - 修改记忆后能否在**下一次请求**立刻生效

> 关于 Prefix Cache：若把反思放在 system prompt **末尾**、且按内容稳定排序，前缀（工具定义 + 基础指令）仍可命中；若插在前面或每次顺序变化，则整段缓存作废。这需要实测而不是推断。

---

## 附录：文件

| 文件 | 作用 |
|---|---|
| `lib/reflection-model.js` | 校验、渲染、记忆项构造、本地记录 |
| `selftest-reflection.mjs` | 36 个用例 |
| `index.js` | `task_reflect` 工具注册 + `closed` 任务索引 |
| `lib/task-context.js` | 材料末尾的 `task_reflect` 指示 |
