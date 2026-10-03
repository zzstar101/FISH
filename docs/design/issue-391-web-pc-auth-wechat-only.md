# PC Web：登录改为仅微信扫码（移除账号密码登录）

> 状态：设计已实现（分支 `robobun/task-391-web-pc-auth-wechat-only`）；验收勾选见本任务 PR 描述。
> 主跟踪：GitHub #391「[P1][WEB][AUTH] PC 登录改为仅微信扫码：移除账号密码登录与注册页」。
> 基线：`origin/main = b641fd7`（2026-10-01 实测）。行号对应该基线，代码变动后需重新核对。
> 依赖：#197（web 端微信扫码登录）已交付（PR #340）；本任务**不新增能力**，是减法。

## 1. 背景

PC 站当前提供两种登录方式：**微信扫码**与**账号密码**。产品口径改为仅保留微信扫码授权（与小程序一致），因此需要移除 web-pc 的账号密码入口与配套注册页。

关键前提：扫码链路（四端点契约、PC 客户端、小程序确认页）**已完整存在于 `main`**，且登录页已经默认停在「扫码登录」页签。本任务删除的是并排的第二个页签及其配套代码，不是从零接线。

## 2. 现状

| 事实 | 证据 |
| --- | --- |
| 登录页双页签，默认扫码 | `apps/web-pc/src/routes/login.tsx:39`、`:76-83` |
| 账号密码表单：学号 + 密码 + 记住账号密码 + 自动登录 | `routes/login.tsx` 的 `PasswordLoginForm`（约 `:117` 起） |
| 注册页：学号 + 密码 + 昵称，注册即登录 | `routes/register.tsx:12` |
| 扫码四端点契约 | `packages/contracts/src/auth/scan.ts` |
| PC 扫码客户端 | `features/auth/scan-api.ts`、`scan-login.tsx` |
| 小程序确认页 | `apps/miniapp/src/pkg-auth/pages/login-confirm/` |
| 密码端点 | `apps/api/src/modules/auth/router.ts:314`（`/login`）、`:297`（`/register`） |
| 扫码前提：小程序侧已有 FISH 会话 | `POST /auth/wechat/scan/ticket/:ticket/confirm` 需 cookie |
| 新账号由小程序微信登录自动创建 | `apps/api/src/modules/auth/wechat-service.ts:184` |
| stub 可本地登录 | `scan-login.tsx`：`qrCodeDataUrl === null` 时展示 ticket + 开发者工具指引 |

**密码登录的站外依赖（决定 §5 决策 1）**：`apps/api/scripts/core-smoke.ts:86,252` 用 `fish123456` 走 `/auth/login`，是 CI `core-smoke` 门禁；`packages/db/src/seed.ts:78` 的演示账号是密码账号。

## 3. 范围

本任务只改 `apps/web-pc` 的登录/注册界面与其专属模块；后端、契约、小程序不动（依 §5 决策 1 的推荐口径）。

## 4. 方案

### 4.1 登录页

`routes/login.tsx` 去掉 `Tabs` 与 `PasswordLoginForm`，只渲染 `ScanLoginPanel`。保留：

- 协议勾选（`agreed`）——`ScanLoginPanel` 的兑换前校验依赖它；
- `sanitizeRedirect` 回跳（`?redirect=` 语义不变）；
- `createAuthSubmissionGate`——扫码兑换与建票共用同一把提交闸，去掉密码表单后它仍是唯一并发门；
- `auth-glass-body` 的 `useLayoutEffect`（玻璃页全屏布局）。

footer 的「注册」链接改为指引文案（新用户先在小程序内登录建号，再回来扫码）。

### 4.2 文案收口（易漏）

`scan-login.tsx` 的 `scanFailureMessage` 在 `WECHAT_DISABLED` 分支返回「微信扫码登录暂不可用，请改用账号密码登录」。密码登录删除后这句指向不存在的功能，必须改写。

### 4.3 死代码清理

`remembered-credentials.ts`（含 `markExplicitLogout` / `consumeExplicitLogout` / 记住凭据）只服务密码表单与"登出后不自动登录"。密码登录删除后整块失去语义，`features/profile/profile-page.tsx:20` 的 `markExplicitLogout` 调用一并移除。

## 5. 待决（需 Owner 口径）

1. **后端密码端点去留** —— 推荐只删前端、后端保留（停用会打断 `core-smoke` 与 seed）。若要"全平台禁用"，需明确并入本任务还是另开票（连带改 smoke / seed）。
2. **`/register` 去留** —— 推荐一并下线；备选是保留为"去小程序注册"的提示页。下线需同步 `routes/__root.tsx:42` 的 `isAuthPage` 白名单。
3. **本地开发免扫码后门** —— 推荐不留（stub 已够）；若保留需指定生产关闭方式。

## 6. 文件范围

```text
apps/web-pc/src/
├── routes/login.tsx                 （改：删密码页签）
├── routes/register.tsx              （删，依决策 2）
├── routes/__root.tsx                （改：isAuthPage 去 /register）
├── features/auth/api.ts             （改：删 login / register）
├── features/auth/queries.ts         （改：删 useLogin / useRegister）
├── features/auth/scan-login.tsx     （改：WECHAT_DISABLED 文案）
├── features/auth/remembered-credentials.ts      （删）
├── features/auth/remembered-credentials.test.ts （删）
├── features/auth/form.tsx           （按调用方核对后收缩）
├── features/auth/form.test.tsx      （改：删密码表单用例）
├── features/auth/error-messages.ts  （按调用方核对后收缩）
└── features/profile/profile-page.tsx（改：删 markExplicitLogout）
```

保留不动：`submission-gate.ts`、`scan-api.ts`、`scan-poll.ts`、`auth-provider.tsx`、`require-auth.tsx`、`lib/session-cache.ts`。

## 7. 风险

- **换号串数据 —— 已排除**：T3 把清缓存挂在 `useLogin` / `useRegister` 的 `onSuccess`；扫码不走这两个 hook，但兑换成功后是 `window.location.assign(target)` 整页跳转（`scan-login.tsx`），QueryClient 重建、内存缓存不残留。`useLogout` 的 `resetPcSession` 与全局 401 清理路径不受影响。
- **测试面**：`routes.structure.test.ts` 只管订单区；`routes.release.test.ts` 未断言 `/register`（已核对）。实际要改 `form.test.tsx` / `queries.test.ts` / `remembered-credentials.test.ts`。
- **产品取舍**：扫码无"记住我"，删除自动登录后每次进 PC 都需重新扫码。

## 8. 验收标准

- [ ] 未登录访问受保护页 → 跳 `/login`，只呈现扫码，无密码表单与「注册」入口。
- [ ] 扫码 → 小程序确认 → PC 确认登录 → 登录态生效，`redirect` 回跳保留。
- [ ] 直接访问 `/register` 不再渲染注册表单。
- [ ] `WECHAT_TRANSPORT=off` 时文案不含"账号密码登录"字样。
- [ ] stub 环境仍可按现有提示用开发者工具完成登录。
- [ ] `bun run typecheck`、`bun run lint`、`bun test --isolate`、`core-smoke` 全绿。

## 9. 非目标

- 不动后端密码端点与契约、seed、smoke（依决策 1）。
- 不动小程序。
- 不做 PC 端教育邮箱注册、忘记密码。
- 不新增"记住登录"能力。
