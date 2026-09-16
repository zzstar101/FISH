# 协作规则（CONTRIBUTING）

本项目由团队成员在同一 monorepo 上**长线开发**。任务通过 **Issue 认领**完成：**一个 Issue 就是一个模块**，由认领人从头到尾做完（前端、后端、Contract 都在其中），**不按前端/后端拆分给多人**。

- 不设按人固定的文件所有权，也不再使用 CODEOWNERS。
- 改动任何文件（包括他人写过的代码）**无需事先征得同意**；并行靠 Issue 切分互不重叠，冲突在合入时解决。
- **所有 PR 最终由 zzstar101 审核。**

## 1. 认领任务（Issue 即模块）

- 每个 Issue 对应一个模块：认领人把 Issue 指派给自己，并对其验收标准负责。
- 模块的**前端（`apps/web`）、后端（`apps/api`）、Contract（`packages/contracts`）都由认领人一个人完成**，不按前后端分包。
- 认领前先确认与别人正在做的模块互不重叠，避免并行冲突。
- 认领后按第 3 节开分支：一个 Issue 一个 `feat/<issue>-<slug>`。

## 2. 文件与并行

- 不设文件所有权，也不需要"Owner 同意"流程。
- 并行安全靠 **Issue 互不重叠**；需要触碰他人正在进行的模块时，注意合并冲突风险，并在 PR 里说明大致影响。
- 跨模块公共文件（根配置、`.github/**`、`infra/**`、`packages/db` 的 schema/migration、API/Worker 根入口等）人人可改，但要做**最小改动**，并保证不破坏其它模块。
- 全仓级约束仍有效：加/删依赖必须带 `--registry`（第 3.1 节）、不手改生成文件、不污染 `bun.lock`。
- **每个 PR 合并前必须由 zzstar101 审核。**

## 3. 分支与提交

- 每个 Issue 一个小分支：`feat/<issue>-<slug>`，例如 `feat/1-infra-scaffold`。
- 提交信息用 **Conventional Commits**：`<type>(<scope>): <subject>`。
  - type：`feat | fix | docs | refactor | perf | test | build | ci | chore | types`
  - subject 用祈使句、小写、不超过 50 字符、结尾不加句号。
- 推送后尽早开 **Draft PR**，完成验收清单后转 Ready。
- 使用 **squash merge**，保持 `main` 线性。

### 3.1 加依赖必须显式指定默认源

**每次 `bun add` / `bun remove` / `bun update` 都必须带 `--registry`**：

```bash
bun add --registry https://registry.npmjs.org <pkg>
bun add --registry https://registry.npmjs.org -d <pkg>
bun remove --registry https://registry.npmjs.org <pkg>
bun update --registry https://registry.npmjs.org <pkg>
```

`bun.lock` 里 tarball URL 的约定：**默认源一律是空字符串**。CI 的 `Verify lockfile sources` 是**白名单**：只接受默认源的空 URL 与 `https://registry.npmjs.org/`。确需其它源（私有 registry、git / tarball 依赖）时，必须在同一个 PR 里同时更新那一步的白名单，并在 PR 说明理由。

**原因**：如果本机默认 registry 是镜像源（如 npmmirror），`bun add` 会把 lockfile 里**每一个**已存在的包条目都改写成带镜像 URL 的形式 —— 不只是你新增的那几个包，而是数百行无关 diff（`ogl` 那次 551 行、PR #26 那次 361 个包）。这种 diff 在 review 时极难发现，当机器上不可达那个镜像源时会直接让 `bun install` 失败。

**为什么不能只靠 review 和 CI 的 install 拦**：`bun install --frozen-lockfile` 只校验 lockfile 与 `package.json` 是否一致，**不校验 tarball URL 的来源**，污染后照样通过。因此 CI 额外加了 `Verify lockfile sources` 一步（见 `.github/workflows/ci.yml`）：反向断言 `bun.lock` 中只出现 `registry.npmjs.org` 或默认源的空 URL。本地可以先自查：

```bash
grep -oE 'https?://[^"]+' bun.lock | grep -vE '^https://registry\.npmjs\.org/' && echo '被污染了' || echo '干净'
```

## 4. PR 要求

使用仓库的 PR 模板，必须明确：

- 对应 Issue 编号（用 `closed #N` / `closes #N` 关联）。
- 验收标准逐条勾选 + 可复现的验证命令。
- 是否改动跨模块公共文件或涉及 DB schema（若有，说明大致影响，供审核参考）。
- 是否提交了任何真实密钥（**禁止**）。

## 5. Contract

- Contract **不设统一的定义 / 冻结流程**：由各模块认领人**在实现时自行定义**所用到的域协议。
- 按 **Domain 分目录**，禁止把 DTO 堆进共享 `types.ts`。
- 禁止大型 barrel `index.ts`；优先 **direct import / package subpath exports**。
- 跨模块需要复用对方 Domain 的字段时，直接引用其 exports，或在对应 Issue/PR 里说明。

## 6. DB schema 变更

- schema 与 migration 就是普通代码，随模块 PR 一起落地：改 schema 必须用 `drizzle-kit` 生成 migration，**不手改 migration 历史**与生成文件。
- 改动 schema 时，在 PR 里填写变更说明（供 zzstar101 审核把关）：

```text
DB 变更说明
- 表/实体：
- 新增/修改的字段与类型：
- 使用场景（对应 Issue）：
- 是否影响已有数据：
```

## 7. 合入与审核

- 完成验收清单后把 Draft PR 转 Ready，**所有 PR 由 zzstar101 审核**后合入。
- 集成问题由各模块认领人自己跟进（前端、后端、Contract）。

## 8. 禁止事项

1. 不提交任何真实密钥、Token、连接串；只维护 `.env.example`。
2. 不手改生成文件：`apps/web/src/routeTree.gen.ts`、`packages/db/src/migrations/**`。
3. 加/删依赖必须带 `--registry`（见第 3.1 节），不污染 `bun.lock`。
4. 不在业务 Issue 中顺手做无关重构；发现问题先报告，确有必要时新开 Issue。
5. 不引入 V1 明确排除的组件（Redis / Kafka / OpenSearch / K8s 等）。
6. 不自行合入 PR —— 每个 PR 必须先经 **zzstar101 审核**。
