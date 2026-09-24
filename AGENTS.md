# AGENTS.md

给 AI coding agent 的操作手册。**人看的协作规则在 [CONTRIBUTING.md](CONTRIBUTING.md)，架构在 [docs/architecture.md](docs/architecture.md)** —— 本文件不重复它们，只写 agent 最容易做错的部分。

> **⚠️ 涉及 `apps/miniapp`（小程序端）前端的任何改动，必须首先遵守 [docs/miniapp-dev-workflow.md](docs/miniapp-dev-workflow.md) 的强制工作流**：每个页面一个新分支、上一个分支完成才开下一个、动手前先提醒 Owner、必须到微信开发者工具演示并经 Owner 确认可行后才允许提交。它是本文件的最高优先级补充，先读它再动小程序代码。

本项目是 **移动端 Web PWA**（广应科校内二手交易平台 FISH），monorepo + Bun。

## 1. 命令

```bash
bun install                 # 安装依赖
cp .env.example .env        # 首次；.env 不进版本库
bun run db:up               # 启动本地依赖（Postgres + MinIO）
bun run dev:api             # API   :3000
bun run dev:worker          # Worker（常驻，无端口）
bun run dev:web             # Web   :5173

bun run typecheck           # TypeScript 7 全仓类型检查
bun run lint                # Biome 检查
bun run format              # Biome 格式化
bun test --isolate          # 全仓测试（每个测试文件独立全局/模块注册表）
bun run build               # 构建
bun run ws:smoke            # WebSocket 连通性冒烟
```

不要用 `npm` / `pnpm` / `yarn`，不要用 `npx` 替代 `bunx`。

## 2. 编码铁律

- **Bun 原生 API 优先**：`Bun.serve`、`Bun.sql`（经 `drizzle-orm/bun-sql`）、`Bun.file`、`Bun.write`、`Bun.sleep`、`Bun.crypto`。运行时不要引入 `pg` / `postgres` / `@hono/node-server` 等 Node 适配层。
  - **已知例外（不要“修掉”）**：`drizzle-kit` CLI 在 Node 下运行且不支持 `bun:sql`，因此 `packages/db` 把 `postgres` 声明为 **devDependency**，仅供 migration CLI 使用。运行时（api / worker）一律走 `drizzle-orm/bun-sql`。
- **TypeScript 严格模式**：遵守 `tsconfig.base.json`，不要用 `any` 或 `@ts-ignore` 绕过。
- **Biome** 负责 lint + format，不要另加 ESLint / Prettier 配置。
- **禁止大型 barrel `index.ts`**：优先 direct import / package subpath exports（如 `@fish/contracts/system/health`）。
- **包边界**：`apps/*` 与 `packages/*` 通过 `workspace:*` 引用；跨包只走 `exports` 暴露的路径。
- 提交信息用 Conventional Commits。

## 3. 范围纪律：只在指定 Issue 内开发

- **一个 Issue 就是一个模块**：认领人负责该模块**全部**验收标准，包括其**前端与后端代码**——不按前后端拆开让多人分别实现。
- **只实现当前被指派 Issue 的验收标准**。Issue 没要求的，不做。
- 需求外发现的问题（bug、坏味道、可优化点）**只报告，不顺手修**；确有必要时新开 Issue。
- 不提前实现后续 Issue 的内容。例：`packages/db` 的业务表属于 #2，`packages/contracts` 的 domain 协议属于各自业务 Issue。
- 不引入 Issue 明确排除的组件（Redis / Kafka / OpenSearch / K8s / 微服务）。
- 全仓不设按人的文件所有权（已去除 CODEOWNERS），改动任何文件**无需事先取得同意**；但改跨模块公共文件要做最小改动，别破坏其它模块。**每个 PR 必须由 zzstar101 审核**（见 CONTRIBUTING 第 2、7、8 节）。

## 4. 实现纪律：第一性原则 + 最小改动

