# PC Web 未接通能力盘点

> **基线**：`origin/main = dc195083be76d9f261dca36b5562b84c7a85aeb1`（2026-10-01 实测）。
> **上一版**：本分支 @ `b641fd7`（2026-09-30，PR #369 初版）。此后第 6 阶段（PC 业务能力）与第 9 阶段整体落库，
> 上一版列出的「未接通」有十四项已被推翻，逐条更正见 §四。
> **口径**：只核对 `apps/web-pc` 的实际代码，不采信规划文档的承诺。
> - 「完全未接通」= PC 端在该基线里没有实现、也没有入口。
> - 「有缺口」= 已接真实 API，但能力不完整（分页、深链、类型等）。
> - 「演示态」= 前端已接真实接口，但当前环境开关让它返回演示结果。
>
> **证据路径**均相对仓库根；行号对应该基线，代码改动后需重新核对。行号可用 `sed -n '<行>p' <文件>` 复现。

---

## 一、完全未接通（PC 无入口 / 无实现）

### 1.1 后端已就绪，只差 PC 接线

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 收藏 | 契约、DB、API 三件齐备，小程序已接（#397），PC 无任何入口 | 契约 `packages/contracts/src/favorites/routes.ts:21`（`GET /me/favorites`）、`:28`（`GET/POST/DELETE /listings/:id/favorite`）+ `packages/contracts/src/favorites/schema.ts`；`packages/db/src/schema/favorites.ts`；`apps/api/src/modules/favorites`。PC 侧非测试代码 `grep -rn '收藏\|favorite' apps/web-pc/src` **零命中**（唯一命中是 `apps/web-pc/src/features/watchers/watchers-panel-view.test.tsx:52` 的注释），`apps/web-pc/src/features` 无 `favorites` |
| 关注 | `follows` 契约已成 Domain，PC 无任何入口 | 契约 `packages/contracts/src/follows/routes.ts:20`（`:28` `GET /me/following`、`:35` `POST/DELETE /users/:userId/follow`）+ `schema.ts`；`packages/db/src/schema/follows.ts`；`apps/api/src/modules/follows`。PC 侧 `grep -rn 'follow\|关注' apps/web-pc/src`（非测试）**只命中 2 行注释**（`apps/web-pc/src/features/user-profile/view.ts:19-20`），无任何调用 —— 且那两行注释本身已过期（见 §1.2 注） |

### 1.2 后端本身未实现（DB 表在，但无契约 / 无 API 模块）—— 不是 PC 单独的欠账

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 浏览历史 | 契约、API、DB 三处都没有，PC 亦无该功能 | `packages/contracts/src` 无 history 目录、`apps/api/src/modules` 无 history、`packages/db/src/schema` 无 history 表（三处 `ls` 均无）。PC 侧 `history` 命中全部是**聊天消息历史**（`apps/web-pc/src/features/chat/conversation-page.tsx:109-110` 的 `useMessageHistory` / `useMediaHistory`） |
| 交易评价 | 表在，契约层无任何 review / rating 文件 | 表：`packages/db/src/schema/transaction-reviews.ts`；`git ls-tree -r --name-only origin/main packages/contracts/src \| grep -icE 'review\|rating'` → **0**。旁证：`packages/contracts/src/users/schema.ts:22` 的 `goodRate` 条写「仓库没有 reviews / ratings 表，**没有真实口径**，不编造」——**「没有表」这句字面已过期**（表文件存在），但「没有真实口径」的结论仍成立：该表没有对应契约 / DTO / 端点，好评率依旧无处可取 |

> **两处已过期的代码注释**（本次核对的副产物，非本 PR 修复范围，仅登记）：
> 1. `apps/web-pc/src/features/user-profile/view.ts:19-20` 写「契约的公开 DTO 只有七个字段…仓库没有 reviews 表、**关注关系未拆 Domain**」——后半句已被 #188 / #360 推翻（`packages/contracts/src/follows/` 已是独立 Domain），前半句「没有 reviews 表」也已字面过期。
> 2. `packages/contracts/src/users/schema.ts:22` 同上（「仓库没有 reviews / ratings 表」）。同文件 `:24-26` 的「关注关系已按 #188 拆成独立的 follows Domain」反而是**准确的**——即同一个仓库里两处注释对同一事实给出了相反描述。

