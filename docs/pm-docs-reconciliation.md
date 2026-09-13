# PM 三表 × GitHub 实际交付对照

**用途**：把 PM 侧三份 docx（`PM需求表` / `开发任务表` / `测试Bug表`）与 `origin/main` 的真实交付对齐，补齐 `开发任务表` 里全空的「负责人」「完成进度」两列。

- 输入文件（`~/Downloads`）：`PM需求表_Fish项目.docx`、`开发任务表_Fish项目.docx`、`测试Bug表_Fish项目.docx`
  - 三份皆为 `V1.0 | 编写人：陈常 | 日期：2026-09-12`
- 代码基线：`origin/main` = `4eade93`
- 对照基准：`docs/team-division-of-labor.md`（GitHub Issue / PR / CODEOWNERS 推导）
- 凡结论都给出 `文件:行号` 或 PR 号；推断项已显式标注「**推测**」

---

## 0. 结论摘要

| # | 现象 | 性质 |
| --- | --- | --- |
| 1 | `开发任务表` 23 条任务，**负责人列全空**、**完成进度列 23/23 都是「未开始」** | 表未维护 |
| 2 | `测试Bug表` 18 条用例**全部「未执行」**，Bug 表 7 行**全空** | 表未维护 |
| 3 | 实际已交付约 17/23 条任务（后端 10 个 API 模块 + Worker + 13 个前端 feature） | 与表严重不符 |
| 4 | **R-010 / R-011 赠物（Gift）整块 P0 功能完全没有实现**：无模块、无契约、无表、无页面 | 真实缺口 |
| 5 | 「删除商品」(R-004)、「删除图片」(R-014)、「编辑愿望」(R-009) 三个动词没有端点 | 真实缺口 |
| 6 | 通知前端（R-016/#23）仍是 fixture，且 fixture 数字被加进真实角标 | 真实缺口 + 缺陷 |
| 7 | 建议窗口 / 基础设置（R-018/R-019）只有两行静态占位，无提交入口、无后端 | 真实缺口 |
| 8 | `T-101` 备注写「已联调通过」但进度写「未开始」；`T-104` 备注写「排序待完成」但排序已实现 | 表内自相矛盾 |

---

## 1. 开发任务表 —— 补全「负责人」「完成进度」

> 负责人按 `CODEOWNERS` + PR 实际作者推导；进度以 `origin/main` 代码/端点为据。
> 进度取值：`已完成` / `部分完成` / `未开始`。

### Sprint 1：跑通最小交易闭环

| 任务编号 | 所属模块 | 任务拆解 | 负责人 | 优先级 | 完成进度 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| T-101 | Auth | 登录/登出接口与页面，获取当前用户状态 | 后端 **zzstar101**；前端 **ouu2006** | P0 | **已完成** | `apps/api/src/modules/auth/{router,service,session,provider,middleware}.ts`（PR #18）；`apps/web/src/features/auth/**`（PR #26） |
| T-102 | Auth | 登录态持久化与 token 刷新 | 后端 **zzstar101**；前端 **ouu2006** | P0 | **部分完成** | 持久化已实现（`packages/db/src/schema/sessions.ts`、`packages/contracts/src/auth/session.ts`）。**无 token / refresh 机制**——`git grep -ni refresh -- packages/contracts/src/auth apps/api/src/modules/auth` 零命中，架构上是 session 表 + cookie，不存在「token 刷新」这个动作 |
| T-103 | Listing | 商品发布表单：基本信息+预期价格（不含联系方式） | 后端 **zzstar101**；前端 **ouu2006** | P0 | **已完成** | `packages/contracts/src/listings/{schema,routes}.ts`、`apps/api/src/modules/listings/{router,service,store}.ts`（PR #20）；`apps/web/src/features/sell/publish-page.tsx` |
| T-104 | Listing | 商品列表页：分页、分类筛选、关键词搜索 | 后端 **zzstar101**；前端 **ouu2006** | P0 | **已完成** | 游标分页 + `q` + `category` + `sort`：`packages/contracts/src/listings/schema.ts:237-256`；`apps/web/src/features/search/search-page.tsx:22`。**原备注「排序待完成」已过期**——`ListingSortSchema = ['newest','priceAsc','priceDesc']` |
| T-105 | Listing | 商品详情页与图片轮播展示 | 后端 **zzstar101**；前端 **ouu2006** | P0 | **已完成** | `LISTING_ROUTES.detail`（PR #20）；`apps/web/src/features/listing-detail/detail-page.tsx` |
| T-106 | Upload | 图片上传/删除接口与前端组件 | **zzstar101** | P0 | **部分完成** | 上传已实现：`UPLOAD_ROUTES = { presign, confirm }`（`packages/contracts/src/listings/routes.ts:17-22`）。**删除端点不存在**——`git show origin/main:apps/api/src/modules/uploads/router.ts \| grep -niE "delete\|remove"` 零命中 |
| T-107 | Transaction | 交易状态机：发起→接受→待面交→确认面交→完成/取消 | **Coast-87** | P0 | **已完成** | `packages/contracts/src/transactions/routes.ts`（proposals / reject / accept / confirm / cancel）；`apps/api/src/modules/transactions/{router,service,store}.ts`（PR #37），4 个测试文件 |
| T-108 | Transaction | 买入/卖出记录查询接口 | 后端 **Coast-87**；前端 **ouu2006** | P1 | **已完成** | `TRANSACTION_ROUTES.base`（可按 role/status 过滤，PR #37）；`apps/web/src/features/profile/orders-page.tsx`（PR #26） |

