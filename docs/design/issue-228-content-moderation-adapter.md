# #228 腾讯云内容安全 — 审核适配器（第一阶段交付：适配器 + 测试 + 调用说明）

> 状态：**代码已落地，待评审**。本阶段只交付适配器；商品写入接线、审核记录表、图片固化与引用**均未开始**（见 §2、§11）。
> 关联：需求载体 [#228](https://github.com/zzstar101/FISH/issues/228)（OPEN）｜ 共享 ID 规则归 [#217](https://github.com/zzstar101/FISH/issues/217)
> 记录人：Coast-87（本机） ｜ 日期：2026-09-23 ｜ 实现分支：`feat/228-content-moderation-adapter`
> **行号基线**：`origin/main = 279c762`（本分支起点；工作树 `/Users/zzstar/Desktop/Programs/FISH-228`）
> 决策来源：Owner 于本次任务分条确认「第一份交付限定为审核适配器＋测试＋调用说明」（见 §2）

---

## 0. Owner 看这里

一句话：把「调用腾讯 TMS / IMS 并返回统一判定」做成一个**可注入、可测、失败必抛错**的适配器；商品发布、审核记录、图片固化还没接线，所以**两条安全条件尚未在业务链上成立**。

需要你本人确认的四件事（第 2、4 项已拍板，原始判断依据保留在下面）：

1. **授权测试环境**：目前只有模拟响应测试。最小真实调用需要一个可用的腾讯云账号、`SecretId` / `SecretKey`、以及文本（TMS）与图片（IMS）各一个 `BizType`，然后 `bun --env-file=.env apps/api/scripts/moderation-live-probe.ts`（见 §9.3）。
2. **确认 SDK 引入的 lockfile 传递版本变化**：`tencentcloud-sdk-nodejs-tms` / `-ims@4.1.311` 会把 hoist 槽位上的 `form-data` 4.0.6→3.0.5、`get-stream` 3.0.0→6.0.1、`ini` 1.3.8→2.0.0、`tslib` 2.8.1→1.13.0、`uuid` 8.3.2→9.0.1 换成旧/新版，并为 `@tarojs/*` 补嵌套 `tslib@2.8.1`（`bun.lock` +73/−7，**无镜像源 URL 改写**）。见 §10-R1。**Owner 已确认保留官方 SDK**：Bun 在运行时接管 `node-fetch`，实际 HTTP 走 Bun 原生实现（实证见 §10-R1）。
3. **确认运维影响**：`apps/api/src/index.ts` 现在启动就校验 `CONTENT_MODERATION_TRANSPORT`；**已部署机器不补这一行会 crash loop**（与 #141 的 `AI_POLISH_TRANSPORT` 同款，`docs/deployment.md` §4 已给追加脚本）。
4. **决定生产护栏要不要在部署侧补齐 `NODE_ENV`**：`local` 的生产禁令只在 `NODE_ENV=production` 时生效（已按 trim + 小写归一化），但仓库现有部署路径**没有任何地方设置 `NODE_ENV`**（`docs/deployment.md` §5.1 的 systemd 单元只有 `EnvironmentFile=/etc/fish/api-mail.env`，`apps/api/package.json` 的 `start` 也没有，`bun --env-file` 不会设置它）。也就是说：只补 `CONTENT_MODERATION_TRANSPORT=local` 的生产机仍会启动成功、只打一条 warn。同款前提也存在于既有的 `WECHAT_TRANSPORT=stub` 护栏，因此"是否在 systemd 单元统一加 `Environment=NODE_ENV=production`"是跨模块的运维决定。**Owner 已决定：本期不并进本 PR，另案处理**（见 §10-R7）。

本期刻意的"不做"是决定，不是遗漏：不改商品 CREATE/UPDATE 主链、不改审核记录表/迁移、不做图片确认与不可变对象接线、不动 Admin 展示与客户端错误反馈、不动共享生产上传路径与存储配置。

**两条安全条件的当前状态**（#228 硬要求）：

| 安全条件 | 适配器层 | 业务链 |
| --- | --- | --- |
| 外部审核失败不放行 | ✅ 任何失败都抛 `ContentModerationError`，**没有任何一条映射到 ALLOW**（§5） | ❌ 未接线：`moderateText` 还没有调用方 |
| 审核通过后不能用覆盖同一对象的方式替换图片内容 | 🟡 只提供材料：返回腾讯 `FileMD5` 作为 `contentDigest`（§8） | ❌ 未接线：固化 key / ETag 校验 / 引用校验都不在本期 |

---

## 1. 目标与非目标

### 目标

- 业务层只看两个异步方法：`moderateText` / `moderateImage`，不接触腾讯 SDK、TC3 签名、BizType。
- 按 #228 统一判定：`Pass→ALLOW`、`Review→REVIEW`、`Block→BLOCK`，多字段/多图取最高风险。
- 统一错误类型与失败语义：超时/5xx/SDK 异常/非法响应**都不放行**，只做有限重试。
- 敏感信息不外泄：Secret 不进日志/错误消息，上游返回体与 `Error.Message` 一律不搬运。
- 开发/测试可用 `local` transport（复用现有词表），图片不审内容时进人工队列。
- 适配器可注入（`loadImage`、`endpoint`），因此**不依赖真实腾讯环境也能测**。

### 非目标（附理由）

| 不做 | 理由 |
| --- | --- |
| 改写商品 CREATE/UPDATE 主链 | #228 的分工里属"需要协调后再做"；且要与 #217 对齐共享文件与迁移 |
| 审核记录表与迁移 | 表结构/人工队列属后续部分；适配器不写库 |
| 图片确认、不可变对象、商品引用接线 | 涉及共享生产上传路径与存储配置，需与 #217 协调 |
| Admin 展示、客户端错误反馈 | 依赖记录表与商品状态字段，本期没有可展示的数据 |
| 生产真实调用 | 没有授权测试环境；本期只做模拟响应测试（§9） |
| 人工改判（`MANUAL`） | 属记录层；适配器只产生 `LOCAL` / `TENCENT_TMS` / `TENCENT_IMS` 三种来源 |

---

## 2. 交付范围与决策

| 决策 | 内容 | 理由 |
| --- | --- | --- |
| 用官方 SDK | `tencentcloud-sdk-nodejs-tms` / `-ims@4.1.311` | #228 明确优先官方 SDK；Bun 下已实证可 `import`、可签名、可往返（§9.2） |
| SDK 只出现在一个文件 | 仅 `providers/tencent.ts` | 若日后要换成手写 TC3 或换 provider，只改一个文件；业务层永不感知 |
| transport 用 `local` / `tencent` | 与 `MAIL_TRANSPORT` / `AI_POLISH_TRANSPORT` / `WECHAT_TRANSPORT` 同款字符串枚举，无默认值 | 生产禁止静默兜底（§6） |
| 图片由注入的 loader 提供字节 | `loadImage(objectKey)` 返回 `{bytes}` \| `null` | 适配器不碰对象存储，避免越过本期边界；也让图片测试不需要真实 S3 |
| 不解析业务 ID | `dataId` 原样回带；仅校验腾讯 `DataId` 取值约束 | #217 统一 ID 规则，适配器只管传参 |
| 不引入 logger 抽象 | 适配器不打印任何日志，错误对象带 `requestId` / `reason` / `latency` 由调用方打点 | 仓库现有模块用 `console.error('[module] …')`；没有 logger 抽象就不新造 |

---

## 3. 接口（`apps/api/src/modules/moderation/providers/types.ts`）

```ts
type ContentModerationProvider = {
  readonly transport: 'local' | 'tencent'
  moderateText(input: {
    dataId: string
    fields: { field: 'title' | 'description'; value: string }[]
  }): Promise<TextModerationResult>
  moderateImage(input: { dataId: string; objectKey: string }): Promise<ImageModerationResult>
}
```

- `TextModerationResult.fields` 每个字段一条 `FieldModerationResult`；`decision` 是字段聚合后的最高风险。
- `ImageModerationResult.contentDigest` 是腾讯 `FileMD5`（腾讯未返回则 `null`，**不得把 null 当通过**）；非空但**不是 32 位十六进制**时按 `invalid_response`（`detail=digest`）失败——它是后续「图片未被替换」的证明，不能把任意上游字符串当摘要透传。
- `policyVersion`：腾讯 transport 记录 `BizType`，本地 transport 记录 `MODERATION_RULE_VERSION`。
- `score` / `label` / `subLabel` 只回带腾讯原值供审计与调参，**适配器不做任何阈值判定**（#228 §2）。
- `requestId` 已过白名单（字母数字 `._-`，≤64），非该形状时为 `null`：它会进日志，上游不能借它注入换行。
- 本地 transport 用 `subLabel` 回带命中的规则码（`PROHIBITED_CONTENT` / `EXTERNAL_CONTACT`），`label` 为 `null`。

---

## 4. 判定与聚合

| 腾讯 `Suggestion` | 统一决策 | 业务含义（后续接线时生效） |
| --- | --- | --- |
| `Pass` | `ALLOW` | 可以继续发布 |
| `Review` | `REVIEW` | 不可公开，进 Admin 人工队列 |
| `Block` | `BLOCK` | 拒绝本次发布/编辑 |

- 聚合：`BLOCK > REVIEW > ALLOW`（`aggregateModerationDecision`）；**空判定集合与未知判定值都直接抛错**，不返回 ALLOW——「没有结论」不是「通过」（本地 provider 的「某字段未命中任何规则」是显式的 ALLOW，不走这条）。
- `Suggestion` 缺失或不是这三个枚举值 → `invalid_response`，**不默认 ALLOW**。
- 全空白字段（`'   '`）→ `invalid_input` / `detail=no_content`：没有可审内容不等于通过。

---

## 5. 错误与重试（`types.ts` / `retry.ts`）

统一错误 `ContentModerationError`，携带 `reason` / `provider` / `requestId` / `httpCode` / `upstreamCode` / `detail` / `retryable`：

| `reason` | 触发 | 可重试 | HTTP（`moderationErrorResponse`） |
| --- | --- | --- | --- |
| `timeout` | 传输超时 | ✅ | 503 `CONTENT_MODERATION_UNAVAILABLE` |
| `network` | 连不上/断连；**对象读取（`loadImage`）抛出存储异常**（`detail=image_load`） | ✅ | 503 |
| `throttled` | HTTP 429 / `RequestLimitExceeded*` | ✅ | 503 |
| `upstream_error` | HTTP ≥500 / `InternalError*` / `FailedOperation*` | ✅ | 503 |
| `invalid_response` | 响应非 JSON / `Response` 缺失 / `Suggestion` 非法 | ✅ | 503 |
| `upstream_rejected` | 其它 4xx / 未知 `Error.Code` | ❌ | 503 |
| `invalid_input` | `dataId` 越界、图片过大、对象不存在、无可审内容 | ❌ | 400 `CONTENT_MODERATION_INVALID_INPUT` |
| `configuration` | HTTP 401/403、`AuthFailure*` / `InvalidParameter*` 等 | ❌ | 503 |

- 重试实现 `withBoundedRetry`：默认 3 次尝试、指数退避（200ms 起），**不重试不可重试项**，也不无上限重试；`attempts < 1` 属于配置错误，直接抛 `RangeError`（不会抛出 `undefined` 让调用方漏判）。
- 错误消息**只由适配器按上述结构化字段拼装**，不接受调用方或上游的自由文本：上游返回体可能回显用户原文，SDK 的 `Error.Message` 同样不可信。
- `requestId` / `upstreamCode` / `detail` 都过同一个白名单（字母数字 `._-`，≤64）：`requestId` 会被调用方写进日志，上游不能借它注入换行；不合规一律置 `null`。
- **没有任何一条失败路径返回 ALLOW**：调用方拿到异常必须按失败处理。

---

## 6. 配置与启动校验（`packages/shared/src/env.ts` · `loadContentModerationEnv`）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CONTENT_MODERATION_TRANSPORT` | ✅ 无默认值 | `local` / `tencent` |
| `TENCENT_CLOUD_SECRET_ID` | `tencent` 时必填 | 只在部署环境变量/密钥文件 |
| `TENCENT_CLOUD_SECRET_KEY` | `tencent` 时必填 | 同上，绝不进 Git/日志/客户端 |
| `TENCENT_TMS_BIZ_TYPE` | `tencent` 时必填 | 文本策略号，同时作为 `policyVersion` |
| `TENCENT_IMS_BIZ_TYPE` | `tencent` 时必填 | 图片策略号，同时作为 `policyVersion` |
| `TENCENT_CLOUD_REGION` | ❌ | 默认 `ap-guangzhou` |

- 缺失/非法一律**抛错**：`loadContentModerationEnv` 无默认值；`apps/api/src/index.ts` 启动即调用，因此配置错就是启动失败（不静默回退）。
- `NODE_ENV=production` + `local` → 直接抛错（本地词表不是内容安全审核）；`NODE_ENV` 按 trim + 小写比较（`Production` / ` production ` 同样拦下）。注意这要求部署侧真的设置了 `NODE_ENV`（见 §0 第 4 条 / §10-R7）。
- `tencent` 四项缺任一项 → 抛错，且错误消息点名**缺的是哪一个**变量。
- 错误信息**只出现变量名**，不回显任何值（`packages/shared/src/env.test.ts` 有断言）。
- `.env.example` 与 `docs/deployment.md` §4 已同步；生产部署用 `docs/deployment.md` 的追加脚本写进 `/etc/fish/api-mail.env`。

---

## 7. 调用说明

```ts
import { loadContentModerationEnv } from '@fish/shared/env'
import { createContentModerationProvider } from './modules/moderation/providers/factory'
import {
  ContentModerationError,
  moderationErrorResponse,
} from './modules/moderation/providers/types'

const provider = createContentModerationProvider(loadContentModerationEnv(), {
  // 图片审核才需要；对象不存在返回 null。生产实现由后续接线的 Issue 提供。
  loadImage: async (objectKey) => {
    const file = await readObject(objectKey) // 由调用方实现（S3/本地）
    return file ? { bytes: file.bytes, contentType: file.contentType } : null
  },
})

// 文本：一次调用审 title + description，聚合结果在 result.decision
try {
  const result = await provider.moderateText({
    dataId: `lst_${listingId}`, // 业务标识原样回带，适配器不解析（#217 统一规则）
    fields: [
      { field: 'title', value: title },
      { field: 'description', value: description },
    ],
  })
  // result.decision: ALLOW | REVIEW | BLOCK —— 接线时按 #228 的映射处理
} catch (error) {
  // 必须是 fail closed：503 可重试错误，本次发布/编辑不放行
  if (error instanceof ContentModerationError) {
    const { status, code } = moderationErrorResponse(error)
    // 日志可记 error.requestId / error.reason / error.provider，不可记原文与密钥
  }
  throw error
}

// 图片：每张图在"被 Listing 引用前"各审一次
const image = await provider.moderateImage({ dataId: `img_${assetId}`, objectKey })
// 只有 ALLOW **且**拿到 contentDigest 才能进入"固化后引用"这条路：
// contentDigest 为 null 时无法证明内容未被替换，接线时必须转人工/重新审核，不能直接公开（§8）。
if (image.decision === 'ALLOW' && image.contentDigest) {
  // 后续接线：把对象固化到不可覆盖的 key，并记录 contentDigest
}
```

调用方注意：

1. **不要 catch 后继续发布**。`ALLOW` 之外的一切（含所有异常）都不等于通过。
2. **不要打印原文 / 图片字节 / Secret**。日志字段建议：`provider`、`outcome`、`reason`、`requestId`、`latencyMs`、`dataId`。
3. `dataId` 必须满足腾讯取值约束：`[A-Za-z0-9_@#-]{1,64}`；文本会按字段拼成 `${dataId}-title` / `${dataId}-description`，所以 `dataId` 本身要留 **12 个字符**余量（`-description` 最长），越界会得到 `invalid_input` / `detail=data_id`。适配器在**发出第一个请求之前**就校验全部字段的 `dataId`：不会出现"先审了 title（已计费、已产生审核记录）再报入参错误"。
4. 图片上限：腾讯 IMS `FileContent` 为 10M Base64 字符，适配器折算为原始字节上限 `7_500_000`；业务侧 `MAX_IMAGE_BYTES` 是 5MB（`packages/contracts/src/listings/schema.ts`），正常走不到适配器这道闸门。

---

## 8. 图片审核与"不可覆盖"的材料

- 每张图独立 `moderateImage`：`Pass` 才能直接用；`Review` 使商品进人工队列；`Block` 不允许引用。
- 适配器返回腾讯 `FileMD5` 作为 `contentDigest`（已校验为 32 位十六进制并统一小写；形状不符按 `invalid_response` 失败，不放行）。**这是"审核后不允许覆盖同一对象"的材料，不是实现**：固化到不可覆盖 key、或校验 ETag/摘要/版本，都在后续接线的 Issue 里（与 #217 协调上传路径）。
- 只校验 size/mime 不能证明内容未被替换；`contentDigest === null` 时调用方**不得**视为通过。
- 本地 transport 判不了图片内容，一律 `REVIEW` + `reasonCode: 'LOCAL_IMAGE_NOT_AUDITED'`，不会给出 `ALLOW`。

---

## 9. 测试与真实调用

### 9.1 模拟响应测试（本期已完成）

```bash
bun test apps/api/src/modules/moderation packages/shared/src/env.test.ts
```

- `providers/tencent.test.ts`：用 `Bun.serve` 起本地假上游（随机端口），按 `X-TC-Action` 分流 TMS/IMS。覆盖 `Pass`/`Review`/`Block` 映射、多字段聚合、base64 请求体、请求不带 Secret、5xx/429/403/非 JSON/`Response` 非对象/`Error.Code`/`Suggestion` 非法/连接失败/传输超时的分类与重试次数、错误消息不搬运上游文本、`RequestId` 非白名单形状置 null、多字段 `dataId` 越界时不发任何请求、图片 `FileMD5` → `contentDigest`（大小写统一为小写）、`FileMD5` 非 MD5 形状 → `invalid_response`（可重试、不放行）、对象不存在/过大/dataId 越界、读取对象抛存储异常 → `network`（503 而非 500）、图片重试只读一次字节。
- `providers/provider.test.ts`：本地词表 transport 的判定语义、聚合、全空白拒绝、图片一律 `REVIEW`；工厂按 transport 选实现；决策聚合取最高风险、空集合与未知判定值都抛错。
- `providers/retry.test.ts`：可重试错误重放到上限、不可重试错误只调用一次、`attempts < 1` 抛 `RangeError`。
- `packages/shared/src/env.test.ts`：4 项缺一即失败（并点名缺哪一项）、生产禁 `local`（含大小写/空白变体）、无默认值、trim、错误信息不含密钥值。

### 9.2 Bun 兼容性实证

`import { tms } from 'tencentcloud-sdk-nodejs-tms'` + `new tms.v20201229.Client(...)` 在当前 Bun 下可 `import`、可构造、可发起请求（`bun.lock` 里的 SDK 版本 `4.1.311`）：对本地假上游发出的请求带 `TC3-HMAC-SHA256` 形状的 `Authorization` 头、`X-TC-Action` 路由正确、请求体是 base64 后的原文（`providers/tencent.test.ts` 有断言）。

**未验证**：假上游不校验签名，因此"签名是否被腾讯接受"没有被证明——只能由 §9.3 的真实调用证明（见 §10-R8）。

### 9.3 授权环境后的最小真实调用（未执行）

```bash
# 前置：.env 里 CONTENT_MODERATION_TRANSPORT=tencent + 四项配置齐全（或直接给环境变量）
bun --env-file=.env apps/api/scripts/moderation-live-probe.ts '文本样例' [可选图片路径]
```

脚本对给定文本做一次 TMS、对给定图片做一次 IMS，打印判定、`RequestId` 与耗时；**只喂构造样例**，不要用真实用户内容。

---

## 10. 已知限制与风险

- **R1 · SDK 带来的 lockfile 传递版本变化**：见 §0 第 2 条。**Owner 已确认保留官方 SDK**，理由：运行时并不执行 Node 版 `node-fetch`——在 SDK 自己的包目录里（旁边就有 `../node_modules/node-fetch` 符号链接、磁盘上也有真实 `node-fetch@2.7.0`）实测 `require.resolve('node-fetch')` 仍返回裸说明符，即 Bun 用内置兼容实现接管，超时文案是 Bun shim 的 `The operation timed out.` 而不是真实库的 `network timeout at: …`（互证见 R2）。残余代价：5 个 hoist 槽位变动、+38 个包/约 3.6MB 安装体积、`json-bigint`。若日后要把新增运行时依赖归零，替代方案是手写 TC3 签名（只改 `providers/tencent.ts` 一个文件，可用腾讯官方 TC3 测试向量在无授权环境下做单测）。
- **R2 · Bun 下的传输超时不精确**：Bun 把 SDK 依赖的 `node-fetch` 解析到内置实现，实测错误消息是 `The operation timed out.`（Node 上是 `network timeout at: …`），且 `reqTimeout` 被量化（1–3s → ~4s，5–8s → ~8s）。已用消息/名称双重识别归类为 `timeout` 并有限重试；**不影响放行与否**（都不放行），但"单次超时约等于 `timeoutMs`"这一点在 Bun 下不成立。
- **R3 · 跨境延迟**：`TENCENT_CLOUD_REGION` 与业务/存储地域不一致会显著放大超时概率；部署时应与存储同地域。
- **R4 · 生产启动强依赖**：未补 `CONTENT_MODERATION_TRANSPORT` 的机器会 crash loop（§6）。这是刻意 fail-fast，但必须在升级说明里对齐。
- **R5 · 真实审核质量未验证**：没有授权环境，`Review`/`Block` 判定质量、IMS 对 OCR/二维码/广告引流的覆盖度均**未验证**，不能作为上线依据。
- **R6 · 成本与配额未处理**：并发、QPS、限频退避参数（`maxAttempts` / `retryDelayMs`）当前是适配器内常量，未按真实配额调参，也无告警。
- **R7 · 生产 `local` 禁令的前提是部署侧设置了 `NODE_ENV`**：`loadContentModerationEnv` 只在 `NODE_ENV=production`（trim + 小写）时拒绝 `local`，但仓库现有部署路径不设置 `NODE_ENV`（见 §0 第 4 条），因此按现有手册部署的生产机若写 `CONTENT_MODERATION_TRANSPORT=local` 仍会启动、只打一条 warn。缓解：`docs/deployment.md` §4 已要求生产写 `tencent`（五项变量由脚本写入 `/etc/fish/api-mail.env`）；根治要 Owner 决定是否在 systemd 单元统一加 `Environment=NODE_ENV=production`——那同时会收紧既有的 `WECHAT_TRANSPORT=stub` 护栏，属跨模块运维变更。**Owner 已决定：本期不并进本 PR，另案处理。**
- **R8 · TC3 签名正确性未验证**：见 §9.2。模拟响应测试只证明 SDK 在 Bun 下能跑通、能发出形状正确的请求；真实签名/鉴权结果必须由 §9.3 的授权环境调用证明。
- **R9 · 腾讯侧 `DataId` 去重语义未查证**：若腾讯按 `DataId` 缓存去重，用同一个 `${dataId}-${field}` 复审同一字段改动后的文案可能拿到旧结论。本机网络无法访问腾讯云文档，**未验证**；接线前应在授权环境实测（`moderation-live-probe.ts` 已可用）并在需要时给 `dataId` 加版本后缀。

---

## 11. 后续接线清单（不属本期）

1. 商品 CREATE/UPDATE 主链调用 `moderateText`，`REVIEW`/`BLOCK` 的落库与状态流转（与 #217 协调共享文件）。
2. 审核记录表与迁移：来源、`dataId`、`decision`、`policyVersion`、`requestId`、`score` / `label`、人工改判。
3. 图片确认 + 不可变对象 + 商品引用接线：用 `contentDigest` 固化，关闭对象替换 TOCTOU。
4. Admin 人工队列展示与客户端错误反馈（包含 503 `CONTENT_MODERATION_UNAVAILABLE` 的文案与重试引导）。
5. 日志与指标：`provider` / `outcome` / `reason` / `requestId` / `latencyMs` 打点（本期适配器不打日志）。
