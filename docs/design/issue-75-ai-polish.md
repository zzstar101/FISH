# #75 商品描述 AI 润色 — 设计方案

> 状态：**方案已确认，不含实现代码**，待评审后开工。
> 关联：需求载体 [#75](https://github.com/zzstar101/FISH/issues/75) ｜ 后端子单 [#141](https://github.com/zzstar101/FISH/issues/141)（已随 PR #148 合入）｜ 客户端子单 [#142](https://github.com/zzstar101/FISH/issues/142)（**已按 NOT_PLANNED 关闭、并入 [#74](https://github.com/zzstar101/FISH/issues/74) 统一维护**，原正文与验收保留为历史上下文）
> 记录人：Coast-87（本机） ｜ 日期：2026-09-21 ｜ 实现分支：`feat/75-ai-polish-backend`（squash 合入，远端分支已删）
> **行号基线**：`origin/main = ed561cd`（本分支 rebase 后的基线；原稿写于 `e3e909a`，行号已按新基线逐条复核）。本文引用的他人代码行号以此为准。
> **客户端（#142 范围）复核基线**：`origin/main = c0bed1a`（2026-09-22 逐条复核，见 §10）；**接线实现**已按 `origin/main = 8609c97` 重核并落地（见 §10.3 / §10.4）。
> 决策来源：Owner 于 2026-09-21 分四轮逐条确认（完整取舍见 §12）；客户端接线的三项决策于 2026-09-22 确认（见 §10.2）。

---

## 0. Owner 看这里

一句话：给发布页加一个**同步、可选、只回文本草稿**的润色接口，送模型前先脱敏、返回前过滤，客户端确认后才覆盖描述。

需要你本人做的三件事：

1. 提供 `live` 上游的最终凭据（开发期那把 key 已进过会话上下文，**PR 合并后请去服务商控制台轮换**）。
2. `live` 首次真实调用的**质量验收**：`thinking` 开/关、`temperature=0.7` 的文案质量，用约 20 条真实描述对比后定（§9 的探针各只跑过 1 次，不构成质量结论）。
3. #142 的**微信开发者工具演示 + 你确认可行后才允许提交**（`docs/miniapp-dev-workflow.md` 硬门禁）。

本期两处刻意的"不做"，是决定不是遗漏：**不设成本上限与告警**（§11-R1）、**不做后台可配**（§11-R2）。

---

## 1. 目标与非目标

### 目标

- 用户在发布页点"润色"后，拿到 1~3 条**可选用**的描述候选草稿。
- 模型 API Key 只在服务端；客户端不持有任何上游凭据。
- AI 不改变任何结构化事实：端点的入参与出参**不存在**价格/成色/分类/0 元送的写回路径。
- 上游失败、超时、返回垃圾内容时，用户的原描述一字不动，且能拿到可区分的错误语义。

### 非目标（附理由）

| 不做 | 理由 |
| --- | --- |
| 后台可配（模型 / prompt / 配额 / 调用量看板） | 属 #73 写操作，而 #73 写操作范围在 #76 仍标注"待冻结" |
| 成本上限、预算告警、自动止血 | Owner 本期决定不控成本；仅把 token 用量落表供事后查（§11-R1） |
| 运行时改 prompt | 与 `MODERATION_RULE_VERSION`（`apps/api/src/modules/moderation/rules.ts:3`）同惯例：改文件即升版本 |
| 流式 / SSE / 异步 job + 推送 | miniapp **无任何 WebSocket 客户端**（`apps/miniapp/src` grep `WebSocket` 零命中），且实时事件契约只允许 `message.new \| conversation.read \| pong`（`packages/contracts/src/chat/schema.ts:247-269`），异步结果今天送不回去 |
| 新增"断言类"词表（发票 / 验机 / 包邮…） | 那是 moderation 词表的职责，两处各养一份必然漂移（§6.3） |
| web 端润色入口 | `apps/web` 发布页当前无任何润色 UI（全 `apps/web/src` grep `polish\|润色` 零命中），Issue 未要求 |
| 自动发布 / 代填结构化字段 | Issue 明写"候选只是草稿" |

---

## 2. 交付切分与分支

| 子单 | 内容 | 分支 | 前置 |
| --- | --- | --- | --- |
| **#141** | 契约 + DB(`0014`) + api 模块 + stub + 测试（**不碰 `apps/miniapp`**） | `feat/75-ai-polish-backend` | 无 |
| **#142** | miniapp 发布页换真接口（状态机、错误态、守卫、角标） | `feat/miniapp-ai-polish-sell` | #141 合入 **且 #129 合入** |

- #142 必须等 #129：两者都改 `apps/miniapp/src/pages/sell/index.tsx`（#129 改顶栏与描述框）。已在 PR #129 上登记该依赖。
- 当前工作区遗留的 `apps/miniapp/project.config.json` 未提交改动与本方案无关，**不纳入任何提交**。

---

## 3. 上游与配置

### 3.1 出网方式

OpenAI 兼容托管端点，**裸 `fetch`，不引入任何 SDK 依赖**（理由：全仓后端运行时依赖只有 `hono` / `drizzle-orm` / workspace 包，`bun.lock` 里 openai / @anthropic-ai / @ai-sdk / ollama 全部 0 命中；加依赖要按 CONTRIBUTING §3.1 带 `--registry`，且 CI 有 lockfile 来源白名单校验）。

实现照 `apps/api/src/modules/auth/email-providers.ts` 的既有形状：`AbortSignal.timeout`、最多尝试次数写死、**不把上游响应体写进错误消息**（外部响应文本不可信）、只记状态码。

### 3.2 env（只四个）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AI_POLISH_TRANSPORT` | **是，无默认值** | `stub \| live`；缺失则**进程启动失败** |
| `AI_POLISH_BASE_URL` | **两种 transport 都必填** | live 形如 `https://api.deepseek.com`；stub 指向本地假服务 `http://127.0.0.1:8787`。stub 指"模型是假的"，不是"进程内有个假实现"——它也是真 HTTP 服务 |
| `AI_POLISH_API_KEY` | live 时 | 真实值**只进本机 `.env`**（`.gitignore:6` 已忽略）；仓库、Issue、提交信息、日志中只出现变量名 |
| `AI_POLISH_MODEL` | live 时 | 例：`deepseek-flash` |

加载器与 `loadMeetupTokenEnv()` / `loadMailTransportEnv()` 同族，放 `packages/shared/src/env.ts`（两个现存的 per-process 加载器分别在 `env.ts:71` 与 `env.ts:42`），**不进 `ServerEnvSchema`**（`env.ts:3`）——避免 worker 进程拿到上游密钥。`transport=live` 但 base_url / key / model 任一缺失 → 装配层启动即失败，遵循 production Provider 的既有注释口径："配置缺失时由装配层在启动时显式失败——不在构造器里静默回退 dev"（`apps/api/src/modules/auth/email-providers.ts` 底部 `createResendEmailVerificationProvider` 上方注释）。

### 3.3 常量（一律不进 env）

`TIMEOUT_MS = 8000` ｜ 重试 **0 次** ｜ 候选数 **3** ｜ `max_tokens = 2000` ｜ `temperature = 0.7` ｜ `thinking = { type: 'disabled' }`（代码保留参数位，§9） ｜ 配额 `最小间隔 5s（不区分 outcome）` + `滚动 24h 正常 ≤ 30 次` + `滚动 24h EMPTY ≤ 60 次` ｜ `PROMPT_VERSION` 常量。

理由：可配的东西越多，`stub` 与 `live` 的行为差异越容易藏起来。

### 3.4 新增变量必须同步的三处

`.env.example`、**`.github/workflows/ci.yml:27-40`（CI 硬编码 env 列表，不读 `.env.example`）**、`docs/deployment.md` §4。

> 破例授权：本 PR 顺带补 `docs/deployment.md` 的**环境变量清单**，同时补上一直欠着的 `MEETUP_TOKEN_SECRET`（main 上该文件对它 0 次提及；它自 #125 起是必填，缺失即 `Restart=always` crash loop）。做法是**复用分支 `feat/70-deploy-meetup-token-secret` 已写好的 120 行，不重写**——按序 cherry-pick `be0cd96` → `da315d1`（顺序敏感：`da315d1` 单独不适用）。除此之外不碰该文件其它章节——§7.1"起服务后无健康检查"那条仍按"只报告不修"处理。这是 Owner 明确批准的、对 AGENTS §3 范围纪律的一次破例。

---

## 4. 契约（`packages/contracts/src/ai/`）

新增 `routes.ts` + `schema.ts`，zod 一律 `.strictObject`；不建 barrel `index.ts`，跨包按 subpath 导出。

### 4.1 端点

`POST /ai/polish-candidates` — 挂 `requireAuth`（未登录 401；不给匿名者烧配额）。

```
请求  { title: string, description: string, category: ListingCategory }
响应  { provider: 'stub' | 'live',
        redacted: boolean,
        candidates: { id: string, text: string }[] }   // 1~3 条
```

- `title` / `description` 复用 listings 契约：`ListingDescriptionSchema = z.string().trim().min(1).max(500)`（`packages/contracts/src/listings/schema.ts:65-69`）。
  - 实现口径：`title` 直接复用 `ListingTitleSchema`（trim、2~40 字），即**标题没写完时润色也会拿到 422**（字段级 `details` 指到 `title`）。Owner 2026-09-21 确认保持——与发布路径同一套字段级错误文案，客户端守卫可复用（§12-18 之前的决策）。
- `category` 只收枚举值，**中文标签由服务端解析**：不接受客户端传标签文本，堵住"伪造上下文诱导模型"的口子。
- `candidates[].id` 是**每次响应内**的稳定 id（非数据库主键，不落库）。
- `description` 的长度上限**只定义在契约**，DB 侧是裸 `text` 无 CHECK（`packages/db/src/schema/listings.ts:46-47`）——所以"≤500"是应用层不变量，必须由 §5 第 6 步守。

### 4.2 错误码

| HTTP | code | 语义 |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | 未登录 |
| 422 | `VALIDATION_FAILED` | 描述为空 / 超 500 / 字段非法（字段级 details 复用 `validationDetails()` 的 `field` / `message` 形状，`packages/contracts/src/system/error.ts:67`；该文件已有跨 domain 的 `SystemErrorCodeSchema = ['VALIDATION_FAILED','INTERNAL_ERROR']`，本模块的错误码应放 `contracts/src/ai/`，不要塞进 system） |
| 429 | `AI_POLISH_QUOTA` | 触发间隔或日配额，带 `retryAfterSeconds` |
| 503 | `AI_NOT_CONFIGURED` | `transport=live` 但配置不全（运行期兜底，正常应在启动即失败） |
| 504 | `AI_TIMEOUT` | 上游超过 8s |
| 502 | `AI_UPSTREAM_ERROR` | 上游违约：`content` 为空、段数 <1、或 `finish_reason=length` 且无正文 |
| 502 | `AI_RESULT_EMPTY` | 上游正常返回，但候选被 §5.6 全部过滤 |

两条口径：

1. **429 不复用 `RATE_LIMITED`**。现成先例在主线上：面交码的失败锁定用独立码 `MEETUP_TOKEN_LOCKED`（`apps/api/src/modules/transactions/service.ts:238`），而不是套一个通用限流码。语义不同的拒绝若共用一个码，客户端就无法给出正确的文案与倒计时。

   `retryAfterSeconds` 的载体（Owner 2026-09-21 定，见 §12-17）：加在共享 `ApiErrorSchema`（`packages/contracts/src/system/error.ts:17-31`）上作为**可选**字段——全仓此前没有这个字段位，两个既有 429 都把秒数写进 message 文本；本模块起改为结构化返回，客户端不必解析文案。
   （注：被 NOT_PLANNED 的 #132 曾在 `contracts/src/auth/session.ts` 里写过同类论证，但那份改动**从未进入 main**，不要把它的行号当依据。）
2. **`AI_UPSTREAM_ERROR` 与 `AI_RESULT_EMPTY` 必须可区分**：前者是"我们或模型出了问题"，后者是"用户内容本身过不了关"。混在一起，排障时看不出区别，也会让 §11 的质量指标失真。

---

## 5. 处理流水线（顺序即语义）

```
1 鉴权 → 2 配额占位 → 3 脱敏 → 4 调上游(8s,无重试)
  → 5 解析 === → 6 逐条过滤 → 7 逐条回填 → 8 落 outcome / 返回
```

### 5.1 输入校验
`title` / `description` / `category` 走 zod；`description.trim()` 为空 → 422（当前 miniapp 已在本地拦"先写一句描述再润色"，服务端仍要独立成立）。

### 5.2 配额
事务内先取 `pg_advisory_xact_lock(hashtext(...))` 串行化"先查后插"（现成写法见 `apps/api/src/modules/auth/verification-service.ts:48-49`，那里按"先 user 后 email"的固定顺序取两把锁），再对 `ai_polish_requests` 做**三条**检查：`now() - max(created_at) ≥ 5s`、滚动 24h 正常额度 `COUNT ≤ 30`、滚动 24h `EMPTY` 桶 `COUNT ≤ 60`。所有时间比较**用 DB 时钟 `now()`**，不用应用时钟。检查通过后**立即写入占位行**——"上游失败也扣配额"由这一步保证，随后回写 `outcome`。

配额计数口径（关键，容易被实现随手写错）：

| outcome | 间隔检查 | 正常日桶（30） | `EMPTY` 桶（60） | 原因 |
| --- | --- | --- | --- | --- |
| `OK` / `UPSTREAM_ERROR` / `TIMEOUT` / `TOKEN_LOST` / `NOT_CONFIGURED` | 计 | 计 | 不计 | 已真实消耗上游；不计入会让脚本免费打上游 |
| `EMPTY` | **计** | **不计** | **计** | 上游已被调用并计费（#173）；但候选全被过滤对用户无损，不该白亏正常额度（#75 Done:"失败可无损返回"） |
| 未回写的占位行（`outcome` 仍为 `NULL`） | 计 | 计 | 不计 | 崩一次不能白送额度；它已被间隔检查挡住，不必在 `EMPTY` 桶重复兜底 |
| `QUOTA` | **不写行** | — | — | 被拒请求若写行，会把 COUNT 撑大，形成"拒一次就少一次额度"的自我收紧 |

实现方式：`EMPTY` 行照样写（供质量指标用）。**正常日桶**的 COUNT/MAX 加 `outcome IS DISTINCT FROM 'EMPTY'` 过滤；**间隔检查不加过滤**；`EMPTY` 桶用 `outcome = 'EMPTY'`（NULL 占位行自然不计入）。

> **实现口径（2026-09-21 定稿）**：必须用 `IS DISTINCT FROM 'EMPTY'` 而不是上面最初写的 `outcome <> 'EMPTY'`——占位行先落库、`outcome` 尚为 `NULL`，而 `NULL <> 'EMPTY'` 求值为 `NULL`（不为真），会把"没来得及回写"的行排除在计数外，等于**崩一次就白送一次额度**。`ai_polish_requests.outcome` 因此是可空列。

> **2026-09-22 口径变更（#173）**：原口径是两条检查、且**两条都排除 `EMPTY`**。那让"能把请求稳定变成 `EMPTY`"的调用方（原文含会被 moderation `BLOCK` 的词、或命中 §5.6c 数字校验误杀）既不占间隔、也不计日配额，可以持续打付费上游——成本与表行数都无上界。改法：间隔检查**不再排除 `EMPTY`**（上游已被调用并计费，不能因为候选被我们过滤掉就免掉间隔），并给 `EMPTY` **单列一个更宽松的 60/日桶**。每账号 24h 的调用上界因此是 **89 次**（29 非 `EMPTY` + 59 `EMPTY` + 1 在飞占位）。
>
> 两个被否的改法：并进正常 30 桶——内容触发过滤的用户会白亏正常额度，与 #75"失败可无损返回"冲突；只加进 5s 间隔——间隔的理论上界是每账号约 1.7 万次/日，仍不封顶。

> **"三桶任一命中即全拒"是刻意的（Owner 2026-09-22 定）**：`EMPTY` 桶满后，该账号**连同尚未使用的正常额度一起**被挡到窗口滚动。最长等待不是"约 20h"而是**约 23.9h**——60 条 `EMPTY` 最快能在 295s（59×5s）内打完，此时最旧那条要到 24h 才出窗。成本上界必须在"还不知道 outcome"的时刻生效——要调上游之后才知道会不会 `EMPTY`——所以"只挡 `EMPTY` 请求、不挡正常请求"的桶在结构上不存在。账面口径（`EMPTY` 不占正常额度）与可观察行为（撞满即当天停用）必然分离；写清它，而不是假装一致。

> **观测口径**：桶被拒**不写行、也不记日志**——拒绝路径不出网、**相对上游开销**几乎免费（但仍各付一次事务 + advisory lock + 三个聚合查询），而 `app.ts` 没有全局限流，记日志会把日志变成刷量入口。校准 `EMPTY` 桶的 60 从表里读：`select user_id, count(*) from ai_polish_requests where outcome = 'EMPTY' and created_at > now() - interval '24 hours' group by 1`。

> **已知近似（误差上界比原先写的大）**：`retryAfterSeconds` 取"桶内最旧一行的到期时刻"。但计数可能**超上限**（`EMPTY` 上界 61、正常日桶上界 31），此时要等**两条**最旧的行都出窗才解锁，而提示只按最旧那条算——**误差 = 最旧两行的间隔，上界不是 5s，最坏可达数十小时**（最旧一条即将出窗、第二条还早时）。实际影响被 §10.2 的文案规则挡住大半：> 60s 一律显示粗粒度文案，所以"报 3600s、真实 85800s"这类情况用户看到的都是同一句话；**只有"报 ≤60s 而真实要等很久"这一种组合**会让用户白重试一次。修正要改成"第 `count - limit + 1` 旧的行到期"（相关子查询 + OFFSET），代价与收益不成比例，故接受并记录。

### 5.3 脱敏（只作用于送往上游的文本）
见 §6.1。脱敏文本与回填映射**只存活在请求生命周期内**，不落库、不落日志。

### 5.4 调上游
`fetch` + `AbortSignal.timeout(8000)`，不重试。理由：重试一次会把"失败扣不扣配额"变得难解释，且"换一条"不重新请求，用户手动再点"润色"就是天然重试。

### 5.5 解析
候选之间**只允许单独一行 `===`** 分隔（不用 JSON：OpenAI 兼容端点对 `response_format` 的支持面不统一，分隔符协议的失败模式更可诊断）。`content` 为空、`split` 后段数 <1、或 `finish_reason === 'length'` 且无正文 → `AI_UPSTREAM_ERROR`。取前 3 段。

### 5.6 逐条过滤（丢弃即静默，只累计 `filtered_count`）

| 序 | 规则 | 依据 |
| --- | --- | --- |
| a | `text.trim().length > 500` → 丢 | **不截断**：截断造出半句话，买家会当事实读。长度上限只在契约定义（§4.1） |
| b | 出现 `标题：` / `分类：` / `描述：` 前缀 → 丢 | 服务端硬校验，不能只靠 prompt：§9 探针 2 实测模型确实照抄过字段名，脏候选会直接污染描述框 |
| c | **数字 / 单位 ⊆ 校验**：原文与候选各自归一化后取"数字 + 紧邻单位"有序集合，候选 ⊄ 原文 → 丢 | 这是"AI 不得新增事实"唯一可验证的形式。归一化＝NFKC + 剥空白 + 中文数字→阿拉伯；**不做单位换算表**（第二个会漂移的真相源）。**基线是模型看到过的全部用户内容（标题 + 描述）**，见下方口径 |
| d | moderation：`BLOCK` → 丢；`REVIEW` → **也丢** | REVIEW 会把商品硬推 `OFFLINE`：PATCH 路径 `apps/api/src/modules/listings/service.ts:442`、CREATE 路径 `apps/api/src/modules/listings/store.ts:327`。用户在发布页看不出掉线原因，比少一条候选糟得多。规则本体：`EXTERNAL_CONTACT → REVIEW`（`apps/api/src/modules/moderation/rules.ts:15`，判定在 `:73-77`、返回 `reasonCode` 在 `:81-86`） |

**d 的口径（已定）**：本步跑在**回填前的标记版**文本上。若改跑回填后的全文，则凡用户原文自带联系方式者，每条候选都会命中 `EXTERNAL_CONTACT → REVIEW`，润色对这批用户**永久返回空**。该过滤的边界是"模型新增内容"；用户原文的风险由 `PATCH /listings/:id` 的真实审核承担（#74 既有语义，非本单引入）。

> **prompt 侧缓解（2026-09-21 加，真实上游实测后）**：实测用户原文写"有意者**加微信**详聊"（没给出可被脱敏规则识别的账号）时，"加微信"三字原样进 prompt，模型三条候选都照抄 → 每条都 REVIEW → 整个请求 `AI_RESULT_EMPTY`，用户点润色只会看到"没有可用文案"。因此 prompt 第 5 条显式禁止候选写出 `加微信`/`微信号`/`vx`/`v信`/`二维码`/`外链`，并给出替代说法（"有意者私聊"）。这只是**降低触发率**，服务端过滤照常兜底——§11-R5 的丢弃率仍需用 `filtered_count` 观测。

**c 的基线口径（2026-09-21 定稿，真实上游实测后修正）**：基线取**标题 + 描述**的并集，不是只取描述。标题本来就在 prompt 里（§4.1），模型在候选里写出标题中的型号属合理行为——实测 `原文(标题) = ["380"]`（"罗技 K380"）、三条候选都写了它，只取描述时三条全被判"新增事实"丢弃、接口返回 `AI_RESULT_EMPTY`（`filtered_count=3`）。**单位只认 ASCII 字母、`%` 与 `元/块/折/成/新`，且只取首字符**（`128G` 与 `128 GB` 必须等价，这是 §8.3 测试矩阵钉住的）；未列入单位的字符退化为只比数字，单字中文数字（`一起`/`一年` 里的 `一`）不抽——**少判不误杀**，已知误杀（`元↔块`、`三件→3件`）由 `filtered_count` 观察（§11-R4）。

### 5.7 回填
按**整条候选**降级：该条任一标记未能原样找回 → 此条全部标记位统一替换为类型化提示语（如"（你的地址已被移除）"），`outcome = TOKEN_LOST`。
不做逐标记混合回填、不按顺序猜（错回填 = 把 A 的电话接到 B 的位置）。回填后仍需 ≤500 字——**还原的是用户原文，它可能比标记长**（39 字邮箱换掉 13 字 `[fish-mail-1]`），标记版不超限不代表回填后不超限，所以要再测一次长度，超限则同样丢弃。

**"任一标记"的边界（2026-09-21 定稿，真实上游实测后修正）**：只要求**被改写那段文本（描述）自己那次脱敏**发出的标记齐全。标题的标记是上下文：候选是描述的改写，标题里的标记天然不出现在候选里，把它也算"丢失"会在标题含可脱敏内容（如"出 12号楼 的键盘"）时把用户自己的联系方式换成提示语、并错记 `TOKEN_LOST`——正是 §12-5 否掉"只做不可逆替换"要避免的困惑。标题的标记若真被模型带进候选，仍会照常还原。
标记**被改写过的半成品**（`[fish-phone- 1]`、全角数字、`fish-phone-1` 这种漏括号写法）既不算"找回"，也不允许原样留在候选里：整条降级时一并换成同类型提示语。**插了不可见字符**（零宽、软连字符 U+00AD、LRM U+200E、CGJ U+034F、变体选择符 U+FE0F、Hangul 填充符 U+3164…）的标记**不属于**此类：比对前先把不可见字符剥掉，标记归一成标准形态后按"找回"处理、还原用户原文——用户拿回自己的内容比换成提示语更符合预期。

标记被**整段删掉**（候选里根本没有该标记）时没有可替换的位置，候选照原样返回，只记 `outcome = TOKEN_LOST`——"全部标记位换成提示语"只对**还在的**标记位成立；§12-5 否掉的是"不可逆替换"（模型根本没见过原文），不是模型自己选择不写。

**脱敏规则匹配前也要剥不可见字符**，且字符集不能手枚举：`138\u200b12345678`、`138\u00ad12345678`、`138\u316412345678` 只要有一个没列进去，号码就整段绕过手机号规则、原样送上游（#141 二次/三次审查发现）。现用 `\p{Cf}` + Hangul 填充符（U+115F/U+1160/U+3164/U+FFA0）+ CGJ（U+034F）+ **非空白**控制字符。刻意**不**收 `\p{Mn}`/`\p{Me}` 的其余部分与空白：前者是可见内容（emoji 变体选择符、keycap、泰文/天城文/阿拉伯文的声调符号），后者是用户描述的排版，全剥会静默篡改用户文案；而 moderation 那份更宽的集合（`rules.ts:39`，含 `\p{Mn}\p{Me}\p{Cc}`）不受此限，因为它随后会再剥掉全部空白。

### 5.8 收口
候选为 0 → `AI_RESULT_EMPTY`；否则返回 1~3 条 + `provider` + `redacted`。无论走哪条出口，都必须回写 `outcome` 行。

---

## 6. 安全与隐私设计

### 6.1 脱敏规格

| 类型 | 标记 | 识别来源 |
| --- | --- | --- |
| `phone` | `[fish-phone-<n>]` | 11 位手机号及其分隔/全角变体 |
| `contact` | `[fish-contact-<n>]` | 微信 / QQ 号及其"+v:xxx"类前缀变体 |
| `mail` | `[fish-mail-<n>]` | 邮箱 |
| `addr` | `[fish-addr-<n>]` | 楼栋 + 门牌样式（弱信号，允许漏，不允许大面积误伤正文） |
| `id` | `[fish-id-<n>]` | 身份证号样式 |
| `card` | `[fish-card-<n>]` | 银行卡号样式 |
| `url` | `[fish-url-<n>]` | http(s) / 常见外链样式 |

规则文件 `apps/api/src/modules/ai/redact.ts`（**改文件即生效，但脱敏规则版本本期不落库**：`ai_polish_requests` 没有该列，事后无法判断某行是哪版规则产生的。原稿曾按 `MODERATION_RULE_VERSION` 的惯例留了一个 `REDACT_RULE_VERSION` 常量，因没有任何可观测出口属死常量，已删；需要可追溯时走 DB CHANGE REQUEST 另开单）。
三条边界：

1. **中文姓名不做**——正则不可靠，误伤正文的收益为负。
2. **不反向修改 `EXTERNAL_CONTACT` 审核规则**：那是审核语义，动它要升 `MODERATION_RULE_VERSION` 并影响 #74 的既有结果，属独立迭代。
3. **映射不可导出**：不写日志、不进 `ai_polish_requests`、不进错误消息。

标记字面为什么用 ASCII：中文方括号标签会被模型改写或删（"（联系方式）"），删掉就回填不上；`[fish-phone-1]` 短、非自然语言，且标记内不含数字之外的语义，配合 §5.6c 的数字校验能被顺带保护。

### 6.2 日志与数据红线
`ai_polish_requests` **不存任何用户文本**；日志只允许出现 `user_id`、`outcome`、计数、`latency_ms`、`model`、`prompt_version`、字符数、token 数。上游响应文本**不得**写进错误消息（同 `email-providers.ts:76-78` 的既有做法）。

### 6.3 词表单一来源
"是否属于新增事实"的判定**只由 §5.6c 的数字/单位集合校验承担**；语义类风险（"包邮""正品""可退换"）交给 moderation。若将来要加断言词表，走 #74 的规则迭代并升版本，**不在本模块养第二份**。

---

## 7. DB 变更说明（DB CHANGE REQUEST）

| 项 | 内容 |
| --- | --- |
| 目标 | 润色调用的配额与质量指标 |
| 新增表 | `ai_polish_requests`，migration 序号 **`0014`**（`0012`/`0013` 已被 #130 占用） |
| 列 | `user_id uuid notNull references users.id`, `created_at timestamptz`, `outcome text`, `candidate_count int`, `filtered_count int`, `latency_ms int`, `model text`, `prompt_version text`, `input_chars int`, `prompt_tokens int`, `completion_tokens int`。**外键跟随全仓约定**：`users.id` 是 uuid，`listings` / `messages` / `comments` / `conversations` 等一律 `.references(() => users.id)`（如 `packages/db/src/schema/listings.ts:45`）。本表只在 `requireAuth` 之后写，不存在"给未注册 id 也留痕"的需求，故**不设无外键的例外** |
| 索引 | `(user_id, created_at)` —— 支撑 §5.2 的两条检查 |
| 枚举 | `outcome ∈ OK \| EMPTY \| QUOTA \| UPSTREAM_ERROR \| TIMEOUT \| NOT_CONFIGURED \| TOKEN_LOST`；**DB 存裸 text、契约用 enum**（理由同 `packages/db/src/schema/jobs.ts:17-18,35` 的 **`type`** 列：text + TS 收窄，避免每加一类都改 migration。注意 `jobs.status` 走的是 `pgEnum('job_status')`，两者别混为一谈） |
| 不存 | 任何用户文本、脱敏映射、上游响应体 |
| 清理 | **不设清理任务**，接受长期增长。增长上界可算：每用户 ≤89 行/24h（29 非 `EMPTY` + 59 `EMPTY` + 1 在飞占位，口径见 §5.2；被拒请求不写行），配额查询只需滚动 24h 窗口。若日后要加保留期，属独立运维迭代 |
| 兼容性 | 纯新增表，不改任何既有表与列，不影响现有读写路径与既有 migration 历史 |
| 回滚 | `drop table ai_polish_requests`（新表无被引用方） |
| 生成方式 | 由 `drizzle-kit` 生成 migration 与 meta snapshot 带入 PR，**不手改** `packages/db/src/migrations/**`（AGENTS §8）；本机无 Postgres，真库验证依赖 CI 与 `core:smoke` |

---

## 8. stub 与测试

### 8.1 stub 服务
`apps/api/scripts/ai-polish-stub.ts`：真 HTTP 假模型服务（同族先例 `apps/api/scripts/core-smoke.ts`），`AI_POLISH_TRANSPORT=stub` + `AI_POLISH_BASE_URL` 指向它。**CI 与本机都走 stub，CI 不出网、不需要任何密钥。**

stub **必须故意返回脏数据**：一条含标记、一条超 500 字、一条含原文没有的新数字。否则脱敏回填 / 长度 / 数字三层过滤等于从未被 CI 执行过——"理想格式的 stub 会让 CI 全绿骗人"。

两条实现约束（#141 三次审查补）：
- 那条"超 500 字"的候选必须**真的 >500 且不含数字/单位/moderation 命中**：早先它重复 20 次正好 500 字（`max(500)` 放行）、又被数字层丢掉，长度层在端到端里从未执行；现在是 `'长'.repeat(501)`，唯一丢弃理由就是长度。
- 唯一那条**干净**候选拼接后缀后不能越过 500，否则 494~500 字的合法描述在 stub 下三条全丢、恒返回 `AI_RESULT_EMPTY`，本地联调（#142）会误判成线上 bug。
- 那条"含原文没有的新数字"的候选必须**定长**、不拼描述：拼描述时描述 ≥490 字会先被长度层丢掉，事实层在长描述下根本不执行，"三层都在 CI 里跑"就缺一层。

### 8.2 假数据可见性（防"忘记配置"，三件全做）
1. 响应契约带 `provider: 'stub' | 'live'`；
2. miniapp 候选卡在 `provider==='stub'` 时显示角标"演示文案·非真实模型"（#142）；
3. 进程启动时对 `stub` 输出一行 WARN。

### 8.3 测试矩阵（按 AGENTS §5"只为改动的行为加测试"）

| 用例 | 挡住的决策 | 依赖 |
| --- | --- | --- |
| 脱敏：各类标识符被替换为正确标记与计数 | §6.1 | 无 |
| 回填：标记原样返回 / 一个丢失→整条降级 | §5.7 | 无 |
| 长度：>500 候选被丢；全丢 → `AI_RESULT_EMPTY` | §5.6a | 无 |
| 数字校验：`九成新`↔`9成新`、`128G`↔`128 GB` 不误杀；新增 `500元` 必丢 | §5.6c | 无 |
| 字段名泄露：候选含 `描述：` 被丢 | §5.6b | 无 |
| 解析：`content` 空 / `finish_reason=length` → `AI_UPSTREAM_ERROR`（**不是** EMPTY） | §5.5、§4.2 | 无 |
| moderation：BLOCK / REVIEW 命中被丢，且跑在标记版上 | §5.6d | 无 |
| 配额：5s 间隔、24h 30 次正常、`EMPTY` 计入间隔但单列 60/日桶、`QUOTA` 不写行、并发不放大计数 | §5.2 | **真库**（CI） |
| 未登录 401；`transport=live` 缺配置启动失败 | §3.2、§4.1 | 无 |
| provider 出网：超时、4xx/5xx 不泄露响应体 | §3.1 | `globalThis.fetch` 打桩 + `finally` 还原（照 `apps/api/src/modules/auth/router.test.ts:791` 起的 `Resend transport` 用例组） |
| stub 端到端一条真链路 | §8.1 | stub 服务 |

---

## 9. 实测数据与参数依据（2026-09-21，真实上游探针）

| 探针 | 延迟 | 结果 |
| --- | --- | --- |
| `max_tokens=1200`，旧 prompt，thinking 默认 | 5.6s | ❌ `content` 为空，1200 token 全被 `reasoning_content` 吃掉 |
| `max_tokens=4000`，旧 prompt，thinking 默认 | **11.7s** | ⚠️ 3 段合格，但候选里照抄了"标题：/分类：/描述："字段名 |
| 同上，prompt 加"只输出正文"约束 | 2.4s | ✅ 3 段、6 个标记全保留、无字段名泄露，596 tok |
| 同上 + `thinking:{type:'disabled'}` | **1.3s** | ✅ 3 段、标记全保留，258 tok |

**端到端真实调用（2026-09-21，完整链路 router → service → provider → DeepSeek `deepseek-flash`）**：参数 `thinking:{type:'disabled'}` + `max_tokens=2000` + `temperature=0.7`。

- 单次抽查（prompt v1）：3 段候选全过过滤（`filtered_count=0`、`outcome=OK`），**932ms**，tokens 295/157，手机号标记已回填。
- **20 条真实描述验收（prompt v2；覆盖全部 8 个分类，含带手机号、带地址、带型号数字、无数字、以及原文写"加微信"的样本）**：候选 **60/60 保留、0 丢弃**；延迟 min 698 / 中位 1095 / max 1889 ms（预算 8000ms，余量充足）；tokens 合计 prompt 6327 + completion 2181（单条 307~337 / 74~160）。
- prompt v1 跑同一批样本是 57/60——唯一被全丢的是"原文写『加微信详聊』"那条（三条候选都照抄"加微信"→ 命中 `EXTERNAL_CONTACT → REVIEW`），prompt v2 禁止这类字样后该样本 3/3 通过（见 §5.6d 口径）。
- 复跑方式：`AI_POLISH_TRANSPORT=live AI_POLISH_BASE_URL=https://api.deepseek.com bun --env-file=.env apps/api/scripts/ai-polish-live-probe.ts <samples.jsonl>`（JSONL 每行 `{title,description,category}`，逐条打印四层判定）。

样本量为 20 条级且由单一构造者编写，**不构成质量结论**：`thinking` 开/关与 `temperature` 的最终取值仍需 Owner 用真实描述对比后定（§0-2、§11-R6）。

四条结论：

1. `thinking:{type:'disabled'}` **被该端点接受**，且 1.3–2.4s 完成 → **8s 预算成立**。
2. 但 `max_tokens` 给小会"想完就没正文"（探针 1）→ 默认 `disabled` + `max_tokens=2000`，并按 §5.5 把"空正文"判为上游违约。
3. prompt 必须显式要求"只输出描述正文、禁止复述字段名"——探针 2 的泄露是实测出来的，因此 §5.6b 的服务端硬校验不是臆想。
4. **样本各仅 1 次**，不构成质量结论 → `temperature=0.7` 与 `thinking` 的最终取值待 Owner 用约 20 条真实描述对比（§0-2）。

### 9.1 live 验收实测（2026-09-22，20 条构造样例）

样例集：`apps/api/src/modules/ai/fixtures/polish-samples.jsonl`（**人工构造、无用户数据**；覆盖 8 个分类 + 手机号 / 地址 / QQ / 邮箱 / 型号数字 / 无数字 / "加微信" / 规格行 / BLOCK 词）。探针直连 provider，不占配额、不落表。

| 参数组 | 上游失败 | 延迟 min / 中位 / max | completion tokens | 保留 |
| --- | --- | --- | --- | --- |
| `thinking=disabled`（现状） | **0** | 888 / 1124 / **4169** ms | 71 – 775 | 19/20 条 3/3；#19 为 0/3 |
| `thinking` 开启 | **1**（#20 撞 8s 超时） | 1181 / 2203 / **7776** ms | 171 – **1435** | 同，但 #20 无结果 |

**结论（Owner 2026-09-22 确认）**：参数**保持现状**——`thinking: { type: 'disabled' }`、`temperature = 0.7`、`max_tokens = 2000`。`thinking` 开启违反"延迟 max < 8000ms"这条硬门槛（448 字描述直接超时），且中位延迟 ×2、completion token ×2–9。`temperature` 未做对照：Owner 判断 0.7 的候选质量可接受，不再消耗调用。

丢弃归因：基线 3 处丢弃**全在 #19、全部 moderation `BLOCK`**（R5）；**数字/单位校验（R4）零误杀**。
正向确认：#8 / #15（原文写"加微信"）**3/3 保留且 `ALLOW`**，模型改写为"有意者私聊"——§5.6d 的 prompt v2 缓解**实测有效**。

**R3 首测 + 探针盲区**：6 条带标记样例里 **2 条**（#14 QQ、#20 手机）的标记在 **3/3 候选里被整段丢掉**（模型改写成"有意者私聊"）→ 真实 HTTP 路径上会整条降级 `TOKEN_LOST`；#20 更糟：同条**地址标记本已保住，也会被一并换成类型化提示语**。**探针看不见这一步**——四层判定不含回填，所以它对 #20 报的是"保留 3 条 / 丢 0 条"。**`TOKEN_LOST` 率只能走 HTTP 路径或查 `outcome` 列。**

---

## 10. 客户端（#142）要点

> **跟踪载体（2026-09-22）**：#142 已按 NOT_PLANNED 关闭并并入 [#74](https://github.com/zzstar101/FISH/issues/74) 维护，原正文与验收作为历史上下文保留、不再更新；**本节是客户端接线的权威版本**。
> **复核基线**：`origin/main = c0bed1a`，`apps/miniapp/src/pages/sell/index.tsx` 共 929 行，下列行号已按此逐条复核。
> **行号已过期**：接线实现落在 `feat/miniapp-ai-polish-sell`（基线 `origin/main = 8609c97`），本节开头那段按 c0bed1a 核过的行号仅作历史记录；**当前行号以 §10.3 为准**。
> **不要拿 `feat/75-ai-polish-backend` 的本地工作副本当基线**：它停在 rebase 前的 `e3e909a`，落后 main 15 个提交（该分支已 squash 合入，远端分支已删）。

完整清单见 #142，此处只记与后端契约耦合的点：

- 状态机 `PolishState = idle | loading | ready{candidates,index}` 需补 `failed{code}`（`:93-96`）——六个错误码各有文案，失败时原描述一字不动。
- **润色入口当前在非 idle 态仍可点**（`:667-668` 只有 `is-busy` 样式类，`openPolish()`（`:403-409`）只检查描述非空、从不检查 `polish.phase`）。接真接口后每次点击吃 5s 配额，连点必 429 → 必须加守卫；429 时按 `retryAfterSeconds` 变灰倒计时，文案只说"操作太频繁，N 秒后再试"，**不透露日配额数字**。
- "换一条"保持纯前端轮播（`:419-424`），不重新请求。
- `adopt()` 只把候选写进描述框并把状态机复位（`:427-434`），不再触碰审核结果（#155 重写发布页时 `setReview(null)` 那行已随既有 mock 流程一起移除）；真实语义是采用后由 `PATCH /listings/:id` 服务端重跑 moderation，客户端**不自行推断审核结论**。
- `polishCandidates()` mock 保留但受 `TARO_APP_MOCK=1` 门禁；生产失败绝不静默退 mock（#89 的 fail-closed 原则）。

### 10.1 落笔前复核出的两处缺口（2026-09-22）

1. **`retryAfterSeconds` 客户端没透出**：契约 `packages/contracts/src/system/error.ts:35` 已带该可选字段、服务端 429 也确实回写它（`apps/api/src/modules/ai/router.ts:30-32`），但 `apps/miniapp/src/lib/request.ts` 的 `ApiError`（`:31-40`）只有 `code` / `status` / `message` / `details`，`apiRequest` 里的 4 参构造（`:144-149`）没带 —— 倒计时拿不到秒数。**这是接线时唯一需要改的非页面文件**（纯增量，既有调用方不受影响）。
2. **入参要 `title` + `category`**：`AiPolishCandidatesRequestSchema`（`packages/contracts/src/ai/schema.ts:24-28`）复用 `ListingTitleSchema`（2~40 字）与 `ListingCategorySchema`，而 `openPolish()`（`:403-409`）目前只把 `description` 喂给 mock。

### 10.2 Owner 决策（2026-09-22）

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 输入不齐（未选分类 / 标题不合法） | **本地先拦**：先 toast（与既有"先写一句描述再润色"（`:405-408`）对称）；若仍拿到 422，把 `details` 经 `sellFieldErrorsFromDetails` 落到对应输入框标红 | 不新增第二套字段级文案体系；服务端校验照常独立兜底 |
| 429 长等待文案 | **> 60s 改粗粒度**："今天润色次数用完了，明天再来"；≤ 60s 才用"N 秒后再试" | 命中滚动 24h 配额时 `retryAfterSeconds` 可达数千至上万秒（`apps/api/src/modules/ai/store.ts` 的三个桶之一；`store.test.ts` 的「EMPTY 桶满后被拒」用例断言 `retryAfterSeconds > 3600`），一律"N 秒后再试"不可读 |
| mock 兜底门禁 | **只认 `TARO_APP_MOCK=1`**（照 `__DEMO_AUTH__` 的严格先例，`apps/miniapp/config/index.ts:64`） | 复用 `__ALLOW_MOCK_FALLBACK__`（`:52-54`）会把 `NODE_ENV=development` 一起放进来：`dev:weapp` 下失败会静默显示本地假候选，而那种候选没有 `provider==='stub'` 角标可区分（§8.2） |

### 10.3 实现落点（2026-09-22，分支 `feat/miniapp-ai-polish-sell`）

> **本条基线**：`origin/main = 8609c97`。`apps/miniapp/src/pages/sell/index.tsx` 共 1118 行。

| 文件 | 落点 |
| --- | --- |
| `apps/miniapp/src/pages/sell/polish.ts`（新，190 行） | 纯判定：失败码→文案（`polishFailureView`）、失败分流（`polishFailureRoute`）、429 两档文案与冷却（`polishQuotaMessage` / `polishCooldownFrom` / `tickPolishCooldown`）、按钮文案、轮播索引、本地前置拦截 |
| `apps/miniapp/src/features/ai/api.ts`（新，62 行） | `POST /ai/polish-candidates` + `AiPolishCandidatesResponseSchema.parse`；传输层失败的 mock 兜底 |
| `apps/miniapp/src/lib/request.ts:41`、`:154` | `ApiError` 增可选 `retryAfterSeconds` 并从信封透出（§10.1-1） |
| `apps/miniapp/config/index.ts:76` | `__DEMO_AI_POLISH__`（只认 `TARO_APP_MOCK=1`，§10.2-3） |
| `apps/miniapp/preview/build.mjs:74` | H5 预览的 `define` 补 `__DEMO_AI_POLISH__: 'true'`（见下） |
| `apps/miniapp/src/pages/sell/form.ts:70` | `sellFieldErrorsFromDetails` 补 `category` 映射（见下） |
| `apps/miniapp/src/pages/sell/index.tsx:115`、`:444-611`、`:1043-1118` | 状态机补 `failed`、冷却倒计时、失败分流、请求作废（`lib/cancellable`）、stub 警告条与脱敏说明渲染 |
| `apps/miniapp/tests/sell-polish.test.ts`（新） | 上述纯判定的用例；`sell-form.test.ts` 另加 `category` 映射的回归用例 |

本轮复核新查出的三条（§10.1 之外）：

1. **`sellFieldErrorsFromDetails` 丢 `category`**：它原只映射 title / description / priceCents / objectKeys，而 AI 润色的 422 字段恰好只有 title / description / category —— §10.2 第 1 行那条「把 `details` 落到对应输入框」若原样执行，**分类这条错误会被静默丢弃**（用户只看到标题标红）。实际触发面比字面小（本次的本地前置拦截会先挡住「未选分类」），但该映射对发布 / PATCH 路径同样成立（`ListingCreateInput` 也带 `category`），且是「不新增第二套字段级文案体系」这条决策的前提。已补映射并加回归用例。
2. **新构建常量必须同步进 H5 预览的 `define`**：`features/ai/api.ts` 在模块顶层裸读 `__DEMO_AI_POLISH__`，而 `preview/build.mjs` 的 `define` 是逐项列出的（`__ALLOW_MOCK_FALLBACK__` / `__DEMO_AUTH__`）—— 漏加则预览构建里该标识符原样保留，**一进「出物」页就 `ReferenceError`**（已实测：`preview/dist/preview.js` 里出现 `MOCK_FALLBACK_ENABLED2 = __DEMO_AI_POLISH__ === true`）。与 `lib/api-base.ts:16-19` 要给 `__API_BASE__` 加 `typeof` 守卫是同一类问题。修法是补 define（预览的 Taro 桩没有 `request`，不注入它就永远截不到候选卡与 stub 角标）。
3. **两个错误码在端上不可达**。两条论断本身是事实（不是取舍）：`VALIDATION_FAILED`（422）被本地前置拦截（描述为空 / 标题 <2 字 / 未选分类）挡住、描述长度又被 `maxlength={500}` 限住，正常 UI 走不到服务端 422（服务端校验照常独立成立，只是端上触发不到）；`AI_NOT_CONFIGURED`（503）的 `isConfigured()`（`apps/api/src/modules/ai/service.ts:55-61`）唯一假分支要求 `baseUrl` 为空，而 `loadAiPolishEnv()`（`packages/shared/src/env.ts:105-112`）在那种配置下**启动即失败** —— 与 §4.2 自己写的「运行期兜底，正常应在启动即失败」一致。**据此把验收里的「演示六种错误码」收窄为「演示四个可达码 + 这两条由单测与本文覆盖」是 Owner 2026-09-22 的决定**，记在 §10.4 的「演示范围」一行，不是本节自行改的口径。

### 10.4 接线实现时的补充决策（Owner 2026-09-22 确认）

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 失败态落点 | 留在 sheet 内（主文案 + 可选副文案 + 「重试」/「关闭」）；429 **不给重试**，另把入口按钮置灰 | 用户刚点过按钮，失败原因要落在同一个上下文里；429 再点只会再吃一次拒绝 |
| 副文案 | 只有 `AI_TIMEOUT` / `AI_UPSTREAM_ERROR` / `AI_RESULT_EMPTY` / 枚举外兜底写「你的描述没有改动」 | #75「失败可无损返回」；配额与「未开放」不是「没轮到调用」，说它反而像在解释别的 |
| >60s 的 429 | 不逐秒倒计时，按钮显示「今日次数已用完」并**在本次页面生命周期内保持置灰**（不写本地存储） | 真实等待可达上万秒；服务端始终是权威，重进页面复位后误点只会再吃一次 429，代价可接受 |
| 429 没带 `retryAfterSeconds` | **仍置灰**，走 `unknown`（不编秒数，按钮只说「请稍后再试」）。契约里该字段是 `positive().optional()`，只有漂移会出现 | 要防的是「被拒了还能接着点、每点一次再吃一次」的循环；但也不能因此声称「今日次数已用完」—— 服务端三个桶里最可能命中的恰恰是 5s 间隔桶 |
| 422 且字段级错误一个都认不出 | 留在 sheet 里说「有些内容没填对，请检查后再试」（不给「重试」），**不**关 sheet 去 toast。认得出字段才关 sheet + 标红 + toast | 关掉 sheet 只剩一句指向空的 toast（说你有错，却满屏找不到标红的地方）；同样的入参重试还是 422 |
| `redacted` 的说明文案 | 「发送给 AI 前已对联系方式脱敏；生成结果可能保留原文信息，请在发布前检查。」—— 只说**发送前**做过处理，**不**说最终内容已不含联系方式 | 回填会把用户原文原样还原（§5.7），候选里照样可能出现他自己写过的号码（实测 `redacted:true` 且候选保留 `13812345678`）。写成「已为你隐去联系方式」会让用户以为采用后发出去的内容已经不含联系方式（#185 审查 P2） |
| 演示范围 | 端上演示**四个可达码**（429 / 504 / 502 上游 / 502 空结果）+ 正常 / 脱敏 / stub 角标 / 单候选 dot / 两种构建的失败差异；`VALIDATION_FAILED` 与 `AI_NOT_CONFIGURED` 由单测与 §10.3 覆盖 | 后两者在正常 UI 里按构造不可达（见 §10.3-3），为演示它们去改仓库代码不划算 |
| 401 | 静默关 sheet，反馈交给 `useAuthGuard` 的跳登录。**已知边界**：`TARO_APP_MOCK=1` 构建里 store 刻意忽略会话清除（`features/auth/store.ts:61-66`），守卫不会跳转 —— 该构建若连真实后端（演示账号没有真会话）会表现为「点了没反应」；演示走生产构建 + seed 账号登录即可规避 | `apiRequest` 已清会话，再弹一句失败提示会与跳转打架 |
| mock 兜底的边界 | 只覆盖**传输层失败**（`!isApiError`，即后端没起 / 断网）；服务端一旦给出信封（429 / 422 / 5xx）一律走真实错误 UI | 否则 429 会一边倒计时、一边在 sheet 里摆着本地假候选 |
| 迟到响应 | 关 sheet（遮罩 / 放弃 / 采用）即 `cancellable.cancel()`，响应丢弃 | 请求要 1~8 秒（服务端上游超时 8s，客户端 `REQUEST_TIMEOUT_MS = 15s`），足够用户点两下 |

### 10.5 已知边界与后续（#185 审查提出）

1. **润色的取消只覆盖「关 sheet」这一种放弃**：`closeSheet()` 会 `cancellable.cancel()`，但**换账号**与**页面卸载**都不会取消在飞的润色请求 —— 迟到的候选可能写回新账号的表单。这属 #170「账号作用域请求守卫盘点」的 sell 页清场范围，本 PR 不顺手修（AGENTS §3），已同步到 #170。
2. `TARO_APP_MOCK=1` 构建下 401 表现为「点了没反应」（该构建的 store 刻意忽略会话清除，守卫不跳转）—— 见 §10.4 的 401 行；演示走生产构建规避。
3. 只报告不修：`apps/miniapp/preview/verify-mock-only.mjs:16` 那句「出物仍必须零业务请求」自 #155 起就已过期（出物页早已接真实上传 / 发布），本次未改（不在本单范围）。

---

## 11. 风险与未验证项

| 编号 | 内容 | 处置 |
| --- | --- | --- |
| R1 | **不设成本上限、不告警**：⚠️ **"脚本化滥用被每用户配额挡住"这条论证不成立**——`EMPTY` 出口按 §5.2 口径同时被两条配额检查排除（`apps/api/src/modules/ai/store.ts` 的两条配额子查询（按当时的文件行号）），凡是能稳定让候选全被过滤的输入（原文含会被 moderation `BLOCK` 的违禁词、或命中 §11-R4 的归一化误杀）都能零配额、无 5s 间隔地打上游；成本与 `ai_polish_requests` 行数因此都没有上界（二次审查实测：同一账号间隔 0s 连打 3 次，全部 `502 AI_RESULT_EMPTY`、无一次 429，落表 3 行 EMPTY、消耗 360 prompt tokens）。**已处置（2026-09-22，#173）**：`EMPTY` 单列 60/日桶 + 计入 5s 间隔，成本上界因此是每账号 89 次/24h（§5.2）。原论证不成立的部分已闭合；剩余只有"撞满即当天停用"这一产品语义（Owner 已确认，见 §5.2） | 已修（#173）；`prompt_tokens`/`completion_tokens` 已落表可事后查 |
| R2 | **无后台可配**：换模型 / 改 prompt / 调配额都要发版 | 归 #73 写操作范围，待其冻结 |
| R3 | **标记被改写的真实比率**——2026-09-22 首测：6 条带标记样例里 **2 条**（#14 QQ、#20 手机）的标记在 3/3 候选里被整段丢掉 | 首测 33%，样本仅 20 条且为构造数据，只作初值。**探针测不到这一步**（四层判定不含回填），`TOKEN_LOST` 率必须走 HTTP 路径或查 `outcome` 列。见 §9.1 |
| R4 | **数字 ⊆ 校验的真实误杀率未知** → 候选经常 1 条还是 3 条不知道 | 同 R3。20 条验收里三层过滤零误杀；**已识别但未触发的一类**：归一化会剥掉空白，`iPhone 13 128G` 被拼成令牌 `13128g`，若模型改写数字顺序（如 `128G 的 iPhone 13`）会拆成 `128g` + `13` 而被判"新增事实"——Owner 2026-09-21 决定先观察不修（修它要动 §5.6c 的核心）。继续靠 `filtered_count` 观察 |
| R5 | **moderation 前置丢弃率未知** | 同上 |
| R6 | ~~**`live` 从未批量验证**~~ **已做（2026-09-22）**：20 条构造样例 + `thinking` 对照，参数经 Owner 确认保持现状（§9.1） | **残留**：样例是构造的、不是真实用户描述（探针会打印原文，不能用真实文本），所以这是"能跑通、参数可用"的判据，不等于"文案质量在真实数据上也成立" |
| R7 | 开发期 key 进过会话上下文 | 按"贴出即泄露"处理，PR 合并后轮换 |
| R8 | #142 依赖 #129 合入，若 #129 长期挂起则客户端无法收口 | 已在 PR #129 登记依赖 |
| R9 | ~~部署手册 §11.6 / §10 的交叉引用漏掉 §4 新增的 AI 变量~~ | **已在本分支修复**：§11.6 改成"§4 列出的全部 API 专属变量（邮件三项、#70 的 `MEETUP_TOKEN_SECRET`、#141 的四个 `AI_POLISH_*`）"（`docs/deployment.md:970-971`），§10 的备份清单本就含整个 `/etc/fish/api-mail.env`（`:807`）。编号保留以免其它地方的引用悬空；原稿"只报告不修"的结论作废 |
| R10 | **脱敏与字段名硬校验的已知边界**（审查登记，本期不修）：① 脱敏只认 11 位手机号，座机 `0758-1234567`、8 位号码、`138(1234)5678` 这类括号写法都不在规则内（§6.1 只声明"11 位手机及分隔/全角变体"，属已声明边界）；② 字段名硬校验只认 `标题` / `分类` / `描述` 三个前缀，而 prompt 自己发出去的是 `商品标题：` / `商品分类：` / `原始描述：`，模型若照抄这几个标签不会被拦；③ `fish phone 1`（无括号、空格分隔）**不再**算半成品标记——这是修 `fish mail 3 个` 误伤的代价，该字面会留在候选里（整条仍记 `TOKEN_LOST`）；④ emoji ZWJ 序列（U+200D 属 `Cf`）会被拆开成多个 emoji，改动前就是如此 | ① 属设计已声明范围；② 超出 Issue 枚举的 `标题：/分类：/描述：`；③④ 概率极低且只影响字面/排版，不改事实。是否收窄由 Owner 定；①③④ 靠 `outcome` / `filtered_count` 观察。**已闭合的**：不可见字符绕过（含软连字符/非空白控制字符，见 §5.7）、大写 `V:` 漏脱敏（改用"值必须以字母/下划线开头"约束，同时排除 `输入电压 V: 100-240V` 这类规格行） |
| R11 | **字段名层（§5.6b）没有端到端覆盖**（2026-09-22 核验 §13 时发现）：`ai-polish-stub.ts` 的脏候选只覆盖脱敏回填 / 长度 / 数字三层（§8.1 的原定义），字段名硬校验只有单测（`service.test.ts`）。而且**不能靠"再加一条脏候选"解决**——`splitSegments` 会 `slice(0, AI_POLISH_CANDIDATE_MAX)`，第 4 条会被直接丢掉；要覆盖必须**替换**现有三条之一，那会牺牲另一层的端到端覆盖 | 只报告不修（AGENTS §3 范围纪律）：§8.1 明确列举的三层不含字段名，属原设计口径而非缺陷；且"一条候选同时触发两层"会让 `dropped` 无法区分是哪层丢的，反而削弱 CI 诊断价值。是否收窄由 Owner 定 |

---

## 12. 决策记录（含被否方案，防重开）

| # | 决策 | 被否方案与理由 |
| --- | --- | --- |
| 1 | 托管 OpenAI 兼容端点 + 裸 fetch | 自建/本地模型（V1 无运维预算）；加官方 SDK（污染 `bun.lock`、无必要）；把模板搬到服务端冒充 AI（价值为零） |
| 2 | 同步单次请求，返回 1~3 条 | 异步 job + 推送（miniapp 无 WS 客户端、事件契约只允许两种）；SSE 流式（同上不支持） |
| 3 | 一次 3 条，"换一条"纯前端轮播 | 每次 1 条 + "换一条"再请求（配额烧 3 倍、与限流语义纠缠） |
| 4 | 入参只 `{title, description, category}`，不送价格/成色 | 送全量结构化字段（隐私面与提示面都更大，且"不改事实"已由接口形状保证，不需要额外上下文） |
| 5 | 送前先脱敏，且映射可逆（本地） | 直接送原文（学生文本进第三方）；只做不可逆替换（用户看到候选里没有自己的微信号会困惑）；命中 >1 就拒绝润色（可用性太差） |
| 6 | 回填按整条降级 | 逐标记混合回填（一条候选里两种状态并存，语义不清）；按顺序猜（错回填） |
| 7 | 新表 `ai_polish_requests` 承载配额 | 复用 `jobs`/`notifications` 打点（歪）；进程内内存计数（重启即失效、多实例各算各的） |
| 8 | `AI_POLISH_TRANSPORT` 无默认、缺失即启动失败 | 未配置=功能关闭返 503（"配错"和"没配"在客户端看起来一模一样，正是"忘记配置"最隐蔽的形态）；默认 stub（生产静默返假数据） |
| 9 | 上游协议用单独一行 `===` | JSON / `response_format`（OpenAI 兼容端点支持面不统一，退化路径反而更复杂）；调 3 次上游（延迟与成本 ×3） |
| 10 | 超长候选丢弃，不截断 | 截断到 500（造半句话，买家当事实读） |
| 11 | REVIEW 候选不返回；且 moderation 跑回填前标记版 | 返回 + 加角标（客户端拿到标记也做不出有用动作，且会掉线）；跑回填后全文（原文含联系方式者永久返回空） |
| 12 | 事实保护＝数字/单位集合校验，静默丢弃 | 只靠 prompt（不可验证）；另养断言词表（与 moderation 双真相源） |
| 13 | 失败扣配额、`EMPTY` 不扣、`QUOTA` 不写行 | 一律不扣（脚本免费打上游）；一律扣（用户被白亏一次无损失败） |
| 14 | 参数全为代码常量 | 进 env（可配项越多，stub 与 live 差异越难对齐） |
| 15 | 本期不控成本、不做后台可配、不做 web 端 | 见 §1 非目标表 |
| 16 | 拆 #141 / #142 两个 PR 两个子单 | 单个 PR 全做完（后端与小程序演示门禁混在一次审核，且违反“每页一分支”） |
| 17 | 429 的 `retryAfterSeconds` 加在共享 `ApiErrorSchema` 的可选字段上 | 塞进 `details` 的 field/message（客户端得解析文本，语义错位）；AI 模块自定义错误体（与全仓 `{error:{code,message,details}}` 约定不一致） |
| 18 | `title` 复用 `ListingTitleSchema`（≥2 字，润色也要求标题合法） | 放宽为只限长度/允许空标题（服务端对标题的不变量就与发布路径不一致了）；Owner 2026-09-21 定 |
| 19 | 事实基线 = 标题 + 描述 | 只取描述：真实上游实测候选引用标题里的型号（"罗技 K380"→`380`）被判"新增事实"，三条候选全丢、返回 `EMPTY`（见 §5.6c 口径） |
| 20 | 回填只要求"本字段（描述）"的标记齐全 | 要求全部字段的标记：标题含可脱敏内容时会把用户自己的联系方式换成提示语并误记 `TOKEN_LOST`（见 §5.7 口径，真实上游踩过） |
| 21 | **`EMPTY` 出口改为单列 60/日桶 + 计入 5s 间隔**（2026-09-22，#173；原地改写原第 13 条会抹掉"当初为什么选 EMPTY 不计数"的记录） | 保持第 13 条的"不计数"：会让"能把请求稳定变成 `EMPTY`"的调用方零配额、无间隔地打付费上游，成本与表行数都无上界（二次审查实测：间隔 0s 连打 3 次全部 `EMPTY`、无一次 429）。改为并进正常 30 桶：内容触发过滤的用户白亏正常额度。只加进间隔不加日桶：5s 的理论上界是 1.7 万次/日，仍不封顶。代价是"三桶任一命中即全拒"，撞满 `EMPTY` 桶当天停用——Owner 2026-09-22 确认接受并写进文案 |

---

## 13. 验收门禁

**#141（本方案主体，已随 PR #148 合入 main）**

> 2026-09-22 用**全新子代理**逐项核验：可证实才勾，不可证实就标注。证据写在各行末尾。

- [x] 契约 / 路由 / requireAuth / 七个错误码全落地，`AI_UPSTREAM_ERROR` 与 `AI_RESULT_EMPTY` 可区分 —— 契约 5 码在 `packages/contracts/src/ai/schema.ts`，`VALIDATION_FAILED` 在 `apps/api/src/modules/ai/router.ts`，`UNAUTHENTICATED` 由 `requireAuth`；`service.ts` 分流两个上游码，`service.test.ts` 断言 `not.toBe`
- [x] §5 八步全链路；日志与 `ai_polish_requests` 中**无用户文本** —— `service.ts` 逐段标注；表内只有计数列（`input_chars` 是数字，无文本列）；`app.ai-polish.test.ts` 断言行内不含原文片段
- [x] `ai_polish_requests` 走 `0014`；配额检查 + advisory lock + 计入/不计入口径有测试 —— `0014_strong_lorna_dane.sql`；`pg_advisory_xact_lock(hashtext('ai-polish:'+userId))`；`store.test.ts` 覆盖 NULL 占位 / `EMPTY` / 日桶 / 并发（口径已于 #173 变更，测试同步更新）
- [x] stub 脏响应形状让三层过滤在 CI 里真被执行 —— **按 §8.1 定义的三层（脱敏回填 / 长度 / 数字）**：`ai-polish-stub.ts` 三条候选各触发一层，`app.ai-polish.test.ts` 断言 `filteredCount === 2` 且标记已回填。⚠️ **字段名层（§5.6b）仍只有单测、无端到端覆盖**，已登记为 §11-R11
- [x] `.env.example` / `ci.yml` / `deployment.md` §4 三处同步（含破例补的 `MEETUP_TOKEN_SECRET`） —— 三处均已实测命中
- [x] `bun run typecheck` → `bun run lint` → `bun test` 全绿（AGENTS §6 由窄到宽） —— PR #148 的 `ci` check 为 SUCCESS（含 Lint / Typecheck / Test / Migrate / Core smoke）
- [ ] AGENTS §7：**全新子代理**对抗性审查 —— **无法独立验证**，故不勾：PR #148 评论区只有 sourcery-ai 机器人与作者自述（PR 正文），仓库内无审查产物。§13 记录的是"当时是否做过"，事后补做无法改变这个事实；补偿是 #173 这次改动本身已做**三轮**独立审查

**#142（另单，已并入 #74）**：见 §10（含 §10.1 两处缺口、§10.2 三项 Owner 决策、§10.3 实现落点与 §10.4 补充决策）——静态检查不能替代微信开发者工具演示 + Owner 确认。实现分支 `feat/miniapp-ai-polish-sell`（基线 `origin/main = 8609c97`）。
