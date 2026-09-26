# PC Web T7：通知中心

> 状态：设计，待实现。依赖 T3。
> 主跟踪：GitHub #89「B：Web 桌面版前端」。

## 1. 范围

交付：

- `/notifications` 通知列表。
- 顶栏通知未读角标。
- 单条通知标记已读。
- MATCH 通知跳转到商品详情；目标不可用时回退到通知列表或搜索。

后端通知列表当前没有 cursor，P0 只取 `limit` 上限内的数据。

## 2. 后端契约

- `GET /notifications?limit=`
- `GET /notifications/unread-count`
- `POST /notifications/:id/read`

响应使用 `notificationListResponseSchema`、`notificationUnreadCountSchema`。

## 3. 页面设计

### 3.1 列表

- 每行显示图标、标题、描述、时间、未读点。
- 客户端按 `type` 生成文案；服务端不返回文案。
- `MATCH` 显示“许愿有匹配结果”。
- 已读行降低视觉强调，但不隐藏。

### 3.2 跳转

payload 中 `listingId` / `wishId` / `matchId` 都可选，且目标可能已删除：

1. 有有效 `listingId`：跳商品详情。
2. 只有 `wishId`：跳许愿页对应愿望；T9 未完成前回退到通知列表。
3. 跳转前无法确认目标存在时，不制造 404 页面。

### 3.3 未读角标

- 顶栏 Bell 右上角显示数字。
- 角标只读独立 unread-count 端点。
- 标记已读后同时失效列表和角标 query。
- 数字超过 99 显示 `99+`。

## 4. 状态

- 空态：还没有通知。
- 加载失败：列表错误态，顶栏角标失败不阻塞其它页面。
- 标记已读失败：不提前把 UI 永久改为已读，可重试。
- 404 `NOTIFICATION_NOT_FOUND`：提示通知不存在或已失效。

## 5. 文件结构

```text
apps/web-pc/src/features/notifications/
├── api.ts
├── queries.ts
├── notifications-page.tsx
└── notification-row.tsx
apps/web-pc/src/features/shell/top-bar.tsx
apps/web-pc/src/routes/notifications.tsx
```

## 6. 验收标准

- [ ] 通知列表和未读数来自真实 API。
- [ ] 未读点、已读状态、角标三者一致。
- [ ] 标记已读幂等，失败可重试。
- [ ] MATCH 可跳到商品详情。
- [ ] 目标不存在时不跳无效页面。
- [ ] 顶栏角标错误不影响导航。

## 7. 非目标

- 通知分页、删除、批量已读。
- 新增通知类型。
- 浏览器系统通知。
- 实时推送；P0 可用轮询或进入页面刷新。
