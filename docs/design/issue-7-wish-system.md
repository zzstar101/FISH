# Issue #7 [P0][WISH] 许愿系统与需求池 — 设计方案

> Owner: Coast-87 (Dev B / Wish Owner)
> 状态: Contracts + API 已合入 main（PR #19）；DB schema/#18 auth 已就绪（#17/#18），本分支完成集成：真实 MATCH_WISH 投递、matchCount 读 matches、app.ts 挂载接线与 app 级集成测试
> 原则: 严格遵守 EPIC #15 的文件所有权规则，所有跨 Owner 依赖显式声明为「协调点」，绝不直接修改他人目录。

---

## 当前实现进度（2026-09-12）

已落地：
- `packages/contracts/src/wishes/schema.ts`、`routes.ts` 及 Zod 边界测试。分类枚举已与 `packages/db` 的 `listing_category`（DIGITAL/BOOKS/…）逐值对齐。
- `apps/api/src/modules/wishes/store.ts`：基于 Bun SQL 的持久化适配层；findById/listByUser/update/状态迁移均带 matches 计数子查询返回 `match_count`。
- `apps/api/src/modules/wishes/service.ts`：创建、列表、详情、编辑、关闭、fulfilled、k-匿名需求池、60 秒进程内缓存。
- `apps/api/src/modules/wishes/match-queue.ts`：新增 `createDbWishMatchQueue(db)`，向 jobs 表插入 `MATCH_WISH`/PENDING job（#2 的 jobs schema 已预留该类型）；router 默认仍为 no-op，接线时注入真实实现。
- `apps/api/src/modules/wishes/router.ts`：相对路由；已由 app.ts 以 `app.use('/wishes/*', auth.requireAuth)` + `createWishesRouterFromDb(db, { getUserId })` 挂载（见 `apps/api/src/app.ts`）。
- 集成测试：`store.test.ts` 与 `app.wishes.test.ts` 均以 per-pid scratch 库跑真实 migration（Windows 下必须用 `fileURLToPath`，勿用 `URL.pathname`）。
## 1. 目标与范围

把"求购"做成持续存在的**愿望订阅**（ACTIVE 状态长期存在），并基于全部 ACTIVE 愿望形成匿名聚合的**需求池**。

**本 Issue 我交付（我的目录）：**

```
apps/api/src/modules/wishes/**
packages/contracts/src/wishes/**
```

**本 Issue 不碰（他人目录）：**

| 目录 | Owner | 说明 |
|---|---|---|
| `packages/db/**`（含 migration） | zzstar101 | 我只提交 DB CHANGE REQUEST（§6.1） |
| `apps/api/src/modules/matching/**` | zzstar101 | 匹配消费方，我只投递 job（§6.2） |
| `apps/worker/**` | zzstar101 | job 的执行方 |
| `apps/api/src/app.ts` | zzstar101 | 根路由接线，我只导出 router（§6.3） |
| `apps/web/**`、`packages/ui/**` | ouu2006 | 愿望页 UI 由前端按我的 contracts 实现（§6.4） |

> 注：Issue #7 原文把 `apps/web/src/features/wish/**` 列为 Dev B 文件，与 EPIC #15 的 "`apps/web/**` 仅 ouu2006 修改" 冲突。本方案按更严格的 EPIC 规则执行：**UI 交给 ouu2006，我只提供 contracts**。如团队希望我直接写愿望前端页，需 zzstar101 在 Issue 中明确豁免后再动。

**非目标（P1 及以后）**：愿望成真通知开关、热门愿望趋势、首页需求卡、愿望图片、多关键词。

---

## 2. 数据模型（提交给 Dev A 的 DB CHANGE REQUEST 草案）

表 `wishes`，由 Dev A 落 migration，列定义如下（金额用 **int 分**，避免浮点）：

```sql
CREATE TABLE wishes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  keyword       text NOT NULL,              -- 2~30 字符，创建时 trim + 统一小写归一化
  category      text NOT NULL,              -- 复用 listings 的分类枚举（contracts 单一来源）
  budget_min_cents int NOT NULL DEFAULT 0,
  budget_max_cents int NOT NULL,            -- >= budget_min_cents, CHECK 约束
  description   text,                       -- 可选, <= 500 字符
  accept_similar boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | CLOSED | FULFILLED
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wishes_user_idx   ON wishes (user_id, status);
CREATE INDEX wishes_pool_idx   ON wishes (status, category, keyword);
CREATE INDEX wishes_keyword_trgm ON wishes USING gin (keyword gin_trgm_ops);  -- 需求池聚合 + 后续匹配检索
```

