# #217 上线前统一 ID 体系设计

> 状态：**历史设计稿——Issue #217 已 CLOSED，实现已合入 `origin/main`，本文仅供追溯。** Owner 已确认核心决策；不再是待办约束，也不属于任何未合并分支。
> 原文件头部写的「当前工作区在未合入的 `feat/73-admin-governance`，本文不得提交到 #73 分支」是 2026-09-25 设计时点的**工作区约束，已失效**：#217 由 PR #280 面向 `main` 直接集成（merge `529ca42a`，2026-09-27），没有经过 #73 分支。落地位置见本文末尾「落地状态」。

## 目标与边界

核心实体 PostgreSQL PK/FK、服务端事务和 Job payload 保持 UUIDv7，应用正常路径仍以 `Bun.randomUUIDv7()` 生成。所有传给 Web、小程序或管理员客户端的资源 ID（HTTP、WebSocket、二维码负载、游标中的资源语义）改为标准 TypeID：类型前缀 + `_` + 26 位规范小写 Base32 编码；解码检查前缀、规范编码及 UUIDv7，交给 store 的仍是 UUID。客户端自建幂等键 `clientRequestId` 和对象存储 objectKey 等非资源标识不盲目转换。无旧裸 UUID 对外兼容入口，内部表不新增 `public_id` 列。

至少覆盖 `usr/lst/wsh/mtc/cnv/msg/txn/cmt/ntf`，并给已暴露的举报单、聊天媒体、审核/审计等资源补各自固定前缀；实施前逐字段列出边界，禁止同一资源有多个编码。本人资料、嵌套卖家/对方/发送者、通知 payload、管理员视图、聊天事件和交易 QR 在同一边界内。服务端日志优先 Public ID，必要时并列 internal UUID。错误前缀在数据库查询前拒绝；非法路径参数按现有 404 语义处理，非法查询参数/请求体/游标按现有 422 语义处理，不得变 SQL cast 500。游标对前端仍不透明，内部包含的资源 ID 采用公开语义，查询前解码。

## 商品人工编号

`listings.listing_no BIGINT NOT NULL UNIQUE` 是第三层永久不可变人工编号，不是主键、现有业务外键或事务键。发号不使用顺序 sequence：应用使用加密安全随机源生成首位非零的 12 位十进制数，同一数据库事务内向永久占号表写入唯一编号并创建商品，冲突时重试；占号记录不随商品物理删除而删除，并绑定商品 UUID，防止复用或重新指派。商品更新不改号。seed 六件固定商品各有稳定的 12 位编号并可重复运行；生产环境不跑 seed。API 的 `listingNo` 始终为 string，前端不经过 JS number；详情展示并提供复制入口。

完整 12 位数字输入优先精确定位，其它输入仍走原有关键词搜索。编号查询沿用详情可见性规则，未授权或不存在不透露隐藏商品。找到后返回 `lst_...`，Web/小程序跳转 canonical `lst_...` 详情 URL，没有数字编号详情 URL。登录按账号、匿名按可信源 IP 做服务端持久限流，每主体滚动 60 秒最多 50 次精确查询，超限 429 并提示何时重试；普通关键词搜索不共用额度。随机数字提高批量猜测成本，不构成绝对防枚举保证；不能采信客户端伪造的代理转发头。

## 数据迁移与 PostgreSQL

采用 Drizzle **生成**的分阶段 schema migration 与独立可重复执行的 Bun 旧数据回填步骤；不手改 `packages/db/src/migrations/**` 或历史。阶段一加占号表及可空编号；回填旧商品随机号并占号，冲突安全重试；阶段二生成非空、唯一及必要约束。统一迁移入口在空库和有旧数据的库上保持顺序，中断后可重入，不能要求删除开发数据。占号表不能随 seed 清空商品行而丢失。无法直接用 DB schema 表达的约束用最小事务性应用行为与回归测试落实，不偷偷改生成 SQL。PR 附 `CONTRIBUTING.md:99-112`（§6「DB schema 变更」；设计时点为 `:70-81`，该文件此后已重排）要求的 DB 变更说明。