### Sprint 2：补齐三大核心场景

| 任务编号 | 所属模块 | 任务拆解 | 负责人 | 优先级 | 完成进度 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| T-201 | Wish | 求物发布：物品信息+可接受价格范围 | 后端 **Coast-87**；前端 **ouu2006** | P0 | **已完成** | `packages/contracts/src/wishes/{schema,routes}.ts`（PR #19）；`apps/api/src/modules/wishes/**`（PR #25）；`apps/web/src/features/wish/wish-page.tsx` |
| T-202 | Wish | 愿望编辑/关闭、我的愿望、需求池列表 | 后端 **Coast-87**；前端 **ouu2006** | P0 | **部分完成** | 关闭有 `WISH_ROUTES.close`；需求池有 `WISH_ROUTES.pool`；**编辑端点不存在**——`packages/contracts/src/wishes/routes.ts` 只有 `base / pool / detail / close / fulfill` |
| T-203 | Gift | 赠物发布：基本信息+赠予要求填写 | **无人**（`CODEOWNERS` 无 Gift 条目） | P0 | **未开始** | `git grep -niE "gift\|赠物"` 在 `packages/contracts`、`apps/api`、`apps/web/src` 零命中。注意 `listings.free`（`apps/api/src/modules/listings/service.ts:68`）+ DB CHECK `listings_free_price_cents_zero` 只是「0 元商品」属性，不含「赠予要求 / 申请理由 / 同意·拒绝」 |
| T-204 | Gift | 赠物申请：申请理由提交与赠予者回应（同意/拒绝） | **无人** | P0 | **未开始** | 同上 |
| T-205 | Listing | 我的商品：编辑、下架、删除 | 后端 **zzstar101**；前端 **ouu2006** | P0 | **部分完成** | 编辑/下架有 `LISTING_ROUTES.offline` / `online`（`routes.ts:9-16`）；**删除无端点**，前端已在注释里确认：`apps/web/src/features/profile/queries.ts:79`「契约只有这一条『收回』路径，没有删除端点」 |

### Sprint 3：体验与互动增强

