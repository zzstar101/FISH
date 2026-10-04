# #74「谁想要」（Watchers）来源定义冻结

- **状态**：冻结稿 —— 结论已经对照 `origin/main = b641fd7` 的实现逐条核实；**生效需 Owner 在对应 Issue 上确认**。
- **关联**：EPIC #74（Watchers / 列表读模型 / 市场信号）、#214（卖家读取，已合入）、#290（本卡，纯文档）、#381（PC 端接线，PR #384 **尚未合入 main**，见 §7）。
- **性质**：定义文档，不含任何实现改动；「待改项清单」只登记不实现（见 §7）。

## 1. 结论速览

| 维度 | 冻结口径 | 实现状态 |
| --- | --- | --- |
| 来源 | 与该商品**已建立会话**的买家，唯一来源 | ✅ 已实现 |
| 去重 | 同一买家同一商品只计一人（DB 唯一约束结构保证） | ✅ 已实现 |
| 排序与游标 | 会话创建时间降序 + id 兜底的 keyset 分页 | ✅ 已实现 |
| 权限 | 仅商品卖家本人可读（登录 + 403 兜底） | ✅ 已实现 |
| 隐私 | 只出 `user` 公开投影 + `startedAt`，无邮箱 / 手机号 | ✅ 已实现 |
| Wish / Match / 收藏 / 关注 | **均不计入**，也不与「想要」合并计数 | ✅ 口径一致（#290 冻结，#192 未实现） |
| 计数 | `total` = 与名单同一条 SQL、同一筛选条件、同一快照的全量 COUNT | ✅ 已实现 |
| `startedAt` 语义 | 会话创建时间（`conversations.created_at`），不随后续消息 / 已读变化 | ✅ 已实现 |

## 2. 来源：只认「已建立会话的买家」

「谁想要」的唯一数据源是 `conversations` 表中该商品的会话记录（买家一侧）。
契约注释在 `packages/contracts/src/chat/schema.ts:253`：

> `#74「想要的人」以该商品已建立会话的买家为源；仅商品卖家有权查看。`

服务端 SQL（`apps/api/src/modules/conversations/store.ts:222-243`）从
`conversations c JOIN users u ON u.id = c.buyer_id` 取数，条件 `c.listing_id = ? AND c.seller_id = ?`。

**明确不当作同一种意向**（EPIC #74 原文要求「不能未经定义就把聊天、收藏或关注当作同一种意向」）：

| 信号 | 是否计入「想要」 | 理由 |
| --- | --- | --- |
| 发起会话（聊天） | ✅ 计入（即本定义） | 「我想要」动作的服务端语义就是建立会话；买家付出的意向成本最高 |
| 收藏（favorites，#190） | ❌ 不计入 | 轻量 bookmark，可能只是比价 / 观察，不是交易意向 |
| 关注卖家（follows，#188） | ❌ 不计入 | 指向的是**人**不是**商品**，维度不同 |
| Wish / Match（#7 / #8） | ❌ 不计入 | 愿望匹配是服务端推断的相关性，不是买家对该商品的主动意向 |

三套信号今后也**不合并成同一个数字**：商品市场计数（浏览 / 想要）属 #192，其「想要」若要落地，
必须引用本节口径自行决定来源，而不是复用 watchers 的数字去拼。

## 3. 去重、排序与游标

- **一人一条**：`packages/db/src/schema/conversations.ts:52` 的
  `uniqueIndex('conversations_listing_id_buyer_id_uq')` 在 DB 层保证同一 (商品, 买家) 只有一条会话；
  创建侧 `insertIfAbsent` 幂等（`apps/api/src/modules/conversations/store.ts:66-67`）。
  因此名单天然无重复买家，**无需在读取侧再做去重**。
- **排序**：`ORDER BY c.created_at DESC, c.id DESC`（store.ts:239,242）——最新发起的排最前；
  `id` 兜底保证同毫秒创建的会话顺序稳定。
- **游标**：keyset 分页，游标 = `(created_at, id)` 二元组（`store.ts:226-228`），
  编解码在 `apps/api/src/modules/conversations/cursor.ts`；`nextCursor !== null` 即还有下一页
  （`packages/contracts/src/chat/schema.ts:244` 的通用注释）。
- **`startedAt` 语义**：会话 `created_at`（store.ts:223 注释：不随聊天消息变化）。它是「买家发起
  『我想要』的时间」，不是最近消息时间——后者属于会话列表（`lastMessageAt`），两者刻意不同。

## 4. 权限：仅商品卖家本人可读

- 端点 `GET /listings/:id/watchers`（`packages/contracts/src/chat/routes.ts:26`）整段挂
  `requireAuth`（`apps/api/src/modules/conversations/watchers-router.ts:17`）；
