# task-197 实现计划（#197 按 Owner 复审路线重做）

## 需求理解
#327 被关闭（未合入），复审给出 2 个架构 blocker。本 PR = 在新 main（c7b50a9，#334 已删
apps/web）上重建 #197 交付：保留 #327 后端/小程序核心，UI 移植 web-pc，token 抽成 #294
形状的共用服务。真机扫码 E2E 归 Owner（本地/CI 不冒充）。

## 移植预演（实测）
`git apply --3way` #327 diff（4f49325..40dcc76）到 c7b50a9：非 apps/web 部分零冲突；
apps/web 文件会**静默复活**（目录被删不报冲突），必须整体排除。4f49325→c7b50a9 期间
main 改了 .env.example / app.ts / deployment.md / miniapp auth api —— 全部以 main 为底、
重放 #327 增量（首次 checkout 曾把 #334 的 brand-assets 装配退掉，已修复并提交）。

## 改动清单（3 个 commit）
1. 后端核心移植：contracts/auth/scan.ts、scan-service/store/rate-limit、app 挂载 clientIp、
   miniapp login-confirm/login-continue、env qrEnvVersion、core-smoke、设计文档；
   login_tickets 迁移重新生成（20260929000513_absurd_medusa）；seed.ts TRUNCATE 纳入。
2. token 下沉：modules/wechat/access-token.ts（stable_token 缓存/单飞/退避/invalidate）
   + 测试拆分（#294 验收用例全覆盖）；auth/wechat-platform.ts 只留出码、tokens 注入。
3. web-pc UI：scan-api/scan-poll/submission-gate/scan-login 原样移植 + login.tsx 双 Tab
   （扫码/密码）+ 协议勾选 + 提交闸；玻璃外壳与无障碍语义保留。

## 并发敏感逻辑时序（写码前先记）
- **提交闸**（#267 移植）：密码 mutate onSuccess 前 / 扫码 exchange 前 claim()；密码
  onError 释放，exchange 在 finally 释放；Tab 切换被 submitting 锁死。
- **扫码面板**：verifier 只在 ref；所有异步回调过 isCurrent()（mounted + seq + ticket +
  verifier 四重校验），StrictMode 双跑由 autoCreateRef 挡；轮询 1s→2s→3s 封顶、
  min(delay, remainingMs)；expired 本地判定 + 服务端 expired 双保险。
- **token 单飞**：in-flight Promise 合并并发请求；退避窗口只挡重新取凭证不挡缓存命中；
  失败不缓存（finally 清 in-flight）；invalidate(expectedToken) 防迟到 40001 清新缓存。
- **exchange 语义**：一次性消费票据，重复兑换 404 SCAN_TICKET_INVALID，不签发第二份会话。

## 验证策略
L0 每 commit biome+定向测试；L1 quick（ROBOBUN_TEST_SCOPE=apps/api apps/web-pc）；
L2 full 结论性 1 次。变异验证以审查者复跑为准（327 的测试随移植带入，56 用例绿）。
真机 E2E 与小程序演示门禁：PR 说明中明示，归 Owner。
