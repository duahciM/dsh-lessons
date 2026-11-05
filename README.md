# DSH 元认知插件（metacog-task）

> 让 Agent 在任务结束后复盘，把可复用的经验沉淀下来，并在后续任务中按作用域注入。
>
> 版本 `0.2.1` · 运行环境 DeepSeek Harness `0.2.1-rc.5` · 单包安装

---

## 一、插件解决的问题

Agent 可能在不同任务中重复犯错。当前会话结束后，相关上下文不一定会保留；换一个会话，Agent 也未必能利用之前的经验。

单纯增加提示词只能提供静态规则，无法自然记录某次任务中实际出现的问题、修正方法，以及这些经验后来是否再次得到验证。

本插件尝试建立一个闭环：

```text
任务开始 → 决策轨迹 → 任务结束 → Agent 反思 → 结构化记忆
   ↑                                           │
   └──────────── 后续任务读取并应用经验 ────────┘
```

它试图回答的问题是：**一次任务中形成的经验，能否迁移到后续的独立任务？**

> 实验数据见第四节。当前证据表明，记忆能够把正确做法稳定地提前；但无记忆的 Agent 也可能自行采取正确做法，因此不能把记忆视为避免错误的唯一来源。

---

## 二、插件的机制

### 2.1 三个工具，界定并复盘一个任务

| 工具 | 作用 |
|---|---|
| `task_start(goal, expected_result)` | 声明任务目标与预期结果，建立任务记录 |
| `task_end(task_id, status, result)` | 声明任务结果，关闭任务并生成复盘材料 |
| `task_reflect(task_id, assessment, source, lessons[])` | 保存 Agent 对任务的反思与经验 |

`task_end` 会把任务时间窗内的材料整理成一份**决策轨迹**，主要包括用户请求与纠正、助手对外表述，以及在缺少对外表述时限量采集的推理摘录。它不收集完整工具调用清单；工具失败计数只作为辅助信号。

这里的反思对象是 Agent 的**工作决策**，而不是工具调用技巧。工具调用记录与任务决策轨迹分开处理。

任务状态包括 `succeeded`、`failed`、`abandoned` 和 `aborted`。任务是否结束，不等同于会话或 Agent 是否关闭。

### 2.2 三层记忆

| 层 | 主要用途 | 默认作用域 |
|---|---|---|
| `global` | 跨任务通用的方法论 | 所有会话 |
| `session` | 与特定会话/项目背景绑定的约束或经验 | 指定会话 |
| `reflection` | 从具体任务反思中产生的经验 | 产生该经验的会话 |

三层区分的是记忆的语义类别与作用域，不代表内容粒度由程序自动判断。模型负责判断一条经验应该属于哪一层；程序负责检查结构与引用关系。

注入规则由作用域决定：`global` 对所有会话可见；`session` 对指定 `session_id` 可见；`reflection` 默认随来源会话生效。经验可以晋升到 `global` 或指定的 `session` 作用域。晋升不会复制出一条重复的有效记忆，而是改变注入路径及源条目的有效状态。

三层目前渲染在同一个 system prompt section（`## Accumulated Lessons`）中，按层分组。

### 2.3 记忆治理

- **四分类**：写入时由模型声明与已有经验的关系：`new`（新增）/ `repeat`（再次出现，只累加证据）/ `revise`（修正同一经验，旧版本不再注入）/ `none`（无新增信息，不落盘）。程序执行声明，不自行判断语义相似度。
- **晋升是状态迁移，不是复制**：源反思保留为来源与历史依据；派生条目覆盖的注入路径不再重复注入源条目。晋升到 `global` 会覆盖所有会话中的源注入路径；晋升到指定 `session` 只覆盖该会话的路径，不误伤其他会话。
- **冲突只显性化，不裁决**：记忆可以声明四种关系：`condition`（适用条件不同）、`goal`（目标要求不同）、`contradiction`（同一条件下直接矛盾）、`apparent`（一般规则与具体例外）。渲染时并列呈现并说明系统没有裁决；由 Agent 判断适用条件并说明依据。系统不自动排序、择优或屏蔽冲突双方。
- **生命周期**：`active`、`superseded`（被新版本或新经验替代）、`deprecated`（不再推荐，但保留正文与历史依据）、`deleted`（墓碑，不再作为有效记忆注入）。
- **结构检查器**：检查 `conflicts` / `promoted_from` 引用、scope 与 subject/session_id 的一致性，以及非 `reflection` 条目是否声明 `boundary`。它不判断内容是否足够抽象，也不阻止语义上的错层写入。
- **来源与主体分离**：`source` 由 Agent 自述经验最初从何而来；`task_id`、`session_id`、时间等机器侧字段独立记录。`source_text` 用于溯源，不参与记忆注入。

