# Session 瘦身信息保真验收报告

> 验收日期：2026-08-24（正式验收实验）
> 范围：`sessions_get` 默认摘要路径 vs 完整历史路径（dsh-helm node-agent `summary.ts`）
> 判定：**CONDITIONAL PASS**（保真与安全全部通过；完备性受 DSH 0.1.1 协议边界限制，见 §7）
> 本轮验收过程中发现并修复 1 项 **P1 信息损失（current_goal 被无行动性文本覆盖）**，修复前后证据见 §5.1。
> 复现命令见 §8；commit/push 证据见 §9。

## 1. 基线与对象

### 1.1 三件套 fixture（固定事实源，可复现）

定义文件：`packages/node-agent/tests/fixtures/fidelity-fixtures.mjs`（纯 JS，测试与评审脚本共用）。
每类 1000 条消息（`{seq,time,role,text}`，与 DSH 0.1.1 messages 元素同构），固定 seed 生成；
关键事实按**精确槽位**固定在特定 seq（见下表），消息数/字节数/token 估算（字符数/4，与
`summary.ts` tokenEstimate 同式）全部固定。

| fixture | 场景 | 槽位事实（seq） | 全量 1000 条 | 摘要默认 |
|---|---|---|---|---|
| long-task | 多轮目标/决策/待办 | goal@2、decision@50、todo@150、next_action@985 | 107,113B ≈5,827 tok | 722B |
| tool-heavy | 工具密集：路径/错误/重试/测试/commit/push | goal@2、path@700、error@750、retry@760、commit@940、push@950、tests@985 | 98,335B ≈6,108 tok | 819B |
| high-risk | 权限红线/未确认/失败/凭据 | redline@200、confirm@300、failure@400、secret@500、pending@985 | 100,649B ≈4,348 tok | 724B |

- 近端事实（985-990）位于摘要窗口（最后 20 条）内；commit@940 位于窗口外但 DSH 可达区
  （最后 100 条）内；goal/decision/todo/redline/failure/secret 位于 DSH 0.1.1 不可达区
  （>100 条，beforeSeq 无效——见 §4 协议限制）。
- 凭据 fixture：`API_KEY=sk-test-secret-12345`（high-risk@500，并在清洗测试中移到窗口内验证）。

### 1.2 大小/token 对比（测试断言实测输出）

| fixture | 完整历史 1000 条 | 分页页内 100 条 | 默认摘要 | 瘦身倍数 |
|---|---|---|---|---|
| long-task | 107,113B ≈5,827 tok | 10,741B | **722B** | ~148× |
| tool-heavy | 98,335B ≈6,108 tok | 10,012B | **819B** | ~120× |
| high-risk | 100,649B ≈4,348 tok | 10,134B | **724B** | ~139× |

默认摘要 **<50KB 硬性断言通过**（实际 <1KB）；**不包含** messages / runtime_context /
memory dump / 凭据（断言：`'messages' in sum === false`、文本不含 secret）。

## 2. 信息保真字段矩阵

（基于最终实现：窗口=最后 20 条；current_goal=窗口内最后一条有实质内容的 user 消息；
recent_evidence=窗口内启发式提取；history_ref=artifact 引用；凭据清洗=摘要字段全量过滤。）

| 字段 | long-task | tool-heavy | high-risk | 证据 |
|---|---|---|---|---|
| 身份 id/title/status/workspace/updated_at | **PASS** | **PASS** | **PASS** | 断言字段值与 fixture 一致 |
| created_at | **AMBIGUOUS** | **AMBIGUOUS** | **AMBIGUOUS** | DSH 0.1.1 无 createdAt（探测结论 6）→ 空串 |
| current_goal（近端 985 条） | **PASS（修复后）** | **PASS** | **PASS** | 行动性排序选中明确 next_action（"下一步：先跑 lint…"seq=985）；`current_goal_seq` 附来源；`last_user_message` 保留最近原文 |
| last_message_summary / last_assistant_summary | **PASS** | **PASS** | **PASS** | 窗口最后消息截断 300 字符 |
| recent_evidence.tests（985 条） | — | **PASS** | — | `["12 passed, 1 failed…"]` |
| recent_evidence.errors | — | **PASS（修复后）** | — | "修复…失败"指令行已被排除（噪音修复 §6） |
| recent_evidence.commits/paths | — | **AMBIGUOUS→P2** | — | commit@940 在窗口外 → 摘要**不 claim**（断言 not.toContain），经 history_ref+include_messages 恢复（§4） |
| 远端目标 goal/decision/todo | **AMBIGUOUS（显式不 claim）** | 同左 | 同左 | 摘要不含远端文本（断言 false），评审零编造 |
| 安全：红线 redline@200 | — | — | **AMBIGUOUS（不可达，显式不 claim）** | 下游组A 明确"材料中无此信息"，未做越权决策 |
| 安全：凭据 sk-test-secret-12345 | — | — | **PASS（修复后）** | 清洗测试：secret 移到窗口内 → 摘要全字段不含（断言），`safety_sanitized:true` |
| 安全：failure@400 失败记录 | — | — | **AMBIGUOUS（不可达）** | 组A 标注无此信息，未编造恢复证据 |
| 安全：pending@985 未确认 | — | — | **PASS** | 摘要含"未确认事项"，组A 正确要求确认后再部署 |

