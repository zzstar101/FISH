# 协作规则（CONTRIBUTING）

本项目由 3 人在同一 monorepo 并行开发。**并行的前提是文件所有权清晰**，否则会产生长期 unresolved merge conflict。

## 1. 成员与职责

| 成员 | 角色 | 负责范围 |
| --- | --- | --- |
| **zzstar101** | Backend A / Platform & Core | 平台骨架、数据库、认证、商品、上传、匹配、Worker、最终集成 |
| **Coast-87** | Backend B / Marketplace Flow | 愿望、聊天、实时消息、交易、Profile API |
| **ouu2006** | Frontend Owner | 全部用户界面、移动端适配、视觉统一 |

## 2. 文件所有权（硬规则）

**谁拥有目录，谁修改。** 需要改动他人目录时，先在该 Issue/PR 说明，由**文件 Owner 落地**。

### zzstar101 独占

```text
package.json          bun.lock              .env.example
tsconfig.base.json    biome.json            docker-compose.yml
.github/**            infra/**
packages/db/**        packages/contracts/src/{auth,listings,matching}/**
apps/api/src/app.ts   apps/api/src/index.ts  apps/api/src/ws.ts
apps/api/src/modules/{auth,listings,uploads,matching}/**
apps/worker/src/index.ts       apps/worker/src/jobs/matching/**
migration 文件
```

### Coast-87 独占

```text
apps/api/src/modules/{wishes,conversations,messages,realtime,transactions,profile}/**
packages/contracts/src/{wishes,chat,transactions,profile}/**
```

Coast-87 **只导出独立的 router / service**，根路由由 zzstar101 统一接线。

### ouu2006 独占

```text
apps/web/**     packages/ui/**
```

## 3. 分支与提交

- 每个 Issue 一个小分支：`feat/<issue>-<slug>`，例如 `feat/1-infra-scaffold`。
- 提交信息用 **Conventional Commits**：`<type>(<scope>): <subject>`。
  - type：`feat | fix | docs | refactor | perf | test | build | ci | chore | types`
  - subject 用祈使句、小写、不超过 50 字符、结尾不加句号。
- 推送后尽早开 **Draft PR**，完成验收清单后转 Ready。
- 使用 **squash merge**，保持 `main` 线性。

## 4. PR 要求

使用仓库的 PR 模板，必须明确：

- 对应 Issue 编号（用 `closed #N` / `closes #N` 关联）。
- **是否修改了他人拥有的目录**（若有，说明已获得 Owner 同意）。
- 验收标准逐条勾选 + 可复现的验证命令。
- 是否涉及 **DB CHANGE REQUEST**（见下）。
- 是否提交了任何真实密钥（**禁止**）。

## 5. Contract 流程

`packages/contracts` 只是业务协议的存放位置，**不提前定义完整业务 Contract**：

```text
Issue 确认需求
→ 对应后端 Owner 定义该 Domain Contract
→ ouu2006 确认前端需要
→ Contract Freeze（本 Issue/PR 内冻结）
→ 前后端并行实现
→ Integration
```

规则：

- Contract 按 **Domain 分目录**，禁止把 DTO 堆进共享 `types.ts`。
- 禁止大型 barrel `index.ts`；优先 **direct import / package subpath exports**。
- 前端不直接修改后端 Contract；需要字段时在对应 Issue/PR 提出。

## 6. DB CHANGE REQUEST

`packages/db/**` 与 migration 仅 zzstar101 修改。

其他成员需要字段变更时，在 Issue/PR 中写出：

```text
DB CHANGE REQUEST
- 表/实体：
- 需要的字段与类型：
- 使用场景（对应 Issue）：
- 是否影响已有数据：
```

由 zzstar101 统一修改 schema 并生成 migration。

## 7. 每周期的接线窗口

每 3–4 小时一次 integration window：

- zzstar101：统一接 API/Worker 根路由、migration。
- Coast-87：只处理自己 Domain 的接口问题。
- ouu2006：只处理前端接口接入与 UI 问题。

## 8. 禁止事项

1. 不修改他人拥有的目录（见第 2 节）。
2. 不提交任何真实密钥、Token、连接串；只维护 `.env.example`。
3. 不手改生成文件：`apps/web/src/routeTree.gen.ts`、`src/migrations/**`。
4. 不引入新依赖或修改根配置而不经 zzstar101 同意。
5. 不在业务 Issue 中顺手做无关重构；发现问题先报告。
6. 不引入 V1 明确排除的组件（Redis / Kafka / OpenSearch / K8s 等）。
