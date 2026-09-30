# 并行 Worktree 独立开发数据库

并行任务（agent 或多人）在各自 worktree 里必须使用**各自的独立开发库**，禁止把别的分支的 migration 应用到共享开发库后混跑。本规范与脚本 `scripts/dev-db.ts`（`bun run db:dev`）解决建库、迁移、清理三件事。

## 库命名规则

```text
fish_dev_<slug>_<hash8>
```

- `<slug>`：当前 worktree 的分支名（detached HEAD 时退化为 worktree 目录名），小写、非 `[a-z0-9-]` 归一为 `-`、截断 20 字符。
- `<hash8>`：worktree **绝对路径**的 sha256 前 8 位。

由此：同一个 worktree 派生名恒定（连续调用 `url` 输出相同）；不同 worktree 派生名互不相同。脚本对目标库名做白名单校验（必须匹配 `^fish_dev_[a-z0-9][a-z0-9-]{0,39}_[0-9a-f]{8}$`），非法库名在**建立任何数据库连接之前**非零退出。

## 命令

| 命令 | 作用 |
| --- | --- |
| `bun run db:dev up` | 为当前 worktree 建独立库（如缺）并对**该库**跑 `drizzle-kit` 迁移 |
| `bun run db:dev url` | 打印当前 worktree 的 `DATABASE_URL`（不连库） |
| `bun run db:dev drop` | 删除当前 worktree 的独立库（`drop database ... with (force)`） |
| `bun run db:dev list` | 列出本机全部 `fish_dev_*` 库及其归属 worktree |

典型流程（新 worktree）：

```bash
git worktree add ../fish-<topic> -b <branch> origin/main
cd ../fish-<topic>
bun install --frozen-lockfile

bun run db:dev up                      # 建库 + 迁移，并打印该库的 DATABASE_URL
export DATABASE_URL="$(bun run db:dev url)"   # 后续 dev/test 均指向独立库

# … 开发 / 测试 …

bun run db:dev drop                    # 结束后清理
```

## 指向独立容器

默认管理连接是共享实例的 maintenance 库（`postgres://fish:fish@localhost:5432/postgres`）。要指向独立容器，用 `--admin-url` 或环境变量 `DATABASE_ADMIN_URL`（命令行优先）。仓库既有先例：独立容器 `fish217-postgres18` 监听 `127.0.0.1:55432`，即

```bash
bun run db:dev up --admin-url postgres://fish:fish@localhost:55432/postgres
```

`up` 的迁移步骤会把 `DATABASE_URL` 指向新库再执行 `bun run --filter '@fish/db' migrate`；Bun 中进程环境变量优先于包脚本里的 `--env-file=../../.env`，因此不会回落到 `.env` 里的共享库。

## 并发语义

同一 worktree 并发 `up` 是安全的：脚本按库名取一把会话级 advisory lock，把「建库 + 迁移」整段串行化，后到者等前一个做完再进临界区，此时库已存在、迁移已完成（`drizzle-kit migrate` 幂等），直接放行输出 `DATABASE_URL`。

只兜住建库那一步是不够的——实测两个 `up` 会同时进入迁移步骤并撞在 `pg_namespace` 的唯一约束上，所以锁覆盖的是整段而不只是 `create database`。

**不同 worktree 之间不需要锁**：库名由 worktree 路径派生，互相不重叠，可以真正并行。

## 三条禁令

1. **不得对共享 `fish` 库跑别的分支的 migration**——并行任务一律 `db:dev up` 各自的 `fish_dev_*`。
2. **不得复用其它 worktree 的 `fish_dev_*` 库**——库名由 worktree 路径派生，跨 worktree 共用等于变相共享。
3. **测试/任务结束必须 `db:dev drop`**——不残留孤儿库（`db:dev list` 可盘点）。

## 既有先例对照（独立库命名，非 `fish_dev_*` 约定）

| 库名模式 | 出处 |
| --- | --- |
| `fish_67_rt` | `.decomp/parallel-plan.md` 记录的 per-purpose 实测库 |
| `fish_marketplace_flow_test_${process.pid}` | `apps/api/src/modules/transactions/marketplace-flow.test.ts` |
| `fish_seed_test_${process.pid}` | `packages/db/src/seed.test.ts` |

测试自建库沿用各自测试文件的约定；本脚本只管理开发期 `fish_dev_*` 独立库。