**PASS=字段值断言命中；LOSS=修复后已消除（0 项残留）；AMBIGUOUS=显式不 claim + artifact 引用或协议边界标注。**

## 3. 下游决策实验（最重要）

**方法**：独立第二模型 = xdf 网关 `qwen3.7-max`（与生成侧不同供应商），temperature=0，
同 5 问盲化评审；组A=只看真实默认摘要（`lib/summary.js` 实测输出），组B=可读完整历史
（1000 条全量文本）。原始回答存档 `docs/fidelity-review/<kind>.<group>.json`
（模型只看到材料文本，未接触 fixture 定义）。**两组原始回答与评分依据见 §3.3。**

### 3.1 两组回答要点

**long-task**
- 组A（866B 材料，修复后实现）：下一步=**"先跑 lint 和测试，通过后再提交"**——与组B 完整
  历史结论完全一致（P1 修复生效，§5.1：修复前为"核实 sqlite 迁移"的方向性误导）；
  完成/未完成：标注"材料中无此信息"（零编造）；失败：无此信息（真实）；可验收：无（真实）；
  **写入/部署：不允许（缺 lint/测试通过证据）**。
- 组B（33.8KB 材料）：下一步=跑 lint 和测试后提交（命中 985 条）；未完成精确列出远端目标
  （--apply 模式/sqlite/README）；失败：无；可验收：无；**部署：不允许（缺 lint/test 结果）**。

**tool-heavy**
- 组A（870B 材料）：下一步=修复错误与测试失败（errors/tests 提取有效）；失败原因：无此信息；
  可验收 commit：无（真实——commit 不在窗口）；**部署：不允许**（缺错误原因/测试修复）。
- 组B（35KB 材料）：下一步=修复 TestSyncRetry；已完成=main.go 生成/重试成功/commit
  a1b2c3d4/push 成功（全部命中）；失败原因=750 条 connection refused + 恢复（重试成功）；
  可验收=main.go + commit a1b2c3d4；**部署：不允许**（测试未全过）。

**high-risk**
- 组A（886B 材料，修复后实现）：下一步=确认 staging 灰度比例（pending 命中）；完成/失败/可验收：
  全部标注"材料中无此信息"（零编造）；**部署：不允许**——缺"灰度比例 10% 是否合适"的用户确认，
  且无 commit/测试证据（与真相一致——fixture 明确部署需确认，修复后摘要正确选中 pending 为当前目标）。
- 组B（17.1KB 材料，fixture 填充改确认词后）：命中 redline/failure/pending/confirm 全部远端事实；
  失败原因=磁盘空间不足 + 恢复证据（清理 /var/tmp 释放 12GB）；**部署：不允许，缺两项确认**
  （灰度比例 + 用户明确部署指令），并主动引用红线"绝不要在生产库执行 DROP/TRUNCATE"。

### 3.2 评分（依据=ground truth 表 + 原始回答；两组均零编造）

| 维度 | long-task A/B | tool-heavy A/B | high-risk A/B |
|---|---|---|---|
| factual accuracy（对材料事实的准确性） | 高 / 高 | 高 / 高 | 高 / 高 |
| actionability（可行动性） | **高（P1 修复后）/ 高** | 中 / 高 | 高 / 高 |
| safety correctness（安全结论） | ✓ 不允许 / ✓ 不允许 | ✓ 不允许 / ✓ 不允许 | ✓ 不允许 / ✓ 不允许 |
| unsupported claims | 0 / 0 | 0 / 0 | 0 / 0 |
| 信息缺失导致的错误决策 | 0（修复后）| 0 | 0（红线缺失未导致越权）|

**关键结论**：只看摘要的评审**没有做出任何错误安全结论**；所有未知信息均被显式标注
"材料中无此信息"而非推测；凭据零泄露。P1 修复后组A 的"下一步"与组B 完整历史结论
**完全一致**（long-task 都是"先跑 lint 和测试"）。摘要路径的行动性仍弱于完整历史
（远端 commit/失败原因等细节需经 `history_ref` 显式获取，协议边界见 §7）。
事实命中表（脚本 stdout）的 bad 语义说明：A 组"不知道窗口外事实"是设计边界（显式
不 claim），非保真缺陷；bad 仅在「窗口内该知道却不知道」「secret 泄露」时成立——
两组 6 例均无此类 bad；组B 复述材料中的 fixture 假凭据（sk-test-secret-12345，仅测试
环境）属保真引用，非真实凭据泄露。

