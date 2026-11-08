# DSH 元认知插件（dsh-lessons）
（效果不保证）

[English](README_en.md)
> 让 Agent 在任务结束后复盘，把可复用的经验沉淀下来，并在后续任务中按作用域注入。
>
> 运行环境 DeepSeek Harness `0.2.1-rc.5` · 单包安装

---

## 一、插件解决的问题

Agent可能在不同任务中重复犯错,当前会话结束后,相关上下文不一定会保留,换一个会话Agent也未必能利用之前的经验。

单纯增加提示词只能提供静态规则，无法自然记录某次任务中实际出现的问题、修正方法，以及这些经验后来是否再次得到验证。

本插件尝试建立一个闭环：

```text
任务开始 → 决策 → 任务结束 → Agent反思 → 结构化记忆
   ↑                                           │
   └──────────── 后续任务读取并应用经验 ────────┘
```

插件试图解决的问题是：一次任务中形成的经验，能否迁移到后续的独立任务？

> 实验数据请看第四节

---

## 二、插件的机制

### 2.1 四个工具

| 工具 | 作用 |
|---|---|
| `task_start(goal, expected_result)` | 声明任务目标与预期结果，建立任务记录 |
| `task_end(task_id, status, result)` | 声明任务结果，关闭任务并生成复盘材料 |
| `task_reflect(task_id, assessment, source, lessons[])` | 保存Agent对任务的反思和经验 |
| `lessons_lookup(lesson_id)` | **按需**追溯一条经验的完整来源（只读） |

`task_end` 会把任务时间窗内的材料整理成一份**决策轨迹**，主要包括用户请求和纠正、Agent对外表述，以及在缺少对外表述时限量的采集推理摘录。它不收集完整工具调用清单，工具失败计数只作为辅助信号。

这里的反思对象是Agent的**工作决策**，而不是工具调用技巧，工具调用记录与任务决策轨迹分开处理。
   
任务状态包括 `succeeded`、`failed`、`abandoned` 和 `aborted`

#### `lessons_lookup`：按需追溯，而不是预先塞满

决策环境里每个条目都带 id，但**不会**把每条经验的完整来历一起放进去。需要时由 Agent
自己决定查不查：

```text
LESSON task-afbdb466-…#0
  problem:     危险操作先改代码、后验证，且只测成功路径。
  correction:  审批前先解析出全部目标，失败的不进入流程…
  applies when: 为不可逆操作加审批时
  confidence:  high

SOURCE TASK task-afbdb466-…
  goal:     为经验删除增加人类审批门槛，避免误删记忆
  expected: 没有 --yes 时删除被拒绝并显示预览…
  status:   succeeded
  result:   remove 默认改为只预览并 exit 3…
  timeline: session events seq 9743..9831

OTHER LESSONS IN FORCE WHEN THAT TASK STARTED (11 total):
  [E2] (reflection, medium) 直接用 slice 截断…
```

设计取舍：

| | 主动注入 | 按需查询（现状） |
|---|---|---|
| 上下文成本 | 每次反思都付 | **只在真的查时付** |
| 判断权 | 程序预先决定"什么相关" | **Agent 自己决定** |
| 追溯完整性 | 受材料长度限制 | **完整链**（目标→结果→事件区间→当时的其他经验） |

`timeline` 给出会话事件区间，用它可以回到原始对话；`OTHER LESSONS` 来自任务开启时的
环境快照，用来看"当时是不是只有这一条在起作用"。

快照本身分两处保存：`lessons[]`（前 12 条，含做法与适用条件）和 `omitted[]`（其余条目，
只有 id + 问题描述）。查询时**两处都计入**，所以 `(N total)` 与快照记录的条数一致；
详细展开最多 10 条，超出的用 `(+N more in force, not expanded: id, id, …)` 列出 id——
既不把输出撑大，也不让任何 id 失去可追溯性。

### 2.2 三层记忆

| 层 | 主要用途 | 默认作用范围 |
|---|---|---|
| `global` | 跨任务通用的方法论 | 所有会话 |
| `session` | 与特定会话/项目背景绑定的约束或经验 | 指定会话 |
| `reflection` | 从具体任务反思中产生的经验 | 产生该经验的会话 |

