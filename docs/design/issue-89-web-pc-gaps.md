# PC Web 未接通能力盘点

> **基线**：`origin/main = 58a9e5f13db47df9cbe3b706aa2e827bbf905aa4`（2026-10-05 15:28:40 +0800，
> `Merge pull request #471`；本文于 2026-10-05 在该 commit 上实测）。
> **上一版**：`dc195083be76d9f261dca36b5562b84c7a85aeb1`（2026-10-01）。此后第 6 / 9 阶段与后续若干 PR
> 继续落库，上一版列出的多项「未接通」与「缺口」已被推翻，逐条更正见 §四。
> **口径**：只核对 `apps/web-pc` 的实际代码，不采信规划文档的承诺。
> - 「完全未接通」= PC 端在该基线里没有实现、也没有入口。
> - 「有缺口」= 已接真实 API，但能力不完整（分页、深链、类型等）。
> - 「演示态」= 前端已接真实接口，但当前环境开关让它返回演示结果。
>
> **证据路径**均相对仓库根；行号对应该基线，代码改动后需重新核对。行号可用 `sed -n '<行>p' <文件>` 复现。

---

## 一、完全未接通（PC 无入口 / 无实现）

> 上一版在本章列出的四类欠账（收藏、关注、浏览历史、交易评价）**已全部接通**，见 §四第 1–4 行。
> 本基线 `58a9e5f1` 下本章只剩 §1.3 的「非本阶段目标」与 §1.4 的主动下线。

### 1.1 后端已就绪，只差 PC 接线 —— 本版已清空

上一版列出的两项（收藏、关注）均已接通：`apps/web-pc/src/routes/favorites.tsx`、`apps/web-pc/src/routes/following.tsx`
及各自的 `features/` 模块都在基线里，证据见 §四第 1、2 行。本基线无剩余项。

### 1.2 后端本身未实现（DB 表在，但无契约 / 无 API 模块）—— 本版已清空

上一版列出的两项（浏览历史、交易评价）在后端与契约层均已落地：`packages/contracts/src/view-history/`、
`packages/contracts/src/transaction-reviews/` 与对应 API 模块都在基线里，证据见 §四第 3、4 行。本基线无剩余项。

### 1.3 其它未接通（PC 无入口，非本阶段目标）

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 手机号绑定 | 个人中心只展示绑定状态，无绑定操作 | `apps/web-pc/src/features/profile/profile-page.tsx:113`（非测试代码里「手机号」仅此 1 行） |
| 设置页（主题 / 通知偏好 / 协议 / 隐私） | 无该路由 | `apps/web-pc/src/routes` 下 25 个路由文件（含 `__root.tsx`）无 `settings*`；`grep -rn 'settings\|主题\|通知偏好' apps/web-pc/src` 只命中 `apps/web-pc/src/styles.css:108`、`:154` 与 `apps/web-pc/src/features/shell/pc-shell.tsx:9` 三处「主题」注释。协议 / 隐私没有设置页，只有登录页的静态文案 `apps/web-pc/src/routes/login.tsx:55-56`（`《用户协议》` / `《隐私政策》`） |
| 分享 / 复制商品链接 | 有通用复制能力，但无「分享」入口 | `apps/web-pc/src/lib/copy-text.ts:5`（`copyText`），唯一调用方是 `apps/web-pc/src/features/listing-detail/listing-no-line.tsx:20`（复制商品编号）；全仓源码（`apps/`、`packages/`）无 `navigator.share`——`git grep -n 'navigator\.share'` 全仓只命中两行文档正文（本行与 `docs/design/issue-89-web-pc-t10-id-inventory.md:62`），无源码命中 |
| Admin 控制台 / 审核队列 | **后端已就绪**（契约与 API 模块都在），PC 无页面，且路线图明确不做 | `packages/contracts/src/admin`、`apps/api/src/modules/admin`；PC 侧 `grep -rn 'admin\|Admin' apps/web-pc/src` 只命中 `apps/web-pc/src/lib/redirect.ts:3` 的防逃逸注释与 `apps/web-pc/src/lib/redirect.test.ts:14,:15` 的两条断言；`docs/design/issue-89-web-pc-roadmap.md` §6 `:59`「不把 Admin 页面迁到 `/pc/admin`」（该句原文写的是已被 #325 删除的 `apps/web`） |
| 移动端折叠布局 / PWA / 离线 | 非目标；PC 按桌面视口设计 | roadmap §6 |