| 任务编号 | 所属模块 | 任务拆解 | 负责人 | 优先级 | 完成进度 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| T-301 | Chat | 会话创建/列表/历史消息，发送与实时消息推送 | 后端 **Coast-87**；前端 **ouu2006** | P1 | **已完成** | `apps/api/src/modules/{conversations,messages,realtime}/**` + `packages/contracts/src/chat/routes.ts`（PR #36）；`apps/web/src/features/chat/**`（PR #34、#54）。备注「依赖IM服务」不成立——用的是自建 Hono/Bun WebSocket |
| T-302 | Chat | 已读/未读状态同步 | 后端 **Coast-87**；前端 **ouu2006** | P1 | **已完成** | `CHAT_ROUTES.read = /conversations/:id/read`（推进 `last_read_at`）；前端 `useMarkConversationRead`（`apps/web/src/features/chat/queries.ts:55`）；`realtime/hub.test.ts` |
| T-303 | Notification | 愿望匹配、新消息、交易状态站内通知 | 后端 **Coast-87**；前端 **ouu2006** | P1 | **部分完成** | 后端已交付并合入 `main`：`apps/api/src/modules/notifications/{router,service,store}.ts` + `packages/contracts/src/notifications/**`（PR #60）。**前端仍是 fixture**：`apps/web/src/features/chat/queries.ts:67` `queryFn: fetchMockNotifications`（来自 `lib/mock/store.ts`） |
| T-304 | 匹配 | 商品匹配愿望/愿望匹配商品算法与匹配分数 | **zzstar101** | P1 | **已完成** | `packages/contracts/src/matching/{schema,routes,jobs}.ts`、`apps/api/src/modules/matching/{router,service,store}.ts`（PR #22）、`apps/worker/src/jobs/matching/{engine,scoring,handlers,queue}.ts` + 4 个测试文件 |
| T-305 | Feed/Search | 首页Feed流、分类、搜索、排序综合优化 | 后端 **zzstar101**；前端 **ouu2006** | P1 | **已完成** | `apps/web/src/features/home/**`、`features/search/**`（PR #26）；排序见 T-104。任务名中的「综合优化」无验收标准，无法逐条核验 |

### Sprint 4：收尾与上线

| 任务编号 | 所属模块 | 任务拆解 | 负责人 | 优先级 | 完成进度 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| T-401 | Profile | 个人资料维护、我的商品/愿望/交易统计 | 后端 **Coast-87**；前端 **ouu2006** | P1 | **已完成** | `packages/contracts/src/profile/**`、`apps/api/src/modules/profile/{router,service,store}.ts`（PR #38）；`apps/web/src/features/profile/{profile-page,mylist-page,orders-page,user-page}.tsx`（PR #26、#35） |
| T-402 | 建议窗口 | 用户建议提交与后台查看 | **无人** | P2 | **未开始** | 仅静态占位行：`apps/web/src/features/profile/profile-page.tsx:101` `<StaticRow description="问题反馈与功能建议" emoji="✉️" label="意见反馈" />`；无提交入口、无 `packages/contracts` 定义、无后端 |
| T-403 | 基础设置 | 通用设置项（隐私、缓存、关于） | **无人** | P2 | **未开始** | 同上：`profile-page.tsx:96-101`「帮助与设置」下 2 个 `StaticRow`（隐私设置 / 意见反馈） |
| T-404 | 联调测试 | 全模块联调、至少完成一次「测试→修复」闭环 | **zzstar101**（#43）、**Coast-87**（#42）、**ouu2006**（#41） | P0 | **已完成** | #42：`apps/api/src/modules/transactions/marketplace-flow.test.ts`，真实 HTTP + 真实 WebSocket，15 用例 × 5 轮 **75 pass / 0 fail**（PR #46）；#43：`apps/api/scripts/core-smoke.ts` + CI `bun run ws:smoke`（PR #52、#55）；#41：PR #54。「测试→修复」闭环有多轮实例：PR #32、#45→#48→#49、#57、#61 |

### 迭代计划总览 —— 补全「状态」

| 迭代 | 目标 | 表内状态 | 实际状态 | 依据 |
| --- | --- | --- | --- | --- |
| Sprint 1 | 跑通最小交易闭环 | 进行中 | **已完成** | T-101/103/104/105/107 已完成；T-106 差删除、T-102 无 token 刷新（见上） |
| Sprint 2 | 补齐三大核心场景 | 未开始 | **部分完成** | Wish 主体完成（T-201）；**Gift 两条 P0 全缺**（T-203/T-204）；T-202/T-205 差删除类端点 |
| Sprint 3 | 体验与互动增强 | 未开始 | **基本完成** | Chat/匹配/Feed 完成；仅 T-303 前端未接线 |
| Sprint 4 | 收尾与上线 | 未开始 | **部分完成** | T-401/T-404 完成；T-402/T-403 未开始 |

