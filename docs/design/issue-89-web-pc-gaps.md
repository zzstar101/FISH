# PC Web 未接通能力盘点

> **基线**：`origin/main = 89a09401`（2026-10-04 实测）。
> **上一版**：`dc195083`（2026-10-01，PR #369）。此后 10-01～10-04 合入了收藏 / 关注 / 浏览历史 /
> 我的评论 / 商品删除 / 留言删除 / 消息撤回等十余张 PC 接线 PR，上一版列出的多项「未接通」已被推翻，逐条更正见 §四。
> **口径**：只核对 `apps/web-pc` 的实际代码，不采信规划文档的承诺。
> - 「完全未接通」= PC 端在该基线里没有实现、也没有入口。
> - 「有缺口」= 已接真实 API，但能力不完整（分页、深链、类型等）。
> - 「演示态」= 前端已接真实接口，但当前环境开关让它返回演示结果。
> - **「在飞 PR（未合入）」不算现状**：只写在缺口行里并显式标注，合入后需再核对一次（本仓既有教训：把未合入代码当现状写进基线文档）。
>
> **证据路径**均相对仓库根；行号对应该基线，代码改动后需重新核对。行号可用 `sed -n '<行>p' <文件>` 复现。

---

## 一、完全未接通（PC 无入口 / 无实现）

### 1.1 后端已就绪，只差 PC 接线

当前基线上**没有已合入的**此类缺口；下面两项由在飞 PR 覆盖，合入前仍按「未接通」计：

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 交易评价**写**入口 | 契约与 API 已就绪（#405）：评价边 `GET\|POST /transactions/:id/review`、三档枚举 + 可空 ≤200 评语、错误码 5 个。PC 侧 `apps/web-pc/src/features/profile/api.ts` **无任何 review 函数**（订单详情没有「评价」按钮）；`features/my-comments` 只读展示 | 契约 `packages/contracts/src/transaction-reviews/{routes.ts,schema.ts}`；API `apps/api/src/modules/transactions`。**在飞 PR #448（未合入）** 覆盖此项 |
| 个性签名展示与编辑 | 契约已有（#179）：`Me.signature` + 公开 DTO `signature` + `PATCH /profile` 的 `signature` 字段（trim / ≤200 / 空=清空）。PC 既不渲染也不编辑 | `packages/contracts/src/auth/user.ts:39`、`packages/contracts/src/profile/schema.ts:112`（`SignatureSchema`）；`apps/web-pc/src/features/profile/profile-edit.tsx` 只处理 nickname + avatar。**在飞 PR #448（未合入）** 覆盖此项 |

### 1.2 后端本身未实现（DB 表在，但无契约 / 无 API 模块）—— 不是 PC 单独的欠账

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 商品市场计数（浏览 / 想要） | 契约与 DB **都没有**：`viewCount` / `wantCount` 在 contracts 与 db schema 全无命中；列表卡与详情页的数字整块画不出来 | `git ls-tree -r --name-only origin/main packages/contracts/src`、`packages/db/src/schema` 均无对应文件；票 **#192**（无 assignee）。注：`wishes/schema.ts` 的 `wantCount` 是**愿望池聚合**，不是商品维度，别混 |

> 上一版把「浏览历史」「交易评价」列在本节，两者如今**后端均已就绪**（浏览历史 #418 M1；交易评价 #405），见 §四。

### 1.3 其它未接通（PC 无入口，非本阶段目标）

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 手机号绑定 | 个人中心只展示绑定状态，无绑定操作（且**契约链路起点在小程序** `<button open-type="getPhoneNumber">`，PC 产不出 code，属「做不了」而非「没做」） | `apps/web-pc/src/features/profile/profile-page.tsx:111`（非测试代码里「手机号」仅此 1 行）；`packages/contracts/src/auth/phone.ts` |
| 设置页（主题 / 通知偏好 / 协议 / 隐私） | 无该路由 | `ls apps/web-pc/src/routes` 无 `settings*`；`grep -rn 'settings\|主题\|通知偏好' apps/web-pc/src` 只命中 `apps/web-pc/src/routes/login.tsx`《隐私政策》与样式文件注释 |
| 分享 / 复制商品链接 | 有通用复制能力（唯一调用方是复制**商品编号**，#382），但无「分享」入口 | `apps/web-pc/src/lib/copy-text.ts`（`copyText`）、`apps/web-pc/src/features/listing-detail/listing-no-line.tsx`；全仓无 `navigator.share` |
| Admin 控制台 / 审核队列 | **后端已就绪**（契约与 API 模块都在），PC 无页面，且路线图明确不做 | `packages/contracts/src/admin`、`apps/api/src/modules/admin`；PC 侧 `grep -rn 'admin\|Admin' apps/web-pc/src` 只命中 `apps/web-pc/src/lib/redirect.ts` 的防逃逸注释；`docs/design/issue-89-web-pc-roadmap.md` §6 |
| 移动端折叠布局 / PWA / 离线 | 非目标；PC 按桌面视口设计 | roadmap §6 |