### 1.4 密码登录相关能力已整体移除（#391 / #393）

这一类**不是缺口，而是主动下线**，单列以免被误读成欠账：

- 账号密码登录页签、注册页、记住凭据模块已整体删除；`apps/web-pc/src/routes/register.tsx` **已不存在**。
- 登录页现在只有 `ScanLoginPanel`（`apps/web-pc/src/routes/login.tsx:7`、`:61`），页内注释即声明「登录页只提供微信扫码。账号密码与注册已下线（#391）」（`apps/web-pc/src/routes/login.tsx:20-23`），用户协议默认**不勾选**（`:5` 引入、`:26` 消费 `INITIAL_LOGIN_AGREEMENT_ACCEPTED`）。
- 因此「忘记密码 / 重置密码」**不适用**：`grep -rniE '忘记密码|重置密码' apps/web-pc/src` 零命中，无对应路由，`apps/web-pc/src/features/auth/api.ts` 也没有 password / login / register 调用。
- 副作用：扫码无「记住我」，每次进 PC 都要重新扫码。设计依据见 `docs/design/issue-391-web-pc-auth-wechat-only.md`。

---

## 二、已接通但有明确缺口

| 功能 | 缺口 | 证据 |
| --- | --- | --- |
| 通知列表 | 最多 50 条，无分页 / 删除 / 批量已读 | `apps/web-pc/src/features/notifications/api.ts:11`（`NOTIFICATION_PAGE_LIMIT = 50`）、`:13-18` 一次性取列表、`:26` 只有单条 `markNotificationRead`；`notifications-page.tsx:29` 普通 `useNotifications`；全目录无 `markAllRead` / 删除调用 |
| 通知到达时效 | 无 WebSocket，只有 30 秒轮询（**有意为之**） | `apps/web-pc/src/features/notifications/queries.ts:19`（`NOTIFICATION_POLL_INTERVAL_MS = 30_000`）、`:35`（`refetchOnWindowFocus: 'always'`）、`:36,:50`（列表与未读数 `refetchInterval`）；`queries.ts:15-18` 注释注明「T7 §7 明确实时推送为非目标，P0 允许轮询」 |
| 订单号 | 展示的是**公开 ID**（`txn_…`），仍不是面向用户的人工订单号 | `apps/web-pc/src/features/profile/order-detail-page.tsx:113` 渲染 `detail.id`；该字段由 `packages/contracts/src/transactions/schema.ts:6,:46` 的 `TransactionIdSchema`（来自 `../system/public-id`）收口，HTTP 边界上是 TypeID 而非内部 UUID。见 §四第 11 行 |
| 聊天增强 | typing、**转发**、删除、消息搜索均无（撤回已接通，见 §四第 9 行） | `grep -rniE 'typing\|转发\|forward\|消息搜索' apps/web-pc/src/features/chat \| grep -v '\.test\.'` 零命中；不加 `grep -v '\.test\.'` 过滤时只命中 `apps/web-pc/src/features/chat/realtime.test.ts:114` 的英文 `forwards`，不是功能实现。契约 `packages/contracts/src/chat/routes.ts` 仍无对应端点 |
| 评论区 | 已支持发布、单层回复、**删除自己的留言**与**我的留言页**；无多层评论树、编辑、举报、图片留言 | 已接：`apps/web-pc/src/features/listing-detail/{comments-section.tsx,comments-api.ts,comments-queries.ts}`、挂载 `apps/web-pc/src/features/listing-detail/detail-page.tsx:193`（`<CommentsSection listingId={item.id} />`）、游标分页 `comments-queries.ts:13`；单层回复 `comments-section.tsx:216-227`（`comment.replies.map` 渲染 `ReplyRow`，不递归，故只有一层；回复表单 `:229-239`）；删除 `comments-api.ts:65` → `comments-queries.ts:49` → `comments-section.tsx:252,:340`；我的留言 `apps/web-pc/src/features/my-comments/` + 页 `apps/web-pc/src/routes/comments.tsx`。仍无：多层评论树、编辑、图片留言；举报目标类型只有 `LISTING｜USER`（`packages/contracts/src/reports/schema.ts:23`），评论不可举报 |

> **首页商品流不在本表**：`apps/web-pc/src/routes/index.tsx:68,:74` 已支持「加载更多」（`apps/web-pc/src/features/listings/queries.ts:20,:34` 的两处 `useInfiniteQuery` + `:25,:39` 的 `getNextPageParam`，每页 24 条）。