- service 二次校验卖家身份（`watchers-service.ts:22-26`）：商品不存在 → 404 `LISTING_NOT_FOUND`；
  调用者不是卖家 → 403 `NOT_LISTING_OWNER`；
- 回归测试：`watchers-router.test.ts`（匿名 401 / 路径非法 404 / 查询超限 422 / 非卖家 403）、
  `watchers-service.test.ts`（「只给卖家：非卖家与不存在商品不查询买家名单」）。

## 5. 隐私：最小投影

响应的 `items[]` 只有 `user` 公开投影 + `startedAt`（`packages/contracts/src/chat/schema.ts:260-270`）；
`user` = `ListingSellerSchema`（`packages/contracts/src/listings/schema.ts:173-177`）：
`id`（公开 `usr_...`）、`nickname`、`avatarUrl`、`authStatus`。

- **不出**邮箱、手机号、学号（学号不出 `Me` 是 #3 的验收要求；campus 整体移除与手机号只出派生态是 #86 的产品冻结——见 `packages/contracts/src/auth/user.ts:17,20-22`）；
- 头像经 `publicAvatarUrl` 归一（`watchers-service.ts:39`），不泄漏存储布局；
- 买家内部 UUID 不出 API（游标里的 `id` 是会话内部 id，仅用于游标往返，不单独下发）。

## 6. 计数：`total` 与名单同源

`total` 是「与名单同一条 SQL、同一筛选条件、同一数据库快照」的全量 COUNT
（接口注释 `store.ts:60`：「已建会话的买家；页与全量计数采用同一商品/卖家条件、同一数据库语句」；
实现 `store.ts:224,230-231`：计数子查询与分页 `LEFT JOIN LATERAL` 共用同一 `condition`）。

- `total` ≥ 当前页行数恒成立；空页也带回 total（`LEFT JOIN LATERAL` 的设计目的）；
- 服务端测试钉住这条：`watchers-service.test.ts:33`（「人数来自全部会话而非当前页」）。
- 展示口径：头部「共 N 人想要」用 `total`（小程序 `apps/miniapp/src/pkg-browse/pages/watchers/` 已实现）；
  PC 端的展示细节属 #381（PR #384，未合入），合入时按本节口径复核，不预先当作事实。

## 7. 与现有实现不一致的待改项清单（只登记，不实现）

核对范围（均在基线 `origin/main = b641fd7` 上）：`packages/contracts/src/chat/{routes,schema}.ts`、
`apps/api/src/modules/conversations/{watchers-router,watchers-service,store}.ts` 及其测试、
`packages/db/src/schema/conversations.ts`、`apps/api/src/modules/listings/store.ts`（商品删除）、
小程序 `apps/miniapp/src/pkg-browse/pages/watchers/`。
**PC 消费端（#381）未合入 main，不在本次核对范围内**；其 PR 合入时须按本文件逐节复核。

**结论：未发现与上述冻结口径冲突的实现。** 两条实现事实如实登记（均不构成「待改」，
但属于本定义依赖的持久化语义）：

1. 小程序页（`apps/miniapp/src/pkg-browse/pages/watchers/index.tsx:288,311`）只渲染 `user` + `startedAt`，
   未展示契约外字段；
2. **会话可随商品删除被销毁**：`apps/api/src/modules/listings/store.ts:772-775`
   （`deleteListingAtomic`）在删除商品时清掉该商品的 `favorites` 与 `conversations`
   （messages 对 conversations 是 CASCADE）。商品删除后 watchers 端点本身随商品 404，
   因此不存在「卖家看到名单缩水」的可见态；但「来源 = 会话」意味着名单的存续以商品存续为前提，
   若未来把「想要」改为独立于商品生命周期的信号，需回到本文件重新冻结。

## 8. 参考实现清单（本卡核对过的文件）

| 文件 | 内容 |
| --- | --- |
| `packages/contracts/src/chat/schema.ts:253-270` | `chatWatchersQuerySchema`（limit 默认 20、上限 50、可选 `cursor`）与 `chatWatchersResponseSchema` |
| `packages/contracts/src/chat/routes.ts:26` | `watchers(listingId)` 路径常量 |
| `apps/api/src/modules/conversations/watchers-router.ts` | 挂 `requireAuth` 的端点；非法 id → 404、参数非法 → 422 |
| `apps/api/src/modules/conversations/watchers-service.ts` | 卖家校验、404/403、投影与 `total` 组装 |
| `apps/api/src/modules/conversations/store.ts:222-243` | 名单 + 同源 COUNT 的 SQL |
| `apps/api/src/app.ts:367-373` | watchers router 装配（挂到站点根 `/`） |
| `apps/miniapp/src/pkg-browse/pages/watchers/` | 小程序消费端（已合入的参照实现） |
| （#381，PR #384） | PC 消费端，**未合入 main**；合入时按本文件复核 |