先验证 PG18 + pgvector 镜像、本地 Docker、CI 与生产部署（当前部署文档用宿主机 PG16）。可行则统一升级，公共 UUID PK 加数据库 `DEFAULT uuidv7()` 兜底，正常应用写入仍显式 UUIDv7。明确的部署障碍才保留 PG16 和应用侧 UUIDv7，在 Issue 中记录具体证据；Public ID/编号交付不因此阻塞。当前多数主键使用 `packages/db/src/schema/common.ts:12` 工厂（设计时点为 `:11`），特殊主键单独核对。

## 模块接口与交付顺序

共享编解码模块承担标准 TypeID 与资源独立 schema/type；领域服务和存储保持 UUID 内部键，路由入口解码、读投影与 WS 出口编码。逐字段列举嵌套 ID，不递归替换任意 JSON 字符串。编号占号和创建为原子事务，编号查询沿用详情鉴权。Feed、管理员、聊天、评论游标与 WebSocket、交易二维码必须回归；Job 内部不改 TypeID。

比较三个交付方案：① 后端先破坏性切换会使尚未改的客户端失效；② 长期接受 UUID 与 TypeID 双协议增加兼容债；③ **先加不改变外部协议的共享/DB 能力，逐页面准备客户端，最后统一切换 Contract/API 并全量回归**，选择③。小程序严格遵守 `docs/miniapp-dev-workflow.md`：从最新 main 每页新分支、上页完成后再开下页、动手前告知 Owner 并获确认、微信开发者工具演示且 Owner 认可才提交。开发者工具不可用视为门禁阻塞，不能用 H5/静态检查替代；不自行合入 PR。

## 验收证据

测试先行，覆盖 TypeID UUIDv7 往返、错误前缀/非法字符/非规范编码；随机 12 位、并发冲突与删后不复用；旧数据两阶段迁移、空库迁移、稳定 seed；错误状态/可见性/50 次每分钟限流；Feed cursor、聊天 WS、交易 QR、评论及管理员嵌套 ID。Web/小程序 Mock 中 `u-*`、`l-*` 等伪 ID 改为合法样例，不让 mock 绕开契约。验证顺序：相关测试 → `bun run typecheck` → `bun run lint` → `bun test --isolate` → README 最小运行时路径与端上演示；实现、格式化和测试均通过后，由**全新子代理**仅凭变更范围及需求进行独立对抗审查，修复可执行发现并重验。完成声明须有真实命令结果及端上 Owner 确认。

## 落地状态（原「当前门禁」，2026-10-05 更新）

设计时（2026-09-25）的门禁是「#217 不得提交到尚未合入的 `feat/73-admin-governance`，也不得触碰别人改动」。该门禁已随实现收口，原文保留在此仅作历史记录：

- **Issue #217 已于 2026-09-27 CLOSED**（`gh issue view 217`）。
- **PR #280**「feat(217): 面向 main 的 #217 最终集成 —— 公开 ID 治理、举报闭环与商品编号查询」已 MERGED（merge `529ca42a`，2026-09-27T18:35:13Z），统一 ID 体系面向 `main` 直接集成，并一并完成 #252 的小程序接线——原「小程序逐页分支须等 #73 门禁」同样失效。
- 核心实现位置（本文所有「目标/口径」已按此落地）：
  - 共享编解码 `packages/shared/src/public-id.ts`（`PUBLIC_ID_PREFIX` 覆盖 `usr/lst/wsh/mtc/cnv/msg/txn/cmt/ntf`，另补 `rvw/rpt/rst/med/mdr/aud`）+ `packages/shared/src/public-id.test.ts`；
  - 契约 `packages/contracts/src/system/public-id.ts`，各 domain schema 用其 `UserIdSchema` 等做边界校验；
  - 商品人工编号：占号表 `packages/db/src/schema/listing-numbers.ts`（`listing_no` 主键 + 12 位十进制 `CHECK`，见 `:8`、`:15`），商品侧 `packages/db/src/schema/listings.ts:46`（`listingNo`）、`:76`（`listings_listing_no_uq`）、`:79-81`（指向占号表的复合外键，物理删除后仍绑定原 UUID）；
  - 迁移 `packages/db/src/migrations/0020_real_golden_guardian.sql`、`0021_whole_mister_sinister.sql`（由 drizzle-kit 生成，未手改）；
  - 商品编号精确查询的 Web PC 接线由 #382（`b5748c7f`）完成，见 `docs/design/issue-89-web-pc-gaps.md` §四。
- 实施期的逐项验收证据以最终 PR #280 及其测试为准，不在本文内重复。
