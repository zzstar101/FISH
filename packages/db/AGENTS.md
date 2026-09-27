# AGENTS.md（packages/db）

本包持有 Drizzle schema、migration、seed 与迁移脚本。**根目录 [AGENTS.md](../../AGENTS.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md) 全部有效，本文件只增加本包特有的约束。**

## 迁移（migration）

- schema 在 `src/schema/*.ts`；migration 与 `src/migrations/**`（含 `meta/` 快照）**由 `drizzle-kit` 生成**：`bun run --filter '@fish/db' generate`。**不手改** `src/migrations/**`（含 `meta/_journal.json`）—— 见根 `AGENTS.md` 第 8 节危险清单。**唯一例外**：rebase 后重建本分支的迁移时，允许**删除本分支自己新增的** `.sql` / `meta/*_snapshot.json` / 对应 journal 条目，并**仅在这些新增条目之间按 `when` 升序重排**（见下面「并行分支不再撞号，但 rebase 后必须重新生成」那一条），已合入历史条目的 `tag`/`when`/SQL 内容一个字节都不改。
- **迁移编号（tag）= 生成时刻的 UTC+8 时间戳**，例 `20260928063000_late_havok`：`drizzle.config.ts` 开 `migrations.prefix = 'timestamp'`，而 drizzle-kit 内部只会写 UTC（`toISOString()`），UTC+8 由 `package.json` 的 `generate` 脚本 `bun --preload ./scripts/utc8-timestamp-prefix.ts` 兜住（**必须显式指向 `./node_modules/drizzle-kit/bin.cjs`**，按 bin 名启动的写法不应用 preload）。**不要再手写 4 位序号**：`0000`–`0025` 是遗留编号，新迁移一律用生成器产出的时间戳 tag。注意该路径耦合 bun 的 isolated 安装布局（真实文件在本包 `node_modules/drizzle-kit/`，根目录没有），且 **CI 不跑 `generate`**：升级 `drizzle-kit` 或更换包管理器后，先手动跑一次 `generate` 复核（路径失效会直接报「找不到模块」）。
- **不改迁移历史**：已合入 migration 的 `tag` / `when` / 文件内容不许重写、重排、复用；新 migration 只能追加到末尾。当前 `origin/main` 的末条是 `0025_shallow_mimic`（`src/migrations/meta/_journal.json`）。
- **并行分支不再撞号，但 rebase 后必须重新生成**：开工前先 `git fetch origin --prune` 复核 `origin/main` 的 `meta/_journal.json`；rebase 到最新 main 后，把自己分支产出的 `.sql` + `meta/*_snapshot.json` + `_journal.json` 条目**交回生成器重建**（删掉再 `generate`），不要手工合并 journal。解冲突只允许两种编辑：删除本分支自己新增的条目，以及仅在这些新增条目之间按 `when` 升序重排；不得改动任何条目的 `tag`/`when` —— `when` 乱序会让 drizzle 按 `when > 已应用值` 判定时**静默跳过**该迁移。
- 门禁：`src/migrations-journal.test.ts` 断言 tag 唯一、遗留数字序号段从 0 起与位置一一对应（并行分支各自追加同一编号会在这里被点名）、**遗留序号段已冻结**（数字 tag 恒为 26 条、末条 `0025_shallow_mimic`：接着手写 `0026_xxx` 会被点名，即使它的 idx 与位置恰好一致）、时间戳前缀 == 同条目 `when` 的 UTC+8 墙钟（容差 2s）、`when` 必须是有限数字（缺失 / `NaN` 会被 drizzle 静默跳过）且沿 journal 严格递增、`.sql` ↔ journal 双向对应、snapshot 数量 / `prevId` 链 / snapshot 文件名前缀与编号前缀一致，失败信息点名冲突双方；它在 `packages/db` 变更时随 `db-tests` job 在 CI 跑。
- 落地与本地验证：`bun run db:up`（起 Postgres）→ `bun run --filter '@fish/db' migrate`。改 schema 时按 `CONTRIBUTING.md` 第 6 节在 PR 里填「DB 变更说明」。

## seed

- `src/seed.ts` 用**单条 `TRUNCATE`** 清库（`:102-104`，表清单在 `:103`）。**新增业务表必须同步加进这条语句**，否则本地 seed 会直接失败（报 `0A000`，不需要表里真有数据）；`:96-101` 的注释表清单与 `seed.test.ts` 的 counts 也要一并更新。
- `matches` / `notifications` 刻意不 seed（由 worker 用真实打分产出一条 `PENDING` 匹配），不要"补全"它们。

## 依赖例外（不要"修掉"）

- `postgres` 是本包的 **devDependency**，仅供 `drizzle-kit` CLI（它跑在 Node 下、不支持 `bun:sql`）。运行时（api / worker）一律走 `drizzle-orm/bun-sql`；不要把 `postgres` 升为运行时依赖，也不要引入 `pg`。

## 测试

- 需要真库的测试用**独立 scratch 库**：先例 `fish_seed_test_${process.pid}`（`src/seed.test.ts:31`）与 `fish_migration_test_${process.pid}`（`src/migrations.test.ts:28`）。不要复用别人的库，更不要拿 `fish` 主库当测试库。