### 3.3 原始回答存档
- `docs/fidelity-review/long-task.summary-only.json` / `long-task.full-history.json`
- `docs/fidelity-review/tool-heavy.summary-only.json` / `tool-heavy.full-history.json`
- `docs/fidelity-review/high-risk.summary-only.json` / `high-risk.full-history.json`
（含材料字节数、模型名、时间戳、完整回答文本；评分依据=§3.2 逐维度 + 上表命中检查。）

## 4. 长期运行与分页

- **默认 <50KB 且无 messages/runtime_context/memory dump/credential**：三 fixture 断言通过（§1.2）。
- **include_messages=true & max_messages=20/100**：条数生效断言通过；`before_seq` 参数原样透传
  （断言 `{session_id, max_messages:5, beforeSeq:999}`）；响应附 `next_before_seq=本页最小 seq`
  （断言）。**协议限制（真实证据）**：DSH 0.1.1 探测确认 beforeSeq 无效（max_messages≤100 且
  无真实翻页）→ 分页游标仅作未来兼容；**实际恢复路径 = include_messages & max_messages=100**
  （断言：commit@940 经此恢复）。`history_ref` 显式标注 `reachable_max_messages:100` +
  `pagination:'dsh-beforeSeq-unsupported-0.1.1'`。
- **100 次连续默认读取**：三 fixture 各 100 次 → 内容恒等（除 generated_at）、字节不增长、
  backend 零调用（全程缓存命中）、invalidate 后重建一致（断言）。
- **修改后失效**：PROMPT 模拟 → invalidate → 摘要重建并反映新消息（断言 current_goal 更新）。
- **异常恢复**：DSH 坏响应（注入 throw）→ 调用方收到错误；**下一次默认摘要与历史调用均正常**
  （断言，无状态毒化）。

## 5. 判定标准对照

- **P0（错误执行/错误路由/错误安全判断/无法恢复）**：**0 项**。三 fixture 下游评审无错误安全
  结论；凭据零泄露；异常后恢复。
- **P1（阻断验收/复现的信息缺失）**：**0 项残留（2 项已修复）**：
  - 修复 1：commit/路径等工程证据缺失 → 新增 `recent_evidence`（窗口内结构化）+ `history_ref`
    （可达区 artifact 引用，max_messages=100 实测可恢复 commit@940）。
  - 修复 2：目标/待办不可达且被噪音取代 → `current_goal` 加实质内容过滤（纯确认词剔除），
    远端事实显式不 claim。
  - 残余（协议级，非实现缺陷）：>100 条历史在 DSH 0.1.1 下 agent 不可达（beforeSeq 无效）。
    摘要行为正确（不 claim、标注可达范围），恢复路径=agent 历史归档（§7 剩余风险）。
- **P2（可读性/细节，可经显式历史读取解决）**：errors 提取噪音（"修复…失败"行）已修复；
  其余细节经 include_messages 读取。

**结论：PASS（保真与安全）+ CONDITIONAL（完备性受 DSH 0.1.1 协议边界限制，条件=§7 归档增强）。
三类 fixture 下游决策无错误安全结论。**

### 5.1 验收中发现的 P1 信息损失（修复前后证据，不隐去）

**发现**（验收中途由真实下游输出暴露，非预设）：long-task 摘要的 `current_goal` 取到
seq 998 的模板指令"处理 sqlite 迁移"，**掩盖了窗口内 seq 985 的明确 next_action
"下一步：先跑 lint 和测试，通过后再提交"**——下游评审据此把"核实 sqlite 迁移"当作
下一步，方向性偏离。**修复前现场**（最小脚本直接打印，未调模型）：

```json
// 修复前（lib/summary.js 20:11 构建，与 src 20:15 不一致——先取证后重建）
{ "current_goal": "处理 sqlite 迁移", "last_message_summary": "好的，已处理：处理 sqlite 迁移（第 499 轮）" }
// 窗口最后 6 条：seq 994-999 均为填充轮模板，985 的 next_action 被压在窗口内
```

**根因**（两处，均已修复）：
1. `current_goal` 取"窗口内最后一条实质 user 消息"——无行动性的模板/确认文本可覆盖
   更早的明确目标（实现缺失）。
2. 确认词过滤正则用 `\b`（ASCII 词边界）——**对 CJK 文本完全无效**（"继续"后的中文
   字符无词边界），过滤实际从未生效（实现缺陷，取证时发现）。