---

## 三、接口已接、当前环境是演示态

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| AI 润色 | `.env.example:38` 默认 `AI_POLISH_TRANSPORT=stub`，返回演示文案；页面挂「演示文案」徽标 | `apps/web-pc/src/features/publish/ai-polish-panel.tsx:57-58`；启动警告 `apps/api/src/index.ts:36-38` |
| 内容安全审核 | `CONTENT_MODERATION_TRANSPORT=local` 走本地词表，不是真实审核；生产禁 local | `packages/shared/src/env.ts:206,235`；启动警告 `apps/api/src/index.ts:43-49` |
| 微信身份 | `.env.example:50` 为 `off`（登录 / 绑定入口关闭）；`stub` 不验证微信签发凭证 | `packages/shared/src/env.ts:137,175`；`apps/web-pc/src/features/auth/scan-login.tsx:353` |
| 视觉向量化 / OCR 解析 | `VISUAL_EMBEDDING_TRANSPORT=stub`；`VISUAL_PARSE_TRANSPORT` 未设置即 `off` | `.env.example:95,110`；配置块 `apps/api/src/index.ts:28-33` |
| 邮件 | `MAIL_TRANSPORT=outbox`，只落本地 outbox、不外发 | `.env.example:20` |

> ⚠️ 这些 transport **都没有默认值**：未显式声明时 API 启动即失败（`packages/shared/src/env.ts` 逐项校验），
> 所以「演示态」是**环境选择**，不是代码兜底。生产启用前必须逐项换成 live / tencent / 真实邮件通道。

---

## 四、本版相对上一版的更正

上一版基线是 `dc195083`（2026-10-01）。以下结论已过期：

