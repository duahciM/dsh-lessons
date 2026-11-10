# 任务边界层（Task Boundary Layer）设计说明

> 插件的一个子模块。**本层只负责「界定任务」与「截取任务上下文」**，不做反思生成、不做规则晋升、不做跨会话累计。

---

## 零、核心原则（v0.2.0 修订）

**反思对象是「工作决策」，不是「工具使用」。**

这条原则来自两个已验证的组合：

| 组合 | 观察 | 推论 |
|---|---|---|
| 任务**成功**，过程中有工具失败 | 工具失败了，但结果达成 | 工具失败不必然意味着做错 |
| 任务**失败**，工具层无失败 | 每一步都"成功"，结果却没达成 | 工具成功不必然意味着做对 |

两者互为反例，证明：**任务结果才是反思的主要入口，工具失败只能作为辅助证据。**

因此 v0.2.0 做了方向性修订：

- ❌ 剔除：工具名、参数、调用顺序、每次调用的成败明细
- ✅ 保留：用户请求与纠正、助手对外表述、任务声明与结果、回合结束方式
- ✅ 工具失败降级为**一个计数**，仅作旁证

反思要还原的是：
1. 目标理解与判断
2. 方案选择及其理由
3. 发现新信息后如何调整方向
4. 对已有信息的利用
5. 遇到困难时如何处理
6. 最终结果与预期结果之间的差异

> 不要求记录每一步内部思考，只要足以**还原决策过程**。优先级：对话 > 用户纠正 > 任务声明与结果 > 思考链（必要时）。

---

## 一、概念固定

### 1.1 任务开始

> **Agent 准备执行一个有明确预期结果的目标时。**

判定要素：**存在可检验的预期结果**。没有预期结果的工作不是任务。

工具调用：`task_start(goal, expected_result)`。

### 1.2 任务结束

> **Agent 得到该目标对应的结果时，无论成功还是失败。**

结束条件是「结果出现」，不是「成功」。

- 成功 → `status: "succeeded"`
- 确认无法达成 → `status: "failed"`
- 主动放弃 → `status: "abandoned"`
- 被打断 → `status: "aborted"`

工具调用：`task_end(task_id, status, result)`。

### 1.3 任务大小

> **允许任意大小，但不能小到只是完成总目标中的一个微小操作，例如单独运行测试。**

**给模型的指导，不是程序约束。** 落实方式：

- `task_start` 描述里明确写「running one test, reading one file, or a single tool call is not a task」
- 不设最小事件数阈值 —— 「是否够大」是语义判断
- 只做下限提示：`goal` / `expected_result` 必填非空

> **已知局限**：模型仍可能把「跑一次测试」声明为任务。本层不阻止，也无法可靠阻止。

### 1.4 任务拆分

> **允许 Agent 将一个用户要求拆分为多个有独立结果的阶段性任务。**

- 任务之间**串行**（一个会话同时只有一个 open 任务）
- `task_start` 支持可选 `parent_task_id`，标注阶段归属
- 拆分不需要特殊权限

> **未实现**：嵌套的父子生命周期约束。`parent_task_id` 目前只是标注。

### 1.5 任务标识

> **每个任务由程序生成独立 ID。**

```js
`task-${randomUUID()}`
```

模型不能指定，全程不变，与 `goal.id` 无关。

### 1.6 任务归属

> **任务期间产生的上下文关联到对应 ID。**

v0.2.0 的归属对象从「工具调用」改为「决策上下文」：

每条任务记录存 `start_seq` / `end_seq`（会话事件序号闭区间）。任务期间的**对话、纠正、回合**都落在这个区间里。

```
task.start_seq ─────────────── task.end_seq
   │                              │
   └── user/message, assistant/message, turn/end ... ──┘
```

**工具事件不再作为归属对象**，只保留一个失败计数。

---

## 二、为什么不用 goal / todo / turn

