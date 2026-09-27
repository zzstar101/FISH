# AGENTS.md（packages/db）

本包持有 Drizzle schema、migration、seed 与迁移脚本。**根目录 [AGENTS.md](../../AGENTS.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md) 全部有效，本文件只增加本包特有的约束。**

## 迁移（migration）

- schema 在 `src/schema/*.ts`；migration 与 `src/migrations/**`（含 `meta/` 快照）**由 `drizzle-kit` 生成**：`bun run --filter '@fish/db' generate`。**不手改** `src/migrations/**`（含 `meta/_journal.json`）—— 见根 `AGENTS.md` 第 8 节危险清单。
- **不改迁移历史**：已合入的 migration 文件与其序号不许重写、重排、复用；新 migration 只能追加到末尾。当前 `origin/main` 的末条是 `0025_shallow_mimic`（`src/migrations/meta/_journal.json`）。
- **序号按合入顺序分配，两个并行分支各自生成必然撞号**：开工前先看 `origin/main` 的 `meta/_journal.json`，生成新迁移前再 `git fetch origin --prune` 复核一次；预期撞号时在 PR 里写明并 rebase 后重新生成。
- 落地与本地验证：`bun run db:up`（起 Postgres）→ `bun run --filter '@fish/db' migrate`。改 schema 时按 `CONTRIBUTING.md` 第 6 节在 PR 里填「DB 变更说明」。

## seed

- `src/seed.ts` 用**单条 `TRUNCATE`** 清库（`:102-104`，表清单在 `:103`）。**新增业务表必须同步加进这条语句**，否则本地 seed 会直接失败（报 `0A000`，不需要表里真有数据）；`:96-101` 的注释表清单与 `seed.test.ts` 的 counts 也要一并更新。
- `matches` / `notifications` 刻意不 seed（由 worker 用真实打分产出一条 `PENDING` 匹配），不要"补全"它们。

## 依赖例外（不要"修掉"）

- `postgres` 是本包的 **devDependency**，仅供 `drizzle-kit` CLI（它跑在 Node 下、不支持 `bun:sql`）。运行时（api / worker）一律走 `drizzle-orm/bun-sql`；不要把 `postgres` 升为运行时依赖，也不要引入 `pg`。

## 测试

- 需要真库的测试用**独立 scratch 库**：先例 `fish_seed_test_${process.pid}`（`src/seed.test.ts:31`）与 `fish_migration_test_${process.pid}`（`src/migrations.test.ts:28`）。不要复用别人的库，更不要拿 `fish` 主库当测试库。
