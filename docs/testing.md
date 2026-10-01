# 测试与验证口径

本文是**可执行的验证口径**：每条命令的前置条件、验证顺序、以及 CI 的实际门禁结构。
与 `AGENTS.md` §6（完成门禁）一致；两者冲突时以仓库根 `AGENTS.md` 为准并回来修本文。

基线：`origin/main = b641fd7`（2026-10-01 逐条核对）。

## 1. 验证顺序（最窄 → 最宽）

1. 先跑与改动直接相关的测试或冒烟命令（定向 `bun test` 或对应 smoke）；
2. `bun run typecheck`；
3. `bun run lint`；
4. `bun test --isolate`（全量）；
5. 涉及运行时行为时，按 `README.md` 的最小启动路径实跑验证。

任何一步失败都不得声称完成；CI（`.github/workflows/ci.yml`）跑同一口径。

## 2. 命令与前置条件

| 命令 | 作用 | 前置条件 |
| --- | --- | --- |
| `bun install` | 安装依赖（per-workspace，`apps/*` 各有自己的 node_modules） | Bun ≥ 1.4.0；改依赖必须带 `--registry https://registry.npmjs.org`（见 `CONTRIBUTING.md` §3.1） |
| `bun run typecheck` | 全仓 TypeScript 检查（`bun run --filter '@fish/*' typecheck`，各包独立 tsconfig） | `bun install` 后 |
| `bun run lint` | Biome 检查（含格式） | 无 |
| `bun run format` | Biome 格式化写入 | 无 |
| `bun test --isolate` | 全仓测试 | 部分 db 型用例需要 Postgres 已启动且迁移已应用（先 `db:up` + `db:migrate`，见下）；缺迁移时大量用例红 |
| `bun run test` | 同 `bun test --isolate`（根 `package.json:25` 的别名） | 同上 |
| `bun run db:up` / `db:down` | 启动 / 停止本地 Postgres + MinIO（`docker compose`） | Docker；**只 wait postgres/minio 时用 `docker compose up -d --wait postgres minio`**（一次性容器 minio-init 正常退出会被整栈 `--wait` 误判） |
| `bun run db:migrate` | 应用 drizzle 迁移 | Postgres 已启动；`DATABASE_URL` 指向本地库 |
| `bun run db:generate` | 由 schema 生成迁移（**禁止手改** `packages/db/src/migrations/**`） | schema 有变更时 |
| `bun run db:seed` | 写入演示数据（三账号，密码 `fish123456`） | **会 `TRUNCATE` 全部业务表**（`packages/db/src/seed.ts:116`）；守卫 `assertLocalDatabase`（`packages/db/src/seed.ts:405-411`）拒绝非 localhost/127.0.0.1/::1 的连接串，绕过需显式 `SEED_FORCE=1` |
| `bun run db:promote` | 按显式学号把用户提升为 `ADMIN` 并写审计（#73 自举/受控提升） | `DATABASE_URL` 指向目标库；系统无任何 ADMIN 时才允许省略 `--actor` |
| `bun run db:studio` | Drizzle 数据浏览器 | Postgres 已启动 |
| `bun run ws:smoke` | WebSocket 连通性冒烟 | API 已在本机 `:3000` 运行 |
| `bun run core:smoke` | 核心主链端到端（自建 scratch 库 + 真实 API/Worker/MinIO） | Docker（自起 MinIO、自管 scratch 库）；`-- --runs=5` 连跑 5 轮，`-- --clean` 失败也清理 |
| `bun run rank:compare` | 推荐排序离线对比脚本（#322 M3：v1 / semantic-only / hybrid 权重组评估，不改生产行为） | 无——纯离线 fixture 评估，**不需要数据库 / `DATABASE_URL`**（脚本内明示，样本 cosine 人工给定） |

## 3. `--isolate` 的语义

`bun test --isolate` 让**每个测试文件**拿到独立的全局对象与模块注册表：文件间不共享被 mock 的
`fetch`、storage 或模块级单例，杜绝跨文件污染。权威入口两处，改口径必须同步：

