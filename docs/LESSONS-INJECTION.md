# 经验的注入与验证（步骤 3）

> 本文第二节把「Hindsight 保留语义检索能力」列为前提，现该前提已不成立 ——
> `tasks.jsonl` 是唯一来源。其余结论（注入实现、6 项验收、Prefix Cache 实测）不受影响。
>
> 三个小目标：**确定记忆来源 → 注入 system prompt → 验证注入行为**，外加一项性能验证（Prefix Cache）。
>
> 状态：四项全部完成，6/6 验收通过，Prefix Cache 已实测。

---

## 一、结论

| 目标 | 状态 | 关键证据 |
|---|---|---|
| 3.1 记忆来源 = `tasks.jsonl` | ✅ | 全量读取，重启后仍可读 |
| 3.2 注入 `systemPrompt.section` | ✅ | 独立段落 `## Accumulated Lessons` |
| 3.3 验证注入行为 | ✅ | 6/6 场景通过 |
| Prefix Cache 影响 | ✅ 已实测 | **每次内容变更 = 一次全量重算** |
| 变更能否及时生效 | ✅ | 下一次请求即生效 |

---

## 二、记忆来源：为什么读 tasks.jsonl

按你的判断，不调用语义 recall：

| 理由 | 说明 |
|---|---|
| 反思已持久化在本地 | `record_type: "reflection"` 记录完整 |
| 不需要语义召回 | 避免「检索不到就漏注入」 |
| 不需要全量枚举 Hindsight | 那需要额外接口 |
| 字段现成 | `pattern` / `correction` / `applies_when` / `confidence` |

Hindsight 继续保存任务事实与 lesson，**保留语义检索能力**，等真需要标签筛选时再用。

### 2.1 读取语义

```
tasks.jsonl 逐行解析
  ├─ 只取 record_type === "reflection"
  ├─ 坏行跳过（一行脏数据不毁掉整段注入）
  ├─ 身份 = lesson_id（缺失时回退 `<task_id>#<序号>`）
  ├─ 修改 = 同 lesson_id 的后写记录覆盖先写（last-wins）
  └─ 删除 = 后写记录带 deleted: true（墓碑）
```

**为什么需要墓碑**：JSONL 是追加写。要支持「删除一条反思」而不重写整个文件，只能追加一条声明删除的记录。

### 2.2 缓存

按 `mtimeMs:size` 失效。每个 step 都会调用渲染函数（实测 `renders` 计数一路涨到 45+），命中缓存时零解析开销。

---

## 三、注入实现

### 3.1 契约（源码核对）

```js
// dsh-system-prompt/lib/index.js:253
section({ name, order, text, interpolate })
```

关键发现：**`text` 可以是函数**（`:388`）：

```js
text: typeof section.text === "function" ? section.text(context) : section.text
```

`context` 由 Agent 循环构造（`dsh-agent/lib/index.js:291`）：

```js
{ agent, scope: agent, signal? }
```

所以每步装配时都会用当时的记忆重新求值 —— 这正是「动态注入」需要的。

### 3.2 注册

```js
systemPrompt.section({
  name: "metacog:accumulated-lessons",
  order: 10500,        // 排在所有既有段落之后
  interpolate: false,  // 教训文本里的 ${...} 不当模板处理
  text: renderSectionText,  // 函数：每次装配读盘（走 mtime 缓存）
});
```

`order` 选 10500：现有最大是 `DEPLOYMENT_PERSONA_SUFFIX: 10200`。

> **placement 的用意**：把易变内容放在最后，理论上能让它前面的前缀保持稳定。
> **实测结论见第五节 —— 这个做法在本次 provider 上没能只失效尾部。**

### 3.3 空值处理

没有 lesson 时渲染函数返回 `""`，框架在拼装时过滤空段（`filter(text => text.length > 0)`），因此**不会产生空白区块**。

### 3.4 渲染格式

```
## Accumulated Lessons

The following lessons were recorded after earlier tasks.
Judge whether each one applies to the situation in front of you; do not apply them mechanically.

[Lesson 1]
Pattern: 整个任务窗口内只发出工具调用、没有任何对外结论…
Correction: 在关键节点（选定方案、遇到阻碍、改变方向）先用一句话写下判断和理由…
Applies when: 一个任务预计要跨多个步骤或多次工具调用时
Confidence: high

