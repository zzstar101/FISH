# #147 交易、订单与面交凭证 — 剩余项设计方案

> 状态：**方案已确认（Owner 逐条拍板），本文不含实现代码**。工程侧（PR-1）已实现并随 PR #181 提审；页面侧（PR-2）待 #177 合入后启动。
> 关联：Refs [#147](https://github.com/zzstar101/FISH/issues/147)（需求载体；只引用、不关闭，见 §10） ｜ 前置已落地：[#169](https://github.com/zzstar101/FISH/issues/169)（长期凭证 + 终态同事务销毁）、[#176](https://github.com/zzstar101/FISH/issues/176)（一单一码 + 幂等取码）、[#167](https://github.com/zzstar101/FISH/issues/167)（Orders 真实列表）、[#168](https://github.com/zzstar101/FISH/issues/168)（Meetup UI 与身份守卫） ｜ 基线校准：[#183](https://github.com/zzstar101/FISH/issues/183)（#76 flake 修复：三处终态 DELETE 拆出 CTE、改为同一事务的独立语句，本文 §4.2 的结构描述与行号据此更新）
> 记录人：Coast-87（本机） ｜ 日期：2026-09-22 ｜ 更新：2026-09-23（#183 合入后校准）
> **行号基线**：`origin/main = ad38862`（2026-09-23，`#183` 合入后）。本文引用的代码行号以此为准；#183 改写了 `store.ts` 三处终态 DELETE 的形态与行号，本文引用已按新基线逐条核对。
> 决策来源：Owner 于 2026-09-22 分两轮逐条确认（完整记录见 §9）。

---

## 0. Owner 看这里

一句话：#147 的尾巴分工程侧与页面侧 —— 工程侧（交易/面交流程不变量进 CI）已由 PR #181 实现并提审；页面侧还剩两个客户端正确性 bug、一处注释残留与真机回归没做（真机回归由 Owner 按 §6 执行），按 `docs/miniapp-dev-workflow.md` §2 的串行门禁排成**一个页面 PR（等 #177 合入）**。

需要你本人做的三件事：

1. **PR-2 的微信开发者工具演示 + 你确认可行后才允许提交**（`docs/miniapp-dev-workflow.md` 硬门禁）。
2. **真机回归**：§6 的五条清单由你在微信开发者工具 / 真机上执行。
3. **PR-2 的排期取决于 #177 何时合入**——`docs/miniapp-dev-workflow.md` §2 是串行门禁，`feat/miniapp-verify-redesign` 未落地前不开新页面分支。

---

## 1. 目标与非目标

### 目标

- 面交页的核销 → 确认链路在两个已知竞态下不再产生错误的终态显示。
- 同一 tick 的重复提交不再双发。
- 交易 / 会话 / 面交凭证三者的一致性不变量由 CI 长期守住，而不是靠一次性人工核对。
- 面交流程在真机上有可复述的验收记录。

### 非目标（附理由）

| 不做 | 理由 |
| --- | --- |
| 补 seed 的「待面交 + 已签发凭证」样例数据 | #176 定的是「取码即创建、一单一码」，seed 预写凭证等于造第二份真相；且 `packages/db/src/seed.test.ts:74-88` 的计数断言会连带扩散 |
| 重构 `core-smoke.ts` 的 34KB 基建 | AGENTS §4 最小改动；本次只是复用既有 scratch 库 / 真 API / HTTP 助手 |
| 清理 `apps/miniapp/src/pages/transaction-meetup/index.tsx:218` 的「过期」字样 | 那处指 epoch 代次（语义正确），不是 `MEETUP_TOKEN_EXPIRED` 残留 |
| 客户端串号类问题的 smoke 覆盖 | 属页面生命周期，`core:smoke` 测不到；由 #170 与真机清单承担 |
| 关闭 #147 | Done 列表里还有「交易状态机与订单数据一致」这类长期项 |

---

## 2. 现状（事实；决策时快照，「smoke 缺口」一行已由 §4 消除）

| 项 | 事实 | 位置 |
| --- | --- | --- |
| P2-1 竞态 | `verify` 内层 `catch` 无差别 `setConfirmPending(true)`，把 409 `TRANSACTION_NOT_IN_PENDING` 也当成「confirm 网络失败」，页面会停在「还差最后一步确认」；`retryConfirm` 对同一错误有专门分支（重拉终态 + `setConfirmPending(false)`） | `apps/miniapp/src/pages/transaction-meetup/index.tsx:320,327,331` 与 `:377,388` |
| P2-2 双击 | 防重复提交只判 React state `submitting`，同一 tick 两次点击都能通过（`is-off` 只是样式） | 同上 `:305`、`:840-844` |
| P3 | `:118` 注释残留「码错误 / 过期 / 已被使用 / 次数过多」，运行时已无 `MEETUP_TOKEN_EXPIRED` | 同上 `:118` |
| seed 不变量（已有） | scratch 库跑 seed，断言 3 会话 / 2 交易 + 每笔交易按三元组 join 得到会话 | `packages/db/src/seed.test.ts:74,76,85-93` |
| smoke 缺口 | `core-smoke` 的 11 个步骤（干净环境 / 启动 / Demo 样例 / 上传发布 / Wish 匹配 / 幂等 / 编辑重算 / 上下架 / 重启恢复 ×2 / 坏 payload）**没有任何交易与面交场景** —— **已由 §4 消除**（PR #181 追加「交易与面交」步骤，代码内序号 `// 11.`） | `apps/api/scripts/core-smoke.ts:411-792` |
| 面交语义 | 取码幂等且每次复位 `failed_attempts` / `locked_until`（卖家重取是现场解锁的唯一路径）；连错 5 次锁 10 分钟；终态 409 | `apps/api/src/modules/transactions/store.ts:132-133`、`service.ts:51-53,219-245` |
| 路由 | `POST /transactions`（卖家接受并创建）、`POST /transactions/:id/meetup-token`（取码）、`POST /transactions/:id/meetup-token/verify-code`（核销）、`POST /transactions/:id/confirm`、`POST /transactions/:id/cancel` | `packages/contracts/src/transactions/routes.ts:14-32` |

---

## 3. 交付切分与分支

| PR | 分支 | 改动范围 | 前置 | 顺序 |
| --- | --- | --- | --- | --- |
| PR-1 工程 | `feat/147-tx-smoke-invariants` | `apps/api/scripts/core-smoke.ts`、`.github/workflows/ci.yml`、`docs/README.md`、`docs/design/issue-147-transaction-invariants.md` | 无（不碰 `apps/miniapp`，不受小程序串行门禁约束） | 已实现（PR #181） |
| PR-2 页面 | `feat/miniapp-meetup-confirm-race` | `apps/miniapp/src/pages/transaction-meetup/**`、`apps/miniapp/tests/**` | #177 `feat/miniapp-verify-redesign` 合入 | 后做 |

两个 PR 均 **Refs #147**（只引用、不关闭，见 Q6 与 §10）；均从最新 `main` 切出。

---

## 4. PR-1：交易与面交 smoke 不变量（已实现：PR #181）

### 4.1 落点

在 `apps/api/scripts/core-smoke.ts` 新增 `step = '交易与面交'`，追加在**最后一步「坏 payload」之后**（`core-smoke.ts:792` 之后，`try` 块末尾）。

理由：该步骤会把交易推到 COMPLETED，从而把 listing 置为 SOLD；插在「重启恢复」之前会污染那两步对同一 listing 的 `PATCH /listings/:id`。放在末尾则不影响任何既有断言，且 `finally` 里的 scratch 库与对象清理照旧。

复用既有 `seller` / `buyer` / `listingId` 与 `postJson` / `get` / `assertEqual` 助手，不新建脚本。

### 4.2 四条不变量断言

1. **三元组一致**：提案 → 接受后，买卖双方 `GET /transactions` 各自都能看到该笔；且 `conversationId` 指向 `(listing_id, buyer_id, seller_id)` 完全一致的会话（DB 侧直接断言 join，对应 #157 的失败模式）。
2. **一单一码幂等 + 跨交易唯一**：卖家连续两次 `POST /transactions/:id/meetup-token` → 两次明文码**逐字相同**（6 位码与二维码 token 各断言一次，避免「码不变但二维码重签」漏网）；且与上面那笔已取消交易的凭证 **不同**（钉住派生输入是**交易 id** 而不是 `listingId` —— 后者会让同一商品上先后两笔交易拿到同一枚码）。跨交易比较取 `qrPayload` 里由契约解析器解出的 `t`（token），不比整串 payload：整串含 `tx=<交易 id>`，两笔交易必然不同、比了等于没比；也不比 6 位码：码空间只有 10^6，两枚独立码有 1e-6 的碰撞概率，用它做断言会变成极低频 flake。
3. **阈值口径被独立钉住**：断言 `MEETUP_TOKEN_MAX_ATTEMPTS === 5`（#70 冻结的「5 次 / 锁 10 分钟」），循环边界另取该常量——否则阈值漂到 6 时本步骤会跟着漂、拦不住。
4. **重取即解锁**：买家连错 4 次 `verify-code` 各返回 422，**第 5 次达阈值即返回 429** `MEETUP_TOKEN_LOCKED`（函数 `recordMeetupTokenFailure` 起于 `apps/api/src/modules/transactions/store.ts:704`，置 `locked_until` 的 UPDATE 在 `:707-719`）；卖家再取码 → 码值不变，且该行 `failed_attempts = 0` / `locked_until = null`。
5. **终态销毁（两个终态各一条）**：
   - **CANCELLED**：取码 → 买家 `cancel` → DB 断言凭证行已删、再取码 409、且商品恢复 ACTIVE（`store.ts:531-532` 的无条件 RESERVED→ACTIVE，加同事务内的独立 DELETE `:551`）；
   - **COMPLETED**：买家以正确码核销（该事务同时盖上卖家确认，交易仍停 `PENDING_MEETUP`）→ 买家 `confirm` → COMPLETED → DB 断言凭证行已删，且再 `POST /meetup-token` 返回 409。

   > **断言能力的边界（第一轮 S2 + 第二轮 Standards-1）**：smoke 只能证明「终态之后凭证行已不在」，无法区分「同事务删除」与「提交后异步删除」；要真正证明原子性需要故障注入（让终态事务内后续步骤失败并断言整体回滚），不在本单范围。
   >
   > **现状必须说清：目前没有任何运行时测试证明这条原子性。** `apps/api/src/modules/transactions/store.test.ts:610-620`（cancel）、`:694-718`（cancel × issue 并发）与 `:754`（核销 × 取消 并发的终态断言）也只断言终态后的最终状态（`findMeetupToken → null`）；若把 DELETE 挪到终态事务提交之后，它们同样会绿。这条不变量**只由事务边界保证**：DELETE 是终态事务内的**独立语句**，不在上面那条 CTE 里（`store.ts:509-511` COMPLETED / `store.ts:542-551` CANCELLED）——`#183` 正是把 DELETE 拆出 CTE 才修掉「并发 issue 的凭证在终态交易上幸存」的 flake（READ COMMITTED 下，同一条 CTE 里的 DELETE 对非目标表用语句开头快照）。因此 (a) smoke 的断言标签写「凭证行已删除」，不写「同事务删除」；(b) 若后续要把「同事务」也变成被运行时验证的事实，需另开单做故障注入。
   >
   > **为什么不再写「同一个 CTE」**：#183 修复 #76 flake 的根因正是旧写法——CTE 内 DELETE 对非目标表（凭证表）用**语句开头**的快照，锁等待后的 EvalPlanQual 重评估只作用于 UPDATE/DELETE 的目标行本身；并发 `upsertMeetupToken` 先持交易行锁提交了凭证行、cancel 的语句才开始求值时，DELETE 看不见那行 → CANCELLED 交易上凭证幸存（PR #183 记录的两层最小复刻实测：CTE 内写法 5/10 幸存，独立语句 0/10）。三处 DELETE（`cancel`、`confirm` 完成分支、`consumeMeetupToken` 完成分支）已全部拆为同事务独立语句，「看起来同事务」并不等于原子，这也是上面那条边界必须写清的原因。

### 4.3 验证

`bun run core:smoke`（本地真跑，不得只做静态检查）→ `bun run typecheck` → `bun run lint` → `bun test`。

---

## 5. PR-2：面交页 P2 / P3

### 5.1 P2-1 —— 抽共享判定，消除两处漂移

在 `apps/miniapp/src/features/transaction/` 新增纯函数（命名待实现时定，如 `classifyConfirmFailure(error): 'terminal' | 'retryable'`），`verify` 内层 catch（`:327`）与 `retryConfirm` catch（`:388`）都走它：

- `terminal`（409 `TRANSACTION_NOT_IN_PENDING`）→ 重拉交易终态 + `setConfirmPending(false)` + 返回；
- `retryable` → 维持既有语义（`verify` 侧 `setConfirmPending(true)`，`retryConfirm` 侧 toast）。

只共享「confirm 调用 + 结果落地」这一段；`settle()` 最短展示时长与 `setFxPhase` 动效不动。

### 5.2 P2-2 —— 同步 ref 锁

新增 `createSubmitLock()`（纯逻辑、无 Taro 依赖），`verify`（`:305`）与 `retryConfirm`（`:378`）入口同步 `tryAcquire()`，`finally` `release()`。

**关键**：必须在身份切换重置块（`:215-234`）里一并 `release()`。那里现在只复位了 `submitting` state（`:231`），ref 不复位会让换账号后的新账号被上一账号的锁卡死——等于用一个新 bug 换掉旧 bug。

### 5.3 P3

只改 `:118` 注释，删掉「过期」字样；`:218` 保留。

### 5.4 单测

在 `apps/miniapp/tests/` 新增两个测试文件，按 `order-list-state.test.ts` 的既有写法（先 `mock.module('@tarojs/taro', ...)` 再动态 `import`，避免真 Taro 在 Bun 下抛错）：

- 判定函数：409 → `terminal`；网络错误 / 其它 API 错误 → `retryable`；
- 提交锁：同一 tick 两次 `tryAcquire()` 只有一次通过；`release()` 后可再次获取。

### 5.5 流程门禁

顺序固定：改前提醒 Owner → 改代码 → **微信开发者工具演示** → Owner 确认可行 → `bun run --filter '@fish/miniapp' typecheck` + `bun run lint` + `bun test` → 提交。H5 / 纯代码检查**不能**替代开发者工具演示（`docs/miniapp-dev-workflow.md` §0、§4）。

---

## 6. 真机回归清单（已冻结，由 Owner 执行）

1. **重进码不变**：卖家进「交易码」页 → 退出 → 重进，同一笔交易的码值不变。
2. **解锁码不变**：买家连错 5 次触发锁定 → 卖家重取 → 码值不变且锁定解除。
3. **终态失效**：COMPLETED / CANCELLED 后进「交易码」页 → 无码可取，落到终态卡。
4. **换账号不串号**：A 在面交页 → 切到 B → 不残留 A 的交易 / 凭证 / 输入 / loading，旧账号迟到响应不落地。
5. **cancel × auto-confirm 竞态**：核销成功瞬间被对方取消 → 落到 CANCELLED 终态卡，**不**显示「确认完成面交」（这条是 §5.1 的端上验收）。

执行时机由 Owner 定；清单进 PR-2 描述，不塞进自动化。

---

## 7. 验证门禁汇总

| PR | 必跑 |
| --- | --- |
| PR-1 | `bun run core:smoke`、`bun run typecheck`、`bun run lint`、`bun test` |
| PR-2 | `bun run --filter '@fish/miniapp' typecheck`、`bun run lint`、`bun test`、微信开发者工具演示 + Owner 确认 |

两者完成后各按 AGENTS §7 做一轮**全新子代理**的对抗性审查。

---

## 8. 风险与已知偏差

- **R1（需知情）**：两个 P2 的修复都**写不出「跑旧实现会红」的用例**——旧逻辑埋在页面组件内部、当前不可测。按仓库先例（`apps/miniapp/tests/order-list-state.test.ts` 注释：「判定抽成纯函数锁住组合；组件接线靠 code review 保证」）改为「抽纯函数 + 单测」，与 AGENTS §5 的字面要求存在偏差。
- **R2**：PR-2 的排期完全取决于 #177 何时合入；#177 未落地前不动 `apps/miniapp`。
- **R3**：`core-smoke` 新增步骤会把主链 listing 推到 SOLD。因为它位于最后一步，当前不影响任何断言；但**将来若有步骤追加到它之后**，必须注意该 listing 已不可用。

---

## 9. 决策记录（Owner，2026-09-22）

| # | 决策 | 结论 |
| --- | --- | --- |
| Q1 | 交付范围 | 四类剩余项**全做** |
| Q2 | miniapp 串行门禁 vs 未合的 #177 | 选 (C)：先做不碰 `apps/miniapp` 的工程部分，页面部分等 #177 |
| Q3 | 分支 / PR 拆分 | **2 个 PR**（工程、页面） |
| Q4 | 真机回归 | 本轮**只冻结清单**（§6），执行另定 |
| Q5 | P3 边界 | 只改 `:118`，`:218` 保留 |
| Q6 | #147 收敛 | 完成后**保持打开** |
| Q7 | 不变量落点 | 选 (A)：在 `core-smoke.ts` 新增步骤 |
| Q8 | 断言清单 | 按建议的 4 条（§4.2） |
| Q9 | seed 样例数据 | 选 (B)：**不补** |
| Q10 | P2-1 修法 | 选 (A)：抽共享函数，范围限定在 confirm 结果落地 |
| Q11 | P2-2 锁形态 | 选 (A)：`useRef` 同步锁 + 身份切换处复位 |
| Q12 | 测试形态与命名 | 选 (A)：抽纯函数 + 单测；分支名按 §3 |

---

## 10. 完成定义

PR-1 与 PR-2 合入、§6 的真机清单执行并由 Owner 确认后：

- 勾掉 #147 正文里已达成项（两个 client P2、P3、seed / smoke 不变量进 CI、真机回归）；
- #147 **保持打开**，Done 中「交易状态机与订单数据一致」等长期项留档；
- 本次过程中新发现、且不属本次范围的问题，按 AGENTS §3 只报告、另开单。
