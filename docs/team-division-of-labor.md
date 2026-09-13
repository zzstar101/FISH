# FISH 分工与交付清单

**口径**：本文件由 GitHub 数据生成，颗粒度到**模块**。

- 基线：`origin/main` = `4eade93`（提交快照时间见下）
- 数据源：`gh issue list --state all`、`gh pr list --state all`、`gh api .../pulls/<n>/files`、`git log origin/main`、`CODEOWNERS`、`CONTRIBUTING.md` 第 2 节
- 复核命令：

```bash
gh issue list --state all --limit 200 --json number,title,state,assignees
gh pr list --state all --limit 200 --json number,title,state,author,closingIssuesReferences
gh api repos/zzstar101/FISH/pulls/<n>/files --paginate --jq '.[].filename'
git log origin/main --format='%ae' | sort | uniq -c
```

> 说明：`main` 采用 squash merge，因此**按 PR 计数比按 commit 计数更准**。commit 计数只作参考（部分分支合并会把分支内多个 commit 带入 `main`）。

---

## 1. 三人概览

| 成员 | GitHub | Lane（CONTRIBUTING §1） | 文件所有权 | PR 总数 / 已合并 | `main` 提交数（按邮箱） |
| --- | --- | --- | --- | --- | --- |
| **zzstar101** | `@zzstar101` | Backend A / Platform & Core | 根配置、`.github/**`、`infra/**`、`packages/db/**`、`packages/contracts/src/{auth,listings,matching,system}`、`apps/api/src/{app.ts,index.ts,ws.ts}`、`modules/{auth,listings,uploads,matching}`、`apps/worker/**` | 9 / 9 | 10 |
| **Coast-87** | `@Coast-87` | Backend B / Marketplace Flow | `apps/api/src/modules/{wishes,conversations,messages,realtime,transactions,profile}`、`packages/contracts/src/{wishes,chat,transactions,profile}` | 18 / 17 | 17 |
| **ouu2006** | `@ouu2006`（提交身份亦为 `嚄u <3359796838@qq.com>`） | Frontend Owner | `apps/web/**`、`packages/ui/**` | 10 / 9 | 10 |

`main` 上另有 1 个 `Initial commit`（`96a47b7`，`zzstar <zzstarwork@gmail.com>`），**归属未验证**（17 + 10 + 10 + 1 = 38 = `git rev-list --count origin/main`）。

---

## 2. zzstar101 — Backend A / Platform & Core

### 2.1 已交付模块

| 模块 | 代码路径 | 对应 Issue | 落地 PR | 测试 |
| --- | --- | --- | --- | --- |
| 工程脚手架 / 工具链 / CI | `package.json`、`tsconfig.base.json`、`biome.json`、`apps/{web,api,worker}` 骨架、`packages/{contracts,shared,db,ui}`、`.github/workflows/ci.yml` | #1 | PR #16 | CI 自检 |
| 本地依赖编排 | `docker-compose.yml`、`infra/**`、`.env.example` | #1 | PR #16 | — |
| 核心数据模型 | `packages/db/src/schema/{common,users,sessions,listings,wishes,matches,conversations,messages,transactions,jobs,notifications}.ts`、`migrations/0000~0004`、`seed.ts` | #2 | PR #17 | `packages/db/src/seed.test.ts` 等 |
| Auth 域契约 | `packages/contracts/src/auth/{user,session}.ts` | #3 | PR #18 | — |
| Auth 模块 | `apps/api/src/modules/auth/{router,service,session,provider,middleware,errors}.ts` | #3 | PR #18 | `router.test.ts`、`provider.test.ts` |
| 系统域（错误信封 / health） | `packages/contracts/src/system/{error,health}.ts` | #1 / #3 | PR #16 / #18 | `error.test.ts`、`health.test.ts` |
| 商品域契约 | `packages/contracts/src/listings/{schema,routes}.ts` | #6 | PR #20 | `schema.test.ts` |
| 商品读写 / 发布 | `apps/api/src/modules/listings/{router,service,store,cursor,card}.ts` | #6 | PR #20、#24 | `router/store/service/cursor.test.ts` |
| 图片上传与对象存储 | `apps/api/src/modules/uploads/{router,service,storage}.ts` | #6 | PR #20 | `router/service/storage.test.ts` |
| 匹配域契约 | `packages/contracts/src/matching/{schema,routes,jobs}.ts` | #8 | PR #22 | `schema.test.ts` |
| 匹配读接口 | `apps/api/src/modules/matching/{router,service,store}.ts` | #8 | PR #22 | `router.test.ts`、`service.test.ts` |
| Worker 匹配任务 | `apps/worker/src/jobs/matching/{engine,scoring,handlers,queue}.ts`、`apps/worker/src/index.ts` | #8 / #43 | PR #22、#52 | `engine/scoring/handlers/queue.test.ts` |
| Worker 重启回收 + 核心主链冒烟 | `apps/api/scripts/**`、CI smoke step | #43 | PR #52、#55 | `bun run ws:smoke` |
| lockfile 源校验防线 | `.github/workflows/ci.yml`、`.gitignore`、`AGENTS.md`、`CONTRIBUTING.md` | #27 | PR #33 | CI `Verify lockfile sources` |

