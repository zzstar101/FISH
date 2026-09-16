# Issue #73 实现期变更记录

> 用途：记录 `feat/73-admin` 实现与自查期间对**已评审设计/契约/DB** 的偏离与变更请求，以及审查发现的问题与处置，
> 供 Owner / 组长统一评审。设计正文见 [issue-73-admin.md](./issue-73-admin.md)。
>
> 记录人：Coast-87（本机） ｜ 记录日期：2026-09-16 ｜ 分支：`feat/73-admin`

## 0. 上报摘要（组长看这里）

**状态**：设计 §10 实施顺序的第 1–4、6 步已完成（契约冻结、Platform/DB、Auth 边界、只读 MVP、Web 后台壳），
第 5 步「人工审核操作」因 #74 契约未冻结而**阻塞**，第 7 步「验证」已完成可做的部分（含一轮独立对抗性审查）。

**需要裁决的 4 件事**：

1. **CCR-1**（契约收紧）：管理契约 `category` / `condition` / `status` 由 `z.string()` 改为商品域枚举（第 1 节）。
2. **#74 契约冻结**：`feat/74-listing-moderation` 目前只有 `moderate({title, description})`，没有队列 / 决定接口，
   也没有 `packages/contracts/src/moderation/**`；不冻结则 #73 的「审核队列 + 人工决定」无法开工（第 4 节）。
3. **迁移编号冲突**：#74 与本分支的两个 `0005` 迁移（`_journal` 同为 `idx: 5`）需要在合并窗口统一处置（第 4 节）。
4. **Issue Done「可查询交易」**：设计 §4 未定义 `/admin/transactions`，补端点属超出已评审设计，请裁决是否补（第 4 节）。

**验证证据**（全仓，已并入 origin/main 后重跑）：`bun run typecheck` 8/8 包通过；`bun run lint` 376 files 无问题；`bun test` **482 pass / 0 fail**；
`bun run --filter '@fish/web' build` 通过；真服务（`dev:api` + `dev:web`）冒烟见第 3 节。
已做过**两轮**独立对抗性审查（第二轮针对修复重发，4 条 low 全部处置，无 blocker / major）。

**已知未做的验证**：F1（详情页可达）没有真实浏览器点击证据，只有结构 / 构建 / 类型证据（第 4 节末行）。

## 1. CONTRACT CHANGE REQUEST（待确认）

### CCR-1：管理契约的三个字段由 `z.string()` 收紧为商品域枚举

| 项 | 内容 |
| --- | --- |
| 涉及文件 | `packages/contracts/src/admin/schema.ts`（`AdminListingSummarySchema`、`AdminListingDetailSchema`） |
| 变更内容 | `category` / `condition` / `status` 由 `z.string()` 改为 `ListingCategorySchema` / `ListingConditionSchema` / `ListingStatusSchema`（来自 `packages/contracts/src/listings/schema.ts`） |
| 为什么改 | 数据来源就是 `listings` 表的同名列，DB 层已是枚举，管理契约写 `z.string()` 属于「契约弱于现实」；过宽的契约让 Web 端拿不到类型约束，`apps/web/src/features/admin/listings-page.tsx` 被迫写 `categoryLabel(item.category as never)` |
| 兼容性 | 不改变任何合法数据的形状，仅拒绝此前会被静默接受的非法枚举值；现有测试 fixture（`DIGITAL` / `GOOD` / `ACTIVE`）均在枚举内 |
| 需要谁点头 | 契约按 CONTRIBUTING §5 由模块认领人自行定义、无统一冻结流程；但这是对已实现契约的字段收紧，已在 PR 中说明供 zzstar101 审核 |
| 备选方案（未采纳） | 保留 `z.string()`，Web 侧保留 `as never` 强转，放弃类型约束 |

### CCR-2：`AdminListingDetail.updatedAt` 去掉 `nullable`（已实现，一并备案）