### 1.4 密码登录相关能力已整体移除（#391 / #393）

这一类**不是缺口，而是主动下线**，单列以免被误读成欠账：

- 账号密码登录页签、注册页、记住凭据模块已整体删除；`apps/web-pc/src/routes/register.tsx` **已不存在**。
- 登录页现在只有 `ScanLoginPanel`（`apps/web-pc/src/routes/login.tsx`），页内注释即声明「登录页只提供微信扫码。账号密码与注册已下线（#391）」，用户协议默认**不勾选**（`INITIAL_LOGIN_AGREEMENT_ACCEPTED`）。
- 因此「忘记密码 / 重置密码」**不适用**：`grep -rniE '忘记密码|重置密码' apps/web-pc/src` 零命中，无对应路由，`apps/web-pc/src/features/auth/api.ts` 也没有 password / login / register 调用。
- 副作用：扫码无「记住我」，每次进 PC 都要重新扫码。设计依据见 `docs/design/issue-391-web-pc-auth-wechat-only.md`。

---

## 二、已接通但有明确缺口

| 功能 | 缺口 | 证据 |
| --- | --- | --- |
| 我的发布 | 最多 50 条，无分页 | `apps/web-pc/src/features/profile/api.ts:47` 硬编码 `limit: '50'`；`mylist-page.tsx:58` 用普通 `useMyListings`，`:96` 页头自述「最多显示 50 条」。**在飞 PR #450（未合入）** 转游标翻页 |
| 订单列表 | 最多 50 条；接口支持 `cursor` 但页面不传 | `apps/web-pc/src/features/profile/api.ts:58`（`transactionsPath` 已声明 cursor 参数，页面不传）；`orders-page.tsx:56` 普通 `useOrders`，`:69` 同款页头文案。**在飞 PR #450（未合入）** 同上 |
| 通知列表 | 最多 50 条；无删除 / 批量已读 | `apps/web-pc/src/features/notifications/api.ts:11`（`NOTIFICATION_PAGE_LIMIT = 50`）。**删除 / 批量已读是后端缺**：`apps/api/src/modules/notifications/router.ts` 只有 `GET /`、`GET /unread-count`、`POST /:id/read` 三个端点；通知列表契约也没有 cursor（P0 有意取舍） |
| 通知到达时效 | 无 WebSocket，只有 30 秒轮询（**有意为之**） | `apps/web-pc/src/features/notifications/queries.ts`（`NOTIFICATION_POLL_INTERVAL_MS = 30_000` + `refetchOnWindowFocus`）；契约 WS 只推 `message.new` / `typing`，无 notification 事件类型 |
| 只有 `wishId` 的通知 | 不能跳对应愿望，只提示「后续版本开放」 | `apps/web-pc/src/features/notifications/notification-view.ts:137` 回落成文案；`apps/web-pc/src/routes` 无 `/wish/$wishId` 详情路由（`features/wish/api.ts` 的 `fetchWish` 是**孤儿函数**，零调用方）。**在飞 PR #450（未合入）** 补详情路由 + 预检跳转 |
| 商品图片替换 | 编辑弹窗只改文字 / 价格 / 展示项 | `apps/web-pc/src/features/profile/edit-listing-dialog.tsx:131`（自述「图片替换仍不在 PC 本阶段范围内」）；契约 `ListingUpdateInput.objectKeys` 早已支持全量替换。**在飞 PR #450（未合入）** 覆盖 |
| 聊天增强 | typing、转发、删除、消息搜索均无 | 四项 grep 零命中。**撤回动作已接通**（#424）：入口 `apps/web-pc/src/features/chat/message-bubble.tsx:82`（悬停显形）+ `apps/web-pc/src/features/chat/api.ts:247`（`recallMessage`） |
| 评论区 | 已支持发布 / 单层回复 / **删除自己的留言与回复**（#423）；无多层评论树、编辑、图片留言 | 已接：`apps/web-pc/src/features/listing-detail/{comments-section.tsx,comments-api.ts,comments-queries.ts}`（`comments-api.ts:67` 的 `DELETE /comments/:id`）、挂载 `detail-page.tsx`。举报目标类型只有 `LISTING｜USER`（`packages/contracts/src/reports/schema.ts`），**评论不可举报**（契约限制，非 PC 欠账） |