### 2.4 分工原则

> 插件负责记录、结构校验与注入流程；模型负责语义分类、冲突判断和任务反思。

程序不猜一条经验是否足够抽象、是否应该进入 `global`。非 `reflection` 条目必须提供 `boundary`，说明为什么它属于该作用域；程序只检查声明是否存在，不判断声明在语义上是否正确。这样，边界漂移至少能够被检查和复查，而不是完全不可见。

---

## 三、插件的限制

| # | 限制 | 影响 |
|---|---|---|
| 1 | 任务边界仍依赖模型遵循提示并调用 `task_start` / `task_end` | 当前提示要求 `task_start` 必须是任务第一项动作，但这项提示改动尚未完成行为验证；漏开任务仍会导致决策轨迹缺失 |
| 2 | 语义判断由模型负责 | 模型仍可能把经验分错层、写出空泛的 `boundary`，或错误声明重复/冲突；结构检查器无法判断这些语义问题 |
| 3 | 三层共用一个 system prompt section | 任一层的注入内容变化都会改变该 section，并触发一次全量提示词缓存重算；实测约 69 万 token，之后请求恢复缓存命中 |
| 4 | 不做自动冲突解决 | 冲突双方继续注入，由 Agent 根据条件判断；这是刻意设计，不是遗漏的自动功能 |
| 5 | 不做语义相似度去重 | 是否属于同一经验由模型声明 `repeat` / `revise`；程序按条目 ID 和声明执行，不自行比较语义 |
| 6 | 无 workspace 维度 | 目前不能自动按项目跨会话共享经验；需要显式晋升到 `global` 或指定的 `session` 作用域 |
| 7 | 桌面设置页未提供 | 客户端 bundle 在当前环境加载失败，已放弃；通过配置文件和命令行维护 |
| 8 | 注入内容是从持久化记录派生的视图 | 任务/反思记录与记忆条目保存在 JSONL 中；删除相应数据文件会丢失历史依据，不应把它当作可随意清理的缓存 |
| 9 | 写入器长开文件句柄 | 轮转日志前必须先禁用插件，再操作文件 |

缓存测试是性能观察，不代表当前必须拆分 system prompt section。由于单次任务最多产生一次记忆变更，且尚未证明拆分能带来实际收益，目前保留单 section 设计。

---

## 四、实验数据

完整记录见仓库中的 `插件试验.txt`。以下实验用于观察记忆能否迁移到独立会话，不代表长期训练效果。核心实验都在依赖不全的工作区中进行（`node_modules/.bin` 缺少 `tsc` / `eslint`）。

### 4.1 工具链经验（npx）

判据：模型是否在未确认 `.bin` 的情况下使用 `npx` 运行 `tsc`。

| 组别 | 会话数 | 用了 npx | 未用 npx |
|---|---:|---:|---:|
| 无记忆 | 8 | 5 | 3 |
| 有记忆 | 6 | **0** | **6** |

有记忆组 6 次全部先检查 `node_modules/.bin`，缺失则跳过。但加入后期两个无记忆样本后，无记忆组使用 npx 的比例从早期的 5/6 降到 5/8：模型自身也可能谨慎处理，其中一个会话主动使用了 `npx --no-install`，快速失败而没有拉取远程包。

> 可保留的结论：记忆组 6/6 都先检查 `.bin`，记忆把正确做法稳定地提前了。
>
> 不能成立的结论：没有记忆就必然会误用 npx。

### 4.2 修复方法经验（coupons）

实验换用一条与 npx 无关的经验：定位共享默认对象中的可变字段时，先用 `===` 探针证明引用相等，再在工厂函数中复制可变字段，并冻结默认值作为护栏。

一个独立会话中，三个具体动作全部复现：

```text
① 修复前用 === 探针证明共享引用
② 在工厂函数中复制可变字段
③ 保留 Object.freeze(DEFAULT_COUPONS) 作为回归护栏
```

修复后再次运行探针，引用相等结果变为 `false`。这是目前较强的一次迁移证据：经验来自另一类任务，三个具体动作在独立会话中完整重现。但它仍是单次样本，不能据此推断稳定成功率。

### 4.3 任务边界提醒与提示词改动

旧提醒机制在回合结束时检查：如果本会话从未开过任务、但本回合做了实质工作，就注入一次提醒。记录中四次提醒都让 Agent 当场补开任务并进行反思。

局限在于提醒发生得太晚：补开的任务只能记录提醒之后的过程，不能恢复此前已经发生的决策轨迹。一个会话的复盘材料因此只有 5 个事件。