### 1.3 其它未接通（PC 无入口，非本阶段目标）

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 手机号绑定 | 个人中心只展示绑定状态，无绑定操作 | `apps/web-pc/src/features/profile/profile-page.tsx:94`（非测试代码里「手机号」仅此 1 行） |
| 设置页（主题 / 通知偏好 / 协议 / 隐私） | 无该路由 | `ls apps/web-pc/src/routes` 无 `settings*`；`grep -rn 'settings\|主题\|通知偏好' apps/web-pc/src` 只命中 `apps/web-pc/src/routes/login.tsx:56`《隐私政策》与样式文件注释 |
| 分享 / 复制商品链接 | 有通用复制能力，但无「分享」入口 | `apps/web-pc/src/lib/copy-text.ts:5`（`copyText`），唯一调用方是 `apps/web-pc/src/features/listing-detail/listing-no-line.tsx:20`（复制商品编号）；全仓无 `navigator.share` |
| 个性签名展示与编辑 | 契约已有该字段，PC 既不渲染也不编辑 | `Me.signature` 见 `packages/contracts/src/users/schema.ts`（#179）；`apps/web-pc/src/features/profile/profile-edit.tsx:59,:92-152` 只处理 nickname + avatar |
| Admin 控制台 / 审核队列 | **后端已就绪**（契约与 API 模块都在），PC 无页面，且路线图明确不做 | `packages/contracts/src/admin`、`apps/api/src/modules/admin`；PC 侧 `grep -rn 'admin\|Admin' apps/web-pc/src` 只命中 `apps/web-pc/src/lib/redirect.ts:3` 的防逃逸注释；`docs/design/issue-89-web-pc-roadmap.md` §6「不把 `apps/web` 的 Admin 页面迁到 `/pc/admin`」 |
| 移动端折叠布局 / PWA / 离线 | 非目标；PC 按桌面视口设计 | roadmap §6 |

### 1.4 密码登录相关能力已整体移除（#391 / #393）

这一类**不是缺口，而是主动下线**，单列以免被误读成欠账：

- 账号密码登录页签、注册页、记住凭据模块已整体删除；`apps/web-pc/src/routes/register.tsx` **已不存在**。
- 登录页现在只有 `ScanLoginPanel`（`apps/web-pc/src/routes/login.tsx:7`、`:61`），页内注释即声明「登录页只提供微信扫码。账号密码与注册已下线（#391）」（`apps/web-pc/src/routes/login.tsx:21-23`），用户协议默认**不勾选**（`:5` 引入、`:26` 消费 `INITIAL_LOGIN_AGREEMENT_ACCEPTED`）。
- 因此「忘记密码 / 重置密码」**不适用**：`grep -rniE '忘记密码\|重置密码' apps/web-pc/src` 零命中，无对应路由，`apps/web-pc/src/features/auth/api.ts` 也没有 password / login / register 调用。
- 副作用：扫码无「记住我」，每次进 PC 都要重新扫码。设计依据见 `docs/design/issue-391-web-pc-auth-wechat-only.md`。

---

## 二、已接通但有明确缺口