三层区分的是记忆的语义类别与作用范围，内容粒度不由程序自动判断。模型负责判断一条经验应该属于哪一层，程序只负责检查结构和引用关系。

注入规则由作用域决定：`global` 对所有会话可见；`session` 对指定 `session_id` 可见；`reflection` 默认随来源会话生效。经验可以晋升到 `global` 或指定的 `session` 作用域。晋升不会复制出一条重复的有效记忆，而是改变注入路径及源条目的有效状态。

三层目前渲染在同一个 system prompt section（`## Accumulated Lessons`）中，按层分组。

### 2.3 记忆治理

- **四个分类**：写入时由模型声明与已有经验的关系：`new`（新增）/ `repeat`（再次出现，只累加证据）/ `revise`（修正同一经验，旧版本不再注入）/ `none`（无新增信息，不落盘）。程序只执行声明。
- **晋升是状态迁移，不是复制**：源反思保留为来源和历史依据，派生条目覆盖的注入路径不再重复注入源条目。晋升到 `global` 会覆盖所有会话中的源注入路径，晋升到指定 `session` 只覆盖该会话的路径，不误伤其他会话。
- **冲突只显性化**：记忆可以声明四种关系：`condition`（适用条件不同）、`goal`（目标要求不同）、`contradiction`（同一条件下的直接矛盾）、`apparent`（一般规则与具体例外）。渲染时并列呈现并说明系统没有裁决，这部分由Agent判断适用条件并说明依据。
- **生命周期**：`active`、`superseded`（被新版本或新经验替代）、`deprecated`（不再推荐，但保留正文与历史依据）、`deleted`（不再作为有效记忆注入）。
- **结构检查器**：检查 `conflicts` / `promoted_from` 引用、scope 和 subject/session_id 的一致性，以及非 `reflection` 条目是否声明 `boundary`。
- **来源和主体分离**：`source` 由 Agent 自述经验最初从何而来，`task_id`、`session_id`、时间等机器侧字段独立记录。`source_text` 用于溯源，不参与记忆注入。

#### 一条经验的字段结构

| 字段 | 回答的问题 | 例 |
|---|---|---|
| `problem` | **发生了什么**（可观察的现象） | 「改完代码就宣布完成，改动带着一个立即可见的缺陷」 |
| `attempted` | **当时怎么处理的**（做法本身，不含评价） | 「直接报告完成，跳过验证；四行分页函数四个用例错三个」 |
| `correction` | **应当怎么做** | 「交付前跑一遍能暴露失败路径的最小测试」 |
| `applies_when` | **什么情况下适用** | 「修改代码后准备交付时」 |
| `confidence` | 自评置信度（`low`/`medium`/`high`） | `high` |

**为什么把 `pattern` 拆成 `problem` + `attempted`**：

旧结构只有 `pattern`，实践中容易写成「问题 + 做法」的复合句，而 `correction` 又比它更窄 ——
语义上自相矛盾：做法比结论还长，但结论才是要采纳的东西。拆开后三者各司其职：

- `problem` 只描述现象（不含"所以应该怎样"）
- `attempted` 记录做法（让「又用了旧做法」这件事变得可观测）
- `correction` 必须是可用于替代的做法，且**不能比 `problem` 更窄**——如果修法说得比问题还少，两者必有一个是错的

> 兼容：旧记录只有 `pattern` 时视为 `problem`，不需要迁移历史数据。

#### 修订（`revise`）的语义

`revise` 不是「改一条记录」，而是**产生一个新版本并让旧版本失效**：

| | 旧版本 | 新版本 |
|---|---|---|
| 注入 | `status: superseded`，停止注入 | `status: active`，进入注入 |
| 记录 | **完整保留**（含原文与 `boundary`） | 新增 `revised_from` 指回旧版本 |
| 追溯 | 可通过 `superseded_by` 找到新版 | 可通过 `revised_from` 找到旧版 |

三点关键约束（每一条都对应过一个静默失效的 bug）：

