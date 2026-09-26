# PC Web T9：许愿墙与匹配

> 状态：设计，待实现。依赖 T3、T4。
> 主跟踪：GitHub #89「B：Web 桌面版前端」。

## 1. 范围

交付：

- `/wish` 愿望池与需求聚合。
- 发布、编辑、关闭、完成愿望。
- 我的愿望及匹配结果。
- 从匹配商品跳转到详情，从匹配结果进入 T4 会话。

愿望匹配 Worker 已在后端存在；前端不计算匹配分数。

## 2. 后端契约

愿望：

- `GET /wishes/pool`
- `GET /wishes`
- `POST /wishes`
- `GET /wishes/:id`
- `PATCH /wishes/:id`
- `POST /wishes/:id/close`
- `POST /wishes/:id/fulfill`

匹配：

- `GET /matches?wishId=`
- `GET /matches?listingId=`
- `POST /conversations`：从匹配结果进入会话时创建/复用。

使用 `wishDtoSchema`、`wishPoolResponseSchema`、`WishMatchListResponseSchema`、`ListingMatchListResponseSchema` 和 `conversationDtoSchema`。

## 3. 页面设计

### 3.1 愿望池

- 热门关键词、分类、想要人数、预算中位数。
- 点击关键词可跳到商品搜索。
- k-匿名聚合不展示个人身份。

### 3.2 我的愿望

- ACTIVE / CLOSED / FULFILLED 状态。
- 新建愿望：关键词 2–30 字、分类、预算区间、描述、接受相似商品。
- ACTIVE 可编辑/关闭；FULFILLED 只读。
- 我的愿望卡显示 `matchCount`（历史匹配记录数）；匹配结果页另取 `/matches` 的 `total`（当前可见匹配数）。

### 3.3 匹配结果

- 以愿望或我的商品为入口。
- 愿望侧用 `WishMatchListResponseSchema`，显示商品卡与匹配分。
- 商品侧用 `ListingMatchListResponseSchema`，显示愿望摘要与匹配分。
- 点击商品进入 T2 详情；需要聊天时进入 T4。

## 4. 状态与错误

- 愿望列表使用 page/pageSize，不走 cursor。
- 匹配列表无 cursor，超过 limit 时明确“仅显示前 N 条”。
- 非本人愿望/商品返回 403/404 时显示无权或不存在，不泄漏详情。
- 无匹配数据时显示真实空态，不伪造匹配；前端不从 Worker 进程状态推断结果。
- 愿望保存失败保留表单。

## 5. 文件结构

```text
apps/web-pc/src/features/wish/
├── api.ts
├── queries.ts
├── wish-page.tsx
├── wish-form.tsx
├── my-wishes.tsx
└── match-list.tsx
apps/web-pc/src/routes/wish.tsx
```

## 6. 验收标准

- [ ] 愿望池真实聚合，无个人身份泄漏。
- [ ] 创建/编辑/关闭/完成愿望链路可用。
- [ ] 我的愿望显示 `matchCount`，明确口径为“历史匹配记录数”。
- [ ] 匹配列表显示 `/matches` 的 `total`，明确口径为“当前可见匹配数”；两者不强行相等。
- [ ] 匹配商品可跳详情。
- [ ] 无匹配数据或 Worker 未产出数据时是真实空态，不是假数据。
- [ ] 切号后愿望和匹配缓存不串。

## 7. 非目标

- 新匹配算法。
- 愿望公开主页。
- 浏览器通知。
- 与 #217 编号体系的提前耦合。