| 候选 | 创建事件 | 完成事件 | 稳定 ID | 覆盖率 | 结论 |
|---|---|---|---|---|---|
| `goal/change` | ✅ | ✅ | ✅ `GoalId` | ❌ 需显式创建 | 语义是「目标」不是「任务」 |
| `todo/write` | 整体替换 | ❌ 靠 status | ❌ **无 ID** | ⚠️ 模型自觉 | 无 ID，且 turn 边界重置 |
| `team/task` | ✅ | ✅ | ✅ | ❌ 需 Team 模式 | 语义是「分派给队员」 |
| `turn/start..end` | ✅ | ✅ | ⚠️ 仅序号 | ✅ 总是 | 粒度是「一轮对话」，不可拆 |
| **本层自建** | ✅ | ✅ | ✅ `task-N` | ⚠️ 模型调用 | **语义可精确控制** |

### 2.1 goal 的具体问题（实测）

- **同时只能 1 个**：`create` 在 `phase !== "complete"` 时抛 `GOAL_ALREADY_EXISTS`
- **`edit` 不换 ID**：复用 `current.id`，只递增 `revision` —— 不能用来分段
- **`edit` 不释放槽位**：编辑后仍无法建新 goal
- **`pause` 后模型无法 `resume`**（需用户），但可以 `complete` —— 产生**语义错误的完成事件**
- **被打断时不闭环**：会话结束不会自动 mark complete

### 2.2 todo 的具体问题（实测）

- `TodoItem` 只有 `{content, status}`，**没有 ID**
- 投影在 `turn/start` 时 `return null` —— **每个 turn 清零**

### 2.3 turn 不够用的原因

- 用户一句话可能包含多个任务 → 一个 turn 无法拆
- 一个任务可能跨多个 turn → 多个 turn 无法合并

---

## 三、数据结构

### 3.1 文件

```
<taskDir>/tasks.jsonl
```

独立文件，反思消费后可整体删除。

### 3.2 记录类型

| `record_type` | 含义 | 何时写 |
|---|---|---|
| `open` | 任务开始 | `task_start` 成功时 |
| `close` | 任务结束 | `task_end` 成功 / 被顶替 / 插件卸载时仍开着 |
| `orphan` | 会话结束仍未结束 | 插件卸载时 |

### 3.3 字段

**规格必填**

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | `task-<uuid>` |
| `session_id` | string | 所属会话 |
| `goal` | string | 任务目标 |
| `expected_result` | string | 可检验的预期结果 |
| `start_time` | number | 毫秒时间戳 |
| `end_time` | number \| null | open 记录为 null |
| `status` | string \| null | open 记录为 null |
| `result` | string \| null | open 记录为 null |

**扩展**

| 字段 | 类型 | 说明 |
|---|---|---|
| `start_seq` / `end_seq` | number | 决策上下文的区间 |
| `tool_failures` | number | 区间内工具层失败数，**仅作辅助证据** |
| `parent_task_id` | string \| null | 阶段任务的父任务 |
| `closed_by` | string | `manual` / `superseded` / `session-end` |
| `recorded_at` | number | 写入时间 |
| `ev` / `record_type` | string | 记录类型判别 |

> **已移除**：`tool_calls`、`call_ids`。工具调用不是反思对象，留计数足矣；明细仍在 `error-events.jsonl`。

---

## 四、工具契约

### 4.1 `task_start`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["goal", "expected_result"],
  "properties": {
    "goal": { "type": "string" },
    "expected_result": { "type": "string" },
    "parent_task_id": { "type": "string" }
  }
}
```

校验：两项去空白后非空，各 ≤ 2000 字符。

副作用：顶替旧任务（若开）→ 写 `open` → 返回 `{task_id, goal, expected_result}`。

### 4.2 `task_end`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["task_id", "status", "result"],
  "properties": {
    "task_id": { "type": "string" },
    "status": { "type": "string", "enum": ["succeeded","failed","abandoned","aborted"] },
    "result": { "type": "string" }
  }
}
```

校验：有 open 任务；`task_id` 匹配；`status` 合法；`result` 非空且 ≤ 4000 字符。

副作用：截取决策轨迹 → 写 `close` → `deferContext` 注入反思材料 → 清除 open 状态。

返回值：`{task_id, status, review_pending, tool_failures}`。