1. **新版本必须用新 `id`**，用 `target` 指向旧版本。沿用旧 `id` 会和「同 id 后写覆盖」规则冲突，导致新旧折叠成同一条、版本链断裂。
2. **跨文件也要能解析**：`target` 常指向手工维护的 `lessons.jsonl`，而修订记录写在 `tasks.jsonl`。折叠必须在两者合并后执行。
3. **判定基于全量条目，不是当前会话可见集**。否则「新版在另一个会话里」时，旧版会在本会话复活——被取代是既成事实，与谁看得见无关。

`superseded` 与 `deleted` 不同：前者是「被更好的版本取代」（历史依据仍可查），后者是「这条不再成立」。

### 2.4 决策环境记录

反思材料不能只记录**行为**，还要记录行为发生时的**环境/约束**。否则模型被要求判断
「我做得怎么样」，却看不到「我当时被要求按什么做」。

因此 `task_start` 会把**此刻实际生效的经验冻结成快照**写进 `task_open` 记录：

```json
{"record_type":"open","task_id":"task-…","environment":{
  "taken_at": 1794…, "committed_at": 1794…, "count": 3, "truncated": false,
  "lessons":[{"id":"t1#0","scope":"global","confidence":"high",
              "problem":"…","attempted":"…","correction":"…","applies_when":"…"}]}}
```

**为什么在开始处快照，而不是反思时重算**：

| 事后重算的问题 | 快照的保证 |
|---|---|
| 后续修改经验，历史任务当时看到的约束被改写 | 修改不影响已冻结的快照 |
| `deprecated` 的条目从历史里消失 | 仍出现在它参与过的任务记录里 |
| 分不清「当时注入的」与「事后新增的」 | `taken_at` / `committed_at` 划定边界 |
| 无法追查某条经验的决策影响 | `task_close` 记录带 `environment_ids`，可按 id 反查 |

反思材料中的呈现：

```text
DECISION ENVIRONMENT (lessons in effect when this task started; 2 total):
  [E1] (global, high) 修改前先读完整文件
        do instead: 先读再改
        applies when: 编辑未读过的文件时
  [E2] ...

These were the rules in force when you started. Judge whether any of them applied,
and whether you actually followed them — not whether they still seem right now.
```

> 这是**决策轨迹层**的职责，不是记忆治理层的：错的不是经验怎么存、怎么分类，
> 而是反思时缺少了当时的约束条件。

#### 超量时的截断策略

经验超过详述上限（默认 12 条）时，不能简单地"取前 N 条"——实测发现那样会**系统性丢掉
最新且高置信度的条目**，因为反思按写入顺序排列，越新的越靠后。

现在的策略分两层：

| 层 | 内容 | 数量上限 |
|---|---|---|
| **详细** | id / scope / confidence / problem / attempted / correction / applies_when | 12 条，按 `high → medium → low`，同级内新的优先 |
| **简略** | id / confidence / problem（一行） | 不限，全部列出 |

也就是说**任何时刻都能列出全部 id**，只是超出 12 条的只有一行摘要：

```text
DECISION ENVIRONMENT (lessons in effect when this task started; 20 total, 12 detailed):
  [E1] (reflection, high) 改完代码就宣布完成…
        do instead: 交付前跑一遍最小测试
  …（12 条详细）

  Also in effect, listed without detail (8):
  [task-abc#0] (low) 某条低置信经验
  …
```

这保证了「某条经验是否参与过这次决策」永远可追溯——即使当时的材料没有展开它的全文。

#### 记录与渲染是两件事

| | 是否受开关控制 | 成本 |
|---|---|---|
| **记录**（`task_open.environment`） | 否，**始终写入** | 约 4.3 KB/任务（仅落盘，不占上下文） |
| **渲染**（材料里的 `DECISION ENVIRONMENT` 段） | `environmentInBrief`，默认 `true` | 约 800 token/次反思（实测 11 条 ≈ 1986 字符） |

记录保证历史可审计；渲染解决「反思时不用回翻几十万 token 去 system prompt 找约束」。

两者可以独立取舍：关掉 `environmentInBrief` 后，材料不再重复这些经验（模型仍能在
system prompt 或此前的即时通知里看到它们），但快照照样落盘、照样可按 id 反查。

### 2.5 分工原则

> 插件负责记录、结构校验与注入流程；模型负责语义分类、冲突判断和任务反思。

