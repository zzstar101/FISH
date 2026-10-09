# AGENTS.md

给 AI coding agent 的操作手册。**人看的协作规则在 [CONTRIBUTING.md](CONTRIBUTING.md)，架构在 [docs/architecture.md](docs/architecture.md)** —— 本文件不重复它们，只写 agent 最容易做错的部分。

> **⚠️ 涉及 `apps/miniapp`（小程序端）前端的任何改动，先读 [apps/miniapp/AGENTS.md](apps/miniapp/AGENTS.md) 与 [docs/miniapp-dev-workflow.md](docs/miniapp-dev-workflow.md)**：一批页面一条分支一个 PR、**合并前**必须到微信开发者工具逐页演示并经 Owner 认可。该端上流程**只适用于 `apps/miniapp`**，不适用于 `apps/web-pc`（PC 站）—— 它按本文件的通用纪律走，一个 PR 同样可以包含多个页面。原移动端 PWA `apps/web` 已随 [#325](https://github.com/zzstar101/FISH/issues/325) 移除。

本项目是**微信小程序 + PC Web**（广应科校内二手交易平台 FISH），monorepo + Bun：`apps/api`、`apps/worker`、`apps/miniapp`、`apps/web-pc` 与 `packages/*`。

## 1. 命令

```bash
bun install                 # 安装依赖
cp .env.example .env        # 首次；.env 不进版本库
bun run db:up               # 启动本地依赖（Postgres + MinIO）
bun run dev:api             # API   :3000
bun run dev:worker          # Worker（常驻，无端口）
bun run dev:web-pc          # PC Web（Vite :5174，basepath /pc/）
bun run dev:miniapp         # 小程序（Taro，产物用微信开发者工具打开）
bun run db:migrate          # 应用迁移（集成测试前必需）
bun run db:seed             # 灌演示数据

bun run typecheck           # TypeScript 7 全仓类型检查
bun run lint                # Biome 检查
bun run format              # Biome 格式化
bun test --isolate          # 全仓测试（每个测试文件独立全局/模块注册表；集成测试要求先 db:up + db:migrate）
bun run build               # 构建
bun run ws:smoke            # WebSocket 连通性冒烟
bun run core:smoke          # 核心链路冒烟
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

> **小程序端（`apps/miniapp`）另有一条端上门禁**：见 [docs/miniapp-dev-workflow.md](docs/miniapp-dev-workflow.md) —— 一批页面一个 PR、**合并前**必须在微信开发者工具里逐页演示并经 Owner 认可，不能被本节的静态检查替代。该门禁**只约束 `apps/miniapp`**。

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
- **不手改生成文件**：`apps/web-pc/src/routeTree.gen.ts`、`packages/db/src/migrations/**`（含 `meta/_journal.json`）—— 迁移 tag 由生成器写，见 `packages/db/AGENTS.md`。**第一处例外**：rebase 后把自己分支产出的迁移交回生成器重建时，允许**删除本分支自己新增的** `.sql` / `meta/*_snapshot.json` / 对应 journal 条目，并**仅在这些新增条目之间按 `when` 升序重排**（见下面「并行分支的迁移冲突只按 `when` 解决」那一条）；已合入历史条目的 `tag`/`when`/SQL 内容仍一个字节都不改，也不得手工拼装 journal。
- **第二处例外：pgvector 扩展的引导语句（#322 M1）**：`CREATE EXTENSION IF NOT EXISTS vector;` 这类**前置引导**语句 drizzle-kit 表达不了（0.31 无 `CREATE EXTENSION` 生成能力，drizzle-orm 0.45 也没有对应 schema 对象），而 `generate --custom` 只产 `.sql` + journal 条目、**不产 snapshot**，会踩红 `packages/db/src/migrations-journal.test.ts` 的「snapshot 数量 === journal 条目数」断言。因此允许把这类语句**追加**在本分支新增迁移 `.sql` 的最前面（`vector` 类型必须先于 `CREATE TABLE` 存在）。边界同样是「只加不改」：生成器产出的语句一个字节不动，不得借这条例外改 tag/`when`/历史条目。详见 `packages/db/AGENTS.md` 的「pgvector 扩展」一条。
- **不调整 `migration` 历史**：已合入迁移的 `tag` / `when` / 文件内容一个字节都不改、不重排、不复用；新迁移只能由 `bun run --filter '@fish/db' generate` 追加。**迁移编号 = 生成时刻的 UTC+8 时间戳**（例 `20260928063000_late_havok`），不再按合入顺序手工分配 4 位序号；需要 schema 变更走 DB CHANGE REQUEST。
- **并行分支的迁移冲突只按 `when` 解决**：rebase 到最新 `main` 后必须**重新生成**本分支自己的迁移（删掉本分支产出的 `.sql` + `meta/*_snapshot.json` + `_journal.json` 条目再跑 `generate`）。这是上文「不手改生成文件」的**第一处例外**，且只允许两种编辑：删除本分支自己新增的条目，以及仅在这些新增条目之间按 `when` 升序重排；禁止手写序号，禁止改动或重排历史条目，禁止手工把两条 journal 条目拼在一起。
- 不执行破坏性 git 操作（`reset --hard`、`push --force`）到共享分支。

## 9. 沟通纪律

- 回答简短、具体、技术化。
- 不声称某个函数、模块、行为或命令存在，除非能给出**确切的文件与行号、源码片段或可复现的命令**。
- 拿不到证据时，直接说明"未验证"，不要把它当作事实陈述。
- 区分"事实"与"推测"；决策权在人类 Owner 手上。

## 10. 基线纪律：先 fetch，只信 `origin/main`

- **开工前先 `git fetch origin --prune`**。本地 checkout 的 remote-tracking ref 会过期，而过期的 `origin/main` 会让"某个文件/某一行的现状"整轮判断错位 —— 本仓已经发生过一次：多个 agent 基于陈旧 ref 把 `origin/main` 认成旧提交，得出一整轮错误结论，全部作废。
- **关于代码现状的判断只认已提交的 `origin/main`**：读文件用 `git show origin/main:<path>`，搜代码用 `git grep <pat> origin/main`。不要用本地工作区、未 fetch 的 `origin/main` 或记忆下结论 —— 本地工作区可能正被别人的在飞任务占用（例如 dirty 的 `#286` 分支）。
- **并行任务在独立 worktree 中做**：`git worktree add <dir> -b <branch> origin/main`。不要在别人正在用的 checkout 里切分支、`git add` 或暂存文件；不要动不属于本次任务的脏改动。
- 下结论前先记基线：`git rev-parse HEAD` / `git rev-parse origin/main`，并在回复或 PR 里写明（例："基于 `origin/main = 529ca42`"）。
- 引用行号前重新读该文件确认，不要沿用旧结论里的行号（行号随合入漂移）。

## 11. PR 生命周期与署名

- **push 不是任务终点**。PR 推上去之后要盯到自己这一轮彻底结束：
  - 等 CI 跑完（`.github/workflows/ci.yml`）；红 check 必须查明原因并修到全绿，不能留给 Owner。
  - 逐条处理审查意见：**先独立核实该发现是否成立** —— 成立就修，不成立就用文件与行号说明理由。
  - 带红 check、未读审查意见或未勾完的验收清单的 PR，一律视为**未完成**，不得报告"做完了"。
- **绝不把测试失败当作"预先存在的、与本次无关"而忽略**：任何失败都要先定位（包括确认它在 `main` 上是否也失败）；能修就修，不能修就在 PR 里给出证据与影响面，不允许静默跳过或绕过。
- **agent 产出的内容要署名**：由 AI agent 协助完成的 PR 描述、Issue 评论、Issue 正文，都注明 agent 与模型，例如：`由 AI agent 协助完成（DSH / deepseek-flash）`。PR 模板已含该栏目。

## 12. 相关文档

| 文档 | 内容 |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Issue 认领协议与 state label、分支/提交/PR、zzstar101 审核、Contract、DB 变更说明 |
| [apps/miniapp/AGENTS.md](apps/miniapp/AGENTS.md) | 小程序目录内的端上门禁入口（指向 `docs/miniapp-dev-workflow.md`） |
| [packages/db/AGENTS.md](packages/db/AGENTS.md) | 迁移与 seed 纪律：`drizzle-kit` 生成、tag = UTC+8 时间戳、不手改历史、`postgres` devDependency 例外 |
| [docs/miniapp-dev-workflow.md](docs/miniapp-dev-workflow.md) | **小程序端上验证工作流**：一批页面一条分支一个 PR、**合并前**开发者工具逐页演示 + Owner 认可（**只约束 `apps/miniapp`**，不适用于 `apps/web-pc`） |
| [docs/architecture.md](docs/architecture.md) | 系统形态、运行时拓扑、链路、端口 |
| [README.md](README.md) | 最小启动路径与常用命令 |
