# Issue #197 Web 微信扫码登录设计

> 本文只记录设计与事实，不记录实施进度。接口形状以
> [`packages/contracts/src/auth/scan.ts`](../../packages/contracts/src/auth/scan.ts) 的冻结契约为准。

## 1. 目标与边界

Web 端需要一种不输入学号密码的登录方式：

1. Web 创建短期 `ticket`，取得小程序码与仅由发起浏览器持有的 `verifier`。
2. 用户用微信扫码进入小程序确认页；小程序复用已有 FISH 身份，不引入第二套账号体系。
3. 小程序用户明确确认后，服务端把 `ticket` 绑定到当前 `userId`。
4. Web 轮询到 `confirmed`，再次展示“即将登录为 X”；用户点击确认后，Web 携 `verifier`
   一次性兑换 FISH 会话 cookie。
5. 兑换成功后，Web 使用与现有登录相同的整页跳转路径进入原回跳地址。

本设计**不做**开放平台网站扫码、公众号授权、多 AppID / unionid 账号合并，也**不移除**
Web 学号密码登录。微信登录与账号密码登录在 Web 上并存。

## 2. 端到端时序

```text
Web browser                  API                         Miniapp
    |                         |                             |
    |-- POST ticket --------->|                             |
    |<-- ticket, verifier ---|                             |
    |   qrCodeDataUrl         |                             |
    |                         |                             |
    |                         |<-- GET scene=ticket --------|
    |                         |    wx.login/session --------|
    |                         |<-- POST confirm ------------|
    |                         |    (cookie=user)            |
    |-- GET status + verifier>|                             |
    |<-- confirmed + user ----|                             |
    |                         |                             |
    |-- POST exchange ------->|                             |
    |   + verifier            |                             |
    |<-- user + Set-Cookie ---|                             |
```

`confirm` 与 `exchange` 是两次独立动作。小程序确认只代表“哪个用户同意这次登录”，
不会直接给浏览器发会话；浏览器点击“确认登录”并提交 `verifier` 后才兑换会话。

## 3. 契约与安全语义

四个端点的冻结形状：

| 端点 | 鉴权 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `POST /auth/wechat/scan/ticket` | 匿名 | 空体 | `{ ticket, verifier, qrCodeDataUrl, expiresAt }` |
| `GET /auth/wechat/scan/ticket/:ticket` | `X-Scan-Verifier` | 路径参数 | `pending` / `confirmed` / `expired` 判别联合 |
| `POST /auth/wechat/scan/ticket/:ticket/confirm` | FISH 会话 cookie | 空体 | 204 |
| `POST /auth/wechat/scan/ticket/:ticket/exchange` | `X-Scan-Verifier` | 空体 | `{ user }` + `Set-Cookie` |

安全约束：

- `ticket` 印在二维码 / scene 中，是公开值；浏览器独占的 `verifier` 才是一次兑换的权威凭据。
- `verifier` 只放在请求头 `X-Scan-Verifier`，不进 URL、query、Referer 或浏览器历史。
- 数据库只存 `ticket` 与 `verifier` 的 SHA-256；明文只出现在建票响应和请求头。
- 对外错误码合并“不存在 / verifier 错 / 已消费”为 404 `SCAN_TICKET_INVALID`，避免把匿名状态接口
  变成票据枚举接口。只有持正确 `verifier` 的调用者才看得见 `confirmed + user`。
- 同一张票不能改绑：已绑定到另一用户时返回 409 `SCAN_TICKET_CONFLICT`。
- `exchange` 消费 `ticket` 与签发会话必须满足一次性语义；重复兑换不得签发第二份登录结果。
- 四个端点都必须返回 `Cache-Control: no-store`。

## 4. 数据模型与生命周期

`login_tickets` 使用哈希存储并具备有界 TTL：

| 字段 | 语义 |
| --- | --- |
| `ticket_hash` | `ticket` 的 SHA-256，唯一 |
| `verifier_hash` | `verifier` 的 SHA-256 |
| 逻辑状态 | 不落列；由 `consumed_at`、`expires_at`、`bound_user_id` 推导 `pending` / `confirmed` / `consumed` |
| `bound_user_id` | 小程序确认后绑定的 FISH 用户 |
| `created_at` | 创建时间 |
| `expires_at` | 过期时间 |
| `bound_at` | 确认绑定时间 |
| `consumed_at` | 兑换消费时间 |

过期判定以数据库时间 `clock_timestamp()` 为准，避免 API 实例与数据库时钟不一致。
清理保留有界窗口，不无限积累已结束票据。Web 展示的 `expiresAt` 用于停止本地轮询；
最终有效性始终以服务端状态为准。

## 5. Web 交互与状态机

### 5.1 登录页

- 登录页固定两个 tab：`扫码登录` 在前，`账号密码` 在后。
- “我已阅读并同意《用户协议》和《隐私政策》”是两 tab 共用的一份状态；两个登录分支都必须勾选。
- 默认进入扫码 tab；只有扫码 tab 处于活动状态时才创建票据。密码 tab 不会消耗微信取码额度。
- 切到密码 tab 或页面卸载时停止轮询；切回扫码 tab 时复用当前未结束票据并恢复轮询。
- `verifier` 只保存在扫码组件的内存 / ref 中，不写 `localStorage`、`sessionStorage` 或其它持久化。

### 5.2 扫码状态

```text
idle
  -> creating
       -> pending --(status pending)--> pending
       |             |                    |
       |             |                    +--(status confirmed)--> confirmed
       |             |                    +--(status expired)----> expired
       |             |                    +--(404)---------------> invalid
       |             |                    +--(network/other)-----> status-error
       |             +--(create error)--> create-error
       +----------------------------------> invalid (missing verifier)
```

