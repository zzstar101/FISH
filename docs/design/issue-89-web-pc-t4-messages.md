# PC Web T4：消息中心

> 状态：设计，待实现。依赖 T3。P0 只做文字消息，媒体消息另拆。
> 主跟踪：GitHub #89「B：Web 桌面版前端」。

## 1. 范围

交付 PC 端会话列表、会话详情、历史消息、发送文字、已读和实时刷新。

路由：

- `/messages`：会话列表。
- `/messages/$conversationId`：会话详情。

入口：侧栏「消息」、顶栏消息按钮。商品详情页的「聊一聊」由 T5 负责接线。

## 2. 后端契约

使用现有接口，不新增后端：

- `GET /conversations`：会话列表，`limit` + cursor。
- `POST /conversations`：按 `listingId` 创建/复用会话。
- `GET /conversations/:id`：会话详情。
- `GET /conversations/:id/messages`：历史消息，`before` cursor。
- `POST /conversations/:id/messages`：发送 TEXT。
- `POST /conversations/:id/read`：标记已读。
- `GET /conversations/unread-count`：全量未读总数。
- `WS /ws/chat`：同源 Cookie 鉴权，服务端推送当前用户全部会话事件。

DTO / schema 统一从 `@fish/contracts/chat/schema` 与 `@fish/contracts/chat/routes` 读取。

## 3. 页面设计

### 3.1 会话列表

- 左侧或正文区域展示会话行。
- 行内：商品缩略图、对方昵称、最后消息、时间、未读数。
- 排序由服务端 `lastMessageAt` 决定，前端不重排。
- 翻页使用 `nextCursor`。
- 空白态：说明还没有会话，并给「去逛商品」入口。

### 3.2 会话详情

- 顶部显示商品摘要和对方信息。
- 消息按服务端顺序渲染。
- TEXT 右侧本人、左侧对方；SYSTEM 消息居中。
- 底部输入框发送 TEXT，最大 2000 字。
- 每次新发送生成 `clientRequestId`，重试沿用同一个值。
- 打开会话后调用 read；只有 `readerId !== me` 且 `message.createdAt <= readAt` 的实时读事件才把本人消息标成已读。

### 3.3 实时连接

- 页面级建立 `WebSocket('/ws/chat')`，不是每个会话一个连接。
- 心跳发送 `{ type: 'ping' }`，收到 `pong` 更新健康状态。
- 断线采用指数退避；恢复后重新拉当前会话历史上限页和未读数。
- 推送不保证不重不漏，前端按 message id 去重。

## 4. 状态与错误

- 会话不存在/无权限：404 显示统一“会话不存在或不可访问”。
- 发送失败：保留草稿和失败气泡，可重试并沿用 `clientRequestId`。
- `IDEMPOTENCY_KEY_REUSED`：提示“该次发送已用于其它内容”，不伪造成功。
- 401 由全局 T3 收口。
- 生产环境不回退演示消息。

## 5. 文件结构

```text
apps/web-pc/src/features/chat/
├── api.ts
├── queries.ts
├── realtime.ts
├── conversation-list-page.tsx
├── conversation-page.tsx
└── message-bubble.tsx
apps/web-pc/src/routes/messages.tsx
apps/web-pc/src/routes/messages.$conversationId.tsx
```

## 6. 验收标准

- [ ] 会话列表游标分页、空态、错误重试正常。
- [ ] 详情历史消息向上分页不重不漏。
- [ ] 发送 TEXT 成功并能重试。
- [ ] 打开会话后未读数归零。
- [ ] 同账号多连接可同步新消息和读位。
- [ ] 断线重连后补历史、未读和当前会话。
- [ ] SYSTEM 消息不导致页面崩溃。

## 7. 非目标

- IMAGE / VOICE 消息。
- typing 指示。
- 撤回、删除、转发、搜索消息。
- 修改 chat 后端契约。

## 8. 验证

- 定向：chat api / query / realtime 单测。
- 运行时：双账号聊天、重连、重复发送、未读角标。
- 全仓：typecheck、lint、test、build:web-pc。
