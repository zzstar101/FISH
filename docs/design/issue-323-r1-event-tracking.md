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
- 幂等：同一 `event_id` 撞唯一索引 → 计入 `duplicates`，不写第二行。
- 拒收（通过契约校验但服务端不收）计入 `rejected`，逐条原因只写服务端日志：`listing_not_found` / `request_not_found` / `identity_mismatch` / `occurred_at_in_future`（超过 now + 10 分钟）/ `occurred_at_too_old`（早于 now − 180 天）/ `server_confirmed_event_type`（见下）。原因不进响应体：客户端对这些无能为力，把枚举写进契约意味着每加一种原因就要改协议。
- 写入是 **fire-and-forget**：不阻塞也不影响主流程（评论、会话、交易都不因为埋点失败而失败）。

### 服务端确证行为的埋点（客户端不上报这些）

`COMMENT`（评论创建成功）、`CHAT_START`（**新建**会话；复用既有会话不是新行为信号）、`TRANSACTION_START`（卖家接受 = 唯一建行端点）、`PURCHASE`（双方确认后 `status = COMPLETED`）。挂点是各 router 的成功分支，通过窄接口 `RecommendationDomainRecorder`（`apps/api/src/modules/recommendation/domain-events.ts`）注入，业务模块不依赖推荐模块的 store / 召回 / 游标。

这四类**在写入端点上被显式拒收**（`server_confirmed_event_type`，见契约的 `RECOMMENDATION_SERVER_CONFIRMED_EVENT_TYPES`）：端点匿名可写，照收的话任何人 POST 一批 `PURCHASE` 就能污染训练数据，而且落库后与真实交易**无法区分**（表里没有来源列）。拒收之后「表里出现这四类 = 服务端写的」这条不变式在数据层面成立，不必再加列。`FAVORITE` / `UNFAVORITE` 反过来只能由客户端上报（服务端还没有收藏写路径，见 §1），R1 接受这份不对称。

已知取舍：`transactions` store 对 `COMPLETED` 上的重复 confirm 是**幂等返回**（`{kind:'ok'}` 里没有「这次是否真的推进」的信号），所以重复点确认会多发一条 `PURCHASE`。v1 接受：服务端已确证的行为宁可多记不可漏记；客户端重试的精确一次由 `event_id` 唯一索引负责，R6 的指标按 `request/listing` 去重。这条取舍有一条**回归护栏测试**钉着（`重复确认成交：v1 会再记一条 PURCHASE`）；要根治得让 `transactions/store.ts` 的 `confirm` 回一个 `justCompleted` 标志，属跨模块改动，不在 R1。

---

## 5. 身份与会话

- **`userId` 真值来自 token**（`resolveViewerId`），不是客户端声明；事件里带了 `anonymousSessionId` 但服务端只把它当会话标识用，绝不据此认人。
- 归属校验：事件的 `requestId` 必须属于**当前身份**（登录请求按 `user_id`、匿名请求按 `anonymous_session_id`）；不符即拒收（`identity_mismatch`）。退出 / 切号后旧会话的事件不会记到新账号上。
- 无归因事件（没有 `requestId`，例如详情页的 DETAIL_VIEW）：`user_id` 仍取 token 真值，`anonymous_session_id` 是**客户端自述**。匿名侧本来就没有可验证凭据，这里的会话标识只用于把同一浏览器 / 同一小程序的行为串起来（以及 R2 的会话内兴趣），**不构成授权，也不参与任何身份判断**；因此伪造它最多只能污染自己那一行匿名统计。
- 匿名会话标识：客户端生成 UUIDv4，存 `localStorage` / `Taro` storage，**TTL 180 天**；服务端在 Feed 响应用户没带时补发并在响应头回写。
- **`position` 与 `source` 也是客户端自述**，R1 服务端不校验它们与请求行的对应关系：`source` 缺省时服务端补 `fresh`（R1 只有一条召回通道，客户端不该猜），但客户端**显式**报别的通道也照收；`position` 只受契约约束（0..10000），伪造一个不存在的位次同样落库。R1 不修的原因：请求行没有记录「这次返回了哪些商品、每个商品在第几位」，服务端**没有可比对的真值**；可信的曝光位次要到 R3/R4 由 Feed 侧记录（那时才有召回通道与位次的服务端真值）。对 R1 的影响：曝光率这类指标在 R1 只能当参考，不能当实验结论。
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
5. **离线队列**：事件入队即固化 `eventId`、`anonymousSessionId` 与 `occurredAt`，持久化到本地存储；触发冲刷：入队即冲刷 + 应用启动 + `online` + 回到前台 + 每 15 秒。每批 ≤ 50 条，2xx 才出队（重试沿用原 `eventId`，所以服务端看到的仍是同一条事件）；上限 500 条，超出丢最旧。发送前用契约 schema 自检，不合格的丢弃并 `console.warn`（客户端 bug 不该把整批打成 422）。

