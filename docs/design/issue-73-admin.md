# #73 管理后台与平台治理设计方案

> 状态：方案待评审，不包含实现代码。
> 
> 目标：为产品方/运营提供最小可用的管理后台；Admin 只允许访问管理能力，不改变普通用户的权限边界。商品审核规则由 #74 Moderation Domain 负责，#73 只消费其结果并提供运营操作界面。

## 1. 目标与非目标

### 目标

- 支持管理员登录，并在服务端完成独立的 Admin 授权校验。
- 查询用户、商品、商品审核记录与平台基础统计。
- 支持管理商品审核结果、处理高风险运营动作，并记录不可抵赖的操作日志。
- 管理后台与普通用户页面、普通用户 API 路由隔离。
- 为 #74 的 `ALLOW / BLOCK / REVIEW` 审核结果提供查询与人工复核入口。

### 非目标

- 不在 #73 重写普通用户认证；普通用户仍使用现有学号 + 会话 Cookie。
- 不把 Admin UI 挂到普通用户底部导航，也不允许通过隐藏按钮代替服务端授权。
- 不实现 #74 的敏感词检测、规则词库与审核判定逻辑。
- 不引入独立 Admin 服务、Redis、搜索引擎或第三方 RBAC 产品。
- 不提供用户密码查看/重置、数据库管理、任意 SQL、平台支付或财务操作。
- P1 第一阶段不做批量删除、批量封禁、图片内容审核和复杂报表导出。

## 2. 总体架构

```text
浏览器
  ├─ 普通 Web 路由 /api/* ──> 现有业务 API
  └─ Admin Web 路由 /admin/*
        ├─> Admin API（同一 apps/api 进程，/admin/*）
        └─> 复用同一 fish_session，但每个 Admin API 入口额外执行 requireAdmin

requireAdmin = requireAuth + 当前用户 role == ADMIN
Admin API ──> Admin service/store ──> PostgreSQL
                              ├─> users / listings
                              ├─> moderation_records（#74）
                              └─> admin_audit_logs
```

Admin API 与普通 API 同进程、同数据库，原因是当前项目明确采用单体 Hono + Bun 架构，且 Admin 是操作界面而不是独立业务域。代码仍按模块隔离：`apps/api/src/modules/admin/**` 只依赖公开的 auth 上下文和 #74 暴露的 Moderation service/store 接口，不直接修改其他 Domain 的内部状态。

## 3. 身份与权限模型

### 3.1 用户角色

在 `users` 增加 `role` 枚举：

- `USER`：现有普通用户，默认值。
- `ADMIN`：允许进入管理后台和调用 Admin API。

初始版本不做多级角色。未来如需运营只读、审核员、超级管理员，再通过新 Issue 扩展权限集合，避免现在提前引入复杂 RBAC。

### 3.2 授权规则

- 所有 Admin API 必须经过现有 `requireAuth`，随后经过 `requireAdmin`。
- `requireAdmin` 只从服务端会话解析出的 `me/userId` 查询角色，禁止信任请求头、URL 参数、前端状态或可伪造 Cookie 字段。
- 未登录返回现有 `UNAUTHENTICATED` / `401`；已登录但非 Admin 返回稳定的 `FORBIDDEN` / `403`。
- 前端路由守卫只负责体验；API 授权是最终边界。
- 普通用户的 `Me` DTO 默认不暴露内部权限字段；若 Admin 页面需要当前角色，提供单独的 `GET /admin/me`。
- Admin 会话沿用现有 httpOnly Cookie。第一阶段不增加第二套 Token；若后续需要独立设备管理，再单独评估。

### 3.3 Admin 初始化与紧急处置

禁止通过公开注册接口注册 Admin。采用受控初始化方式之一，由 Platform Owner 在实现阶段确认：

1. 本地/部署初始化脚本按显式学号提升角色；或
2. 受保护的一次性环境变量初始化流程。

无论采用哪一种，都必须：不记录密码/密钥到日志；提升操作写入审计日志；初始化完成后不可被普通用户调用。

## 4. Admin API 草案

统一挂载根级 `/admin`，Web 通过相对路径 `/api/admin/...` 调用，保持现有 API 去前缀约定。

### 4.1 当前管理员

- `GET /admin/me`
  - 返回管理员公开资料、角色和可用能力列表。
  - 非 Admin 不可通过该接口探测后台数据。

### 4.2 用户查询

- `GET /admin/users`
  - 参数：`q`（学号精确/昵称前缀搜索）、`authStatus`、`role`、`cursor`、`limit`。
  - 返回：用户 ID、脱敏学号/昵称、校区、认证状态、角色、注册时间、商品数量、最近活动时间。
  - 默认按 `createdAt DESC, id DESC` 游标分页。
- `GET /admin/users/:userId`
  - 返回用户概要、商品统计、审核统计、最近 Admin 操作记录。
  - 不返回密码哈希、完整敏感凭据。

### 4.3 商品与审核查询

- `GET /admin/listings`
  - 参数：关键词、商品状态、审核状态、卖家 ID、时间范围、游标分页。
  - 返回商品卡片、卖家摘要、当前 Listing 状态、最新 Moderation 状态、最新审核原因与时间。