---

## 2. PM需求表 R-001 ~ R-019 追溯

| 编号 | 模块 | 优先级 | 实际状态 | 对应 Issue / PR | 缺口 |
| --- | --- | --- | --- | --- | --- |
| R-001 | Auth | P0 | ✅ 已交付 | #3 / PR #18 | — |
| R-002 | Listing·买物 | P0 | ✅ 已交付 | #6 / PR #20 | — |
| R-003 | Listing·买物 | P0 | ✅ 已交付 | #4 / #5 / #6 / PR #20、#26 | 排序、分类、搜索、详情均已在 `main` |
| R-004 | Listing·买物 | P0 | ⚠️ 部分 | #6 / PR #20、#24 | **删除无端点**（编辑、下架有） |
| R-005 | Transaction | P0 | ✅ 已交付 | #11 / PR #37 | 另有契约未要求的 proposals/reject |
| R-006 | Transaction | P0 | ✅ 已交付 | #11 / PR #37 | — |
| R-007 | Transaction | P1 | ✅ 已交付 | #11 / #12 / PR #37、#38 | — |
| R-008 | Wish 求物 | P0 | ✅ 已交付 | #7 / PR #19、#25 | — |
| R-009 | Wish 求物 | P0 | ⚠️ 部分 | #7 / PR #19、#25、#53 | **编辑无端点**（创建/关闭/我的/需求池有） |
| R-010 | **Gift 赠物** | **P0** | ❌ **未实现** | 无 | 整块缺失：无契约、无模块、无表、无页面 |
| R-011 | **Gift 赠物** | **P0** | ❌ **未实现** | 无 | 同上 |
| R-012 | 匹配 | P1 | ✅ 已交付 | #8 / PR #22 | — |
| R-013 | Feed/Search | P0 | ✅ 已交付 | #4 / PR #26 | — |
| R-014 | Upload | P0 | ⚠️ 部分 | #6 / PR #20 | **删除无端点**（上传有） |
| R-015 | Chat | P1 | ✅ 已交付 | #9 / PR #36 | 已读/未读已实现（`CHAT_ROUTES.read`） |
| R-016 | Notification | P1 | ⚠️ 部分 | #23 / PR #60（后端） | **前端仍 fixture**；#23 Issue 仍 OPEN |
| R-017 | Profile | P1 | ✅ 已交付 | #12 / PR #38 | — |
| R-018 | 建议窗口 | P2 | ❌ 未实现 | 无 | 仅 `profile-page.tsx:101` 静态行 |
| R-019 | 基础设置 | P2 | ❌ 未实现 | 无 | 仅 `profile-page.tsx:100-101` 静态行 |

**需求覆盖率**：19 条中 ✅ 12 条、⚠️ 4 条、❌ 3 条（含 2 条 P0）。

**两个 P0 硬缺口**：`R-010` / `R-011` 赠物。这两条无 Issue、无 owner、无排期——`CODEOWNERS` 里也没有 Gift 相关条目（默认规则会落到 `@zzstar101`）。GitHub 侧与 Gift 最接近的是 `#14 [P1][GROWTH] 急出、0元送…`，但它是 **P1 且仍 OPEN**，且 `0元送` 语义上只是 `listings.free`，不含「赠予要求 + 申请理由 + 同意/拒绝」。

---

## 3. 测试Bug表 —— 用例执行情况的实际对照

### 3.1 测试用例表（TC-001 ~ TC-018）

表内 18 条**执行结果全部为「未执行」**，但 `main` 上已有 **49 个测试文件**（`git ls-tree -r --name-only origin/main | grep -cE '\.test\.(ts|tsx)$'` → `49`），另有两条端到端冒烟。

