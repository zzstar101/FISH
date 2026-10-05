# PC Web T10：#217 ID 边界盘点

> 状态：**历史文档**——T10 实现前的冻结检查表，写于 #217 落地之前。下表「当前参数 / 当前行为」
> 两列描述的是 **#217 之前的**状态，保留作追溯，**不要当作现状**；逐项落地结果见 §4。
> **基线**：`origin/main = 58a9e5f13db47df9cbe3b706aa2e827bbf905aa4`（2026-10-05 实测）。

## 1. 路由与 URL 参数

| PC 位置 | 当前参数 | 契约 / 来源 | 是否把 UUID 当公开展示编号 | #217 前处理 |
| --- | --- | --- | --- | --- |
| `/listing/$listingId` | `listingId` | `ListingIdSchema`（#217 前为 `z.uuid()`，**现为公开 TypeID `lst_…`**：`packages/contracts/src/listings/schema.ts:117` → `system/public-id.ts:12`）；`ListingDetail.id` | 否，页面不展示该值；分享 / 复制 URL 会暴露 | 保持 ID 路由；#217 若引入公开编号，另议 URL 是否新增别名与跳转 |
| `/messages/$conversationId` | `conversationId` | 会话 DTO `id`；API 路径按 UUID 列查询 | 否 | 保持 UUID 路由；不能把编号拼进路径 |
| `/orders/$transactionId` | `transactionId` | `TransactionDto.id`（**现为公开 TypeID `txn_…`**）；交易写接口 / 面交凭证在 #217 前用 `z.uuid()`，现用公开 ID（`ConversationIdSchema` / `TransactionIdSchema`） | 否 | 保持 ID 路由；公开编号不替代交易主键 |
| `/pc/`、`/pc/search`、`/pc/wish`、`/pc/profile` | 无可变 ID | 仅 query 搜索参数或 owner id 来自登录态 | 否 | 无变更 |

## 2. DTO / 页面传递的 ID

| ID | 用途 | 是否展示 | #217 前处理 |
| --- | --- | --- | --- |
| `ListingDetail.id` / `ListingCard.id` | 详情查询、缓存 key、跳转参数 | 否 | 保留内部 UUID；若要展示编号，新增 DTO 字段而不是复用 `id` |
| `ConversationDto.id` | 会话列表与详情跳转、读位 | 否 | 保留内部 UUID |
| `TransactionDto.id` | 订单列表与详情跳转、确认 / 取消；订单详情显示为“订单号” | **是**——#217 前直接展示内部 UUID；**现已改为公开 ID**：`apps/web-pc/src/features/profile/order-detail-page.tsx:113` 渲染的 `detail.id` 由 `TransactionIdSchema`（`packages/contracts/src/transactions/schema.ts:6,:46`）收口为 `txn_…` | ✅ **已由 #217 落地满足**（PR #280，merge `529ca42a`，2026-09-28）；不再是欠账 |
| `WishDto.id` / `matchId` | 许愿编辑、匹配列表、发起会话 | 否 | 保留内部 UUID |
| `NotificationDto.id` | 通知列表 key、标记已读 API 路径 | 否 | 保留内部 UUID；不把通知 id 暴露成可复制编号 |
| `NotificationDto.payload.listingId` / `wishId` | 通知跳转前的目标校验 | 否 | #217 后若要兼容编号，先扩展 payload 契约，不在 PC 端猜测 |
| `MessageDto.id` / `senderId` | 消息 key、发送者判断、历史分页 `before` | 否 | 保留内部 UUID；`before` 只按不透明分页参数处理 |
| `CommentDto.id` / `CommentReply.id` | 留言 key、回复目标、留言分页 cursor | 否 | 保留内部 UUID；cursor 只按不透明分页参数处理 |
| `User.id` / `ownerId` | 账号作用域缓存、资料与订单 key | 否 | 保留内部 UUID；不得作为可复制的用户编号 |

## 3. 搜索与 cursor

| 项 | 当前行为 | 结论 |
| --- | --- | --- |
| 商品搜索 | 关键词搜索仍只接受 `q`、`category`、`sort`、`cursor`；**另已增加编号精确查询** | ✅ 已放开并落地（#217 + #382）：编号走独立端点 `LISTING_ROUTES.byNumber`（`packages/contracts/src/listings/routes.ts:12`，只返回 canonical `lst_…` ID），PC 接线在 `apps/web-pc/src/features/search/number-lookup.ts`、`search-page.tsx:79-84` |
| 列表 cursor | `apps/api/src/modules/listings/cursor.ts` 用 base64url 包装 `(sortKey, id)`，`id` 是内部 UUID | 对前端是不透明字符串；PC 只原样回传 |
| 会话 cursor | 服务端同样编码 `(lastMessageAt, conversationId)` | 对前端是不透明字符串；PC 不解析 |
| 留言 cursor | `apps/api/src/modules/comments/cursor.ts` 用 base64url 包装 `(created_at, commentId)`，`commentId` 是内部 UUID | 对前端是不透明字符串；PC 只原样回传 |
| 消息历史 cursor | `messageListQuerySchema.before` 是 `z.uuid()`；服务端把上一页最早消息 `id` 作为 `nextCursor`，PC 原样作为 `before` 回传 | 当前确实把消息 UUID 当分页键；#217 若要改公开编号，需单独迁移该参数与兼容策略 |
| 分享 / 复制 URL | #217 前没有内置复制 / 分享按钮，地址栏里是内部 UUID；**现在地址栏里是公开 TypeID**，详情页另有「复制商品编号」按钮 | 复制已落地：`apps/web-pc/src/features/listing-detail/listing-no-line.tsx:15,:20`（组件只收 `listingNo` 字符串，内部 UUID 传不进来）。分享口令 / 公开 URL 重定向**仍未做** |