| 项 | 内容 |
| --- | --- |
| 涉及文件 | `packages/contracts/src/admin/schema.ts` |
| 变更内容 | `updatedAt: z.iso.datetime().nullable()` → `z.iso.datetime()` |
| 为什么改 | `listings.updated_at` 是 `NOT NULL`（`packages/db/src/schema/common.ts`），实现也直接 `toISOString()`；契约放宽会让「缺字段」静默通过 |
| 兼容性 | 与真实数据一致；补了「`updatedAt: null` 必须被拒绝」的用例 |

## 2. DB CHANGE REQUEST

无新增。设计 §5 的 DB CHANGE REQUEST A（`users.role`）与 B（`admin_audit_logs`）已落地为 `packages/db/src/migrations/0005_slippery_bruce_banner.sql`。
DB CHANGE REQUEST C（#74 Moderation 数据依赖）仍未满足，见第 4 节。

## 3. 自查发现与处置

对 `main..HEAD` 的改动做过一次独立对抗性审查（全新会话、只给改动范围与需求、只读工具），另加一轮运行时冒烟。发现与处置如下。

| 编号 | 问题 | 严重度 | 处置 |
| --- | --- | --- | --- |
| F1 | 用户/商品**详情页 UI 不可达**：列表页是 layout 路由，组件不渲染 `<Outlet/>`，详情组件永不挂载 | blocker | 已修：列表页改为 index 路由（与 `category.index.tsx` 同型），重建 `routeTree.gen.ts`，加结构守卫测试（修复前 2 fail） |
| F9 | 未匹配的 `/admin/*` 返回 `text/plain` 404，不走错误信封 | major | 已修：补 catch-all 返回 `ADMIN_NOT_FOUND` 信封（子应用 `notFound()` 不经 `app.route()` 生效，实测） |
| F2 | `maskStudentNo` 对 9–11 位学号几乎不脱敏（9 位露 8 位） | major | 已修：按长度收缩保留位数，4 位以上一律至少掩蔽 4 位；12 位输出不变 |
| F4 | 契约 `updatedAt` 可空 vs DB `NOT NULL` | minor | 已修，见 CCR-2 |
| F5 | 时间区间契约注释写「含边界」，实现是左闭右开 | minor | 已修：统一为左闭右开并写明 |
| F6 | Web `api.ts` 返回 `unknown` + 页面本地重复定义契约类型，契约漂移不会编译失败 | minor | 已修：改为契约类型 + 同 schema 运行时 `parse`（对齐 `features/chat/api.ts`），删除 6 处页面本地的契约类型 / 内联断言（3 处具名类型 + 4 处内联 `as`，含 `overview-page`）与全部 `as never`；CCR-1 由此暴露 |
| F10 | `db:promote --actor` 只校验学号存在，可把提升记到无管理权限者头上 | minor | 已修：非 ADMIN 的 `--actor` 一律拒绝；补 CLI 集成测试（拒绝 / 合法 actor / 自举三条分支） |
| F11 | 注释与实现不符（`routes.ts`、`middleware.ts` 都写 app.ts 挂 `requireAuth`）；`createAdminModule` 返回死代码；`router.ts` 残留注释 | minor | 已修 |
| F3 | `insertAuditLog` 无调用方，且签名不接 `tx`，无法满足设计 §6「审计与业务同事务」 | minor | **未修（有意延后）**：当前 Admin 零写操作，此刻改签名属为未来抽象（AGENTS §4）；随 S6「人工决定接口」一起落地并补「审计失败→业务回滚」用例 |
| F7 | `features/scanner/scanner.tsx` 卸载竞态导致摄像头不释放 | minor | **不在 #73 范围**：该文件来自 #69（提交 `527b7c7`）。建议新开 issue，不在本分支修 |
| F8 | UI 未暴露 `sellerId` / `authStatus` / 时间范围筛选（API 已支持） | minor | **未修（记录为后续项）**：设计 §7 只要求「筛选条件写入 URL」，未要求这三个控件的具体集合；当前 `q` / `status` / `role` 已写入 URL |

### 运行时冒烟（真服务，不是单测）

