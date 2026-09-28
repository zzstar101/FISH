# #323 R1 — 行为埋点与推荐归因契约（实现说明与数据策略）

> 状态：**R1 已实现**（契约 + DB + API + 服务端领域事件 + web-pc/miniapp 客户端埋点）。多路召回、兴趣向量、ranker、Feed 策略切换、指标与 guardrail 归 R2–R6。
> 关联：Refs [#323](https://github.com/zzstar101/FISH/issues/323)（需求载体；R1 只勾选其中「Tracking / API / Engineering」三组里属于本 PR 的条目）
> 基线：`origin/main = 4f49325706b113e96063f12778b0fe4c5f40cabf`
> 记录人：Coast-87（本机）

---

## 1. R1 的范围

**做**：推荐请求上下文（`requestId` / `strategyVersion` / 身份 / 时间）、12 类行为事件的写入契约与幂等、`recommendation_events` 落库、最小推荐 Feed 入口（`GET /recommendations/feed`，R1 透传 `newest`）、客户端曝光/详情归因与「不感兴趣」入口、服务端确证行为的埋点。

**不做**（附理由）：

| 不做 | 理由 |
| --- | --- |
| 个性化排序、多路召回、兴趣向量、re-rank | Issue #323 §M1–M6，R1 只负责「事件可信」，排序没有可信事件就是空转 |
| 把首页换成真实策略 | R5；R1 的 Feed 是 `newest` 透传（`strategyVersion = rec-v1-none`），目的是让归因链端到端可验证 |
| 改变 `GET /listings?sort=newest` | #323 §M7 明确不得破坏；R1 只新增入口（集成测试里有一条断言它没有多出推荐字段） |
| Redis / Kafka / ES / 独立向量库 | #323 §明确不做 |
| 事件删除任务与 retention 作业 | 归 R6；R1 只建表、建索引并在此文档写清策略（见 §6） |
| `FAVORITE` / `UNFAVORITE` 的服务端埋点 | 仓库**没有收藏 API**（`favorites` 表由 #287 落 schema，#190 的接口未实现），没有写路径可挂；待 #190 落地后按 `RecommendationDomainRecorder` 同一形态补挂 |
| `HIDE` / `UNFAVORITE` 的服务端持久化 | R1 只要求有真实入口；隐藏目前是客户端本地名单（§7.4） |

---

## 2. 三条写进契约的决定

1. **事件 id 由客户端生成**（UUIDv4，`event_id` 唯一索引兜底重试幂等）。重试只有客户端知道「这是同一条事件」，服务端生成 id 做不到。web-pc 用 `crypto.randomUUID()`（仓库既有惯例），小程序没有 `crypto`，用 `wx.getRandomValues` + `Math.random()` 降级的生成器（`apps/miniapp/src/lib/uuid.ts`）。服务端 UUIDv7 是**主键**惯例（`packages/db/src/ids.ts`），不能当幂等键：`decodePublicId` 只接受规范 v7，会把客户端 v4 拒掉。
2. **`requestId` 可为 `null`**：只有从推荐 Feed 点进去的浏览才有推荐来源。搜索/分类/卖家主页进入详情时硬塞假 `requestId` 会把归因污染成「看起来来自推荐」。曝光类事件（`IMPRESSION` / `QUICK_SKIP`）**必须**带 `requestId` + `position`，由契约的 `superRefine` 强制。
3. **`metadata` 逐 event_type 白名单**（`strictObject`，未知键 422），单条 2KB 上限。埋点表最容易变成隐私倾倒场，白名单是唯一能长期守住边界的机制；白名单里只允许「判定这件事本身用到的数值」（可见比例、时长、页码、图片下标）。上限按 **UTF-8 字节**算（`utf8ByteLength` 手写实现，不用 `TextEncoder`：这份 schema 也在小程序端跑，微信小程序 JS 运行时没有 `TextEncoder` 全局）；用 `String.length` 会把中文/emoji 少算，上限就形同虚设。R1 的白名单全是数值字段，这条分支实际上不可达，但它必须是对的。

阈值集中在契约（`RECOMMENDATION_THRESHOLDS`）：曝光 = 可视面积 ≥ 50% 且持续 ≥ 1000ms；快速划过 = 可见 < 1000ms 且未点开；长浏览 = 详情停留 ≥ 10000ms。小程序用 `wx.createIntersectionObserver`、PC 用 `IntersectionObserver`，两套 API 触发时机不同，**只有阈值共享才能让两端的 `IMPRESSION` 可比**。

---

## 3. 数据模型

迁移：`packages/db/src/migrations/20260928164032_dusty_doctor_spectrum.sql`（由 `bun run --filter '@fish/db' generate` 生成，未手改）。

### `recommendation_requests` — 一次推荐请求的上下文（不可变行）

| 列 | 说明 |
| --- | --- |
| `id` | uuidv7 主键，即对外的 `requestId` |
| `user_id` | → `users.id` **ON DELETE SET NULL**（注销后保留匿名行为统计） |
| `anonymous_session_id` | 客户端会话标识（UUIDv4） |
| `strategy_version` | varchar(64)，R1 为 `rec-v1-none` |
| `requested_at` | timestamptz |

索引：`(user_id, requested_at)`、`(anonymous_session_id, requested_at)`。约束：`recommendation_requests_has_identity`（两种身份至少一个非空）。没有 `created_at`：这行是不可变上下文，`requested_at` 就是它的时间。

### `recommendation_events` — 行为事件

| 列 | 说明 |
| --- | --- |
| `id` | uuidv7 主键（服务端） |
| `event_id` | **客户端幂等键**，`UNIQUE`；与 `id` 分开，重放同一事件撞唯一索引即丢弃 |
| `user_id` / `anonymous_session_id` | 归因身份；匿名请求的行为不会因为补发时已登录而记到账号上（以请求行为真值） |
| `request_id` | 推荐请求 id。**刻意不建外键**：事件保留 180 天、请求上下文 90 天，有外键就得先删事件 |
| `listing_id` | **NOT NULL**，→ `listings.id` ON DELETE CASCADE（商品删了，指着它的事件没有意义） |
| `event_type` | pgEnum，12 类 |
| `position` | 本次推荐请求内跨页连续的全局序号（从 0 开始） |
| `source` | pgEnum，召回通道；R1 只有 `fresh`（客户端不传时由服务端补） |
| `metadata` | jsonb NOT NULL DEFAULT `'{}'`，逐类型白名单（写入必须过 `jsonParam`，否则会被双重 stringify） |
| `occurred_at` / `created_at` | 客户端发生时刻 / 落库时刻 |

索引：`UNIQUE(event_id)`、`(user_id, occurred_at)`、`(listing_id, occurred_at)`、`(request_id)`、`(anonymous_session_id, occurred_at)`。
两条**部分唯一索引**（把"换一个 `event_id` 就能重复写"的数据污染变成库级约束，`ON CONFLICT DO NOTHING` 吞掉冲突并计入 `duplicates`）：

- `UNIQUE(request_id, listing_id, event_type) WHERE event_type IN ('IMPRESSION','QUICK_SKIP')`：曝光/快速划过在契约里本就是「每次推荐请求每张卡各一次」，而端点匿名可写、`eventId` 由客户端自生成、R1 又故意不做限流 → 不拦的话同一 `(request_id, listing_id)` 能被无成本刷出任意多行，曝光率、CTR 与「多次曝光无点击」的负样本全部被放大。只约束这两类：`DETAIL_VIEW` 允许重复（同一商品可以被反复点开），`IMAGE_VIEW` 更是每张图一条。
- `UNIQUE(listing_id) WHERE event_type = 'PURCHASE'`：`PURCHASE` 是商品级唯一事实（见 §4）。服务层写前先查一次 `hasListingEvent`，但那是 check-then-insert —— 两个并发 confirm 可以都查到「无行」再各自插入，这条索引才是并发下的真保证。

约束：`recommendation_events_impression_requires_attribution`（`IMPRESSION` / `QUICK_SKIP` 必须同时有 `request_id` 与 `position`）、`recommendation_events_position_non_negative`。

不做分区：R1 的量级用 B-tree 索引足够，分区键（时间）会把唯一索引约束复杂化，等 R6 的保留作业需要时才谈。

---

## 4. 接口

### `GET /recommendations/feed`

- 查询：`limit`（1..50，默认 20）、`cursor`（不透明串）。
- 请求头 `x-anonymous-session-id`（可选）：没有时服务端生成一个并在**响应头**回写；客户端必须采纳回写值。
- 200 → `{ requestId, strategyVersion, items: ListingCard[], nextCursor }`。**不含 rankScore / 特征**（内部分数不进契约）。
- `cursor` = base64url(`{ listingCursor, requestId }`)：内层商品游标仍是 `GET /listings` 那套 `(sortKey, id)` 编码，**不重写排序键解析**。翻页复用同一个 `requestId`（否则 position 会从 0 重来、曝光序号在服务端重复）；归属不符与请求不存在对外返回**同一个** 422（不把 `requestId` 是否存在变成可探测的预言机）。
- 内层游标坏掉时，`listings` 层抛 `ListingServiceError(VALIDATION_FAILED)`，推荐层必须接住并同样返回 422：`app.onError` 只认 `HTTPException`，让它冒上去就变成 500，而同一个坏游标在 `GET /listings` 是 422（集成测试有一条专门篡改内层游标来钉住这点）。
- 翻页必须带 `x-anonymous-session-id`：归属校验以请求行的身份为真值，匿名请求换了会话就认不出这条请求 → 422。两端客户端在 Feed 请求上都会带（含翻页），所以这是使用约束而非缺陷。
- 匿名可用；`GET /listings` 完全未改，集成测试断言其响应没有 `requestId` / `strategyVersion`。

### `POST /recommendations/events`

- body `{ events: RecommendationEventInput[] }`，1..50 条；**202** → `{ accepted, duplicates, rejected }`。
- 匿名可用（不挂 `requireAuth`）。会话标识走 **body**（离线补发的一批可能横跨会话切换），Feed 的会话标识走头。
- 幂等：同一 `event_id` 撞唯一索引 → 计入 `duplicates`，不写第二行。三本"重复"账合起来看：`event_id` 相同（客户端重发）、同一 `(request_id, listing_id)` 的曝光类事件换 `eventId` 重报（多标签页 / 坏客户端 / 无上限重试）、同一商品的第二条 `PURCHASE` —— 后两类由 §3 的部分唯一索引拦下，同样计入 `duplicates`（不是 `rejected`：客户端没做错什么，只是重复）。
- 拒收（通过契约校验但服务端不收）计入 `rejected`，逐条原因只写服务端日志：`listing_not_found` / `request_not_found` / `identity_mismatch` / `occurred_at_in_future`（超过 now + 10 分钟）/ `occurred_at_too_old`（早于 now − 180 天）/ `server_confirmed_event_type`（见下）。原因不进响应体：客户端对这些无能为力，把枚举写进契约意味着每加一种原因就要改协议。
- 写入是 **fire-and-forget**：不阻塞也不影响主流程（评论、会话、交易都不因为埋点失败而失败）。

### 服务端确证行为的埋点（客户端不上报这些）

`COMMENT`（评论创建成功，**含回复**）、`CHAT_START`（**新建**会话；复用既有会话不是新行为信号）、`TRANSACTION_START`（卖家接受 = 唯一建行端点）、`PURCHASE`（双方确认后 `status = COMPLETED`）。挂点是各 router 的成功分支，通过窄接口 `RecommendationDomainRecorder`（`apps/api/src/modules/recommendation/domain-events.ts`）注入，业务模块不依赖推荐模块的 store / 召回 / 游标。

`COMMENT` 有两个写路径：顶层留言走 `service.createComment`，`POST /comments/:commentId/replies` 的回复走 `createReply` 自己的 `store.insert`（同一张表、同一 listing 上的新行，不经过 `createComment`）。两条路都必须挂 recorder —— ingest 拒收客户端上报的 `COMMENT`，漏一条就等于把该类强正反馈整条丢掉。回复路径的 listing 从 DTO 的公开 id 解回 DB uuid（`decodePublicId`）后再交给 recorder。

这四类**在写入端点上被显式拒收**（`server_confirmed_event_type`，见契约的 `RECOMMENDATION_SERVER_CONFIRMED_EVENT_TYPES`）：端点匿名可写，照收的话任何人 POST 一批 `PURCHASE` 就能污染训练数据，而且落库后与真实交易**无法区分**（表里没有来源列）。拒收之后「表里出现这四类 = 服务端写的」这条不变式在数据层面成立，不必再加列。`FAVORITE` / `UNFAVORITE` 反过来只能由客户端上报（服务端还没有收藏写路径，见 §1），R1 接受这份不对称。

`PURCHASE` 的精确一次：`transactions` store 对 `COMPLETED` 上的重复 confirm 是**幂等返回**（`{kind:'ok'}` 里没有「这次是否真的推进」的信号），而 `recordDomainEvent` 每次都新生成 `eventId`，`event_id` 唯一索引对这类重复**永远不生效** —— 不拦的话卖家重复点确认或重放 `POST /transactions/:id/confirm` 就能把最强的正样本无界放大。因此服务端在写入前按「一个商品只会成交一次」（成交即转 `SOLD`，同一商品的第二条成交事件在业务上不存在）查一次 `hasListingEvent(listingId, 'PURCHASE')`，命中即不写；并发下真正的保证是 §3 的 `UNIQUE(listing_id) WHERE event_type = 'PURCHASE'`（先查后插是 check-then-insert，两个并发 confirm 可以都查到「无行」，索引让输家静默落空而不是 500）。护栏测试：`重复确认成交不会重复记 PURCHASE（商品级唯一事实）`。若将来真的要支持同一商品重卖，需要把去重键从 listing 换成 transaction（届时 `transactions` store 应回一个 `justCompleted` 标志，属跨模块改动）。

---

## 5. 身份与会话

- **`userId` 真值来自 token**（`resolveViewerId`），不是客户端声明；事件里带了 `anonymousSessionId` 但服务端只把它当会话标识用，绝不据此认人。
- 归属校验：事件的 `requestId` 必须属于**当前身份**（登录请求按 `user_id`、匿名请求按 `anonymous_session_id`）；不符即拒收（`identity_mismatch`）。退出 / 切号后旧会话的事件不会记到新账号上。
- 无归因事件（没有 `requestId`，例如详情页的 DETAIL_VIEW）：`user_id` 仍取 token 真值，`anonymous_session_id` 是**客户端自述**。匿名侧本来就没有可验证凭据，这里的会话标识只用于把同一浏览器 / 同一小程序的行为串起来（以及 R2 的会话内兴趣），**不构成授权，也不参与任何身份判断**；因此伪造它最多只能污染自己那一行匿名统计。
- 匿名会话标识：客户端生成 UUIDv4，存 `localStorage` / `Taro` storage，**TTL 180 天**；服务端在 Feed 响应用户没带时补发并在响应头回写。
- **UUID 大小写规范化**：契约的 `z.uuid()` 与 `isUuidShape` 都接受大写，而 PG 的 `uuid` 列写入即规范化成小写、回读也是小写。所以服务端在**边界**（`readAnonymousSessionId` / `readRecommendationContext` / `ingest` 里的 `requestId`、`anonymousSessionId`）统一 `toLowerCase()` 后再比对与落库；否则同一个合法会话标识会第一页 200、第二页 422，带该 `requestId` 的事件全被判 `identity_mismatch`。仓库内两个客户端本来就产小写，所以这是潜伏缺陷（自研/第三方客户端或做大小写规范化的代理会踩到）。
- **`position` 与 `source` 也是客户端自述**，R1 服务端不校验它们与请求行的对应关系：`source` 缺省时服务端补 `fresh`（R1 只有一条召回通道，客户端不该猜），但客户端**显式**报别的通道也照收；`position` 只受契约约束（0..`RECOMMENDATION_MAX_POSITION`），伪造一个不存在的位次同样落库。**归因头里的 `position` 会在服务端先按 `[0, RECOMMENDATION_MAX_POSITION]` 过滤，越界一律退化为「无归因」**：该列是 int4，头的数字直接落库时 `99999999999` 会让整条 INSERT 报 `integer out of range`，而写失败被 `recordDomainEvent` 的 catch 吞掉 → 评论/下单事件**整条**丢失；归因不值得用整条事件陪葬。R1 不修的（`position`/`source` 真值校验）原因：请求行没有记录「这次返回了哪些商品、每个商品在第几位」，服务端**没有可比对的真值**；可信的曝光位次要到 R3/R4 由 Feed 侧记录（那时才有召回通道与位次的服务端真值）。对 R1 的影响：曝光率这类指标在 R1 只能当参考，不能当实验结论。
- 账号注销：`recommendation_events.user_id` 与 `recommendation_requests.user_id` 都是 **ON DELETE SET NULL**，行为统计保留为匿名，不随账号消失，也不残留可回指个人的外键。

---

## 6. 隐私与保留策略

- **不落** IP / User-Agent / Referer / 设备指纹；`metadata` 白名单里没有任何自由文本，`q`（搜索词）、昵称、学号、手机号、微信标识一律不落库。
- 保留期：**事件 180 天**、**请求上下文 90 天**。理由：事件是训练回放的原料（周期长），请求上下文只用于归因与去重（周期短）；两者不一致，所以 `events.request_id` 不建外键。
- **R1 不含任何自动删除**：删表数据的作业归 R6（连同 guardrail 指标一起）。在那之前，这两张表的增长没有任何自动闸门——这是本 PR 明确留下的、有意识的技术债，R6 必须处理。
- fixture / 开发预览流量：mock 回退时客户端**不发** `IMPRESSION` / `QUICK_SKIP`（没有真实 `requestId`），并且 mock 的商品 id 不是规范公开 id（`lst_` + UUIDv7），客户端在 track 边界就会丢弃并 `console.warn`；即使真发到服务端也会被契约校验或 `listing_not_found` 拒收。
- Bot 流量：R1 不做 UA 判定（不落 UA），真实会话里跑 JS 的机器人目前与普通用户不可区分——归 R6 的 guardrail（结合 request 频率与 position 分布）。
- **写入限流：R1 没有限流**。`POST /recommendations/events` 匿名可写，唯一约束是「单请求 ≤ 50 条 + 单条 metadata ≤ 2KB」。仓库现有的配额都是各模块自己实现的（如 `auth/verification-store.ts` 的滚动窗口），埋点端点的配额（按会话 / 按 IP 的滚动窗口）随 R6 一起做。

---

## 7. 客户端行为（R1）

1. **会话**：无 / 过期的会话标识 → 生成 UUIDv4 并写入（TTL 180 天）；Feed 响应头回写时采纳。
2. **曝光**：卡片可见 ≥ 50% 且连续 ≥ 1000ms → `IMPRESSION`（metadata `visibleRatio` / `durationMs` / `pageIndex`）；可见但 < 1000ms 且未点开 → `QUICK_SKIP`。同一 `requestId` 内同一卡片只发一次。
3. **详情归因**：从推荐卡片进入详情时记住 `{ requestId, position }` → `DETAIL_VIEW`；停留 ≥ 10000ms → `LONG_VIEW`；主动切图 → `IMAGE_VIEW`。非推荐来源的详情**照发 `DETAIL_VIEW`**，只是不带 `requestId`（搜索进来的浏览同样是有效行为信号）。
4. **不感兴趣**：web-pc 卡片菜单、小程序卡片长按 → `HIDE` + 立刻移除 + 本地隐藏名单（TTL 180 天）。服务端持久化不在 R1。
5. **离线队列**：事件入队即固化 `eventId`、`anonymousSessionId` 与 `occurredAt`，持久化到本地存储；触发冲刷：入队即冲刷 + 应用启动 + `online` + 回到前台 + 每 15 秒。每批 ≤ 50 条，2xx 才出队（重试沿用原 `eventId`，所以服务端看到的仍是同一条事件）；上限 500 条，超出丢最旧。发送前用契约 schema 自检，不合格的丢弃并 `console.warn`（客户端 bug 不该把整批打成 422）。**冲刷循环的退出条件是「队列真的被缩短」而不是「这一批发完了」**：本地存储写回失败（配额写满等）时队列内容不变，只按"发完了"退出的话下一轮会读到同一批再 POST —— 一个坏存储就能把队列变成无限重发器（实测 1.5 秒 501 次 POST），且 flush promise 永不 settle，之后所有入队与定时器都挂在死 promise 上。写回失败即 `console.warn` 一次并结束本轮，事件留在队列里等下次触发。
6. **曝光去重表的容量**：两端都按 `requestId` 维护已发过的 key，并在请求切换时重置。淘汰**只允许淘汰不属于当前 `requestId`** 的 key —— 首页把已加载的多页拼成一个列表（每页 24 条、各页共用同一个 `requestId`），按 FIFO 无差别淘汰最旧 key 会在 11 页之后把最早的卡片挤出表，滚回顶部再看满 1s 就会对同一 `(requestId, listingId)` 发出第二条 `IMPRESSION`（服务端现在也会把它计成 `duplicates`，但曝光率已经被客户端算错了）。
7. **归因的消费时机**：进入详情页就消费归因（而不是"等数据 ready 再消费"）。404 / 请求失败 / 用户在数据回来前返回，都不该让那份 `{requestId, position}` 在存储里继续存活 30 分钟 —— 否则从搜索页再点开同一商品时会挂上上一次推荐请求的 `requestId`/`position`。`DETAIL_VIEW` 仍必须等数据 ready 才发（404 不记浏览）。

---

## 8. R1 的验证

- 契约单测（`packages/contracts/src/recommendation/schema.test.ts`）：12 类事件、阈值常量、metadata 白名单逐类型、曝光缺 `position` 必拒、批量上限。
- API 集成测试（`apps/api/src/app.recommendation.test.ts`，20 例）：匿名 Feed + 会话补发、归因链（Feed → IMPRESSION → DETAIL_VIEW 落库）、幂等重放计 `duplicates`、**同一 `(request_id, listing_id)` 的曝光换 `eventId` 重报只落一行且计 `duplicates`**、批内重复 `eventId` 计 `duplicates`、拒收（商品不存在 / 身份不符 / 服务端确证类事件 / `occurredAt` 超前 / 过旧）、游标复用、伪造游标与**篡改内层游标**都是 422、`GET /listings?sort=newest` 未被污染、四个服务端领域事件（**含回复留言也记 `COMMENT`**）、`source` 服务端补 `fresh`、**大写 UUID 会话与小写等价**（翻页 200 + 事件不被判 `identity_mismatch`）、**切号不串事件**（登出/换账号带旧 `requestId` → `identity_mismatch`）、`position` 溢出 int4 时退化为无归因但事件仍落库、重复确认成交不会重复记 `PURCHASE`。
- 门禁：`bun run typecheck` → `bun run lint` → `bun test --isolate` → 真实跑起来（web-pc 首页 / 小程序首页）。
- `#302` core smoke 的归因链用例等其合入后再挂（本 PR 用 API 集成测试覆盖同一条链路）。

### 端到端实跑记录（本地隔离库 `fish_r1_smoke`，2026-09-28）

起真实 API（`apps/api/src/index.ts`，端口 3000，`MAIL_TRANSPORT=outbox`）后实测：

- `GET /recommendations/feed?limit=5` → 200，`strategyVersion=rec-v1-none`，响应头回写 `x-anonymous-session-id`；`?limit=2` 的 `nextCursor` 带上同一个会话头翻页 → 200 且 **`requestId` 与首页相同**、返回下两件商品；不带会话头翻页 → 422（见 §4 的使用约束）。
- `POST /recommendations/events`：IMPRESSION 带 `requestId`+`position` 不带 `source` → 202 `{accepted:1}`，落库行 `source='fresh'`、`position=0`、`request_id`/`anonymous_session_id` 有值、`user_id` 为空；同 `eventId` 重发 → `{accepted:0,duplicates:1}`；DETAIL_VIEW / LONG_VIEW（带 `durationMs`）各自落库。
- 拒收路径逐条实测（均 202 + `rejected:1` 且不写行）：伪造 listingId → `listing_not_found`；不存在的 requestId → `request_not_found`；真实 requestId + 他人会话 → `identity_mismatch`；`occurredAt` 未来 1 小时 → `occurred_at_in_future`；客户端上报 PURCHASE/CHAT_START/COMMENT/TRANSACTION_START → `server_confirmed_event_type`。
- 契约层 422（整批不写）：曝光缺 `position`、非规范公开 id、51 条批量、空 body。
- 共享开发库 `fish` 当时被并行任务（#322）迁入了 `embeddings` 表，`db:seed` 的 TRUNCATE 名单与之冲突；本 PR 的 `seed.ts` 只登记本分支存在的表，实跑因此走隔离库（干净库上 migrate + seed 均通过）。

### 修复轮实跑记录（同一隔离库，用修复后的代码重启真实 API）

第一轮对抗性审查报出的缺陷修复后，重启 API（`apps/api/src/index.ts`，端口 3000，`MAIL_TRANSPORT=outbox`）复测：

- **大写 UUID 会话（P1）**：`GET /recommendations/feed?limit=1` 带 `x-anonymous-session-id: D49C7312-6A1D-4977-962C-6B7CC5F6F68C` → 200 并拿到 `nextCursor`；带**同一个大写**会话头 + 该游标翻页 → **200**（修复前 422），`requestId` 与首页一致；换小写同样 200。
- `PURCHASE` 精确一次、`position` 溢出退化为无归因、切号不串事件、`occurredAt` 时间窗、批内重复 `eventId` 由集成测试覆盖（`apps/api/src/app.recommendation.test.ts`，20 例全绿）。

### 第三轮审查修复记录（同一隔离库，用第三轮修复后的代码重启真实 API）

第三轮对抗性审查（服务端 / 客户端各一个全新子代理）之后：

- 服务端：回复留言补记 `COMMENT`（`apps/api/src/modules/comments/router.ts` 的 `COMMENT_REPLIES_PATH` 分支走的是 `createReply` 自己的 `store.insert`，不经过 `createComment`，而 ingest 拒收客户端上报的 `COMMENT` → 回复类强正反馈原本 100% 丢失）；`recommendation_events` 加两条**部分唯一索引** —— `recommendation_events_impression_once_uq`（`request_id, listing_id, event_type`，`WHERE event_type IN ('IMPRESSION','QUICK_SKIP')`）与 `recommendation_events_purchase_once_uq`（`listing_id`，`WHERE event_type = 'PURCHASE'`），迁移删掉本分支自己的旧条目后重新生成，tag `20260928191108_special_the_call`；`store.insertEvents` 的 `.onConflictDoNothing({ target: eventId })` 改为不指定仲裁者（PG 的 `ON CONFLICT` 一次只能推断一个索引，三本重复账都要吞成 `duplicates`）。
- 客户端：两端离线队列把「写回队列是否成功」当成本轮冲刷的退出条件（`writeQueue()` 返回 `boolean`；坏存储下原实现会 1.5 秒发 501 次 POST 且 `flushPromise` 永不 settle）；web-pc 曝光去重表淘汰只淘汰不属于当前 `requestId` 的 key（11 页 × 24 条之后 FIFO 会无差别淘汰导致同卡重复曝光）、`openedRef` 由组件级改模块级（首页 → 详情 → 返回后同一份缓存数据里点开过的卡不再被误判为快速划过）、进详情页即消费归因（原来 `ready` 之前早退，404 / 加载失败都会让归因在 `sessionStorage` 里存活 30 分钟）；miniapp `readFeedAttribution` 的 `position` 补上界 `RECOMMENDATION_MAX_POSITION`（越界原本会被发送前自检静默丢弃，连累该次浏览的 `DETAIL_VIEW` / `LONG_VIEW`）。
- 实跑复测：新库 `migrate` + `seed` 通过，`pg_indexes` 列出 8 条索引（含两条部分唯一索引）；同 `(requestId, listingId)` 三条不同 `eventId` 的 IMPRESSION → `{"accepted":1,"duplicates":2,"rejected":0}`（修复前 `accepted:3`）；注册两个新用户后顶层留言 201 + 回复 201，库里 `event_type` 计数为 `COMMENT 2` / `IMPRESSION 1`（修复前 `COMMENT 1`）。
- 新增测试与回归证明：`apps/miniapp/tests/recommendation-attribution.test.ts`、`apps/miniapp/tests/recommendation-queue.test.ts`（mock `@tarojs/taro` 存储与投递函数，不 import 真 Taro）；web-pc `queue.test.ts` 新增「写回失败时立刻收工」用例（修复前 `Expected length: 1 / Received length: 4`）。把两处修复临时还原回改前版本：miniapp `11 pass / 4 fail`、web-pc `1 fail`，失败者正是新用例。