| 上一版结论 | 当前实际 | 证据 |
| --- | --- | --- |
| §1.1 收藏：契约、DB、API 齐备，PC 无任何入口 | **已接通** | 页 `apps/web-pc/src/routes/favorites.tsx`（`createFileRoute('/favorites')` → `FavoritesPage`）；模块 `apps/web-pc/src/features/favorites/{api.ts,queries.ts,favorites-page.tsx,favorites-view.tsx}`；入口 `apps/web-pc/src/features/listing-detail/favorite-button.tsx`、`apps/web-pc/src/features/shell/side-nav.tsx`、`apps/web-pc/src/features/profile/profile-page.tsx:243`。支撑提交 `3c7f533c`（2026-10-02，`feat(web-pc): 我的收藏页（/favorites）：游标分页 + 在售/失效分组 + 逐项取消`） |
| §1.1 关注：契约已成 Domain，PC 无任何入口 | **已接通** | 页 `apps/web-pc/src/routes/following.tsx`（`createFileRoute('/following')` → `FollowingPage`）；模块 `apps/web-pc/src/features/follows/{api.ts,queries.ts,follow-button.tsx,following-page.tsx,following-view.tsx}`；入口 `apps/web-pc/src/features/user-profile/user-profile-page.tsx`、`apps/web-pc/src/features/shell/side-nav.tsx`。支撑提交 `db2f16c9`（2026-10-02，`feat(web-pc): follows feature：api/queries/关注钮/我的关注页`） |
| §1.2 交易评价：表在，契约层无任何 review / rating 文件 | **契约与 PC 接线均已落地** | `packages/contracts/src/transaction-reviews/{routes.ts,schema.ts,schema.test.ts}`；`routes.ts` 导出 `TRANSACTION_REVIEW_ROUTES`（`reviewEdge` / `ofTransaction`，两条都 requireAuth）；API `apps/api/src/modules/transaction-reviews`；PC 接线 `apps/web-pc/src/features/profile/order-detail-page.tsx:24`（import `OrderReviewCard`）与 `:216-222`（`detail.status === 'COMPLETED'` 时渲染，组件 `order-review-card.tsx:200`，测试 `order-review-card.test.tsx`）。支撑提交 `f4b654d7`（2026-10-02，`feat(api): 交易评价读写 + /me/comments kind 过滤与合并游标（#195 PR2）`）。`git ls-tree -r --name-only origin/main packages/contracts/src \| grep -icE 'review\|rating'` 现为 **3**，不再是 0 |
| §1.2 浏览历史：契约、API、DB 三处都没有 | **三方齐备且 PC 已接** | 契约 `packages/contracts/src/view-history/{routes.ts,schema.ts}`（`VIEW_HISTORY_ROUTES`；`myViewHistory: '/me/view-history'` 在 `packages/contracts/src/view-history/routes.ts:22`；GET 读 + DELETE 清空）；API `apps/api/src/modules/view-history/{cursor,ingest,router,service,store}.ts`；DB `packages/db/src/schema/view-history.ts`；PC 页 `apps/web-pc/src/routes/history.tsx` + `apps/web-pc/src/features/view-history/`。支撑提交 `0d8cb5bf`（契约，2026-10-02，`feat(contracts): view-history 域（#415 M1）`）、`5a842f3c`（PC 页，2026-10-02） |
| §二 我的发布 / 订单列表：最多 50 条、无分页 | **已转游标翻页** | `apps/web-pc/src/features/profile/queries.ts:121`（`useMyListings`）与 `:133`（`useOrders`）现为 `useInfiniteQuery`（`:124,:136` `initialPageParam: null as string \| null`、`:125,:137` `getNextPageParam`）；消费方 `mylist-page.tsx:259,:269`、`orders-page.tsx:137,:147` 调 `fetchNextPage()`。`apps/web-pc/src/features/profile/api.ts:55,:66` 的 `limit: '50'` 仍在，但已是**每页**上限而非总量上限。支撑提交 `e1216398`（2026-10-04，`feat(web-pc): 我的发布/订单列表转游标翻页（#446）`） |
| §二 只有 `wishId` 的通知：不能跳转，无愿望详情路由 | **已上线** | 路由 `apps/web-pc/src/routes/wish.$wishId.tsx`（`createFileRoute('/wish/$wishId')`）、页 `apps/web-pc/src/features/wish/wish-detail-page.tsx:17`（自述「wishId 通知的落点」）；跳转 `apps/web-pc/src/features/notifications/notifications-page.tsx:97`（`navigate({ to: '/wish/$wishId', params: { wishId } })`）；`apps/web-pc/src/features/notifications/notification-view.ts:137` 注释已改为「`/wish/$wishId` 已上线（#446）；这句只在『预检发现愿望已删/不可见』时出现」。支撑提交 `5ec2eab3`（2026-10-04） |
| §二 商品图片替换：编辑弹窗只改文字 / 价格 / 展示项 | **已交付** | `apps/web-pc/src/features/profile/edit-listing-dialog.tsx` 现有 `ImagePlus`、`startImageEdit()`（`:123`）、`EditImageState`（`:94`）与 `image-model`（`enterImageEditMode` / `existingImagesFromDetail` / `remainingImageSlots` / `uploadListingImage` / `validateImageFile`）；上一版引用的原文「图片替换仍不在 PC 本阶段范围内」（旧 `:131`）已不存在。支撑提交 `3f6259e6`（2026-10-04，`feat(web-pc): 编辑商品弹窗支持图片替换（#446）`） |
| §1.3 个性签名：契约已有该字段，PC 既不渲染也不编辑 | **已接通（编辑 + 展示）** | 编辑 `apps/web-pc/src/features/profile/profile-edit.tsx`（`:28` import `prepareSignatureInput`，`:62,:72,:108-110,:163,:240-255` 字段与错误态）；展示 `apps/web-pc/src/features/profile/profile-page.tsx:107-109`、`apps/web-pc/src/features/user-profile/user-profile-page.tsx:90-92`（后者 `:95` 注释已写「契约的公开 DTO 九个字段（含 #179 的 signature）」）。支撑提交 `fee1dbb6`（`feat(web-pc): 个性签名编辑与展示（#445）`） |
| §二 聊天增强：无 typing、撤回动作、转发、删除、消息搜索 | **撤回已接通**；typing / 转发 / 删除 / 消息搜索仍无 | `apps/web-pc/src/features/chat/api.ts:241`（`recallMessage`，204 无响应体、幂等）、`conversation-page.tsx:226,:232,:274-276`（在途锁 + 成功后重取历史）、`conversation-list-page.tsx:39-40`（撤回后列表摘要必须重取）；契约 `packages/contracts/src/chat/routes.ts:47` 的 `recall` 现已有调用方 |
| §二 评论区：契约已有 `DELETE /comments/:id` 与 `GET /me/comments`，**PC 未用** | **两者均已接通** | 删除 `apps/web-pc/src/features/listing-detail/comments-api.ts:65`（`deleteComment`）→ `comments-queries.ts:49`（`useDeleteComment`）→ `comments-section.tsx:252,:340`（动作入口）；我的留言 `apps/web-pc/src/features/my-comments/api.ts:9`（`myCommentsPath`）+ 页 `apps/web-pc/src/routes/comments.tsx`（`createFileRoute('/comments')` → `MyCommentsPage`） |
| §二 订单号：直接把内部 UUID 当「订单号」展示 | **展示的是公开 ID**（`txn_…`） | `apps/web-pc/src/features/profile/order-detail-page.tsx:113` 渲染 `detail.id`，而该字段由 `packages/contracts/src/transactions/schema.ts:6,:46` 的 `TransactionIdSchema`（来自 `../system/public-id`）收口，HTTP 边界上是 TypeID。`docs/design/issue-89-web-pc-t10-id-inventory.md:22` 登记了这一处（「订单详情显示为『订单号』」）并标注 ✅ 已由 #217 落地满足（PR #280，merge `529ca42a`）；该文件其余内容描述的是 #217 之前的冻结检查表，本版已在其中标注落地结果（见该文件头部与 §4） |