轮询策略：

- 首次延迟 1s；之后按 1s → 2s → 3s 退避，3s 封顶。
- 到达响应中的 `expiresAt` 立即停止轮询并显示“二维码已过期”；**不自动重建**，由用户点击
  “重新获取”才创建新票。
- 状态接口 404：显示“登录链接已失效，请重新扫码”，同样不自动重建。
- 网络失败：保留当前票据和 verifier，显示可重试态；用户点击重试后继续查询。
- 所有异步响应必须同时校验请求代次与当前 `ticket`；重新取码、切走、卸载后的迟到响应必须丢弃。

### 5.3 已确认与兑换

- `confirmed` 分支先展示 `ScanUser` 的昵称 / 头像和“即将登录为 X”。
- 只有用户点击“确认登录”后才调用 `exchange`，防止“攻击者先扫码，Web 端自动完成登录”。
- 未勾选协议时，`exchange` 不发出，提示用户先同意协议。
- `exchange` 404 表示票据已经失效 / 已消费，进入“登录链接已失效”分支，不给重复点击机会。
- `exchange` 成功响应就是 `{ user: Me }`，与现有登录 / 注册同构：
  1. 将 `user` 写入 `authKeys.me()` 缓存；
  2. 对 `redirect` 执行 `sanitizeRedirect`；
  3. `window.location.assign(target)` 整页跳转，让 cookie 与新应用状态从干净入口生效。

### 5.4 stub 环境

`qrCodeDataUrl` 为 `null` 表示当前 transport 无法生成真实小程序码。Web 必须：

- 展示 `ticket` 明文；
- 提示使用微信开发者工具，以 `pages/login-confirm/index` 为启动页面、`scene=<ticket>` 为启动参数；
- **不绘制普通二维码冒充小程序码**，避免把不可用路径伪装成可用。

## 6. 小程序确认页设计

页面路由：`pages/login-confirm/index`（无前导 `/`，与契约 `SCAN_CONFIRM_PAGE` 一致）。
该页与交易码专用 `pages/scan/index` 完全分离，不改变后者的形状门禁。

进入页面后：

1. 读取 `scene`。缺失或不符合 `ScanTicketSchema` 时**不发送任何请求**，提示“请从浏览器扫码进入”。
2. 静默执行 `Taro.login()`，复用 `signInWithWechat(code)` 恢复 / 建立 FISH 身份。
   - `authStatus` 为 `unknown` 时不抢跑确认；
   - 已登录用户直接使用当前身份；
   - 微信登录失败则停留在可重试态。
3. 展示当前将要登录的 FISH 账号（昵称 / 头像），由当前小程序的 FISH 会话提供。
4. 用户点击“确认登录”才调用
   `POST /auth/wechat/scan/ticket/:ticket/confirm`。
5. 用户取消只关闭 / 返回，不通知后端，票据保持 `pending` 直至过期。

结果分支：

| 结果 | 页面行为 |
| --- | --- |
| 204 | 提示“已确认，请回到浏览器完成登录”，**不自动跳走** |
| 404 `SCAN_TICKET_INVALID` | 提示链接失效 / 已过期，不提供重试 |
| 409 `SCAN_TICKET_CONFLICT` | 提示该二维码已被其他账号确认，不提供改绑 |
| 网络失败 | 提供重试；不把失败当成功 |
| 取消 | 不调用后端 |

页面必须纳入 #170 的账号作用域约束：`unknown` 不抢跑；换号 / 退出会使上一账号在飞的确认结果
失效，不能把旧账号的响应画到新账号名下。

小程序路由登记是双份事实，新增页面时必须同步：

- `apps/miniapp/src/app.config.ts`
- `apps/miniapp/preview/main.tsx`

漏登记任一处会被 `apps/miniapp/tests/preview-routes.test.ts` 拦住。

## 7. 错误与文案口径

| 状态 / 错误 | 端上口径 |
| --- | --- |
| 建票 503 `WECHAT_DISABLED` | 微信扫码登录暂不可用，引导账号密码登录 |
| 建票 502 `WECHAT_QR_UNAVAILABLE` | 暂时无法生成登录二维码，可重试 |
| 状态 404 `SCAN_TICKET_INVALID` | 登录链接已失效，请重新扫码 |
| 状态网络失败 | 网络连接失败，可重试 |
| 到期 | 二维码已过期，点击重新获取后建新票 |
| 确认 409 `SCAN_TICKET_CONFLICT` | 该二维码已被其他账号确认，不换绑 |
| 兑换 404 | 登录链接已失效 / 已消费，不签发 cookie |

上游原始错误文本、ticket、verifier、access token 与 AppSecret 均不得进入用户可见错误或日志。

## 8. 部署与外部前置

代码之外仍有硬前置：

- 微信官方限制 `getUnlimitedQRCode` 生成的是**已发布小程序**的码；因此确认页必须先发布到目标版本。
- `WECHAT_QR_ENV_VERSION=trial/develop` 的码可由谁扫开，官方文档未给出完整结论，需平台实测。
- 真机必须走通“Web 建票 → 微信扫码 → 小程序确认 → Web 兑换 → `GET /me` 为同一用户”。
- 反向代理必须保留 / 追加 `X-Forwarded-For`，限流只认最右侧可信值；API 应只监听回环地址，
  避免客户端伪造左侧 XFF。
- 反向代理 access log 不得记录 `/auth/wechat/scan/ticket/*` 的完整 path，或在记录前对该段脱敏。
- 当前限流是进程内单实例实现；多实例部署前必须换共享存储，并配置受信代理 CIDR。

以上外部事实与真机差异必须保留证据，不能用本地 stub、H5 预览或 CI 测试冒充真实扫码验收。