- **做满足需求的最小改动**。先问"最简单的正确实现是什么"，再动手。
- 不为假想的未来需求做抽象；第二个调用方出现前不抽公共层。
- 不做与本次改动无关的重构、改名、格式化。**不要回退或重写不是你做的改动**，保留 worktree 中无关的变更。
- 不确定时先读代码与现有实现，不要凭记忆写 API 或命令；查证后再写。

## 5. 测试：恰好够用

- **只为"改动的行为"加测试**；改动不涉及行为时（纯文档、纯配置、纯重命名）不加测试。
- 修 bug 必须带一个**在修复前会失败**的用例。
- **不写凑覆盖率的多余测试**：不测语言/框架本身、不测显然的 getter、不为同一分支写多个等价用例。
- 不测试未在本次改动中出现的代码。

## 6. 验证（完成前必须做）

按"最窄 → 最宽"的顺序：

1. 先跑与改动直接相关的测试或冒烟命令。
2. `bun run typecheck`
3. `bun run lint`
4. `bun test --isolate`
5. 涉及运行时行为时，按 README 的最小启动路径实际跑起来验证（不要只靠静态检查下结论）。

> **小程序端（`apps/miniapp`）另有一条更严的验证门禁**：见 [docs/miniapp-dev-workflow.md](docs/miniapp-dev-workflow.md) —— 页面改动必须在微信开发者工具里演示、经 Owner 确认可行后才允许提交，不能被本节的静态检查替代。

CI 会跑同样的检查（`.github/workflows/ci.yml`）。任何一步失败都不得声称完成。

## 7. 完成后：派子代理做对抗性审查

实现、格式化、类型检查、测试都通过之后，**必须**对完整改动做一次独立审查：

- 使用**全新的子代理**（fresh subagent）执行审查，不要复用当前上下文。
- 只提供两样东西：**改动范围**与**要满足的需求**。
- **不要**提供实现思路、可疑点、已有结论、预期结果或任何提示。审查者必须独立得出结论，否则审查无效。
- 对每条可执行的发现：修复它，然后重跑受影响的验证。
- 若修复明显改变了实现，**重新发起一次**审查。
- 审查结论要落到实处：要么给出具体修复，要么说明为何该发现不成立（附文件与行号）。

## 8. 危险清单

- **不自行合入 PR**：每个 PR 必须由 zzstar101 审核后合入（见 CONTRIBUTING 第 7 节）。
- **不提交任何真实密钥**；只维护 `.env.example`。
- **不污染 `bun.lock`**：加/删依赖必须带 `--registry https://registry.npmjs.org`（本机默认源若是镜像源，会重写 lockfile 里全部已存在条目的 tarball URL）；详见 CONTRIBUTING.md 第 3.1 节。
- **不手改生成文件**：`apps/web/src/routeTree.gen.ts`、`packages/db/src/migrations/**`。
- 不调整 `migration` 历史；需要 schema 变更走 DB CHANGE REQUEST。
- 不执行破坏性 git 操作（`reset --hard`、`push --force`）到共享分支。

## 9. 沟通纪律

- 回答简短、具体、技术化。
- 不声称某个函数、模块、行为或命令存在，除非能给出**确切的文件与行号、源码片段或可复现的命令**。
- 拿不到证据时，直接说明"未验证"，不要把它当作事实陈述。
- 区分"事实"与"推测"；决策权在人类 Owner 手上。

## 10. 相关文档

| 文档 | 内容 |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Issue 认领、分支/提交/PR、zzstar101 审核、Contract、DB 变更说明 |
| [docs/miniapp-dev-workflow.md](docs/miniapp-dev-workflow.md) | **小程序前端强制工作流**：每页一分支、上一个完成再开下一个、改前提醒 Owner、开发者工具演示 + Owner 确认后才提交 |
| [docs/architecture.md](docs/architecture.md) | 系统形态、运行时拓扑、链路、端口 |
| [README.md](README.md) | 最小启动路径与常用命令 |