约束：
- 单用户 ACTIVE 愿望上限 **10 条**（应用层校验，防刷）。
- `budget_max_cents >= budget_min_cents` 用 CHECK 约束兜底。
- 分类枚举与商品分类共用同一 Zod schema（`packages/contracts` 内 wishes 引用一个共享常量文件；该文件归属由 Dev A 定，避免两边各写一份）。

**协调点 ①（Dev A）**：请按上述 DDL 出 migration；如需调整命名（如 `user_id` → `owner_id`）请在此 Issue 反馈。`pg_trgm` 扩展如果 Dev A 尚未启用，请一并 `CREATE EXTENSION IF NOT EXISTS pg_trgm`。

---

## 3. API 设计（v1，全部走 `/api` 前缀）

| Method | Path | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/wishes` | 创建愿望（成功后投递匹配 job） | 登录 |
| GET | `/wishes` | 我的愿望列表，`?status=ACTIVE\|CLOSED\|FULFILLED`，分页 | 登录 |
| GET | `/wishes/:id` | 愿望详情（含 `matchCount`） | 登录（仅本人） |
| PATCH | `/wishes/:id` | 编辑（keyword/category/budget/description/acceptSimilar） | 登录（仅本人） |
| POST | `/wishes/:id/close` | 关闭：`ACTIVE → CLOSED` | 登录（仅本人） |
| POST | `/wishes/:id/fulfill` | 标记愿望成真：`ACTIVE → FULFILLED` | 登录（仅本人） |
| GET | `/wishes/pool` | 大家想要（匿名聚合需求池） | 登录（全站可用） |

设计要点：
- **Router 自包含**：`apps/api/src/modules/wishes/router.ts` 导出独立 Hono router，由 Dev A 在 `app.ts` 统一挂载（EPIC 规则 6），我不改根入口。
- **状态机**：只有 `ACTIVE → CLOSED`、`ACTIVE → FULFILLED` 两条边；对非 ACTIVE 愿望做编辑/再关闭返回 409。CLOSED/FULFILLED 为终态（P0 不做重新激活）。
- **鉴权**：所有写操作在 service 层二次校验 `wish.user_id === ctx.userId`，不信任路由参数。
- **幂等**：POST /wishes 前端防重复提交 + 服务端对同用户同 keyword+category 的 5 秒窗口去重（软幂等）；close/fulfill 为状态幂等（重复调用返回当前状态而非报错）。
- **`matchCount`**：从匹配侧读取。P0 先按 §6.2 的约定读 job 结果表/匹配表，Dev A 提供查询接口前先返回 `0`，不阻塞愿望链路。

### `GET /wishes/pool`（需求池，隐私安全）

对全站 `ACTIVE` 愿望聚合：

```json
{
  "items": [
    { "keyword": "机械键盘", "category": "DIGITAL",
      "wantCount": 7, "medianBudgetCents": 20000 }
  ]
}
```

- 按 `keyword + category` 归一化后 GROUP BY，取 `wantCount` 降序前 50。
- **k-匿名**：准入按**去重用户数** `count(DISTINCT user_id) >= 3`（同一用户刷多条不抬高门槛），`wantCount` 仍是该组的需求条数；不足门槛的分组不返回，防止小组意愿反推个人。
- 只输出聚合数字，**永不输出 user_id 或任何个人字段**（验收标准第 5 条）。
- 结果缓存 60s（进程内，P0 不引入 Redis）。

---

## 4. Contracts 设计（`packages/contracts/src/wishes/`）

前端 ouu2006 只依赖这一层对接，字段变更走 PR/Issue 反馈给我：

```
packages/contracts/src/wishes/
├─ schema.ts      # zod: wishCreateInput / wishUpdateInput / wishDto / wishPoolItem
└─ routes.ts      # 路径 + 请求/响应类型常量（供前端 typed client 使用）
```

导入路径走深子路径：`@fish/contracts/wishes/schema`、`@fish/contracts/wishes/routes`（`package.json` 的 exports 是 `./*` → `./src/*.ts`，没有包级入口）。

关键校验规则（zod，前后端共用）：
- `keyword`: `string` 2–30 字符，trim 后非空，禁纯空白/纯符号
- `category`: 共享分类枚举
- `budget_min_cents`: `int ≥ 0`；`budget_max_cents`: `int > 0` 且 `≥ min`
- `description`: 可选 `≤ 500` 字符
- `accept_similar`: boolean，默认 true

包内不用大 barrel，走 package subpath exports（EPIC 规则 7）。

---

## 5. 创建愿望 → 异步匹配的触发方式

需求：创建愿望后写入 Match job（验收标准第 3 条）。但 matching 模块、worker、jobs 表全部归 Dev A。**我不写任何 job 代码，只投递事件**。

**协调点 ②（Dev A）**：请提供稳定的投递接口，二选一（我倾向 a）：

- a) Dev A 在 `packages/` 下（如 `packages/core` 或 matching contracts）导出 `enqueueWishMatch(wishId: string)`；wishes service import 它。
- b) Dev A 约定一个共享 `jobs` 表的插入函数；我按 Dev A 给的类型写。

在接口就绪前，wishes service 内用一个**可替换的注入点**：

```ts
// apps/api/src/modules/wishes/match-queue.ts —— 仅我的目录内
export interface WishMatchQueue {
  enqueue(wishId: string): Promise<void>;
}
// 默认实现为 no-op（记日志），Dev A 接口落地后替换/由接线时注入
```

这样创建愿望的主链路现在就能测试，匹配触发属于纯增量接线，不产生跨目录改动。

---

## 6. 跨 Owner 协调点汇总（唯一需要别人配合的清单）

| # | 对象 | 需要什么 | 阻塞程度 |
|---|---|---|---|
| ① | zzstar101 (Dev A) | `wishes` 表 drizzle schema + migration（§2 DDL）+ `pg_trgm` 扩展 | 阻塞集成测试；开发期测试内临时建表 |
| ② | zzstar101 (Dev A) | 匹配 job 投递接口 `enqueueWishMatch(wishId)`（§5） | 不阻塞；先 no-op 注入点 |
| ③ | zzstar101 (Dev A) | `app.ts` 挂载 wishes router（一行接线） | 不阻塞开发；合并时一行 PR |
| ④ | ouu2006 (前端) | 按 §4 contracts 实现愿望页；字段需求走 PR/Issue | 不阻塞 API 开发 |
| ⑤ | zzstar101 | 分类枚举共享常量的归属文件 | 小；可先在 wishes contracts 内临时定义，Dev A 落地 listings 时合并 |
| ⑥ | zzstar101 (Dev A) | **认证身份来源**：auth 模块（#18）尚未合并。router 通过 `getUserId(context)` resolver 取 `userId`（拿不到即 401，不读请求头）；请确认 middleware 的挂载方式与 `c.get()` 的 key（如 `c.get('userId')`），接线时传入对应 resolver | 不阻塞开发；#18 合并后补 resolver 接线 |

除以上 6 点，我不产生任何对他人目录的写入。

---

## 7. 测试计划（bun test，全部在我的目录内）

- **单元**：zod 校验边界（keyword 长度、budget min≤max）、状态机非法迁移、非本人操作 403、ACTIVE 上限 10 条。
- **集成**（需 Dev A 的 migration，本地 docker-compose 起 PG）：CRUD 全链路、pool 聚合的 k-匿名、分页。
- **契约**：contracts 的 zod schema 与 API 实际响应一致性。

## 8. 分支与交付节奏

1. `feat/wish-contracts` — contracts 先行合入，前端可立刻按类型开发 UI。
2. `feat/wish-api` — service + router + 测试（带 no-op match queue），提交 DB CHANGE REQUEST。
3. Dev A 出 migration 后：集成测试 + 接线 PR（由 Dev A 执行挂载），替换 match queue 实现。

每步小 PR、先合先验（EPIC 规则 9、10）。

---

## 9. 详细实施步骤

> 基于脚手架现状（2cb59ca）：contracts 用 zod v4 + subpath exports（`@fish/contracts/wishes/schema`）；API 用 `bun:test` + `app.request()` 测试；Docker 可用时 DB 集成用例真实运行，不可用时 `test.skipIf(!process.env.DATABASE_URL)` 跳过；auth/jobs 均由 #2 提供、尚未落地。

### 阶段 0：环境基线（10 分钟）

> 本机现状：Docker 已具备（用于 `db:up` 起 Postgres + MinIO）；Bun 尚未安装；Git Bash 的 PATH 中未见 `docker` 命令（Docker Desktop 需处于运行状态，或改用 PowerShell 执行）。

1. 安装 Bun（Windows PowerShell）：`irm bun.sh/install.ps1 | iex`，重开终端确认 `bun --version`。
2. 确认 `docker` 可用：若 Git Bash 中找不到命令，先启动 Docker Desktop，或将 `C:\Program Files\Docker\Docker\resources\bin` 加入 PATH。
3. `bun install`；`cp .env.example .env`（本地填 DB/S3 配置）。
4. `bun run db:up` 启动 Postgres + MinIO；`bun run db:migrate` 应用现有 migration。
5. `bun run typecheck && bun run lint && bun test` —— 确认基线全绿（Docker 可用时 DB 用例也会真实运行），之后每步都保持绿。

### 阶段 1：Contracts 先行（分支 `feat/7-wish-contracts`，PR #A）

目标：让 ouu2006 拿到类型即可开工 UI，是我这边唯一不被任何外部依赖阻塞的交付。

新建三个文件（均为我的目录，无跨 Owner）：

**1.1 `packages/contracts/src/wishes/schema.ts`**

```ts
import { z } from 'zod'

export const wishStatusSchema = z.enum(['ACTIVE', 'CLOSED', 'FULFILLED'])

// 协调点⑤：listings contract 落地后迁移为共享枚举引用
export const wishCategorySchema = z.enum([
  'DIGITAL', 'BOOKS', 'BEAUTY', 'DAILY', 'SPORTS', 'APPAREL', 'TRANSPORT', 'OTHER',
])

const trimmedKeyword = z.string().trim().min(2).max(30)
  .refine((k) => /[^\s\p{P}]/u.test(k), '关键词不能只有空白或标点')

export const wishCreateInputSchema = z.object({
  keyword: trimmedKeyword,
  category: wishCategorySchema,
  budgetMinCents: z.number().int().nonnegative(),
  budgetMaxCents: z.number().int().positive(),
  description: z.string().max(500).optional(),
  acceptSimilar: z.boolean().default(true),
}).refine((w) => w.budgetMaxCents >= w.budgetMinCents, {
  message: 'budgetMaxCents 必须 ≥ budgetMinCents',
})

export const wishUpdateInputSchema = wishCreateInputSchema.innerType()
  .partial()   // 全字段可选；service 层禁止改 status

export const wishDtoSchema = z.object({
  id: z.string(), userId: z.string(),
  keyword: z.string(), category: wishCategorySchema,
  budgetMinCents: z.number().int(), budgetMaxCents: z.number().int(),
  description: z.string().nullable(), acceptSimilar: z.boolean(),
  status: wishStatusSchema,
  matchCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
})

export const wishListResponseSchema = z.object({
  items: z.array(wishDtoSchema), total: z.number().int(),
})

export const wishPoolItemSchema = z.object({
  keyword: z.string(), category: wishCategorySchema,
  wantCount: z.number().int(), medianBudgetCents: z.number().int(),
})
export const wishPoolResponseSchema = z.object({ items: z.array(wishPoolItemSchema) })
// + 各 z.infer 类型导出
```

**1.2 `packages/contracts/src/wishes/routes.ts`**：路径常量（`/wishes`、`/wishes/:id`、`/wishes/:id/close`、`/wishes/:id/fulfill`、`/wishes/pool`）。

**1.3 `packages/contracts/src/wishes/schema.test.ts`**：纯 zod 测试（无需 DB）——keyword 长度边界、budget min>max 拒绝、trim 行为、status 枚举。

收尾：
```bash
bun run typecheck && bun run lint && bun test
git checkout -b feat/7-wish-contracts && git add packages/contracts/src/wishes
git commit -m "feat(wishes): add wish domain contracts"
git push -u origin feat/7-wish-contracts   # 立即开 Draft PR，@ouu2006 确认字段
```

PR 描述注明：对应 Issue #7、未修改他人目录、请 ouu2006 确认字段后 **Contract Freeze**。

### 阶段 2：API 模块（分支 `feat/7-wish-api`，PR #B）

新建目录 `apps/api/src/modules/wishes/`：

**2.1 `router.ts`** —— 导出独立 `wishesRouter`（不动 `app.ts`）：

```ts
import { Hono } from 'hono'
// 身份：只认调用方注入的 getUserId resolver，缺失即 401；不读请求头
// 路由绑定 → 调 service.ts，zod parse 请求体，响应 Zod schema parse 后返回
```

**2.2 `service.ts`** —— 纯函数式 service，`createWishService({ db, matchQueue })` 依赖注入，便于测试：

- `createWish`：校验 ACTIVE 上限 10 → 插入 → `matchQueue.enqueue(id)`；
  软幂等：同 user 同 keyword+category 且 `created_at > now() - 5s` 直接返回已有行。
- `listWishes(userId, status?, page)`、`getWish(id, userId)`（非本人 403）。
- `updateWish`：仅本人 + 仅 ACTIVE；非法状态返回 409。
- `closeWish` / `fulfillWish`：状态机校验 `ACTIVE →`，重复调用幂等返回当前状态。
- `getPool`：
  ```sql
  SELECT keyword, category, count(*)::int AS want_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY budget_max_cents)::int AS median_budget_cents
  FROM wishes WHERE status = 'ACTIVE'
  GROUP BY keyword, category HAVING count(*) >= 3
  ORDER BY want_count DESC LIMIT 50
  ```
  （`matchCount` P0 先固定返回 0，等 Dev A 匹配结果表就绪后接入。）

**2.3 `match-queue.ts`** —— §5 的 `WishMatchQueue` 接口 + no-op 实现。

**2.4 测试**：

- `service.test.ts`：状态机非法迁移、ACTIVE 上限、非本人 403、软幂等（不依赖 DB 的逻辑单测）。
- `router.test.ts`：`app.request()` 风格走 router，测试内自建 middleware 写入 `userId` 以喂给 `getUserId`；DB 依赖用例 `test.skipIf(!process.env.DATABASE_URL)`，测试内 `CREATE TABLE IF NOT EXISTS wishes ...`（标注为临时，Dev A migration 落地后删除）。

**2.5 收尾**：typecheck / lint / test 全绿 → commit `feat(wishes): add wish api module` → Draft PR（勾选 DB CHANGE REQUEST 项，注明"未修改他人目录"）。

### 阶段 3：DB CHANGE REQUEST（协调 zzstar101，阻塞集成）

1. 在 PR #B 与 Issue #7 下贴出 §2 的 drizzle schema 定义 + SQL，请 zzstar101 落 `packages/db/src/schema/wishes.ts` + migration + `pg_trgm`。
2. 等 migration 合并后：删除测试内临时建表，`import` Dev A 的 wishes 表类型，跑 `bun run db:migrate` 后全量集成测试。

### 阶段 4：根路由接线（协调 zzstar101，1 行）

zzstar101 在 `app.ts` 中挂载 `app.route('/wishes', wishesRouter)`。合并顺序：contracts PR #A → API PR #B → 接线改动（可由 zzstar101 在其集成 PR 中带上）。

### 阶段 5：匹配触发接线（等 #2 jobs 表 + Dev A 接口）

用 Dev A 的 `enqueueWishMatch(wishId)` 替换 no-op queue（只改我目录内的 `match-queue.ts` 工厂参数，service 不变）。`matchCount` 接入匹配结果读取。

### 阶段 6：验收 + 收尾

- 逐条核对 #7 验收标准（多 ACTIVE 愿望 / 关闭 / fulfilled / 创建触发匹配 / pool 读匹配数 / 匿名聚合 / 零跨 Owner 改动）。
- `bun run typecheck && bun run lint && bun test` 全绿，PR 转 Ready（`closes #7`），squash merge。

### 依赖关系

```
阶段1 contracts ──→ 阶段2 API ──→ 阶段4 接线 ──→ 阶段6 验收
                        │              ↑
                        │              └── 阶段3 migration（zzstar101，可与阶段2并行）
                        └── 阶段5 匹配接线（zzstar101 的 jobs/#2，最后做，不阻塞验收主链）
```

阶段 1、2 完全不依赖任何人；阶段 3、4 只差 zzstar101 的两小步；阶段 5 可与验收主链解耦。