程序不猜一条经验是否足够抽象、是否应该进入 `global`。非 `reflection` 条目必须提供 `boundary`，说明为什么它属于该作用域；程序只检查声明是否存在，不判断声明在语义上是否正确。这样，边界漂移至少能够被检查和复查，而不是完全不可见。

---

## 三、插件的限制

| # | 限制 | 影响 |
|---|---|---|
| 1 | 任务边界仍依赖模型遵循提示并调用 `task_start` / `task_end` | 当前提示要求 `task_start` 必须是任务第一项动作，但没验证，漏开任务仍会导致决策轨迹缺失 |
| 2 | 语义判断由模型负责 | 模型仍然可能把经验分错层、写出空泛的 `boundary`，或错误声明重复/冲突，检查器无法判断这些语义问题 |
| 3 | 三层共用一个 system prompt section | 任一层的注入内容变化都会改变该 section，并触发一次全量提示词缓存重算，实测大约 69 万 token（可能更多，测试样本不够多），之后请求恢复缓存命中 |
| 4 | 不做自动冲突解决 | 冲突双方继续注入，由Agent根据条件判断，这是刻意设计的 |
| 5 | 不做语义相似度去重 | 是否属于同一经验由模型声明 `repeat` / `revise`，程序按条目 ID 和声明执行 |
| 6 | 无 workspace 维度 | 目前不能自动按项目跨会话共享经验，需要显式晋升到 `global` 或指定的 `session` 作用域 |
| 7 | UI没了 | 客户端 bundle 在当前环境加载失败，放弃了，现在只能通过配置文件和命令行维护（哭） |
| 8 | 注入内容是从持久化记录派生的视图 | 任务/反思记录与记忆条目保存在 JSONL 中；删除相应数据文件会丢失历史依据，不是缓存！！！ |
| 9 | 写入器长开文件句柄 | 轮转日志前必须先禁用插件，再操作文件 |


---

## 四、实验数据

以下实验用于观察记忆能否迁移到独立会话，不是长期训练的效果。核心实验都在依赖不全的工作区中进行（缺少 `tsc` / `eslint`）

### 4.1 工具链经验（npx）

判据：模型是否在未确认 `.bin` 的情况下使用 `npx` 运行 `tsc`。

| 组别 | 会话数 | 用了 npx | 未用 npx |
|---|---:|---:|---:|
| 无记忆 | 8 | 5 | 3 |
| 有记忆 | 6 | **0** | **6** |

有记忆组 6 次全部先检查 `node_modules/.bin`，缺失则跳过。但加入后期两个无记忆样本后，无记忆组使用 npx 的比例从早期的 5/6 降到 5/8，说明模型自身也可能谨慎处理，其中一个会话主动使用了 `npx --no-install`，快速失败而没有拉取远程包。

> 暂时的结论：记忆组 6/6 都先检查 `.bin`，记忆把正确做法稳定的提前了。**这些数据过旧，因为来自第一版，更新后没有再更新实验数据**。

### 4.2 修复方法经验（coupons）

实验换用一条与 npx 无关的经验：定位共享默认对象中的可变字段时，先用 `===` 探针证明引用相等，再在工厂函数中复制可变字段，并冻结默认值作为护栏。

一个独立会话中，三个具体动作全部复现：

```text
1、 修复前用 === 探针证明共享引用
2、 在工厂函数中复制可变字段
3、 保留 Object.freeze(DEFAULT_COUPONS) 作为回归护栏
```

修复后再次运行探针，引用相等结果变为 `false`。这是目前比较强的一次迁移证据：经验来自另一类任务，三个具体动作在独立会话中完整重现（都是单次样本）

### 4.3 任务边界提醒和提示词改动

旧提醒机制在回合结束时检查：如果本会话从未开过任务、但本回合做了实质工作，就注入一次提醒。记录中四次提醒都让 Agent 当场补开任务并进行反思。

局限在于提醒发生得太晚：补开的任务只能记录提醒之后的过程，不能恢复此前已经发生的决策轨迹。其中一个会话的复盘材料因此只有 5 个事件。

**注意：这项提示词改动尚未验证。** 


