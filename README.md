# FISH

广应科校内二手交易平台 · **移动端 Web PWA**。

> 当前处于 **Phase 0 工程骨架阶段**（issue #1）。
> 本仓库现在只有脚手架：**不含任何 Listing / Wish / Match / Chat / Transaction 业务定义**。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Runtime / 包管理 | **Bun**（`>= 1.4.0`） |
| 前端 | React + Vite + TypeScript |
| 路由 / 服务端状态 | TanStack Router + TanStack Query |
| UI | Tailwind CSS（shadcn/ui 由前端 Owner 接入） |
| 后端 | **Hono on Bun**（`Bun.serve`） |
| 校验 | Zod |
| 数据库 | PostgreSQL 16 + Drizzle ORM（`drizzle-orm/bun-sql`） |
| 异步 | PostgreSQL jobs + 独立 Bun Worker |
| 实时 | Hono / Bun 原生 WebSocket |
| 对象存储 | S3 兼容（本地用 MinIO） |

V1 **不引入** Redis / Kafka / OpenSearch / K8s / 微服务。

## 目录结构

```text
FISH/
├─ apps/
│  ├─ web/       # React + Vite（移动端 PWA 壳；页面由 #4 起）
│  ├─ api/       # Hono on Bun：/health、/ws
│  └─ worker/    # 常驻 job 轮询进程
├─ packages/
│  ├─ db/        # Drizzle 连接与 schema（schema 由 #2 建立）
│  ├─ contracts/ # 对外协议；业务 Contract 由各业务 Issue 建立
│  ├─ ui/        # 共享 UI 组件（由前端 Owner 建立）
│  └─ shared/    # 跨包基础能力（环境变量校验等）
├─ docs/         # 文档
├─ infra/        # 部署相关
├─ scripts/      # 一次性脚本（ws-smoke 等）
└─ docker-compose.yml   # 只托管本地依赖
```

## 本地启动（最小路径）

前置：**Bun >= 1.4**，以及 **Docker**（仅用于本地依赖）。

```bash
# 1. 安装依赖
bun install

# 2. 准备环境变量（只需一次；.env 已被 .gitignore 忽略，切勿提交）
cp .env.example .env

# 3. 启动本地依赖：Postgres + MinIO（含 healthcheck 与 bucket 初始化）
bun run db:up

# 4. 分三个终端分别启动应用
bun run dev:api      # API   → http://localhost:3000
bun run dev:worker   # Worker（常驻，不监听端口）
bun run dev:web      # Web   → http://localhost:5173

# 5. 验收
open http://localhost:5173      # 页面应显示 status: ok / db: up
bun run ws:smoke                # 应输出 [ws-smoke] ok
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `bun run dev:web` / `dev:api` / `dev:worker` | 分别启动三个应用 |
| `bun run dev` | 一次并行启动三者（同样可用） |
| `bun run typecheck` | 全仓 TypeScript 7 类型检查 |
| `bun run lint` / `bun run format` | Biome 检查 / 格式化 |
| `bun test` | 全仓测试（需 Postgres 的用例在无 `DATABASE_URL` 时自动跳过） |
| `bun run build` | 构建 |
| `bun run ws:smoke` | WebSocket 连通性冒烟 |
| `bun run db:up` / `db:down` | 启动 / 停止本地依赖 |
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle 迁移与调试 |

### 端口

| 服务 | 端口 |
| --- | --- |
| web | 5173 |
| api | 3000 |
| worker | 不监听端口 |
| MinIO API / Console | 9000 / 9001 |
| PostgreSQL | 5432 |

## 文档

- [架构说明](docs/architecture.md) — 系统形态、运行时拓扑、链路与所有权
- [CONTRIBUTING.md](CONTRIBUTING.md) — 文件所有权、分支/提交/PR、Contract 流程
- [AGENTS.md](AGENTS.md) — 给 AI agent 的操作与实现纪律
- [docs/](docs/README.md) — 文档索引