| 功能 | 缺口 | 证据 |
| --- | --- | --- |
| 我的发布 | 最多 50 条，无分页 | `apps/web-pc/src/features/profile/api.ts:47` 硬编码 `limit: '50'`；`apps/web-pc/src/features/profile/queries.ts` 无 `useInfiniteQuery`，`mylist-page.tsx:47` 用普通 `useMyListings` |
| 订单列表 | 最多 50 条；接口支持 `cursor` 但页面不传 | `apps/web-pc/src/features/profile/api.ts:58`（`:61` 虽声明 cursor 参数，页面不传）；`orders-page.tsx:56` 普通 `useOrders` |
| 通知列表 | 最多 50 条，无分页 / 删除 / 批量已读 | `apps/web-pc/src/features/notifications/api.ts:11`（`NOTIFICATION_PAGE_LIMIT = 50`）、`:13-18` 一次性取列表、`:26` 只有单条 `markRead`；`notifications-page.tsx:25` 普通 `useNotifications` |
| 通知到达时效 | 无 WebSocket，只有 30 秒轮询（**有意为之**） | `apps/web-pc/src/features/notifications/queries.ts:16`（`NOTIFICATION_POLL_INTERVAL_MS = 30_000`）、`:32`（`refetchOnWindowFocus: 'always'`）、`:33,:47`（列表与未读数 `refetchInterval`）；`queries.ts:12-16` 注释注明「T7 §7 明确实时推送为非目标，P0 允许轮询」 |
| 只有 `wishId` 的通知 | 不能跳对应愿望，只提示「后续版本开放」 | `apps/web-pc/src/features/notifications/notification-view.ts:33-34` 解析出 `{ kind: 'wish', wishId }`，`:137` 回落成文案；`apps/web-pc/src/routes` 无 `/wishes/$wishId` 详情路由 |
| 订单号 | 直接把内部 UUID 当「订单号」展示 | `apps/web-pc/src/features/profile/order-detail-page.tsx:112`；见 `docs/design/issue-89-web-pc-t10-id-inventory.md`（#217 必办） |
| 商品图片替换 | 编辑弹窗只改文字 / 价格 / 展示项 | `apps/web-pc/src/features/profile/edit-listing-dialog.tsx:131`（原文自述「图片替换仍不在 PC 本阶段范围内」） |
| 聊天增强 | typing、**撤回动作**、转发、删除、消息搜索均无 | 四项 grep 零命中；撤回只有「撤回碑」渲染（`apps/web-pc/src/features/chat/message-bubble.tsx:104`）与实时失效处理（`conversation-page.tsx:259`），动作入口在 `message-bubble.tsx:101` 自述不在本 Issue 范围（「会话页的撤回入口本身不在本 Issue 范围（PC 只负责不再画空泡）」）；契约 `packages/contracts/src/chat/routes.ts:47` 已有 `recall`，**PC 无调用方** |
| 评论区 | 已支持发布与单层回复；无多层评论树、编辑、删除、举报、图片留言 | 已接：`apps/web-pc/src/features/listing-detail/{comments-section.tsx,comments-api.ts,comments-queries.ts}`、挂载 `detail-page.tsx:31`、游标分页 `comments-queries.ts:13`；单层回复 `comments-section.tsx:148-153`。契约其实已有 `DELETE /comments/:id` 与 `GET /me/comments`（`packages/contracts/src/comments/routes.ts`），**PC 未用**；举报目标类型只有 `LISTING｜USER`（`packages/contracts/src/reports/schema.ts:23`），评论不可举报 |

> **首页商品流不在本表**：`apps/web-pc/src/routes/index.tsx:68,:74` 已支持「加载更多」（`apps/web-pc/src/features/listings/queries.ts:18` 的 `useInfiniteQuery` + `:23` 的 `getNextPageParam`，每页 24 条）。

---

## 三、接口已接、当前环境是演示态

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| AI 润色 | `.env.example:38` 默认 `AI_POLISH_TRANSPORT=stub`，返回演示文案；页面挂「演示文案」徽标 | `apps/web-pc/src/features/publish/ai-polish-panel.tsx:57-58`；启动警告 `apps/api/src/index.ts:31` |
| 内容安全审核 | `CONTENT_MODERATION_TRANSPORT=local` 走本地词表，不是真实审核；生产禁 local | `packages/shared/src/env.ts:206,235`；`apps/api/src/index.ts:44` |
| 微信身份 | `.env.example:50` 为 `off`（登录 / 绑定入口关闭）；`stub` 不验证微信签发凭证 | `packages/shared/src/env.ts:137,175`；`apps/web-pc/src/features/auth/scan-login.tsx:353` |
| 视觉向量化 / OCR 解析 | `VISUAL_EMBEDDING_TRANSPORT=stub`；`VISUAL_PARSE_TRANSPORT` 未设置即 `off` | `.env.example:95,110`；`apps/api/src/index.ts:33-38` |
| 邮件 | `MAIL_TRANSPORT=outbox`，只落本地 outbox、不外发 | `.env.example:20` |

> ⚠️ 这些 transport **都没有默认值**：未显式声明时 API 启动即失败（`packages/shared/src/env.ts` 逐项校验），
> 所以「演示态」是**环境选择**，不是代码兜底。生产启用前必须逐项换成 live / tencent / 真实邮件通道。

---

## 四、本版相对上一版的更正

上一版基线是 `b641fd7`。以下十四项结论已过期：