| 用例 | 模块 | 表内结果 | 自动化覆盖现状 | 覆盖位置 |
| --- | --- | --- | --- | --- |
| TC-001 | Auth | 未执行 | ✅ 有 | `apps/api/src/modules/auth/router.test.ts`、`provider.test.ts` |
| TC-002 | Auth | 未执行 | ✅ 有 | `apps/api/src/modules/auth/router.test.ts` |
| TC-003 | Listing | 未执行 | ✅ 有 | `apps/api/src/modules/listings/{router,service}.test.ts`、`uploads/{router,service,storage}.test.ts` |
| TC-004 | Listing | 未执行 | ✅ 有 | `packages/contracts/src/listings/schema.test.ts`、`listings/service.test.ts`、DB CHECK `listings_free_price_cents_zero` |
| TC-005 | Listing | 未执行 | ✅ 有 | `listings/router.test.ts`、`listings/cursor.test.ts`（排序/分页） |
| TC-006 | Listing | 未执行 | ⚠️ 部分 | 编辑/下架/上架有用例；**删除无法执行（端点不存在）** |
| TC-007 | Transaction | 未执行 | ✅ 有 | `apps/api/src/modules/transactions/marketplace-flow.test.ts`（真实 HTTP+WS，PR #46） |
| TC-008 | Transaction | 未执行 | ✅ 有 | `apps/api/src/modules/transactions/store.test.ts` cancel 用例（偶发性已由 #56 / PR #57 修掉） |
| TC-009 | Wish | 未执行 | ✅ 有 | `apps/api/src/modules/wishes/router.test.ts` |
| TC-010 | Wish | 未执行 | ✅ 有 | `packages/contracts/src/wishes/schema.test.ts` |
| TC-011 | **Gift** | 未执行 | ❌ **不可执行** | **无 Gift 模块** |
| TC-012 | **Gift** | 未执行 | ❌ **不可执行** | **无 Gift 模块** |
| TC-013 | Upload | 未执行 | ⚠️ 部分 | 上传/确认有用例；**删除无法执行（端点不存在）** |
| TC-014 | Chat | 未执行 | ✅ 有 | `apps/api/src/modules/{conversations,messages}/**/*.test.ts`、`realtime/hub.test.ts` |
| TC-015 | Notification | 未执行 | ⚠️ 部分 | 后端仅 `apps/api/src/app.notifications.test.ts`；`modules/notifications/**` **无模块内测试**，且前端走 fixture |
| TC-016 | 匹配 | 未执行 | ✅ 有 | `matching/{router,service}.test.ts`、`worker/src/jobs/matching/{engine,scoring,handlers,queue}.test.ts` |
| TC-017 | Profile | 未执行 | ✅ 有 | `apps/api/src/modules/profile/{router,service,store}.test.ts` |
| TC-018 | 兼容（弱网/断网） | 未执行 | ❌ 无 | 全仓无此维度测试；且 `apps/web` **零测试文件**（`git ls-tree -r --name-only origin/main -- apps/web \| grep -cE '\.test\.'` → `0`），前端 18 条用例全部只能人工执行 |

**要点**：TC-001~TC-017 里绝大多数在**后端**已有自动化等价覆盖，但 PM 表里的用例是**UI 操作级**的（「打开登录页 → 输入 → 点击」），而 `apps/web` 没有任何测试文件——所以「未执行」这个状态对**前端**而言是真的，对**后端**而言已被自动化覆盖。两个结论不能混。

### 3.2 Bug 记录表（BUG-001 ~ BUG-007，表内 7 行全空）

`main` 上实际存在过并可枚举的缺陷/返工（可直接回填）：