### 2.2 跨目录的历史落地

| 内容 | 路径 | PR | 说明 |
| --- | --- | --- | --- |
| 初始脚手架 | `apps/web/**`、`packages/ui/**` 骨架 | PR #16 | 早于 ouu2006 接管前端；仅 `main.tsx`、`__root.tsx`、`index.tsx`、`styles.css`、`button.tsx` |
| 核心主链冒烟脚本 | `apps/api/scripts/core-smoke.ts` | PR #52、#55 | 属 Owner 自有目录 |
| 协作规范 / PR 模板 / 根配置 | `AGENTS.md`、`CONTRIBUTING.md`、`.github/pull_request_template.md` | PR #16、#33 | `CODEOWNERS` 默认规则归属 zzstar101 |

> 未发现 zzstar101 在本周期内修改过 Coast-87 或 ouu2006 当前拥有的目录。

### 2.3 该 Owner 名下 Issue 状态

| Issue | 标题 | 状态 |
| --- | --- | --- |
| #59 | 全量 `bun test` 连接峰值超过 PG `max_connections`，随机 53300 | **OPEN**（P1） |
| #43 | Listing / Wish / Match / Worker / Storage + Demo 环境验收 | CLOSED（PR #52） |
| #13 | 真实 API 接线、E2E 与 Demo 验收 | CLOSED |

---

## 3. Coast-87 — Backend B / Marketplace Flow

### 3.1 已交付模块

| 模块 | 代码路径 | 对应 Issue | 落地 PR | 测试 |
| --- | --- | --- | --- | --- |
| Wish 域契约 | `packages/contracts/src/wishes/{schema,routes}.ts` | #7 | PR #19、#53 | `schema.test.ts`、`routes.test.ts` |
| Wish 模块（需求池 / 匿名门槛 / 幂等 job） | `apps/api/src/modules/wishes/{router,service,store,match-queue}.ts` | #7 | PR #19、#25、#53 | `router/service/store.test.ts` |
| Chat 域契约 | `packages/contracts/src/chat/{schema,routes}.ts` | #9 | PR #36 | `schema.test.ts` |
| 会话模块 | `apps/api/src/modules/conversations/{router,service,store,cursor}.ts` | #9 | PR #36 | `router/service/store/cursor.test.ts` |
| 消息模块 | `apps/api/src/modules/messages/{router,service,store}.ts` | #9 | PR #36 | `router/service/store.test.ts` |
| 实时推送 | `apps/api/src/modules/realtime/{hub,router}.ts` | #9 | PR #36 | `hub.test.ts`、`router.test.ts` |
| Transaction 域契约 | `packages/contracts/src/transactions/{schema,routes}.ts` | #11 | PR #37 | `schema.test.ts` |
| Transaction 状态机 + 原子锁定 | `apps/api/src/modules/transactions/{router,service,store}.ts` | #11 | PR #37 | `router/service/store/marketplace-flow.test.ts` |
| Profile 域契约 | `packages/contracts/src/profile/{schema,routes}.ts` | #12 | PR #38 | `schema.test.ts` |
| Profile 只读聚合 | `apps/api/src/modules/profile/{router,service,store}.ts` | #12 | PR #38 | `router/service/store.test.ts` |
| Notification 域契约 | `packages/contracts/src/notifications/{schema,routes}.ts` | #23 | PR #60 | `schema.test.ts` |
| Notification 读接口（列表 / 未读数 / 标记已读） | `apps/api/src/modules/notifications/{router,service,store}.ts` | #23 | PR #60 | **无模块内测试**（仅 `apps/api/src/app.notifications.test.ts`） |
| 双账号链路验收（真实 HTTP + WebSocket） | `apps/api/src/modules/transactions/marketplace-flow.test.ts`、相关用例 | #42 | PR #46 | 15 用例 × 5 轮 75 pass / 0 fail |
| 审查发现收口 | conversations / messages / profile / transactions 域内 | #40 | PR #45 → revert（#48）→ #49 重落 | 域内用例 |
| 文档 | `docs/design/issue-7-wish-system.md` | #7 / #53 | PR #19、#44、#58 | — |