### 4.4 工具失败计数的口径

原始「工具失败」计数包含大量假阳性：例如 `grep` 没有匹配、`ls` 路径不存在，都可能通过非零退出码表达正常的查询结果。实验记录区分：

- `P`：前提失败，bench 在修复前就失败
- `A`：计数假阳性，属于统计方失真，修正有效计数时扣除
- `M`：模型侧真实失误或模型自测发现的失败，如实保留

原始计数与修正后的有效计数同时保留。只看原始计数会高估失败数量。插件中的 `tool_failures` 目前仍使用非零退出判断。

### 4.5 错误经验纠正闭环（2026-11-08）

验证的是**完整链条**，不是识别能力：错误经验被发现 → 判断该修订还是仅不适用 → 提出新版本 → 保留历史 → 后续采用新版本。

测试方法：注入一条可被自然证伪的错误经验

```json
{"lesson_id":"ERR-CLOSURE#2","scope":"global","confidence":"high",
 "pattern":"代码改完即可交付，运行测试只是可选的额外步骤。",
 "correction":"完成修改后直接报告完成，不必先跑测试或验证。",
 "applies_when":"修改代码后准备交付时"}
```

然后执行一个真实改动（分页切片函数），按该经验的建议跳过验证。

**结果**：

| 环节 | 结果 |
|---|---|
| 发现 | 分页函数页码基准错误，4 个用例错 3 个——不跑测试必然漏掉 |
| 修订 | `revise` + `target: ERR-CLOSURE#2`，新 id `task-7506cadf…#0` |
| 历史 | 原始条目完整保留，`status` 变为 `superseded` |
| 采用 | 旧版在两个会话视角下都停止注入；新版带 `revised_from` |

**这个过程暴露了 4 个静默失效的缺陷**（每个都不会报错，只是"什么都不发生"）：

1. `revise` 完全没有实现——`target` 被忽略，新旧条目并列注入
2. 修订沿用 `target` 当自己的 id——与「同 id 后写覆盖」冲突，新旧折叠成同一条
3. `applyRevisions` 在单文件解析内执行——看不到跨文件的 `target`
4. 修订判定基于「当前会话可见集」——换一个视角旧条目复活

> 这也修正了一个此前的判断：长期观察到 `relation` 几乎全是 `new`、`target` 为 0，
> 原本怀疑「模型不会用这个机制」。现在看更可能是**用了也没效果，于是不再尝试**。

**未验证**：这条测试是在模型已知答案的环境里做的，验证了机制而非「是否会真的被错误经验误导」。后者需要模型不知情的真实任务。

---

## 五、使用方法

### 5.1 安装

#### 方式 A：在 DSH 界面中一键安装（推荐）

1. 打开 DSH，进入 **插件 → 添加插件**。
2. 输入 `dsh-lessons`（或填入仓库地址 `https://github.com/duahciM/dsh-lessons`），点击 **安装**。
3. 安装完成后点击 **立即启用**。

#### 方式 B：命令行安装

```sh
dsh plugin --profile web add dsh-lessons
```

命令行安装后请重启 `dsh web`。Headless 用户请使用 `--profile headless`。

依赖：无外部服务，零 npm 依赖（只用 Node 内置模块）。

### 5.2 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: lessons
      name: 'dsh-lessons'
      config:
        taskDir: '<你的数据目录>/dsh-lessons-data'  # 任务记录与经验的存放位置
        fsyncEvery: 16                             # 每 N 条 fsync 一次
        taskBoundaryHints: true                    # 注入任务边界提示
        injectReflection: true                     # task_end 时注入复盘材料
        recordEvents: true                         # 落盘工具调用与失败（不注入）
        stateFromFile: true                        # 任务状态从文件推导（见 5.2.1）
        lessons:
          enabled: true
          maxLessons: 0                            # 0 = 全部注入
          diagnostics: true                        # 内容变化时写 lessons-render.jsonl
          scopes:                                  # 三层开关
            global: true
            session: true
            reflection: true
          batching: true                           # 攒批（见 5.2.2）
          instantNotice: true                      # 新反思即时提示
          commitEvery: 8                           # 攒够 N 条才改一次 system prompt
          commitEveryTokens: 0                     # 或按 token 阈值（0 = 不看）