| 上一版结论 | 当前实际 | 证据 |
| --- | --- | --- |
| §1.1 举报：后端就绪、PC 无入口（#367） | **已接通** | 页 `apps/web-pc/src/routes/reports.tsx:4`、模块 `apps/web-pc/src/features/reports/api.ts:1`；入口 `apps/web-pc/src/features/listing-detail/detail-page.tsx:208`「举报商品」、`:258`「举报该用户」、`apps/web-pc/src/features/chat/conversation-page.tsx:545`、`apps/web-pc/src/features/profile/profile-page.tsx:144` |
| §1.1 他人主页：后端就绪、PC 无入口（#368） | **已接通** | 页 `apps/web-pc/src/routes/users.$userId.tsx:4`、模块 `apps/web-pc/src/features/user-profile/api.ts:18,:35`；商品详情卖家块已可点 `apps/web-pc/src/features/listing-detail/detail-page.tsx:222-225`；匿名白名单 `apps/web-pc/src/routes/__root.tsx:46` |
| §1.2 收藏：契约与 API 都没有 | **后端三件齐备**，只剩 PC 接线 → 移入 §1.1 | `packages/contracts/src/favorites/routes.ts:21,:28`、`packages/contracts/src/favorites/schema.ts`、`packages/db/src/schema/favorites.ts`、`apps/api/src/modules/favorites` |
| §1.2 Watchers（想要）：无表、无契约 | **已接通**；契约在 **chat 域**（`chatWatchersQuerySchema`），PC 入口是「谁想要」 | 契约 `packages/contracts/src/chat/schema.ts:363,:369` + `packages/contracts/src/chat/routes.ts:26`；API `apps/api/src/modules/conversations`（watchers-router）；PC `apps/web-pc/src/features/watchers/{api.ts:21,watchers-dialog.tsx:13}`，入口 `apps/web-pc/src/features/profile/mylist-page.tsx:169`。**仍无独立 watchers 表**（数据源自 conversations），故「无表」半句成立 |
| §1.3 校园认证：PC 无入口，只有注册页文案 | **已接通** | 页 `apps/web-pc/src/routes/verify.tsx:4`、模块 `apps/web-pc/src/features/verify/{verify-page.tsx,api.ts:23}`（#380）；入口 `apps/web-pc/src/features/profile/profile-page.tsx:78-81`、`apps/web-pc/src/features/shell/top-bar.tsx:103`。旧证据 `routes/register.tsx:57` **文件已不存在** |
| §1.3 忘记密码 / 重置密码：无路由、无入口 | **不适用**：整条密码登录已按 #391 移除 → 见 §1.4 | `apps/web-pc/src/routes/login.tsx:21-23` 自述「账号密码与注册已下线」；`apps/web-pc/src/routes/register.tsx` 已删除 |
| §1.4 消息图片 / 语音：PC 接线在 PR #351（open） | **已合入** | `apps/web-pc/src/features/chat/media.ts:290`（MediaRecorder 录音）、`message-bubble.tsx:184,:220`（图片 / 语音气泡）、`conversation-page.tsx:691-698`、`api.ts:218` |
| §1.4 个性签名：PC 未接，在 PR #345（open） | PR 已合，**PC 仍无展示位** → 缺口保留在 §1.3 | `apps/web-pc/src/features/profile/profile-edit.tsx:59,:92-152` 只改 nickname + avatar |
| §1.4 关注：未拆 Domain，在 PR #360（open） | **契约已成 Domain**，PC 仍无入口 → 缺口移入 §1.1 | `packages/contracts/src/follows/routes.ts:20,:28,:35`、`packages/db/src/schema/follows.ts`、`apps/api/src/modules/follows` |
| §二 通知实时推送：无 WebSocket、无轮询 | **已接 30s 轮询**（仍无 WebSocket） → 缺口改写后留在 §二 | `apps/web-pc/src/features/notifications/queries.ts:16,:32,:33,:47` |
| §二 面交码：只有「确认完成面交」，无凭证 | **已接通**（面交二维码 + 核销） | `apps/web-pc/src/features/profile/meetup-panel.tsx:110,:137,:164`、`api.ts:182,:190,:199,:208`、`qr.ts`；`order-detail-page.tsx:22` 引用（#176） |
| §二 搜索公开编号（#217）：只支持关键词 | **已接通按编号精确查** | `apps/web-pc/src/features/search/number-lookup.ts:38`（`findListingByNumber`）、`:63`（`/listings/by-number/…`）、`number-lookup-panel.tsx`、输入三档分类 `search-page.tsx:48-53`（#382） |
| §二 聊天增强：无 typing、撤回、删除、转发、消息搜索 | **仍基本成立**（仅多出「撤回碑」渲染与实时失效） → 表内改写 | `apps/web-pc/src/features/chat/message-bubble.tsx:102,:104`、`conversation-page.tsx:259`；契约 `packages/contracts/src/chat/routes.ts:47` 已有 `recall` 但 PC 无调用方 |
| §二 评论区：无多层评论树 | **已接通发布与单层回复**；多层树 / 编辑 / 删除 / 举报 / 图片留言仍无 → 留 §二 | `apps/web-pc/src/features/listing-detail/{comments-section.tsx,comments-api.ts,comments-queries.ts:13}`、`detail-page.tsx:31` |
| §二 愿望：无愿望公开主页、无新匹配算法 | **PC 已有 `/wish` 许愿墙（三 tab）+ 匹配列表**；新匹配算法已落地服务端。注意该页**需登录**，不是匿名公开主页 | `apps/web-pc/src/routes/wish.tsx:4`、`apps/web-pc/src/features/wish/{wish-page.tsx:19-23,match-list.tsx,queries.ts:47}`；`wish-page.tsx:24-26` `if (!me) return null`；`packages/contracts/src/matching/`、`apps/api/src/modules/matching/`、`docs/design/issue-322-matching-v2-m1..m3.md` |
| （上一版未列） | **新增** `apps/web-pc/src/features/recommendation`：曝光 / 快速划过追踪与本地隐藏名单 | `apps/web-pc/src/features/recommendation/{track.ts,use-impressions.ts,hidden.ts}` |
| （上一版未列） | **Admin 后端已就绪**（契约 + API 模块），PC 不接是路线图明确取舍 | `packages/contracts/src/admin`、`apps/api/src/modules/admin`；roadmap §6 |

