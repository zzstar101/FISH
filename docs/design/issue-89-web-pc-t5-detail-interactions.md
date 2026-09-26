# PC Web T5：商品详情互动

> 状态：设计，待实现。依赖 T4。只做留言和「聊一聊」。
> 主跟踪：GitHub #89「B：Web 桌面版前端」。

## 1. 范围

在 T2 只读详情页上增加：

1. 留言列表、发送顶层留言、回复留言。
2. 非本人商品显示「聊一聊」，创建或复用会话后进入 T4 会话页。
3. 本人商品显示 owner 状态，不给自己创建会话。

不接收藏、关注、Watchers、点赞或评价。

## 2. 后端契约

留言：

- `GET /listings/:listingId/comments`
- `POST /listings/:listingId/comments`
- `POST /comments/:commentId/replies`

会话：

- `POST /conversations`，请求 `{ listingId }`。

使用 `CommentDtoSchema`、`CommentListResponseSchema`、`CommentCreateInputSchema` 和 `conversationDtoSchema` 收口响应。

## 3. 页面设计

### 3.1 留言区

- 留言区位于详情描述下方。
- 顶层留言显示作者、认证标识、正文、时间、回复数。
- 回复只嵌套一层；回复按钮挂在顶层留言下。
- 已登录用户可发留言/回复。
- 发送后失效对应 query，并显示最新数据。

### 3.2 聊一聊

- 详情侧栏 seller 卡下方增加主按钮。
- 点击后 `POST /conversations`。
- 201 新会话或 200 复用会话都跳 `/messages/:conversationId`。
- `CANNOT_CHAT_WITH_SELF` 时不展示按钮，防止竞态误点。
- 创建中禁用按钮，失败显示可重试错误。

## 4. 状态与错误

- 留言为空：显示“还没有留言，来问第一个问题吧”。
- 留言加载失败：区块内错误态，不影响详情主体。
- 留言命中敏感词 `COMMENT_CONTENT_BLOCKED`：保留草稿并提示原因。
- 回复一条回复：服务端 422；前端不提供该入口。
- 商品非 ACTIVE 时不显示「聊一聊」。

## 5. 文件结构

```text
apps/web-pc/src/features/listing-detail/
├── comments-api.ts
├── comments-queries.ts
├── comments-section.tsx
└── detail-page.tsx
apps/web-pc/src/features/chat/queries.ts
```

## 6. 验收标准

- [ ] 匿名/登录均可读取留言。
- [ ] 登录用户能发顶层留言和单层回复。
- [ ] 留言失败保留草稿，不显示假成功。
- [ ] 卖家标签只信服务端 `isSeller`。
- [ ] 非本人商品可创建/复用会话并跳转。
- [ ] 本人商品不会创建自聊会话。
- [ ] 详情主链不因留言失败整体不可用。

## 7. 非目标

- 收藏、关注和商品编辑。
- 多层评论树。
- 评论编辑、删除、举报。
- 图片留言。