`db:up` → `db:migrate`（重跑幂等）→ `db:seed` → `db:promote` → `dev:api`，逐项验证：

- 未登录 `/admin/*` → `401 UNAUTHENTICATED`；普通用户全端点（含详情路径）→ `403 FORBIDDEN`；管理员 → `200`。
- 伪造 `X-User-Role: ADMIN` / `X-Admin: true` / `X-Role: ADMIN` → 仍 `403`；伪造 `fish_session` 值 → `401`。
- 公开注册接口带 `role: "ADMIN"` → `422`（`strictObject` 拒绝），且 `apps/api/src/modules/auth/**` 完全不接触 `role` 字段。
- 非 UUID 路径参数 / 不存在的 UUID → `404`（非 500）；`limit` 越界、坏 cursor → `422`。
- `Me` DTO 不含 `role`；`/admin/users` 返回脱敏学号（`2021****0002`）。
- 普通用户 `/me`、`/health` 无回归。

### 第二轮独立审查（修复后重发，AGENTS §7）

修复改变了实现（路由结构、catch-all、契约收紧、Web 类型收敛），因此对修复提交（`417c242..HEAD`）重发了一次全新会话的审查。
结论：**无 blocker / major，4 条 low，均已处置**。

| 编号 | 发现 | 处置 |
| --- | --- | --- |
| R1 | catch-all 把「路径存在但方法不匹配」（如 `POST /admin/users`）也返回 404 而非 405 | 已确认：改动前 Hono 同样返 404（实测 `POST /admin/me` → 404 text/plain），非本次引入；已在 `router.ts` catch-all 处把该代价与理由写成注释 |
| R2 | `--reason` 缺值时静默回落默认原因，与 `--actor` 的用法校验不同口径 | 已修：改为 `usage(1)`；新增用例（修复前 exit 0、修复后 exit 1） |
| R3 | 用法文案与实现不符：`--actor` 等于被提升者时跳过角色校验 | 已修：文案明确「缺省或等于被提升者 = 首次引导自举，不做角色校验」 |
| R4 | `maskStudentNo` 注释声称「4 位以上一律至少掩蔽 4 位」，但 5–7 位实际只掩蔽 3–5 位 | 已修：注释改为分档描述（≤8 位只留首位各 1 位；≥9 位按长度收缩） |

审查者明确写「未发现问题」的方向包括：权限边界、`Me` DTO 不泄漏字段、审计同事务与脱敏快照、游标校验、9–11 位脱敏、
契约枚举与 DB `pgEnum` 一致、Web 路由结构、Web 契约类型收敛。

> 过程说明：第一、二次调用审查子代理时输出跑成了思考流而被截断，换模型（`deepseek-v4-pro`）并限定输出格式后才拿到结构化报告；
> 另外子代理留下了两个临时脚本（`apps/api/.tmp-*.ts`），已确认无引用后删除。