[Lesson 2]
...
```

按你的模板；`Confidence` 保留，供后续筛选用（本阶段不筛）。

---

## 四、6 项验收

全部在真实运行时完成，证据来自 `data/lessons-render.jsonl`（每次**内容变化**时记一条）：

```
时刻       lessons  chars  renders
03:30:41   1        359    1      ← 首次注入
03:36:25   2        500    15     ← ① 写入一条
03:36:52   5        812    21     ← ② 写入多条（3 条）
03:37:19   5        825    27     ← ③ 修改一条（字符数变化，条数不变）
03:37:38   4        724    33     ← ④ 删除一条（5→4）
03:38:06   4        724    1      ← ⑤ 重启插件（计数器归零，条数不变）
03:38:27   0        0      1      ← ⑥ 无反思记录（渲染空串）
03:38:55   4        724    1      ← 恢复
```

| # | 测试 | 结果 | 判据 |
|---|---|---|---|
| ① | 写入一条 | ✅ | 1→2，hash 变化 |
| ② | 写入多条 | ✅ | 2→5，5 条 id 全在 |
| ③ | 修改一条 | ✅ | 条数仍 5，字符 812→825，旧文案消失 |
| ④ | 删除一条 | ✅ | 5→4，被删的消失，其余完好 |
| ⑤ | 重启插件 | ✅ | `renders` 归零（新进程）但 lessons=4（数据仍在） |
| ⑥ | 无反思记录 | ✅ | lessons=0，chars=0（空串被过滤） |

> ③④ 是直接向文件追加记录来模拟的 —— 因为没有「修改反思」的工具接口。
> 这也验证了「文件即真相」：任何外部写入都会被 mtime 检出。

---

## 五、Prefix Cache 实测

### 5.1 方法

会话日志的 `assistant/message.data.usage` 带 `cacheReadTokens` 与 `inputTokens`：

```
命中率 = cacheReadTokens / (cacheReadTokens + inputTokens)
```

### 5.2 基线（无任何变更）

连续 9 次请求：

```
99.7% 99.4% 99.0% 99.4% 99.4% 99.9% 100.0% 99.9% 99.9%
未命中：0 / 9
```

缓存稳定可用，没有路由抖动。

### 5.3 受控实验（只改一条 lesson）

```
03:43:45  99.9%   uncached=177     cached=274816
03:43:51  99.7%   uncached=743     cached=274944
03:44:08   0.0%   uncached=276181  cached=0        ← 改动后的第一次请求
03:44:13  99.9%   uncached=174     cached=276096   ← 立刻恢复
```

### 5.4 结论

| 问题 | 答案 |
|---|---|
| 动态 section 是否影响 Prefix Cache | **是** |
| 影响范围 | **整段提示词**（`cached=0`），不是只有尾部 |
| 代价 | 一次全量重算，当前约 **27.6 万 token** |
| 是否持续 | **否**，下一次请求即恢复 99.9% |
| 变更是否及时生效 | **是**，下一次请求就带上了新内容 |

**「整段失效」说明了什么**

我把 section 放在最后（order 10500），本以为只会失效尾部。实测 `cached=0`，说明该 provider 的缓存并非「逐 token 前缀匹配到变更点」，更像是**按整段系统提示（或请求哈希）归组**：系统提示一变，整条请求的缓存全部作废。

这是观测结论，不是对 provider 实现的断言 —— 但从工程决策看，结论一样：**placement 换不来局部失效**。

### 5.5 工程建议

| 建议 | 理由 |
|---|---|
| 只在任务边界更新 lessons | 一个任务本来就伴随大量 token，一次全量重算可摊薄 |
| 不要在每个 step 追写 lesson | 每次变更都是 27 万 token 的重算 |
| **不要**为了省缓存而放弃注入 | 一次重算 ≈ 一次任务本身的成本，而记忆是长期收益 |
| 若将来记忆条目暴增 | 那时再引入「变更攒批」：只在 turn 边界提交 section 版本 |

> 当前实现每个任务最多产生一次 lesson 变更 → **每任务一次全量重算**，可接受。

---

## 六、限制

| # | 限制 | 说明 |
|---|---|---|
| **I1** | 所有 lesson 全量注入 | 按本阶段要求不做筛选；条目增多会推高每步 token 成本（当前 2 条约 200 token） |
| **I2** | 无去重/归并 | 同一类教训在不同任务重复出现会有多份 |
| **I3** | 变更即全量重算 | 见第五节 |
| **I4** | 修改/删除只能靠追加记录 | 没有工具接口，需要手工写 JSONL 或日后补工具 |
| **I5** | 无条件信任 lesson 内容 | 错误反思会被注入，`assessment` 字段目前仅存不用 |

> 当前生效 2 条（测试用占位 lesson 已用墓碑清除）。

---

## 七、下一步（步骤 4）

要验证的是**行为是否改变**，不是注入是否存在。建议对照设计：

| 组 | 条件 |
|---|---|
| A（有记忆） | 正常注入 `metacog:accumulated-lessons` |
| B（无记忆） | `lessons.enabled: false` |

同一类任务各跑 N 次，观察：
- 是否重复犯同一条 lesson 描述的错
- 是否出现**错误泛化**（把不适用的 lesson 套用上去）
- 是否被无关 lesson 干扰

**基线成本要算进去**：每切一次组，section 内容变化 = 一次全量重算。

---

## 八、缓存友好改造：攒批 + 即时通知

### 8.1 动机

第五节已实测：**任何 `system/message` 变更都会清空缓存**（8/8 样本命中率 ≤0.7%，多数 `cached=0`）。
而 lessons 段每次内容变化都会触发一次 `system/message` 重写 —— 于是每条反思都等于一次全量重算。

### 8.2 补充实测：哪些变化不吃缓存

用 `cache-probe/controlled.mjs` 对会话日志做**单一触发归因**（排除混杂样本）：

| 触发类型 | 样本 | 均值 | 中位数 | 最低 |
|---|---:|---:|---:|---:|
| plugin（插件注入） | 22 | 99.9% | 99.9% | 99.6% |
| user | 5 | 99.1% | 99.9% | 96.2% |
| tools（工具结果） | 948 | 99.4% | 99.9% | 0.1% |
| developer | 21 | 62.1% | 98.9% | 0.0% |
| **system** | **8** | **0.1%** | **0.0%** | **0.0%** |

结论：**缓存是前缀匹配，不是整条请求哈希。**
末尾追加（plugin / user / tools）几乎零代价；开头的 `system/message` 一变，整段作废。

> 一次 plugin 注入实测：`cached=499456 / uncached=358`（99.9%）。
> 作为对照，一次 system 变更的 `uncached` 约 50 万。**比值约 1400:1。**

### 8.3 机制

```
task_reflect
  ├─ 写入 reflection 记录（recorded_at = 现在）
  ├─ 与水位的差 = pending
  ├─ 未达阈值 → 发一条 plugin 通知（零缓存代价，agent 立刻看到）
  └─ 达到阈值 → 追加 commit 记录推进水位
                    ↓
              下一次装配才重算 section（一次全量）