### 3.2 该 Owner 之外的改动（边界事实）

以下 PR 触及了 `CONTRIBUTING.md` §2 中属于 zzstar101 的路径，**仅作事实记录**：

| PR | 越界路径 | 说明 |
| --- | --- | --- |
| PR #25 | `apps/api/src/app.ts`、`packages/db/src/schema/jobs.ts`、`packages/db/src/migrations/0004_*`、`packages/db/src/seed.test.ts`、`apps/api/src/modules/auth/router.test.ts` | §6 DB CHANGE REQUEST 要求 `packages/db/**` 由 zzstar101 落地 |
| PR #36 / #37 / #38 | `apps/api/src/app.ts` | 路由挂载点属 Owner 独占 |
| PR #44 | `apps/api/src/app.ts`、`WISH_ROUTES` | 合并后按规则 **revert**（`bc5c7ae` → `adc7801`），改由 PR #51 交接、Owner 落地 |
| PR #51 | `apps/api/src/app.ts` | 交接件，**CLOSED 未合并**（正确做法） |
| PR #60 | `apps/api/src/app.ts` | 通知路由挂载 |
| PR #61 | `apps/api/src/modules/listings/{service.ts,service.test.ts}` | `listings` 属 zzstar101 |
| PR #62 | `.github/workflows/ci.yml`、`docker-compose.yml` | 根配置 / infra 属 zzstar101 |

### 3.3 与该 Owner 相关、但尚未闭合的事项

> `gh issue list` 中**没有**任何 OPEN Issue 的 assignee 是 Coast-87。下表为与其交付有上下游关系、但仍未闭合的 Issue。

| Issue | 标题 | 状态 |
| --- | --- | --- |
| #23 | 通知列表、未读数与标记已读 | **Issue 仍 OPEN**（assignee 含 zzstar101、ouu2006），后端 PR #60 已合并；前端入口未见对应 PR |
| #14 | 急出 / 0 元送 / 降价通知 / 毕业清仓与市场信号 | OPEN，assignee = ouu2006 |

---

## 4. ouu2006 — Frontend Owner

### 4.1 已交付模块（`apps/web/src/features/**`）