## 4. 未完成 / 阻塞项（需组长裁决）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 审核队列与人工审核决定（`GET /admin/moderation/queue`、`POST /admin/moderation/:recordId/decision`） | **阻塞** | 设计 §5「DB CHANGE REQUEST C」要求先冻结 #74 的读写契约。`feat/74-listing-moderation` 目前只有 `apps/api/src/modules/moderation/{rules,service,store,types}.ts`，`service` 仅导出 `moderate({title,description})`，且**没有** `packages/contracts/src/moderation/**` |
| Issue #73 Done「可查看/处理商品审核结果」 | **未达成** | 同上，属有据可依的延后 |
| Issue #73 Done「可查询用户、商品、**交易**」 | **部分达成** | 用户/商品列表与详情、概览（含已完成交易计数）已实现；**没有** `/admin/transactions` 端点。设计 §4 未定义该端点，补它属于超出已评审设计，需组长决定 |
| 高风险操作确认 + 审计 | **未达成** | 当前 Admin API 零写操作；审计表、索引、脱敏快照已就绪 |
| 迁移编号冲突 | **待处置** | #74 分支 `0005_faulty_energizer.sql` 与本分支 `0005_slippery_bruce_banner.sql` 都是 `_journal` `idx: 5`，两分支合并必然冲突。按 AGENTS §8「不调整 migration 历史」，只能由 Platform Owner 在合并窗口决定顺序/改号 |
| 合并窗口的 seed 协调 | **待处置** | 本地库被其它分支迁移污染（`message_media`(#67)、`listing_moderation_records`(#74)）时 `db:seed` 会因外键失败。`seed.ts` 的 TRUNCATE 列表按分支维护，#67 合并时需同步加入 `message_media` |
| 浏览器端到端验证 | **未做** | 本机无 playwright/puppeteer，按规则不新增依赖；F1 的修复目前只有结构、构建与类型证据，没有真实浏览器点击证据 |

## 5. 提交清单（`main..HEAD`，共 19 个：16 个 #73 提交 + 1 个 merge + 2 个前序提交）

> `527b7c7`（#69 扫码）是本分支的基点，其内容已由 PR #84 squash 合入 `main`；`main` 上后合入的 #81/#82/#84
> 已通过下面的 merge 提交并入，因此本 PR 不会回退任何已合并工作。

```text
4716e00 Merge remote-tracking branch 'origin/main' into feat/73-admin         ← 并入 main 已合入的 #81/#82/#84 + 治理文档改动
0831217 docs(api): correct two comments flagged by review (#73)              ← R1 / R4
be313dc fix(db): reject --reason without a value (#73)                        ← R2 / R3
2c61d27 docs(admin): record contract change requests and fix report (#73)
3747ba0 fix(web): use admin contract types instead of unknown (#73)
3c3687d fix(contracts): type admin listing enums from listings domain (#73)   ← CCR-1
f6a5cb3 docs(api): fix stale admin mount comments, drop dead export (#73)
6214135 fix(db): require an admin actor when promoting (#73)
a9b8ca1 fix(contracts): mask 9-11 digit student numbers (#73)
9226a71 fix(contracts): align admin contract with storage (#73)                ← CCR-2 / F5
ba41f04 fix(api): envelope for unmatched admin paths (#73)
0c4892f fix(web): make admin detail pages reachable (#73)                      ← F1
417c242 feat(web): add admin console pages (#73)
876b18e feat(api): add read-only admin api (#73)
c2b3433 feat(contracts): add admin api contract (#73)
c9457fe feat(db): add user role and admin audit log (#73)                      ← DB CHANGE REQUEST A/B
8a407dd docs(admin): add admin console design for #73
```

规模：50 files changed, 6128 insertions(+), 4 deletions(-)（含设计文档与迁移快照）。

## 6. 遗留风险（提请组长注意）

1. **跨模块公共文件**：本 PR 同时改了 `packages/db/**`（schema + migration）、`apps/api/src/app.ts`（API 根入口）
   与 `apps/web/**`，都属 CONTRIBUTING §2 的跨模块公共文件。按新规则（已去除 CODEOWNERS）此类文件人人可改、
   无需事先同意，但要做最小改动并在 PR 说明影响——本 PR 只新增 admin 模块与一个用户角色字段，
   对现有模块的侵入为：`app.ts` 加一行挂载、`users` 加一个带默认值的列、`seed.ts` 加一张表进 TRUNCATE 列表。
   **每个 PR 必须由 zzstar101 审核后才可合入，本分支未自行合入。**
2. **契约收紧的向后兼容**：CCR-1 只拒绝此前会被静默接受的非法枚举值，但若有其它消费者依赖「任意字符串」，需同步。
3. **审计原子性尚未被代码保证**：F3 记录的 `insertAuditLog` 无事务句柄问题在 S6 落地前一直存在；当前零写操作，暂无实际影响。
4. **`db:seed` 的跨分支耦合**：`seed.ts` 的 TRUNCATE 列表按分支维护，任何新增带外键的表都要同步，否则本地 seed 直接失败。