- `GET /admin/listings/:listingId`
  - 返回商品详情、图片元数据、卖家摘要、审核记录时间线、关联操作日志。
- `GET /admin/moderation/queue`
  - 只读查询 `REVIEW` 队列，支持按风险级别和创建时间排序。
- `GET /admin/moderation/:recordId`
  - 返回审核输入摘要、命中规则、机器判定、人工判定、操作者和时间线。

### 4.4 人工审核操作

- `POST /admin/moderation/:recordId/decision`
  - Body：`decision: ALLOW | BLOCK`、`reason`（必填，长度限制）、幂等请求键。
  - 服务端校验审核记录仍可处理；重复提交相同决定返回当前结果，冲突决定返回 `409`。
  - 通过 #74 的领域接口更新审核结果，由 #74 负责决定商品是否可公开；Admin 模块不复制规则。
  - 每次成功决定写 `admin_audit_logs`，包含操作者、目标、旧值、新值、原因和请求追踪信息。

### 4.5 平台统计

- `GET /admin/overview`
  - 返回固定口径的聚合数据：用户总数/近 24 小时新增、在售商品数、待人工审核数、已完成交易数、近 7 日审核通过/拦截数。
  - 只提供预定义指标，不接受任意 SQL、任意字段或任意聚合表达式。
  - 慢查询统计可先使用带时间条件的 SQL；达到数据量门槛后再单独做汇总表/缓存设计。

### 4.6 审计日志

- `GET /admin/audit-logs`
  - 参数：操作者、动作、目标类型、目标 ID、时间范围、游标。
  - 只读，默认最新优先。
  - 审计日志不可由后台 UI 删除或修改。

## 5. 数据模型与 DB CHANGE REQUEST

`packages/db/**` 由 Platform Owner 落地；本方案只提出变更请求。

### DB CHANGE REQUEST A：用户角色

- 表/实体：`users`
- 字段：`role`，PostgreSQL enum `user_role`，值 `USER | ADMIN`，`NOT NULL DEFAULT 'USER'`
- 使用场景：Admin 授权与 Admin 用户查询
- 已有数据：全部回填 `USER`
- 索引：第一阶段可不加单列索引；若 Admin 用户筛选频繁，再补 `role` 索引

### DB CHANGE REQUEST B：Admin 审计日志

- 表/实体：`admin_audit_logs`
- 字段：
  - `id` UUID 主键
  - `actor_user_id` UUID，关联 `users.id`，建议 `ON DELETE RESTRICT`
  - `action` text/enum（如 `MODERATION_DECISION`）
  - `target_type` text/enum（如 `LISTING`、`MODERATION_RECORD`、`USER`）
  - `target_id` UUID
  - `before` JSONB nullable
  - `after` JSONB nullable
  - `reason` text nullable
  - `request_id` text nullable
  - `created_at` timestamptz
- 使用场景：追踪高风险管理操作、事后审计与争议定位
- 已有数据：新表，无迁移数据
- 索引：`created_at DESC`、`actor_user_id + created_at DESC`、`target_type + target_id + created_at DESC`
- 约束：应用层不提供更新/删除接口；`before/after` 禁止保存密码、Cookie、完整学号等敏感信息

### DB CHANGE REQUEST C：#74 Moderation 数据依赖

- 所属：#74 负责 schema、migration 和领域契约
- #73 需要的最小只读/写入能力：按 Listing 查询最新审核结果和历史；提交人工决定并返回领域状态
- #73 不直接依赖 #74 的表结构；通过 #74 导出的 service/router contract 接入
- 若 #74 尚未冻结 Contract，#73 只能先完成用户/商品只读和后台壳，不实现审核操作

## 6. 后端模块拆分

建议新增：

```text
packages/contracts/src/admin/
  routes.ts
  schema.ts

apps/api/src/modules/admin/
  middleware.ts       # requireAdmin
  router.ts           # HTTP 参数解析、错误映射
  service.ts          # 权限后业务编排、幂等、审计
  store.ts            # 用户/商品/统计/审计 SQL
  errors.ts
  router.test.ts
  service.test.ts
  store.test.ts       # 需要 Postgres
```

根接线仍由 `apps/api/src/app.ts` 完成：创建 Admin module，挂载 `/admin`，并注入现有 auth 的 `requireAuth` / `resolveViewerId`。Admin router 只导出独立 router，遵守当前包边界和无大型 barrel 约定。

审计写入必须与业务决定处于同一数据库事务：审核状态更新成功但审计失败时整体回滚；审计成功但业务更新失败时不得留下“已操作”的假记录。

## 7. 前端信息架构

Admin 页面不进入普通用户 `TabBar`，建议单独使用 `AdminShell`：

- `/admin`：概览
- `/admin/users`：用户查询
- `/admin/users/:userId`：用户详情
- `/admin/listings`：商品/审核队列
- `/admin/listings/:listingId`：商品与审核时间线
- `/admin/audit-logs`：操作日志

交互要求：