## 4. 结论

> 以下三条是 **#217 落地前**写下的结论，保留原文以对照；逐项落地状态见 §4.1。

- 当前 PC Web 没有编号搜索入口；唯一直接把内部 UUID 当用户可见“订单号”展示的位置是订单详情，已登记为 #217 必须处理项。
- UUID 仍被用作路由和 API 内部标识；在 #217 冻结前这是已登记的事实，不是新的公开编号契约。
- #217 若引入 TypeID / 公开编号，PC Web 需要单独完成：DTO 字段接入、URL 兼容、搜索入口、分享口令和 cursor 迁移测试。

### 4.1 落地结果（2026-10-05 核对，基线 `58a9e5f1`）

Issue #217 已于 2026-09-27 CLOSED，统一 ID 体系由 **PR #280** 面向 `main` 集成落地（merge `529ca42a`，2026-09-28）。

| 检查表要求 | 落地结果 | 证据 |
| --- | --- | --- |
| 公开 ID 前缀与编码 | ✅ 已落地，14 个前缀 | `packages/shared/src/public-id.ts`（`PUBLIC_ID_PREFIX`：`usr/lst/wsh/mtc/cnv/msg/txn/cmt/ntf` + `rvw/rpt/rst/med/mdr/aud`）+ `public-id.test.ts`；契约 `packages/contracts/src/system/public-id.ts:11-17` |
| `ListingIdSchema` 不再是 `z.uuid()` | ✅ 现为公开 TypeID | `packages/contracts/src/listings/schema.ts:117`（`export const ListingIdSchema = PublicListingIdSchema`） |
| 交易 DTO / 写接口改用公开 ID | ✅ 已切换（`z.uuid()` 只剩 job payload 与 `clientRequestId` 等内部/非 HTTP 边界字段） | `packages/contracts/src/transactions/schema.ts:6,:46`；写请求用 `ConversationIdSchema`（`transactionProposalInputSchema` / `transactionAcceptInputSchema`） |
| 订单详情不得展示内部 UUID（§2、§4 第一条） | ✅ 已满足：展示 `txn_…` | `apps/web-pc/src/features/profile/order-detail-page.tsx:113` |
| §3「不增加编号搜索」 | ✅ 已放开并落地 | `packages/contracts/src/listings/routes.ts:12`（`byNumber`，注释「12-digit human reference lookup; returns only a canonical lst_... ID」）；PC `apps/web-pc/src/features/search/number-lookup.ts`（编号判据只有 `ListingNoSchema` = `^[1-9][0-9]{11}$`，不在前端重写正则）、`search-page.tsx:79-84` |
| §2 公开编号展示 | ✅ 详情页已展示并可复制人工编号 | `apps/web-pc/src/features/listing-detail/detail-page.tsx:249-251`、`listing-no-line.tsx:15,:20` |
| 内部 UUID 仍作路由 / API 内部标识 | ✅ 仍成立——§1 的三个路由参数名未变，但**值的形态由 UUID 变为公开 TypeID** | `apps/web-pc/src/routes/orders.$transactionId.tsx`、`listing.$listingId.tsx`、`messages.$conversationId.tsx` |
| 分享口令 / 公开 URL 重定向（§3 末行） | ❌ **仍未做**，是本表唯一未完成项 | 全仓无 `navigator.share`；`listing-no-line.tsx` 只复制编号，不定义公开 URL |
| cursor 迁移测试 | ➖ 未随 #217 变更；cursor 仍是不透明 base64url，PC 只原样回传 | `apps/api/src/modules/listings/cursor.ts`、`apps/api/src/modules/comments/cursor.ts` |

> 说明：本文件写于 #217 之前，§1–§3 表里的「#217 前处理」列是当时定下的动作清单，保留作追溯。
> 上文已就地标注**可证伪**的单元格（`ListingIdSchema` 形态、交易写接口、订单号展示、编号搜索、复制按钮）；
> 其余「保留内部 UUID」条目描述的是**内部标识**口径，#217 后仍然成立。