- `package.json:25`（`"test": "bun test --isolate"`，本地 `bun run test` 的实义）；
- `.github/workflows/ci.yml:259-271`（db-tests 作业）与 `:289-303`（unit-tests 作业）的 Test 步骤。

## 4. Bun 版本口径

三处一致为 **1.4.0**，升级必须三处一起动：

- `package.json:5`（`"packageManager": "bun@1.4.0"`）；
- `package.json:7`（`"engines": { "bun": ">=1.4.0" }`）；
- `.github/workflows/ci.yml` 每个作业的 setup-bun 步骤（`:72,110,167,284,316,341,380`，全部 `"1.4.0"`）。

## 5. CI 的实际门禁结构（`origin/main = b641fd7` 时点）

作业按改动范围裁剪（`changes` 作业跑 `scripts/ci-changes.ts` 算范围；纯文档 PR 到 `changes`
为止，不装依赖、不起容器、不跑测试）。作业清单与行号：

| 作业 | 行号 | 内容 |
| --- | --- | --- |
| `changes` | `ci.yml:47` | 算改动范围，产出各作业开关 |
| `static` | `ci.yml:100` | lockfile 源断言（拒镜像源污染）→ Install → Lint & format → Typecheck |
| `db-tests` | `ci.yml:141` | 起 Postgres（+按需 MinIO）→ Migrate → Chat media smoke → `bun test --isolate` 受影响目录 |
| `unit-tests` | `ci.yml:274` | 无服务依赖的单测（web-pc / miniapp / contracts / shared / scripts） |
| `web-pc` | `ci.yml:306` | `Build PC web`（`:321`）+ `PC preview smoke`（`:325`，真实验证 `/pc` 308 与深链回退） |
| `miniapp` | `ci.yml:331` | `Build Miniapp`（`:346`，Taro production 构建） |
| `core-smoke` | `ci.yml:354` | 主链端到端（scratch 库 + 真实 API/Worker/MinIO） |
| `ci` | `ci.yml:450` | 聚合结论（作业按范围 skip 是正常的） |

事实陈述（本卡时点）：CI **构建** PC Web（build + preview smoke）与 miniapp（Taro build）；
`apps/web`（移动端 PWA）已随 #325 从仓库移除，不存在「未构建的 apps/web」这一缺口。
CI 不跑微信开发者工具级的小程序端上验证——那属 `docs/miniapp-dev-workflow.md` 的人工门禁。

## 6. `.env.example` 与环境变量校验的逐键核对结论

`.env.example`（当前 89 行）中出现的键**全部有真实消费方**，无幽灵键、无缺失键：

- `packages/shared/src/env.ts` 的各 `load*Env`：`AI_POLISH_*`（4）、`CONTENT_MODERATION_TRANSPORT`、
  `EMBEDDING_*`（4）、`MAIL_TRANSPORT`、`RESEND_API_KEY`、`RESEND_FROM`、`MEETUP_TOKEN_SECRET`、
  `TENCENT_*`（5）、`WECHAT_TRANSPORT` / `WECHAT_APPID` / `WECHAT_APP_SECRET` / `WECHAT_QR_ENV_VERSION`；
- `DATABASE_URL` / `API_PORT`：经 `packages/shared/src/env.ts` 的 `ServerEnvSchema` 校验，
  消费于 `apps/api/src/app.ts:132` 与 `apps/worker/src/index.ts:13`（`API_PORT` 在
  `apps/api/src/index.ts:62` 起服务）；
- `LISTING_LOOKUP_TRUSTED_PROXY_IP`：`apps/api/src/index.ts:43-45`（规范化校验，非法即启动失败）；
- `WEB_ORIGIN`、`S3_*`（6）：API 装配层与 `apps/api/src/modules/uploads/*`；
- `MAIL_OUTBOX_PATH`：`apps/api/src/modules/auth/email-providers.ts`（dev outbox 路径，缺省
  `.dev/mail-outbox.jsonl`，相对 API 工作目录）。

因此本卡**未改动 `.env.example`**（验收口径：只允许注释行或确实写错的键名；当前无此类问题）。
新增环境变量时必须同步 `.env.example` 并在对应 `load*Env` 里显式校验——缺配置启动即失败，
不静默降级（各 transport 的既有纪律）。