> **首页商品流不在本表**：`apps/web-pc/src/routes/index.tsx` 已支持「加载更多」（`apps/web-pc/src/features/listings/queries.ts` 的 `useInfiniteQuery`，每页 24 条）。

---

## 三、接口已接、当前环境是演示态

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| AI 润色 | `.env.example:38` 默认 `AI_POLISH_TRANSPORT=stub`，返回演示文案；页面挂「演示文案」徽标 | `apps/web-pc/src/features/publish/ai-polish-panel.tsx`；启动警告 `apps/api/src/index.ts:36` |
| 内容安全审核 | `.env.example:65` 为 `CONTENT_MODERATION_TRANSPORT=local`，走本地词表，不是真实审核；生产禁 local | `apps/api/src/index.ts:25`；`packages/shared/src/env.ts` |
| 微信身份 | `.env.example:50` 为 `WECHAT_TRANSPORT=off`（登录 / 绑定入口关闭）；`stub` 不验证微信签发凭证 | `apps/api/src/index.ts:22`；`apps/web-pc/src/features/auth/scan-login.tsx` |
| 视觉向量化 / OCR 解析 | `.env.example:95` 为 `VISUAL_EMBEDDING_TRANSPORT=stub`；`VISUAL_PARSE_TRANSPORT` 未设置即 `off` | `apps/api/src/index.ts:28-31`；`.env.example:110-113`（live 的 baseUrl / apiKey / model 注释项） |
| 邮件 | `.env.example:20` 为 `MAIL_TRANSPORT=outbox`，只落本地 outbox、不外发 | `packages/shared/src/env.ts`（resend 必须同时配 `RESEND_API_KEY` / `RESEND_FROM`） |

> ⚠️ 这些 transport **都没有默认值**：未显式声明时 API 启动即失败（`packages/shared/src/env.ts` 逐项校验），
> 所以「演示态」是**环境选择**，不是代码兜底。生产启用前必须逐项换成 live / tencent / 真实邮件通道。

---

## 四、本版相对上一版（`dc195083`）的更正

上一版列出的以下结论已过期（10-01～10-04 合入）：

| 上一版结论 | 当前实际 | 证据 |
| --- | --- | --- |
| §1.1 收藏：契约与 API 齐备、PC 无入口 | **已接通**（#400） | 页 `apps/web-pc/src/routes/favorites.tsx`、模块 `apps/web-pc/src/features/favorites/`（我的收藏页）；详情页收藏心 `apps/web-pc/src/features/listing-detail/favorite-button.tsx`；个人中心收藏计数卡 |
| §1.1 关注：契约成 Domain、PC 无入口 | **已接通**（#413） | 页 `apps/web-pc/src/routes/following.tsx`、模块 `apps/web-pc/src/features/follows/`；他人主页关注钮；个人中心关注计数卡 |
| §1.2 浏览历史：契约 / API / DB 三处都没有 | **三处齐备且 PC 已接通**（M1 #418 / M2 #419） | 页 `apps/web-pc/src/routes/history.tsx`、模块 `apps/web-pc/src/features/view-history/`（按天分组 + 清空）；契约 `packages/contracts/src/view-history/`、API `apps/api/src/modules/view-history`、表 `listing_view_history` |
| §1.2 交易评价：契约层无 review / rating 文件 | **契约与 API 已就绪**（#405）；PC 读侧已接（#440 我的评论页），**写入口在飞 #448（未合入）** | 契约 `packages/contracts/src/transaction-reviews/`、`/me/comments?kind=review`；页 `apps/web-pc/src/routes/comments.tsx`、模块 `apps/web-pc/src/features/my-comments/` |
| §1.3 个性签名：契约有、PC 不渲染不编辑 | **仍未接**；写/读两端由**在飞 PR #448（未合入）** 覆盖 | `apps/web-pc/src/features/profile/profile-edit.tsx` 仍只处理 nickname + avatar |
| §二 订单号：直接把内部 UUID 展示 | **过期**：`TransactionDto.id` 是 `txn_` 公开 ID（`PUBLIC_ID_PREFIX.transaction = 'txn'`），订单详情显示的就是它 | `packages/shared/src/public-id.ts:11`、`packages/contracts/src/system/public-id.ts:17` |
| §二 聊天增强：撤回无入口 | **撤回动作已接通**（#424）；typing / 转发 / 删除 / 消息搜索仍无 | `apps/web-pc/src/features/chat/message-bubble.tsx:82`、`apps/web-pc/src/features/chat/api.ts:247` |
| §二 评论区：无删除 | **删除自己的留言与回复已接通**（#423） | `apps/web-pc/src/features/listing-detail/comments-api.ts:67` |
| （上一版未列） | **商品删除已接通**（#421 / #426）：入口 `apps/web-pc/src/features/profile/mylist-page.tsx:221`。口径窄——只有「未过审且无交易记录」可删，否则 409 `LISTING_NOT_DELETABLE` | `apps/web-pc/src/features/profile/{api.ts 的 deleteListing, mylist-page.tsx}` |
| （上一版未列） | **「我的评论」页已接通**（#422 / #440）：`/comments` 留言 / 评价分段 + 游标分页 | 页 `apps/web-pc/src/routes/comments.tsx`、模块 `apps/web-pc/src/features/my-comments/` |
| （上一版未列） | **交易取消 / 确认已在 PC**（#378 一并交付）：`apps/web-pc/src/features/profile/api.ts:148,:154`（`confirmTransaction` / `cancelTransaction`）+ 订单详情按钮 | 同文件与 `order-detail-page.tsx` |