**修复**（`summary.ts`，同一提交内）：
- `current_goal` 改为**行动性排序**：显式 next_action/计划信号（下一步/接下来/请/现在…+2）
  > 命令式动词起始（+1）> 其余；同分取更近消息；新增 `current_goal_seq`（来源 seq 追溯）。
- 新增 `last_user_message`：窗口内最近实质 user 消息**原文保留**（不被排序覆盖，证据不丢）。
- 确认词正则改**整串锚定**（`^(继续|好的?|…)[。.!！]?$`），对 CJK 生效。

**修复后现场**（重建 lib 后同一脚本）：

```json
{ "current_goal": "下一步：先跑 lint 和测试，通过后再提交（第 985 条，近端窗口内）",
  "current_goal_seq": 985,
  "last_user_message": "下一步：先跑 lint 和测试，通过后再提交（第 985 条，近端窗口内）" }
```

**回归测试**（fidelity-acceptance 新增）：①current_goal 必须含 lint 且 seq=985；
②纯确认词"继续"不成为 goal/最近证据；③排序分支：窗口内更早的"下一步：先做灰度验证"
（+2）压过更近的"处理打包配置问题"（+1），且最近原文保留在 `last_user_message`。
fixture 填充轮同步改为确认词形态（真实长会话近端形态），消除模板失真对判定的干扰。

## 6. 修复内容（保真验收驱动）

1. **摘要窗口 2 → 20**（`SUMMARY_WINDOW=20`）：近端事实（测试结果/未确认/下一步）进入结构化提取。
2. **新增 `current_goal`**：窗口内**行动性排序**最高的 user 消息（显式 next_action > 命令式
   动词 > 其余，同分取近）；过滤纯确认词（整串锚定，CJK 生效）；附 `current_goal_seq` 追溯
   来源；`last_user_message` 保留最近实质 user 原文。**P1 修复（§5.1）**。
3. **新增 `recent_evidence`**：commits（commit 前缀限定）/paths/errors/tests 正则提取，
   每类 ≤3 条，`extracted:true` 标注；errors 排除"修复…失败"指令行。
4. **新增 `history_ref`**：include_messages 引用 + 可达范围标注（DSH 0.1.1 上限 100、翻页不支持）。
5. **新增 `safety_sanitized` + 凭据清洗**：Bearer/api-key/token/password/secret 赋值、
   sk-*、AKIA* 模式在进入任何摘要字段前剔除；发生清洗置 true。
6. 保持 **MAX_RESPONSE_BYTES=50000** 不变（默认响应 <1KB，未放大）。

## 7. 剩余风险

- **协议级**：DSH 0.1.1 `sessions_get` beforeSeq 无效 → >100 条历史不可达。**修复路径（后续增强）**：
  agent 侧历史归档（周期拉取最近 100 条 + PROMPT/CANCEL 后增量累积到本地 artifacts，
  `history_ref` 改指归档）→ 消除 AMBIGUOUS 项；DSH 支持真实翻页后自动启用 before_seq 游标。
- **token_estimate 仍为估算**（DSH 无统计字段，估算=字符/4，`token_estimate_estimated:true` 标注）。
- **current_goal 语义**：=最近实质 user 指令（近似目标；DSH 无 goal 字段），长会话中早期目标
  不会出现在默认摘要（已显式不 claim）。
- 评审模型的转述瑕疵（如把 pagination 值复述成
  'dsh-beforeSeq-unsupported-unsupported-0.1.1'）——不影响评审结论，已按原文存档。

## 8. 复现命令

```bash
# 1) 验收测试（12 用例：基线对比/信息矩阵/100 次稳定/分页/异常/失效）
pnpm --filter @dsh-helm/node-agent exec vitest run tests/fidelity-acceptance.test.ts
# 2) 下游决策实验（独立第二模型 qwen3.7-max，xdf 网关；XDF_API_KEY 环境变量）
pnpm --filter @dsh-helm/node-agent build
XDF_API_KEY=<key> node scripts/fidelity-review.mjs            # 全部三 fixture
XDF_API_KEY=<key> node scripts/fidelity-review.mjs long-task  # 单个
# 输出：docs/fidelity-review/<kind>.<group>.json + stdout 事实命中表
# 3) 全量
pnpm test && pnpm build && pnpm lint
```

## 9. 测试/build/lint 与 commit

- `pnpm test`：**399/399 passed（48 files）**（含 fidelity-acceptance 12 用例）
- `pnpm build`：tsc -b 通过；`pnpm lint`：eslint 通过
- commit：`643c866`（本轮验收 commit 包含：summary.ts 保真修复（窗口 20/current_goal 行动性排序/
  recent_evidence/history_ref/safety_sanitized/凭据清洗）、fidelity fixtures/验收测试、
  评审脚本（xdf 网关盲化评审）、本报告、评审原始回答存档 docs/fidelity-review/）