> **注意**：返回值保留 `tool_failures` 但**不返回 `tool_calls`** —— 避免把模型的注意力引向工具使用。

---

## 五、上下文截取：决策轨迹

### 5.1 采集规则

| 来源 | 条件 | 归类 |
|---|---|---|
| `user/message` | `source.kind === "user"` | 第 1 条 → `REQUEST`；后续 → `CORRECTION` |
| `assistant/message` | 有 `text` 块 | `ASSISTANT`（对外表述） |
| `assistant/message` | 无 `text` 但有 `reasoning` | 内部推理摘录（限量） |
| `turn/end` | — | 回合结束方式 |
| `tool/result` | 失败（框架错误/非零退出/超时/信号） | **只加计数** |

**显式排除**：`tool/call`、插件注入消息、运行时上下文、goal 轮次消息。

### 5.2 前置请求（关键补充）

任务常常在用户说完话之后才被声明，此时原始请求落在 `start_seq` **之前**。但「目标理解是否正确」必须对照这条请求才能判断。

因此额外采集：**同一 turn 内、`start_seq` 之前最近的一条人类消息**，标注为 `REQUEST (before the task was opened)`。

判据是 turn 边界：若最近一条 `turn/start` 之后有用户消息，它就是同一 turn 的前置请求；跨 turn 的不取（避免抓到上一个任务的话）。


### 5.3 配额

| 项 | 上限 |
|---|---|
| 交换条数 | 24（超出保留首条 + 最近 23 条，中间标省略） |
| 单条用户消息 | 1500 字符 |
| 单条助手消息 | 1200 字符 |
| 推理摘录 | 4 条 × 240 字符（截断加 `…`） |
| 回合记录 | 12 条 |

**推理只在「没有对外文本」时采集** —— 避免把思考过程当对话倾倒，同时保留「只有念头没有输出」的步骤。

---

## 六、反思材料注入

### 6.1 通道

`exec.deferContext(message)` → `additionalContexts` → 下一步的 inbox。

依据：`dsh-tools:3248` 定义 `deferContext`，`dsh-agent-loop:572` 逐条 `acceptContext`。

不阻塞回合、不修改历史、失败不影响工具结果。

### 6.2 消息形状

```js
{
  id: "plugin:metacog-task:<ts>:<n>",
  role: "user",
  content: [{ type: "text", text: brief }],
  source: { kind: "plugin:metacog-task", form: "notice",
            summary: "task closed: task-xxx" }
}
```

## 七、状态机与边界情形

```
          task_start                task_end
  (none) ──────────> open ──────────────────> closed
                      │
                      ├─ task_start（再次）──> closed(abandoned, superseded) + 新 open
                      └─ 插件卸载 ──────────> orphan
```

| 情形 | 行为 | 实测 |
|---|---|---|
| 孤立 `task_end` | 报错，不写记录 | ✅ `no open task for this session` |
| `task_id` 不匹配 | 报错并回显正确 ID | ✅ |
| 重复 `task_start` | 旧任务 `abandoned`/`superseded` | ✅ |
| 非法 `status` / 空 `result` | 报错 | ✅ 单测 |
| `task_end` 后再次 `task_end` | 报错 | ✅ |

---

## 八、实测证据

### 8.1 离线自测

`selftest.mjs`：**53/53 通过**。

新增/变更的关键断言：
- 用户消息只收 `kind: "user"`，第一条为 REQUEST、后续为 CORRECTION
- 助手有文本 → ASSISTANT；无文本有推理 → 推理摘录
- 工具失败**只计数**，`toolCallId` 不出现在轨迹里
- 材料不含 `TOOL ACTIONS`、不含 `call_`
- 材料包含六个反思问题与「不要变成工具使用复盘」
- 同一 turn 的前置请求被取到；跨 turn 不取
- 记录字段不再含 `tool_calls` / `call_ids`

### 8.2 schema 预检

`preflight.mjs`：用 DSH 的 `assertSupportedJsonSchema` 校验两个工具的 `parameters` 与 `output.schema`，并模拟 provider 视角确认 `type === "object"`。