上一版的「未单列『后端已就绪、只差接线』这一类」已完成，即本版 §1.1。

---

## 五、可复现核对命令

```bash
# 路由与页面清单
ls apps/web-pc/src/routes
ls apps/web-pc/src/features

# 显式的「未接通 / 演示」字样
grep -rn '占位\|未接入\|尚未\|后续版本\|暂未\|演示\|fixture\|mock\|stub' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# 后端已就绪但 PC 未接（§1.1）
grep -rn '收藏\|favorite' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'   # 应零命中
grep -rn 'follow\|关注' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'   # 只应有 2 行过期注释命中（user-profile/view.ts:19-20）

# 后端本身未实现（§1.2）：契约 / API / DB 三处都应当无
ls packages/contracts/src | grep -iE 'history|browse'
ls apps/api/src/modules | grep -i history
git ls-tree -r --name-only origin/main packages/contracts/src | grep -icE 'review|rating'   # 0

# 上一版曾断言「零命中」、现在应当**有**命中的反向断言（用于验证本版更正）
grep -rln 'REPORT_ROUTES' apps/web-pc/src --include='*.ts' --include='*.tsx'   # 举报已接线
grep -rln 'USER_ROUTES' apps/web-pc/src --include='*.ts' --include='*.tsx'     # 他人主页已接线
test -f apps/web-pc/src/routes/register.tsx || echo 'register.tsx 已删除（#391）'
grep -rniE 'refetchInterval' apps/web-pc/src/features/notifications            # 通知轮询已接线

# 分页能力对比：有 useInfiniteQuery / getNextPageParam 的地方才算真分页
grep -rn 'useInfiniteQuery\|getNextPageParam\|fetchNextPage' apps/web-pc/src

# 契约已有、PC 未用的调用点（§二 的「只差接线」缺口）
grep -rn 'recall' apps/web-pc/src/features/chat            # 只有墓碑渲染，无召回动作
grep -rn 'me/comments\|comments/' apps/web-pc/src          # PC 未用 DELETE /me/comments
```

---

## 六、结论来源

- 各任务设计文档的「非目标」章节：`docs/design/issue-89-web-pc-t*.md`。
- 路线图明确不做项：`docs/design/issue-89-web-pc-roadmap.md` §6。
- ID / 编号边界：#217，见 `docs/design/issue-89-web-pc-t10-id-inventory.md`。
- 认证口径变更：#391，见 `docs/design/issue-391-web-pc-auth-wechat-only.md`。
- Watchers 口径：#74，见 `docs/design/issue-74-watchers-definition.md`。
- 匹配算法 v2：#322，见 `docs/design/issue-322-matching-v2-m1.md` ~ `m3.md`。
- 本次刷新（2026-10-01，基线 `dc195083`）另据第 6 / 9 阶段已合入的 PC 接线 PR。

---

_由 AI agent 协助完成（DSH / deepseek-flash）。_