---

## 8. R1 的验证

- 契约单测（`packages/contracts/src/recommendation/schema.test.ts`）：12 类事件、阈值常量、metadata 白名单逐类型、曝光缺 `position` 必拒、批量上限。
- API 集成测试（`apps/api/src/app.recommendation.test.ts`，14 例）：匿名 Feed + 会话补发、归因链（Feed → IMPRESSION → DETAIL_VIEW 落库）、幂等重放计 `duplicates`、拒收（商品不存在 / 身份不符 / 服务端确证类事件）、游标复用、伪造游标与**篡改内层游标**都是 422、`GET /listings?sort=newest` 未被污染、四个服务端领域事件、`source` 服务端补 `fresh`、重复确认多发一条 `PURCHASE` 的护栏。
- 门禁：`bun run typecheck` → `bun run lint` → `bun test --isolate` → 真实跑起来（web-pc 首页 / 小程序首页）。
- `#302` core smoke 的归因链用例等其合入后再挂（本 PR 用 API 集成测试覆盖同一条链路）。

### 端到端实跑记录（本地隔离库 `fish_r1_smoke`，2026-09-28）

起真实 API（`apps/api/src/index.ts`，端口 3000，`MAIL_TRANSPORT=outbox`）后实测：

- `GET /recommendations/feed?limit=5` → 200，`strategyVersion=rec-v1-none`，响应头回写 `x-anonymous-session-id`；`?limit=2` 的 `nextCursor` 带上同一个会话头翻页 → 200 且 **`requestId` 与首页相同**、返回下两件商品；不带会话头翻页 → 422（见 §4 的使用约束）。
- `POST /recommendations/events`：IMPRESSION 带 `requestId`+`position` 不带 `source` → 202 `{accepted:1}`，落库行 `source='fresh'`、`position=0`、`request_id`/`anonymous_session_id` 有值、`user_id` 为空；同 `eventId` 重发 → `{accepted:0,duplicates:1}`；DETAIL_VIEW / LONG_VIEW（带 `durationMs`）各自落库。
- 拒收路径逐条实测（均 202 + `rejected:1` 且不写行）：伪造 listingId → `listing_not_found`；不存在的 requestId → `request_not_found`；真实 requestId + 他人会话 → `identity_mismatch`；`occurredAt` 未来 1 小时 → `occurred_at_in_future`；客户端上报 PURCHASE/CHAT_START/COMMENT/TRANSACTION_START → `server_confirmed_event_type`。
- 契约层 422（整批不写）：曝光缺 `position`、非规范公开 id、51 条批量、空 body。
- 共享开发库 `fish` 当时被并行任务（#322）迁入了 `embeddings` 表，`db:seed` 的 TRUNCATE 名单与之冲突；本 PR 的 `seed.ts` 只登记本分支存在的表，实跑因此走隔离库（干净库上 migrate + seed 均通过）。