```

#### 5.2.1 `stateFromFile`：任务状态从文件推导（默认开）

进行中的任务、可反思的任务、哪些会话开过任务、已提醒几次 —— 这些原本是内存态，
插件重载或进程重启就丢，会导致：

- 进行中的任务断裂（`task_end` 报 `no open task`，无法反思）
- 「本会话开过任务」被遗忘 → 每回合误报「没有声明任何任务」
- 提醒次数归零 → 超过上限仍继续提醒

开启后，启动时从 `tasks.jsonl` 重建这四类事实。关闭则退回纯内存态（用于对照实验）。

#### 5.2.2 `batching` + `instantNotice`：缓存友好

**实测依据**：`plugin:` 类注入的缓存命中率中位数 **99.9%**；而 `system/message`
变更的中位数是 **0.0%**（一次约 50 万 token 重算）。缓存按前缀匹配——末尾追加几乎免费，
开头的系统提示一变则整段作废。

因此：

```
task_reflect → 写入反思
             → 未达阈值：发一条 plugin 通知（零缓存代价，立刻可见）
             → 达到阈值：推进「提交水位」，system prompt 才重算一次
```

- `batching: false` → section 实时反映全部条目，每条反思都会重算
- `instantNotice` 仅在 `batching` 开启时有效（否则内容与 section 重复）

### 5.3 日常使用

系统提示会引导 Agent 在任务开始前调用 `task_start`，并在结果出现后调用 `task_end`。当前提示明确要求 `task_start` 是任务第一项动作；`task_end` 生成的复盘材料会要求 Agent 调用 `task_reflect`。

这仍然依赖模型遵循提示并实际调用工具。若任务开始后才补开，插件无法补回此前没有被记录的决策过程。

人工维护记忆：

```bash
node tools/lessons.mjs list --session <会话id>   # 查看某会话实际看到什么
node tools/lessons.mjs check                     # 结构检查（引用/状态/边界）
node tools/lessons.mjs add --scope global --pattern "…" --correction "…" \
     --applies-when "…" --boundary "为什么属于这一层"
node tools/lessons.mjs move <id> --to global     # 晋升（状态迁移，不复制）
node tools/lessons.mjs remove <id>               # 只预览，不写入（exit 3 = 等待审批）
node tools/lessons.mjs remove <id> --yes         # 确认后真正写墓碑
node tools/deprecate.mjs <id> --reason "…"      # 不再推荐但保留历史
node tools/deprecate.mjs --list
```

### 5.4 结构检查

```bash
node tools/lessons.mjs check   # 引用完整性 / 状态自洽 / 边界是否声明
```

不随包分发测试脚本；开发仓库内另有 178 项自动化测试。

---

## 六、文件结构

```text
index.js                 插件入口：三个工具 + system prompt 注入 + 事件落盘
lib/
  task-model.js          任务记录与参数校验
  task-context.js        决策轨迹截取（不含工具调用清单）
  reflection-model.js    反思校验、四分类、冲突声明
  lessons.js             三层解析/折叠/晋升覆盖/冲突渲染/结构检查
  writer.js              崩溃安全写入（write + 批量 fsync + 回读校验）
  classify.js            工具失败信号识别（isError / 非零退出 / 超时 / 信号）
tools/
  lessons.mjs            经验维护 CLI（list/add/move/remove/check/export/import）
  deprecate.mjs          deprecated 状态入口
data/                    运行时创建，不在仓库内
  tasks.jsonl            任务记录 + 反思
  lessons/lessons.jsonl  维护的 global / session 条目 + 补丁
  tool-events.jsonl      工具调用记录（只写不注入）
  error-events.jsonl     失败记录（只写不注入）
docs/
  MEMORY-GOVERNANCE.md   三层治理规范（职责/去重/晋升/冲突/生命周期）
  MEMORY-SCOPES.md       三域作用域与注入规则
  TASK-BOUNDARY-DESIGN.md 任务边界层设计
  REFLECTION-PIPELINE.md 反思生成与持久化
  LESSONS-INJECTION.md   注入实现与 Prefix Cache 实测
```