> **在飞未合入（不计入现状，合入后复核）**：PR #448（#445 评价写入口 + 签名）、PR #450（#446 列表翻页 + `/wish/$wishId` + 编辑换图）、PR #449（清理 `apps/api` 测试的 4 处 lint 告警，非功能）。
>
> **两处已过期的代码注释**（仅登记，非本 PR 修复范围）：`apps/web-pc/src/features/user-profile/view.ts:19-20` 与 `packages/contracts/src/users/schema.ts:22` 仍写「仓库没有 reviews / ratings 表」——表与契约如今都在；同文件 `:24` 的「关注关系已拆成 follows Domain」反而是准确的。

---

## 五、可复现核对命令

```bash
# 路由与页面清单
ls apps/web-pc/src/routes
ls apps/web-pc/src/features

# 显式的「未接通 / 演示」字样
grep -rn '占位\|未接入\|尚未\|后续版本\|暂未\|演示\|fixture\|mock\|stub' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# 上一版曾断言「零命中」、现在应当**有**命中的反向断言（验证 §四 的更正）
grep -rln 'FAVORITE_ROUTES\|favoriteRelation' apps/web-pc/src --include='*.ts' --include='*.tsx'   # 收藏已接线
grep -rln 'FOLLOW_ROUTES\|/me/following' apps/web-pc/src --include='*.ts' --include='*.tsx'       # 关注已接线
ls apps/web-pc/src/features/view-history                                                          # 浏览历史已接线
ls apps/web-pc/src/features/my-comments                                                           # 我的评论已接线
ls packages/contracts/src/transaction-reviews                                                     # 评价契约已就绪
grep -rln 'recallMessage' apps/web-pc/src/features/chat                                           # 撤回已接线
grep -rln 'deleteListing' apps/web-pc/src/features/profile                                        # 商品删除已接线

# 当前仍是缺口（本版 §一 / §二 的锚点）
grep -n 'limit' apps/web-pc/src/features/profile/api.ts | head -3        # 47/:58 仍硬编码 50
grep -rn 'fetchWish' apps/web-pc/src --include='*.ts*' | grep -v test    # 孤儿函数（无页面消费者）
grep -rn 'review' apps/web-pc/src/features/profile/api.ts                # 写入口缺口锚点（#448 合入后应命中）
ls apps/web-pc/src/routes | grep -E 'settings|wish\.'                    # 设置页缺 / wish 详情缺（#450 合入后应出现 wish.$wishId）
```

---

## 六、结论来源

- 各任务设计文档的「非目标」章节：`docs/design/issue-89-web-pc-t*.md`。
- 路线图明确不做项：`docs/design/issue-89-web-pc-roadmap.md` §6。
- ID / 编号边界：#217，见 `docs/design/issue-89-web-pc-t10-id-inventory.md`。
- 认证口径变更：#391，见 `docs/design/issue-391-web-pc-auth-wechat-only.md`。
- Watchers 口径：#74，见 `docs/design/issue-74-watchers-definition.md`。
- 匹配算法 v2：#322，见 `docs/design/issue-322-matching-v2-m1.md` ~ `m3.md`。
- 本次刷新（2026-10-04，基线 `89a09401`）另据 10-01～10-04 合入的 PC 接线 PR（#400/#413/#419/#426/#427/#428/#440 等）与在飞 PR #448 / #450 的范围核对。

---

_由 AI agent 协助完成（ZCode / GLM）。_