| 模块 | 路径 | 对应 Issue | 落地 PR |
| --- | --- | --- | --- |
| 登录注册页 + 登录态 | `features/auth/{auth-provider,auth-badge,form,auth-background,queries,api,error-messages}` | #3 | PR #26 |
| 首页 / 搜索 / 分类 / 底部导航 | `features/home/**`、`features/search/**`、`features/navigation/{app-shell,tab-bar,tabs}` | #4 | PR #26 |
| 商品详情 + 「我想要」入口 | `features/listing-detail/{detail-page,watchers-page,queries}` | #5 | PR #26、#28 |
| 发布 / 急出 / 可刀 / 发布反馈 | `features/sell/{publish-page,queries,api}` | #6 | PR #26、#28 |
| 商品状态徽章 | `features/profile/**` | #6 / #12 | PR #29 |
| 匹配结果 UI + 愿望成真卡片 | `features/match/{match-page,api}`、`features/wish/**` | #8 | PR #31、#32 |
| 聊天 / 消息页 + SYSTEM 消息渲染 | `features/chat/{chat-page,message-page,realtime,queries,api,system-event}` | #9 | PR #26、#34 |
| 交易 / 订单卡片 | `features/transaction/{order-card,queries,api}` | #11 | PR #26、#54 |
| 个人中心 / 我的商品 / 我的订单 / 用户主页 | `features/profile/{profile-page,mylist-page,orders-page,user-page,queries,api}` | #12 | PR #26、#35 |
| 消息 tab 顶部系统通知入口（静态 / Mock 阶段） | `features/notifications/notifications-page.tsx` | #23 | PR #28 |
| Mock → Real API / WebSocket 全量接线 | `features/*/api.ts`、`features/*/queries.ts`、`features/chat/realtime.ts`、`src/lib/**` | #41 | PR #54 |
| 品牌换肤令牌与导航图标资产 | `apps/web/src/**`、`packages/ui/src/**`、`apps/web/public/{categories,notify-icons}` | #21 | PR #63（**OPEN，未合并**） |
| 审查发现修复 | `features/{chat,match,profile}`、`lib/mock` | #32 | PR #32 |
| 还原被镜像源污染的 lockfile | `bun.lock` | #27 相关 | 提交 `917e37e`（同分支） |

### 4.2 未完成

| Issue | 标题 | 优先级 | 状态 |
| --- | --- | --- | --- |
| #14 | 急出、0 元送、降价通知、毕业清仓与市场信号 | P1 | OPEN（assignee = ouu2006） |
| #21 | 前端动效与交互质感优化 | P2 | OPEN；PR #63 已提交未合并 |
| #23 | 通知中心前端入口（真实 API 接线） | P1 | OPEN |

---

## 5. 模块 → Owner 全量矩阵

### 5.1 后端 API 模块

| 模块 | Owner（CODEOWNERS） | 交付 PR | 模块内测试文件数 |
| --- | --- | --- | --- |
| `apps/api/src/modules/auth` | zzstar101 | #18 | 2 |
| `apps/api/src/modules/listings` | zzstar101 | #20 / #24 / #61 | 4 |
| `apps/api/src/modules/uploads` | zzstar101 | #20 | 3 |
| `apps/api/src/modules/matching` | zzstar101 | #22 | 2 |
| `apps/api/src/modules/wishes` | Coast-87 | #19 / #25 / #53 | 3 |
| `apps/api/src/modules/conversations` | Coast-87 | #36 | 4 |
| `apps/api/src/modules/messages` | Coast-87 | #36 | 3 |
| `apps/api/src/modules/realtime` | Coast-87 | #36 | 2 |
| `apps/api/src/modules/transactions` | Coast-87 | #37 | 4 |
| `apps/api/src/modules/profile` | Coast-87 | #38 | 3 |
| `apps/api/src/modules/notifications` | ⚠️ CODEOWNERS 无条目 → 默认 `@zzstar101`；实际由 Coast-87 交付（PR #60） | #60 | **0** |

### 5.2 Contracts

| Domain | Owner | 交付 PR |
| --- | --- | --- |
| `packages/contracts/src/auth` | zzstar101 | #18 |
| `packages/contracts/src/listings` | zzstar101 | #20 |
| `packages/contracts/src/matching` | zzstar101 | #22 |
| `packages/contracts/src/system` | zzstar101 | #16 / #18 |
| `packages/contracts/src/wishes` | Coast-87 | #19 / #53 |
| `packages/contracts/src/chat` | Coast-87 | #36 |
| `packages/contracts/src/transactions` | Coast-87 | #37 |
| `packages/contracts/src/profile` | Coast-87 | #38 |
| `packages/contracts/src/notifications` | ⚠️ CODEOWNERS 无条目 → 默认 `@zzstar101`；实际由 Coast-87 交付（PR #60） | #60 |