> 上一版 §1.2 下方登记的「两处已过期的代码注释」已在本版修复：`apps/web-pc/src/features/user-profile/view.ts:20-22`
> 与 `packages/contracts/src/users/schema.ts:22-29` 都已改为与现状一致（reviews / ratings 已有表与契约、关注关系已是独立 Domain）。

---

## 五、可复现核对命令

```bash
# 路由与页面清单
ls apps/web-pc/src/routes
ls apps/web-pc/src/features

# 显式的「未接通 / 演示」字样
grep -rn '占位\|未接入\|尚未\|后续版本\|暂未\|演示\|fixture\|mock\|stub' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# 上一版曾断言「零命中」、现在应当**有**命中的反向断言（用于验证本版更正）
grep -rln 'favorite\|收藏' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'   # 收藏已接线
grep -rln 'follow\|关注' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'     # 关注已接线
grep -rln 'REPORT_ROUTES' apps/web-pc/src --include='*.ts' --include='*.tsx'   # 举报已接线
grep -rln 'USER_ROUTES' apps/web-pc/src --include='*.ts' --include='*.tsx'     # 他人主页已接线
test -f apps/web-pc/src/routes/register.tsx || echo 'register.tsx 已删除（#391）'
grep -rniE 'refetchInterval' apps/web-pc/src/features/notifications            # 通知轮询已接线
test -f apps/web-pc/src/routes/wish.\$wishId.tsx || echo '愿望详情已上线（#446）'

# 后端与契约不再缺项（§1.2 已清空）
ls packages/contracts/src | grep -iE 'history|view-history|transaction-reviews'
ls apps/api/src/modules | grep -iE 'view-history|transaction-reviews'
git ls-tree -r --name-only origin/main packages/contracts/src | grep -icE 'review|rating'   # 3（不再是 0）

# 分页能力对比：有 useInfiniteQuery / getNextPageParam 的地方才算真分页
grep -rn 'useInfiniteQuery\|getNextPageParam\|fetchNextPage' apps/web-pc/src

# §二 仍存在的缺口（以下两条应零命中）
grep -rn 'typing\|转发\|forward\|消息搜索' apps/web-pc/src/features/chat | grep -v '\.test\.'   # 零命中；不加过滤会命中 realtime.test.ts 的英文 "forwards"
grep -rn 'markAllRead\|deleteNotification' apps/web-pc/src/features/notifications   # 零命中
```

---

## 六、结论来源

- 各任务设计文档的「非目标」章节：`docs/design/issue-89-web-pc-t*.md`。
- 路线图明确不做项：`docs/design/issue-89-web-pc-roadmap.md` §6。
- ID / 编号边界：#217（已 CLOSED，实现见 PR #280），见 `docs/design/issue-89-web-pc-t10-id-inventory.md`。
- 认证口径变更：#391，见 `docs/design/issue-391-web-pc-auth-wechat-only.md`。
- Watchers 口径：#74，见 `docs/design/issue-74-watchers-definition.md`。
- 匹配算法 v2：#322，见 `docs/design/issue-322-matching-v2-m1.md` ~ `docs/design/issue-322-matching-v2-m3.md`。
- 本次刷新（2026-10-05，基线 `58a9e5f1`）另据已合入的 PC 接线 PR：#446（游标翻页 / 愿望详情 / 图片替换）、
  #445（个性签名）、#195 PR2（交易评价契约 / 留言删除）、#415（浏览历史）、#391（密码登录下线）。

---

_由 AI agent 协助完成（DSH / deepseek-flash）。_