- 首次进入调用 `/admin/me`；非 Admin 显示无权限页，不展示后台数据。
- 列表统一游标分页、加载态、空态、错误重试；筛选条件写入 URL，便于复制定位。
- 高风险操作必须二次确认，并要求填写原因；明确展示当前状态、即将变更的状态和操作者身份。
- 审核详情显示“机器判定”和“人工最终判定”两个层级，避免把自动结果误认为人工结论。
- 移动端优先但后台以桌面宽度为主；小屏使用抽屉/堆叠卡片，不改变授权逻辑。
- 不在前端硬编码敏感词或审核规则。

前端文件由 `apps/web/**` Owner 落地；本方案不直接修改普通用户导航文件。

## 8. 一致性、并发与安全约束

- 人工审核采用条件更新：只允许从可处理状态转移；并发操作只能一个成功，另一个得到当前状态或 `409`。
- 决定接口使用幂等键，避免重复点击产生重复审核记录或重复通知。
- 所有列表接口限制 `limit` 上限，关键词与时间范围校验，避免全表扫描型任意查询。
- Admin 错误响应复用系统 error envelope，不返回 SQL、堆栈、密码哈希或对象存储凭据。
- 审计记录中保存脱敏快照；禁止把请求 body 原样写入日志。
- 所有 Admin 写操作带服务端时间、actor ID 和 request ID。
- Admin API 默认不开放匿名 CORS；沿用同源 Cookie 部署方式，生产环境另由 Platform Owner 核验反向代理配置。

## 9. 验收标准

### 权限

- [ ] 普通用户访问所有 `/admin/*` API 均为 `403`，不能靠修改前端状态绕过。
- [ ] 未登录访问 Admin API 为 `401`。
- [ ] Admin 能访问后台；普通用户页面和现有业务接口行为不回归。
- [ ] 注册/公开接口无法创建或提升 Admin。

### 查询

- [ ] 可分页查询用户及其状态、商品摘要。
- [ ] 可分页查询商品、审核状态和审核历史。
- [ ] 概览指标口径固定、带时间边界，不接受任意查询表达式。

### 治理

- [ ] #74 的人工审核 Contract 冻结后，Admin 可处理 `REVIEW` 项并看到稳定结果。
- [ ] 并发审核不会产生两个最终决定。
- [ ] 成功的高风险操作一定产生不可编辑的审计记录，业务更新和日志写入原子完成。
- [ ] 日志列表可按操作者、动作、目标和时间查询。

### 前端

- [ ] Admin UI 不出现在普通用户底部导航。
- [ ] 无权限页不泄漏后台数据。
- [ ] 审核操作有确认、原因输入、成功/失败反馈和刷新后的最终状态。

## 10. 实施顺序

1. **Contract freeze**：确认 `role`、Admin error code、分页格式、审计动作枚举、#74 Moderation 读写接口。
2. **Platform/DB**：落地 `users.role`、`admin_audit_logs` 和 Admin 初始化流程。
3. **Auth boundary**：实现并测试 `requireAdmin`，接入 Admin router。
4. **Read-only MVP**：用户、商品、审核队列、概览、审计日志查询。
5. **Moderation action**：等待 #74 Contract 后接人工审核决定、事务和幂等。
6. **Web UI**：AdminShell、概览、列表、详情、审核确认流。
7. **验证与对抗性审查**：先跑 Admin 定向测试，再执行全仓 typecheck/lint/test；检查权限绕过、越权 IDOR、审计缺失和敏感信息泄漏。

## 11. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| Admin 角色被错误暴露或仅靠前端保护 | 服务端 `requireAdmin` 覆盖所有 `/admin/*`，默认角色 USER |
| #74 schema 未冻结导致跨模块耦合 | #73 只依赖 Moderation service/contract，不直接依赖表 |
| 审核决定与审计记录不一致 | 同一数据库事务写入，失败整体回滚 |
| 审核人员并发处理同一条记录 | 条件更新 + 幂等键 + 409 冲突语义 |
| 后台查询拖慢交易主链 | 固定字段/固定指标、游标分页、索引；统计性能另行观测 |
| 审计日志泄漏隐私 | 仅写脱敏快照，明确禁止密码/Token/完整学号 |
| 后台 UI 与移动端壳冲突 | 单独 AdminShell 和路由分区，不修改普通 TabBar |

## 12. 待 Owner 确认的问题

1. Admin 是否允许使用现有普通用户会话，还是要求独立后台会话/二次认证？本方案默认复用现有会话。
2. 第一阶段是否需要“禁用用户”能力？当前验收只要求查询状态，建议暂不提供封禁写操作，避免与后续治理 Issue 混 scope。
3. #74 的人工决定是否直接改变 Listing 可见性，还是只写 Moderation 状态后由 Listing Domain 消费？建议由 #74 定义最终状态转换，Admin 不直接改 Listing。
4. Admin 初始化采用部署脚本还是一次性环境变量流程？需 Platform Owner 在实现前确认。
5. 概览统计是否允许近实时 SQL，还是需要预聚合？P1 建议先用受限 SQL，出现性能证据后再拆新 Issue。