### 8.3 真实运行时验收

| 场景 | 结果 |
|---|---|
| 任务成功 + 工具失败 | 材料显示 `tool-level failures: 1`，但主体是对话 |
| 任务失败 + 工具无失败 | `status=failed`，`tool_failures=0` |
| 被顶替 | `abandoned` / `superseded`，不静默丢弃 |
| 前置请求 | 任务中途开启时，用户原话仍被纳入材料 |


---

## 九、已知限制

| # | 限制 | 原因 | 影响 |
|---|---|---|---|
| **L1** | 任务边界完全依赖模型调用 | 只有模型知道「预期结果何时出现」 | 模型不调用 → 无记录 |
| **L2** | 「任务大小」不可程序判定 | 语义问题 | 可能记录微小任务 |
| **L3** | 会话结束仍 open 的任务写 `orphan`，无 `end_seq` | 卸载钩子拿不到会话上下文 | 该任务无区间 |
| **L4** | `parent_task_id` 只是标注 | 未实现嵌套约束 | 父子生命周期不联动 |
| **L5** | 前置请求只回溯到同一 turn | 跨 turn 的任务会丢失动机 | 若任务在下一轮才开，取不到上一轮请求 |
| **L6** | 删除 `tasks.jsonl` 时插件仍持有 fd，后续写入会丢 | 写入器长开 fd | 轮转必须先禁用插件 |
| **L7** | 助手对外文本稀疏时，材料信息量低 | 许多步骤只有 reasoning + tool-call | 需要模型养成写结论的习惯 |
| **L8** | 推理摘录可能与事实脱节 | reasoning 是过程性文本 | 已在材料中标注为 excerpt |

> **L7 值得注意**：实测一次任务窗口内 22 个事件，只有 1 条助手对外文本。如果模型全程"闷头调工具"，决策轨迹会很空，反思质量会下降。这需要提示模型**在关键节点写下判断**，属于使用习惯问题，不是本层能强制解决的。

### 9.1 已修复的迭代问题（保留记录）

| 问题 | 现象 | 修法 |
|---|---|---|
| `parameters` 形状 | provider 报 `type: null`，整个请求被拒 | 必须传完整 JSON Schema（`type:"object"` + `properties` + `required` 数组） |
| `output.schema` 的 required | `JsonSchemaError` | `required` 必须是数组，不能写在每个属性上 |
| 失败漏判 | 窗口内 `exit 42` 却报 `failures: 0` | 只查 `isError` 不够，必须解析文本退出码 |
| 删除日志丢写入 | 运行时 `rm tasks.jsonl` 后记录消失 | 写入器长开 fd；轮转前先禁用插件 |

---

## 十、未验证项

| # | 项 | 状态 |
|---|---|---|
| U1 | 插件卸载时的 `orphan` 记录 | 代码已写，未取得真实样本 |
| U2 | 跨多 turn 的长任务材料质量 | 本次任务都在单 turn 内 |
| U3 | 反思材料在 Web UI 的渲染 | 未确认 `form: "notice"` 的视觉效果 |
| U4 | 模型是否自发遵守「不要记录微小任务」 | 需行为观察 |
| U5 | 大区间（数千事件）的截取性能 | 单次线性扫描，未压测 |
| U6 | 反思材料能否真正提升后续任务表现 | 需对照实验（下一阶段） |

---

## 十一、与后续阶段的接口

```
tasks.jsonl 的 close 记录
  ├─ task_id / goal / expected_result   → 判断「目标是否被正确理解」
  ├─ status / result                     → 判断「结果与预期的差异」
  ├─ start_seq..end_seq                  → 去会话日志取该区间的对话
  └─ tool_failures                       → 辅助旁证（仅数字）
```

**本层不产生**：错误归类、反思结论、规则、评分、跨会话聚合。

---

## 附录：文件清单

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：两个工具 + 注入 + 生命周期 |
| `lib/task-model.js` | 记录构造、参数校验、状态枚举 |
| `lib/task-context.js` | 决策轨迹截取、前置请求、材料渲染 |
| `lib/writer.js` | 崩溃安全写入器 |