### 5.3 Worker

| 模块 | Owner | 交付 PR |
| --- | --- | --- |
| `apps/worker/src/index.ts` | zzstar101 | #16 / #52 |
| `apps/worker/src/jobs/matching/**` | zzstar101 | #22 / #52 |
| 重启回收 + 主链冒烟 | zzstar101 | #52 / #55 |

### 5.4 数据库

| 资产 | Owner | 交付 PR |
| --- | --- | --- |
| `packages/db/src/schema/**`（`common/users/sessions/listings/wishes/matches/conversations/messages/transactions/jobs/notifications`） | zzstar101 | #17 / #18（其余为 #7 附带，见 §3.2） |
| `packages/db/src/migrations/**`（`0000~0004`） | zzstar101 | #17 / #18 / #25 |
| `packages/db/src/seed.ts` | zzstar101 | #17 |

### 5.5 前端

| 模块 | Owner | 交付 PR |
| --- | --- | --- |
| `apps/web/src/features/auth` | ouu2006 | #26 |
| `apps/web/src/features/home` | ouu2006 | #26 |
| `apps/web/src/features/search` | ouu2006 | #26 |
| `apps/web/src/features/navigation` | ouu2006 | #26 / #63 |
| `apps/web/src/features/listing-detail` | ouu2006 | #26 / #28 |
| `apps/web/src/features/listing` | ouu2006 | #54 |
| `apps/web/src/features/sell` | ouu2006 | #26 / #28 |
| `apps/web/src/features/wish` | ouu2006 | #26 / #31 / #54 |
| `apps/web/src/features/match` | ouu2006 | #31 / #32 |
| `apps/web/src/features/chat` | ouu2006 | #26 / #34 / #54 |
| `apps/web/src/features/transaction` | ouu2006 | #26 / #54 |
| `apps/web/src/features/profile` | ouu2006 | #26 / #29 / #35 |
| `apps/web/src/features/notifications` | ouu2006 | #28（Mock）；真实接线未交付 |
| `apps/web/src/lib/**`、`routes/**` | ouu2006 | #26 / #28 / #54 |
| `packages/ui/src/**` | ouu2006 | #26 / #63 |

---

## 6. 汇总

| 维度 | zzstar101 | Coast-87 | ouu2006 |
| --- | --- | --- | --- |
| Lane | Platform & Core | Marketplace Flow | Frontend |
| 已合并 PR | 9 | 17 | 9 |
| 未合并 PR | 0 | 1（#51，交接件） | 1（#63，P2 动效） |
| `main` 提交数 | 10（+1 归属未验证的 `Initial commit`） | 17 | 10 |
| 后端模块 | auth、listings、uploads、matching、worker/matching | wishes、conversations、messages、realtime、transactions、profile、notifications | — |
| Contracts | auth、listings、matching、system | wishes、chat、transactions、profile、notifications | — |
| DB / Infra | 全部 schema、migration、seed、CI、compose | （越界项见 §3.2） | bun.lock 还原 |
| 前端模块 | — | — | 全部 13 个 feature |
| 未关闭 Issue | #23、#59、#15（EPIC） | #15（EPIC） | #14、#21、#23、#15（EPIC） |

**仍未交付的模块级事项**：

1. `apps/api/src/modules/notifications` 模块内无测试文件（§5.1）。
2. `#23` 通知前端真实接线未交付（Issue 仍 OPEN）。
3. `#14` 增长功能（急出 / 0 元送 / 降价通知 / 毕业清仓 / 市场信号）未交付。
4. `#21` 前端动效与交互质感：PR #63 OPEN。
5. `#59` 全量测试连接池上限问题未修。
6. `packages/contracts/src/notifications`、`apps/api/src/modules/notifications` 未进 `CODEOWNERS`，归属按默认规则落到 `@zzstar101`，与实际交付人不一致。