```

**水位**（`record_type: "commit"`，记 `committed_at`）：

- 只有 `recorded_at <= committed_at` 的反思进入 system prompt
- 没有 commit 记录时水位为 `Infinity`（向后兼容：既有安装行为不变）
- 首次启用攒批会写一条 `reason: "seed"` 的记录，把「此刻之前已有的反思」固定为已提交
- pending 由**文件推导**（`recorded_at > committed_at`），不依赖内存 → 重启不丢

### 8.4 配置

```yaml
lessons:
  batching: true          # 攒批总开关；关闭则 section 实时反映全部条目
  instantNotice: true     # 即时通知；仅在 batching 开启时有效
  commitEvery: 8          # 待提交条数阈值
  commitEveryTokens: 0    # 待提交 token 阈值（0 = 不按 token 判断）
```

四种组合的实测行为：

| batching | instantNotice | 行为 |
|---|---|---|
| false | — | 不写 seed、不发通知、section 实时（每条反思都会重算） |
| true | false | 写 seed、不发通知、未达阈值不进 section |
| true | true | 写 seed、逐条即时通知、未达阈值不进 section（**默认**） |
| true 但阈值为 0 | — | 等同关闭攒批（没有提交点） |

### 8.5 验收

离线 + 集成共 **59 个用例**通过（`D:/LLM/cache-probe/`）：

- `test-batching.mjs`（29）水位解析、pending 推导、阈值判定、通知渲染、commit 记录不污染条目
- `test-integration.mjs`（15）真实 `apply()`：seed → 即时通知 → 未提交不进 section → 攒满提交 → section 更新 → 新反思重新 pending
- `test-toggles.mjs`（15）四种开关组合

真实运行时（阈值临时设为 1）：

```
task_reflect → <lessons_committed count="2" reason="count>=1">
诊断        → {"kind":"commit","count":2}
section     → 1 条 → 3 条（global:1, reflection:2）
```

### 8.6 已知限制

| # | 限制 |
|---|---|
| 1 | 即时通知只在 `task_reflect` 后被触发；若模型不调用 `task_reflect`，反思链断裂 |
| 2 | 通知内容会进入对话历史，`deprecated` 的旧通知无法撤回（与 system prompt 不同） |
| 3 | 水位按时间戳比较；同一毫秒内写入的反思会被归入同一侧 |
| 4 | 提交后 section 变化仍会触发一次全量重算 —— 攒批只是把频率从「每条」降到「每 N 条」 |

---

## 附录：文件

| 文件 | 作用 |
|---|---|
| `lib/lessons.js` | 解析、身份/墓碑、mtime 缓存、水位过滤、渲染 |
| `lib/instant-notice.js` | 即时通知渲染、攒批阈值判定 |
| `index.js` | `systemPrompt.section` 注册 + 攒批 + 诊断 |