2026-11-04，系统提示中的任务边界段改为强制措辞：要求 `task_start` 必须是任务第一项动作，先于读文件、运行命令、搜索或编辑；任务结果出现后调用 `task_end`，无论成功与否。

**这项提示词改动尚待行为验证。** 改动前后的实验条件不同，不能把新旧样本直接合并统计。

### 4.4 工具失败计数的口径

原始「工具失败」计数包含大量假阳性：例如 `grep` 没有匹配、`ls` 路径不存在，都可能通过非零退出码表达正常的查询结果。实验记录区分：

- `P`：前提失败，bench 在修复前就失败；
- `A`：计数假阳性，属于统计方失真，修正有效计数时扣除；
- `M`：模型侧真实失误或模型自测发现的失败，如实保留。

原始计数与修正后的有效计数同时保留。只看原始计数会高估失败数量。插件中的 `tool_failures` 目前仍使用非零退出判断，因此它只作为反思辅助信号，不作为本实验的主指标。

### 4.5 当前验证状态

- 三层治理、晋升、冲突呈现、生命周期与结构检查已实现。
- 历史非 `reflection` 记忆的 `boundary` 已补齐；当前检查结果中仍保留一条真实的 `dangling-promotion` 警告，不伪造缺失来源。
- 四组测试共 **157 项通过**：任务边界与轨迹 53 项、记忆治理 72 项、反思模型 24 项、结构检查 8 项。
- 尚待验证：强制 `task_start` 提示词能否减少事后补开；依赖齐全环境中是否会错误套用 npx 经验。

---

## 五、使用方法

### 5.1 安装

```bash
# 在 DSH 中安装（target 指向包目录）
plugin_manager install_bundle target=<本目录绝对路径>
```

依赖：无外部服务。可选的 `webServer` 用于只读数据接口，缺失时自动跳过。

### 5.2 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: metacog-task
      name: '@local/dsh-metacog-task'
      config:
        taskDir: 'D:/LLM/metacog-task/data'   # 记忆与任务记录位置
        taskBoundaryHints: true                # 注入任务边界提示
        injectReflection: true                 # task_end 时注入复盘材料
        lessons:
          enabled: true
          maxLessons: 0                        # 0 = 全部注入
          scopes:                              # 三层开关，可用于对照实验
            global: true
            session: true
            reflection: true
```

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
node tools/lessons.mjs remove <id>               # 墓碑删除
node tools/deprecate.mjs <id> --reason "…"      # 不再推荐但保留历史
node tools/deprecate.mjs --list
```

### 5.4 运行测试

```bash
node selftest.mjs              # 53 项：任务边界与轨迹
node selftest-lessons.mjs      # 72 项：分域、晋升、去重、冲突
node selftest-reflection.mjs   # 24 项：反思模型
node selftest-structure.mjs    #  8 项：结构检查器
node preflight.mjs             # 安装前 schema 预检
```

共 **157 项**（不含安装前预检的独立结果）。

---

## 六、文件结构

```text
index.js                 插件入口：三个工具 + system prompt 注入 + 提醒
lib/
  task-model.js          任务记录与参数校验
  task-context.js        决策轨迹截取（不含工具调用清单）
  reflection-model.js    反思校验、四分类、冲突声明
  lessons.js             三层解析/折叠/晋升覆盖/冲突渲染/结构检查
  writer.js              崩溃安全写入（write + 批量 fsync + 回读校验）
tools/
  lessons.mjs            记忆维护 CLI（list/add/move/remove/check/export/import）
  deprecate.mjs          deprecated 状态入口
  cache-probe.mjs        分层缓存测试工具
data/
  tasks.jsonl            任务记录 + 反思
  lessons/lessons.jsonl  人工维护的 global / session 条目 + 补丁
docs/
  MEMORY-GOVERNANCE.md   三层治理规范（职责/去重/晋升/冲突/生命周期）
  MEMORY-SCOPES.md       三域作用域与注入规则
  TASK-BOUNDARY-DESIGN.md 任务边界层设计
  REFLECTION-PIPELINE.md 反思生成与持久化
  LESSONS-INJECTION.md   注入实现与 Prefix Cache 实测
```

---

## 七、历史阶段

| 阶段 | 包 | 状态 |
|---|---|---|
| 运行时探针 | `metacog-probe` | 已完成，**已禁用**（只用于验证事件可用性） |
| 事件持久化 | `metacog-store` | 已完成，**已禁用**（工具计数注入与现行原则冲突） |
| 任务边界 + 记忆 | `metacog-task` | **当前交付物** |

前两个是研究阶段的产物，不参与当前运行。若要做工具层统计，可单独启用 `metacog-store`，但它的每轮工具计数注入会成为实验的混淆变量。