| 建议编号 | 所属模块 | 描述 | 严重程度 | 发现人 | 修复人 | 修复状态 | 验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUG-001 | Infra | `bun.lock` tarball URL 被本机镜像源污染（#26 那次 361 个包、`ogl` 那次 551 行无关 diff） | 严重 | 审查 | zzstar101 | 已修复 | CI 新增 `Verify lockfile sources` 反向断言（#27 / PR #33）；另有一次性还原提交 `917e37e` |
| BUG-002 | Chat / Transaction | #9 / #11 合并进 `main` 时漏过的 Sourcery 审查发现，共 5 条 | 严重 | Sourcery 审查 | Coast-87 | 已修复 | #40 关闭；PR #49（PR #45 的 squash 提交编码乱码 → PR #48 revert → #49 重落） |
| BUG-003 | Listing | 详情端点封面取「最小 `sort_order`」，与 feed / 其它读模型口径分叉 | 一般 | 审查 | Coast-87 | 已修复 | #47 关闭；PR #61（封面只认 0 号图） |
| BUG-004 | Transaction | `transactions/store.test.ts` 的 cancel 用例依赖并发 accept 的胜者，偶发失败 | 一般 | CI | Coast-87 | 已修复 | #56 关闭；PR #57 |
| BUG-005 | Infra | 全量 `bun test` 连接峰值 105 超过 PG `max_connections=100`，随机 `53300 too many clients` | 严重 | CI | — | **未修复** | #59 仍 OPEN；PR #62 只是把 `max_connections` 提到 200（缓解，非修复） |
| BUG-006 | Wish | `WISH_ROUTES` 与 `app.ts` 挂载点被改成根级 `/wishes`，但 `app.ts` 属 Owner 独占 → 合并后被 revert，主 Demo 第 6 步被卡 | 严重 | 规则审查 | Coast-87 / zzstar101 | 已修复 | PR #44 合并 → PR #50 revert（`bc5c7ae` → `adc7801`）→ 交接 PR #51（CLOSED）→ PR #53 + PR #55 |
| BUG-007 | Notification | 前端通知未接真实 API，且 fixture 未读数被加进真实导航角标 | 一般 | 本次对照发现 | ouu2006（`apps/web` 属主） | **未修复** | `apps/web/src/features/chat/queries.ts:4`（`fetchNotifications as fetchMockNotifications` 从 `lib/mock` 导入）、`:67`（`queryFn: fetchMockNotifications`）、`:76-87`（`useNotificationBadge` 把 fixture 未读与真实会话未读相加，`queries.ts:84`） |

> `BUG-005` 的性质需要说明：PR #62 把 `docker-compose.yml` 的 `max_connections` 从 100 提到 200，属**提高阈值**；#59 描述的根因（测试侧连接池未收敛）未处理，Issue 保持 OPEN。

---

## 4. 需要 PM / Owner 决策的事项

| # | 事项 | 影响 |
| --- | --- | --- |
| 1 | **Gift（R-010/R-011/T-203/T-204）是否仍在 MVP 范围内？** 表中标 P0，`CODEOWNERS` 无条目，GitHub 无 Issue | 若保留 → 需要新开 Issue + 指定 owner（`packages/contracts/src/gifts/**` 等）；若移出 → 更新需求表优先级 |
| 2 | 「删除商品 / 删除图片 / 编辑愿望」三个动词：是**产品上不做**（用下架代替），还是**漏做**？ | 决定 R-004 / R-009 / R-014 是「部分完成」还是「已完成」 |
| 3 | T-102 写「token 刷新」，但架构是 session 表 + cookie，无 token | 需求描述需订正，否则永远无法判定为「已完成」 |
| 4 | 通知前端（T-303）何时接真实 API：#23 仍 OPEN，而 #41「全量接线」已关闭 | #41 的关闭口径与实际不符，需澄清 |
| 5 | `apps/web` 零测试文件，而 PM 测试表的 18 条全是 UI 级用例 | 要么补前端测试基建，要么明确「前端用例 = 人工执行」并如实填表 |
| 6 | 三份表的「负责人 / 完成进度 / 执行结果」由谁每周更新 | 建议直接引用 `docs/team-division-of-labor.md` 作为唯一事实源，避免两处漂移 |

---

## 5. 未验证项

- 三份 docx 的**后续版本**未获取，本对照基于 `V1.0 / 2026-09-12`。
- `测试Bug表` 的「发现人 / 修复人」两列，表内为空；上表 BUG-001~BUG-007 的这两列是我按 GitHub 记录**推断**的填法，非 PM 原始记录。
- `开发任务表`「截止时间」列原文为 `—`，未提供排期，无法判断是否延期。
- `R-003` 的「排序」是否满足 PM 期望的排序维度（表未列举具体维度），仅能确认实现了 `newest / priceAsc / priceDesc` 三种。
