# PC Web T8：我的、在售与订单

> 状态：设计，待实现。依赖 T3、T4、T6（复用上传管线）。
> 主跟踪：GitHub #89「B：Web 桌面版前端」。

## 1. 范围

交付 PC 个人中心：

- `/profile`：用户、统计、快捷入口。
- `/mylist`：我的发布，支持 ACTIVE / OFFLINE 上下架。
- `/orders`：买入/卖出订单分组。
- `/orders/$transactionId`：订单详情、确认面交、取消。
- 编辑昵称/头像走 `PATCH /profile`；头像复用 T6 的 presign → PUT → confirm 上传管线。
- 个性签名不在本任务。

## 2. 后端契约

个人：

- `GET /profile`
- `PATCH /profile`
- `POST /uploads/presign`、`POST /uploads/confirm`：头像上传复用 T6 管线

商品：

- `POST /listings/:id/offline`
- `POST /listings/:id/online`
- `GET /listings?sellerId=&status=`

交易：

- `GET /transactions`
- `GET /transactions/:id`
- `POST /transactions/:id/confirm`
- `POST /transactions/:id/cancel`

面交码是否在 PC 首次交付：

- 先支持确认/取消和状态展示。
- 面交码展示、二维码核销、6 位码输入另拆，避免把聊天与交易状态机一次性铺开。

## 3. 页面设计

### 3.1 我的

- 头像、昵称、认证状态、手机绑定派生态。
- 三项统计：在售、愿望、完成交易。
- 买入/卖出是两个订单入口，不用第四个统计数字；`profileStats` 当前没有买卖计数。
- 入口：我的发布、买入订单、卖出订单、许愿、编辑资料。

### 3.2 我的发布

- 列表显示商品、价格、状态、审核态。
- ACTIVE 可下架；OFFLINE 可重新上架。
- RESERVED / SOLD 不显示手工上下架按钮。
- 编辑文字可按现有 `PATCH /listings/:id` 设计；换图另归 #74。

### 3.3 订单

- 买入/卖出用 URL 过滤或分栏，状态筛选走服务端 query。
- PENDING_MEETUP：双方确认和取消入口。
- COMPLETED / CANCELLED：只读终态。
- 订单卡包含商品和交易对方摘要。
- 状态操作后失效订单、商品、个人统计相关 query。

## 4. 状态与错误

- `LISTING_NOT_EDITABLE`：刷新状态后提示不能操作。
- `TRANSACTION_NOT_IN_PENDING`：刷新订单，不把终态操作显示为成功。
- `TRANSACTION_NOT_FOUND`：订单不存在或无权限。
- 编辑资料失败保留输入并显示字段级错误。
- 不做乐观终态：只有服务端返回成功才更新状态。

## 5. 文件结构

```text
apps/web-pc/src/features/profile/
├── api.ts
├── queries.ts
├── profile-page.tsx
├── mylist-page.tsx
├── orders-page.tsx
├── order-detail-page.tsx
└── profile-edit.tsx
apps/web-pc/src/routes/profile.tsx
apps/web-pc/src/routes/mylist.tsx
apps/web-pc/src/routes/orders.tsx
apps/web-pc/src/routes/orders.$transactionId.tsx
```

## 6. 验收标准

- [ ] 个人聚合数据真实返回，不混 fixture。
- [ ] 上下架幂等并刷新列表状态。
- [ ] 买卖订单分组和状态筛选正确。
- [ ] 确认/取消只接受服务端终态。
- [ ] 切号后个人统计、订单、在售不串数据。
- [ ] 编辑资料成功后顶栏头像昵称立即更新。

## 7. 非目标

- 真实个性签名 #179。
- 收藏、关注、浏览历史。
- 交易面交码的完整 PC 流程。
- 商品图片编辑。
