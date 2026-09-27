# PC Web T10：#217 ID 边界盘点

> 状态：T10 实现前的冻结检查表。结论基于当前 `apps/web-pc` 与 `packages/contracts`；在 #217 冻结前不新增 TypeID 前缀、编号搜索或公开编号展示。

## 1. 路由与 URL 参数

| PC 位置 | 当前参数 | 契约 / 来源 | 是否把 UUID 当公开展示编号 | #217 前处理 |
| --- | --- | --- | --- | --- |
| `/listing/$listingId` | `listingId` | `ListingIdSchema = z.uuid()`；`ListingDetail.id` | 否，页面不展示该值；分享 / 复制 URL 会暴露 | 保持 UUID 路由；#217 若引入公开编号，另议 URL 是否新增别名与跳转 |
| `/messages/$conversationId` | `conversationId` | 会话 DTO `id`；API 路径按 UUID 列查询 | 否 | 保持 UUID 路由；不能把编号拼进路径 |
| `/orders/$transactionId` | `transactionId` | `TransactionDto.id`；交易写接口/面交凭证使用 `z.uuid()` | 否 | 保持 UUID 路由；公开编号不替代交易主键 |
| `/pc/`、`/pc/search`、`/pc/wish`、`/pc/profile` | 无可变 ID | 仅 query 搜索参数或 owner id 来自登录态 | 否 | 无变更 |

## 2. DTO / 页面传递的 ID

| ID | 用途 | 是否展示 | #217 前处理 |
| --- | --- | --- | --- |
| `ListingDetail.id` / `ListingCard.id` | 详情查询、缓存 key、跳转参数 | 否 | 保留内部 UUID；若要展示编号，新增 DTO 字段而不是复用 `id` |
| `ConversationDto.id` | 会话列表与详情跳转、读位 | 否 | 保留内部 UUID |
| `TransactionDto.id` | 订单列表与详情跳转、确认 / 取消；订单详情显示为“订单号” | **是**：当前直接展示内部 UUID | #217 冻结后必须改为公开编号或移除该展示；不得继续把内部 UUID 当用户编号 |
| `WishDto.id` / `matchId` | 许愿编辑、匹配列表、发起会话 | 否 | 保留内部 UUID |
| `NotificationDto.id` | 通知列表 key、标记已读 API 路径 | 否 | 保留内部 UUID；不把通知 id 暴露成可复制编号 |
| `NotificationDto.payload.listingId` / `wishId` | 通知跳转前的目标校验 | 否 | #217 后若要兼容编号，先扩展 payload 契约，不在 PC 端猜测 |
| `MessageDto.id` / `senderId` | 消息 key、发送者判断、历史分页 `before` | 否 | 保留内部 UUID；`before` 只按不透明分页参数处理 |
| `CommentDto.id` / `CommentReply.id` | 留言 key、回复目标、留言分页 cursor | 否 | 保留内部 UUID；cursor 只按不透明分页参数处理 |
| `User.id` / `ownerId` | 账号作用域缓存、资料与订单 key | 否 | 保留内部 UUID；不得作为可复制的用户编号 |

## 3. 搜索与 cursor

| 项 | 当前行为 | 结论 |
| --- | --- | --- |
| 商品搜索 | 只接受 `q`、`category`、`sort`、`cursor`；不解析数字编号 | #217 前不增加“编号搜索” |
| 列表 cursor | `apps/api/src/modules/listings/cursor.ts` 用 base64url 包装 `(sortKey, id)`，`id` 是内部 UUID | 对前端是不透明字符串；PC 只原样回传 |
| 会话 cursor | 服务端同样编码 `(lastMessageAt, conversationId)` | 对前端是不透明字符串；PC 不解析 |
| 留言 cursor | `apps/api/src/modules/comments/cursor.ts` 用 base64url 包装 `(created_at, commentId)`，`commentId` 是内部 UUID | 对前端是不透明字符串；PC 只原样回传 |
| 消息历史 cursor | `messageListQuerySchema.before` 是 `z.uuid()`；服务端把上一页最早消息 `id` 作为 `nextCursor`，PC 原样作为 `before` 回传 | 当前确实把消息 UUID 当分页键；#217 若要改公开编号，需单独迁移该参数与兼容策略 |
| 分享 / 复制 URL | 当前没有内置复制/分享按钮；浏览器地址栏或外部复制仍会暴露 `/pc/...` 中的 UUID | #217 若定义公开 URL，需同时定义重定向和兼容策略 |

## 4. 结论

- 当前 PC Web 没有编号搜索入口；唯一直接把内部 UUID 当用户可见“订单号”展示的位置是订单详情，已登记为 #217 必须处理项。
- UUID 仍被用作路由和 API 内部标识；在 #217 冻结前这是已登记的事实，不是新的公开编号契约。
- #217 若引入 TypeID / 公开编号，PC Web 需要单独完成：DTO 字段接入、URL 兼容、搜索入口、分享口令和 cursor 迁移测试。
