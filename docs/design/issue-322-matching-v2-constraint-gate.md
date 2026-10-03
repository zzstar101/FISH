# #322 M4 语义误判：显式约束门禁（policy 1）

当前状态：Owner 已确认“明确冲突才拦截，未知沿用 hybrid”；本地门禁已实现。N01–N24 已批准并在旧冻结实现测得23/24。
最终审查发现后置作用范围误杀，修复改动了实现；N结果仅证明旧实现，不证明本次修复版本。当前仍BLOCK，需新独立组及fresh复审。
范围：M4 PR #403 工作区；基线与冻结验证证据见 `issue-322-matching-v2-holdout.md`。
修复与缓存向量回归没有额外 live 调用；Owner批准的新N组独立测量增加5次，累计10/200。

## 1. 修复前已验证的缺口（初始基线，不是当前实现）

两方向的 description 传递现已补齐，下面记录最初的问题：

- `apps/worker/src/jobs/matching/scoring.ts:126` 的 `MatchWishFacts` 没有 description。
- `engine.ts:232` 的 `WISH_COLUMNS` 不投影 description；商品方向拿到的 Wish 事实因此没有描述。
- `engine.ts:690` 的 `wishFacts` 也不含 description。
- Wish description 只通过 `engine.ts:617` 等路径进入 embedding 文本；原文显式的“不接受第一册 / 必须支持 iPad”等条件不会被单独检查。
- H16/H17/H21 的真实余弦相似度分别为 .659119/.727160/.656994，被判为 81/85/81 分的有效匹配。
- H07 应匹配却只有 .532671 / 67 分。H07/H16 的 category=100、keyword=0、price=100、acceptSimilar=true 都相同。
  因此当前模型的单调 semantic 归一化与正权重，只调一个阈值不能同时救回 H07 并拦住 H16。
  这是当前特征不足，不是标签矛盾，也不是证明所有可能算法都无解。

## 2. 路线比较

| 路线 | 作用 | 本期代价与风险 | 结论 |
| --- | --- | --- | --- |
| 继续调 floor/ceiling/权重 | 改已有标量分数 | 不能解决上述同结构项、反向语义序的问题；看过验证集后调参也会丢失独立性 | 不作为主要修复 |
| 堆品牌、型号、具体商品的例外词表 | 可修特定样本 | 无证据泛化，违背不加样本专用规则的约定 | 不采用 |
| 每对在线 LLM / entailment 判断 | 可加入交叉文本推理信号 | 逐对网络延迟、费用、失败语义；Issue 明确不做每次在线逐对 LLM 判断 | 不采用 |
| 实体创建/编辑时一次性模型提取事实与约束 | 可识别更自由的自然语言 | 新模型/provider、输出证据校验、缓存版本、CAS、回填及失败处理；可能需要 schema/job 扩展；不是免费复用 embedding 的数值输出 | 暂不作为 M4 最小修复 |
| 限定语法的本地显式约束门禁 | 在 semantic 之外增加原文的确定性证据 | 不覆盖任意自然语言或别名；需要明确未知时的产品取舍，并防止否定词误杀 | Owner 已确认采用；限定语法边界 |

阶段记录：首次实现时仅通过修复回归，未做新独立测量。后续N组旧实现结果见[N验证记录](issue-322-matching-v2-holdout-2.md)，
修复后版本仍须新独立验证，不以旧N结果承诺新版本通过率。

## 3. 推荐边界（草案）

门禁只解释用户**明确写出的强制条件**，不是把整段愿望当作一串必含词。

- 输入仍是现有 wish keyword + description，以及 listing title + description；不新增客户端字段。
- 支持一组公开、有限的语言句式：如“不要 X / 不接受 X / 只要 X / 必须支持 X”。具体形式在实现前列清，不声称任意同义改写都可识别。
- 轻量规范化可含 Unicode/case/空白，以及文档化的普通语法处理；不内置 Xbox、iPad、华为或具体教材的补丁。
- “同济版最好 / 第七版也可以 / 优先 X”等表达是偏好或备选，不能仅因含描述而当作必需条件。
- 不把“不介意 X / 不要求 X / 不仅 X”等一律当成排除；也不把商品“不是 X / 不支持 X”里的字符串出现当作满足 X。
- 必须先完成条件与证据的极性/作用范围判断，再比对；不能用整个描述的简单 includes 或一个“不要”正则就宣称正确。
- 输出每条显式条件的 `satisfied / contradicted / unknown` 与有限的内部原因码。
  `unknown` 是没有足够字面证据或无法可靠解析，不等于商品已被证明不兼容。
- 仅本地确定性计算；没有新增出网请求，不改 embedding 模型、文本版本、权重或阈值，不做语义正例加分。

### Owner 已确认的产品取舍

Owner **否决**“unknown 也不放行”。最终口径是：

- `contradicted`：已识别的条件与原文字面声明明确冲突，最终分数归零。
- `satisfied`：继续原 hybrid，不额外加分。
- `unknown`：继续原 hybrid，不因未知扣分，也不宣称满足条件。

`acceptSimilar=true` 只放宽相似产品，不覆盖已被证实的明确冲突。
没有明确强制条件的普通需求沿用现有 hybrid；普通偏好也不触发未知拦截。
对无法可靠识别的任意自由文本，不能声称门禁已保证其约束成立；第一版支持边界必须透明。

## 4. 接入必须保证的行为

- 两方向都投影并传递 Wish description，调用同一门禁。
- 缺向量的 v1 fallback 同样执行已确认的硬性描述约束，避免用降级绕过用户要求；无此约束时保留 v1 公式。
- 不能只给新 match 的 INSERT 加 `qualifies=false`。`persist()` 当前对已有行覆盖 raw score，客户端依据 score 阈值展示；若已有行仍保留 >=70，就会残留旧有效匹配。
- 拦截必须体现在最终可见分数/存储中，并覆盖 Top-K ∪ existing rows；内部保留原始 hybrid 分与拦截原因供解释。
- 不改变“首次有效匹配只发一次通知”；被拦截的 pair 不能发新 MATCH 通知。
- 需要给策略版本及内部解释的记录位置做最小明确决定，不能让调试层把门禁后的分数误认成四项加权原始和。
- 不为本地原文检查另开新的 embedding job，也不引入数据库网络调用或锁内 provider。

## 5. 验证要求

- H16/H17/H21 从本轮失败验证集降格为回归样本，H07 保留真实漏匹配，不再用 H01–H24 宣称独立质量通过。
- 用边界语言样本证明不是按商品名打补丁：明确满足/明确冲突/未知、否定作用范围、偏好与强制的区别，以及别名无法识别时的透明行为。
- 真库覆盖两个方向、新匹配阻止通知、编辑后降级已有高分、向量 fallback 仍受约束。
- 另建未测量的 24 条独立输入，Owner 先确认标签，再 live 测量；门禁保持 >=22/24、FP<=1、优于同组 v1、硬规则零违反。
- 若出现新漏匹配，保留样本并报告，不借“unknown”把错误移出分母。
- 类型/lint/全量/运行时验证全通过后 fresh 子代理审查完整 PR 范围；最终审查未得结论前不宣称 Issue 完成。

## 6. 实现与验证

实现：`apps/worker/src/jobs/matching/constraints.ts`，`CONSTRAINT_POLICY_VERSION = 1`。
两方向都传入 wish description；scoreConstrainedMatch 保留 rawScore、constraint 状态和有限原因码，冲突时最终 score 为 0。
四项 breakdown 仍表示门禁前分项，不能把最终 0 分误读为加权和；原始分可通过内部纯函数重建。
Worker 的 MatchRunResult 增可选 constraints 聚合（policyVersion/rejected/unknown），不记录原文、约束对象或向量。
没有改变 scoreMatch 的 v1/v2 权重公式、文本格式、客户端契约或 schema。

语言支持边界：完整分句以“(我)不要 / 不接受 / 只要 / 必须支持”开头，单个未引用字面对象（去除末尾口语“的”）。
“不要求 / 不介意 / 不需要 / 不用 / 不一定 / 不要紧”不作为排除。
复合/备选/双重否定对象不解释；没有内置商品/品牌词表，也没有 iPad 与苹果平板之类别名映射。
标题与描述使用同一闭合声明语法：完整的简单正向/否定句、裸字面对象，以及“X功能正常 / X可用”等有限完整后置肯定句。
不再将任意标题子串当命名声明；“二手金属支架 / 教材第二册 / 微软有线鼠标”等未解析复合命名保留unknown。
这会使原有仅靠复合标题拦截的输入退化为原hybrid，不能把这项安全退化称为相关属性不存在，也不据此改独立组标签。
普通描述仅提到X不算已拥有X；对象后无问号的“吗/么/呢/吧”等疑问或推测助词同样保留unknown。
简单肯定/否定谓词必须覆盖完整分句：通用可选主体+谓词+完整字面对象，不能有未解释的对象后缀。
因此“不支持X的话可以退货 / 不支持X以外的方式 / 支持X或其他方式”等保留unknown，不通过追加条件词黑名单猜作用范围。
反面证据限定为直接陈述（可带“设备/本品”等通用主体），不能从疑问或复杂前缀截取“不是”后缀；引文、疑问、不确定表达、未支持的后置否定、无需/未必等含糊作用域或正反声明并存保留unknown。
该字面策略不是属性真值提取器，也不代表保证实物满足所有自然语言要求，实际泛化质量必须由新验证集评估。

两条新增 engine 真库回归在未修复代码上 **0 pass / 2 fail**（constraint-red.log），修复后 matching **80 pass / 0 fail**。
覆盖新匹配/通知拦截、愿望编辑后既有高分降级、两方向、vector 与 v1 fallback，以及 unknown 放行。
新纯函数测试覆盖极性、偏好、取消条件、引文、双重否定、英文词边界及无别名推断。

`bun run embed:holdout --reuse-baseline`：复制原真实向量到新本地 scratch 重新跑引擎，**22/24**（v1 scoring +同一门禁为15/24），FP=H17、FN=H07；0 次 HTTP 请求。
这些 H01–H24 已是回归集，结果标注 independentValidation=false，**不能作为新独立验证通过**。
保留 baseline 原始结果 20/24；回归结果在 `.m4-evidence/holdout-regression.json`。

静态/工程验证：脚本单独 strict typecheck、全仓 typecheck/lint exit 0；隔离 scratch 库 `bun test --isolate` **3290 pass / 0 fail（315 文件）**；
`bun run core:smoke` 的真实 API/Worker/DB 链 **266 断言通过**，embedding/visual transport 为 stub（没有新增 live 请求）。
全量测试不操作生产库或共享开发库业务行；这些检查仍不能替代新独立 live 质量门禁。
N01–N24在Owner确认后冻结并测得旧实现hybrid23/24、v1 18/24，FP=N24、FN=0；完整结果不删改。
第五轮fresh审查仍为BLOCK，标题捷径误杀已加红→绿回归并移除特权；N结果不作为修复版本的独立门禁证明。
修复后约束/引擎定向38/38、脚本strict/全仓类型/lint通过、全量3306/3306（317文件，为**当时**计数；其后加入O组转写测试即3310/318）、stub core smoke 266断言通过。
严格脚本检查的完整命令及exit_code=0记录在`.m4-evidence/review-5-script-typecheck.log`，不是以空日志当执行证据。

本轮（fresh对抗审查）结论：**BLOCK**，可执行发现全部处置；因实现随即被改动，最终fresh复审与新独立live质量门禁仍未通过，**不报告就绪**。
- BLOCKER（O16标签）：冻结实现的完整分句口径下"不要有线的"是unknown，而O16结构分项kw/cat/price全100 = 0.32+0.15+0.23 = 70 = `MATCH_SCORE_THRESHOLD` ⇒ 任何语义分都过线，属**确定性错配**；我独立复算24条的结构下限（semantic=0）确认O16是唯一结构性错配（v1 100 / 结构下限70）。Owner裁决把O16标签改为"是（unknown放行）"（与O07同口径），O组口径改为13是/11否，输入与算法未动。
- MAJOR（SQLSTATE丢失）：真实Bun驱动错误把SQLSTATE放`errno`（`code='ERR_POSTGRES_SERVER_ERROR'`），原实现只读`code` ⇒ 生产日志只留`database query failed`，而`log.test.ts`用虚构形状`{code:'23514'}`所以测试是绿的。已修：`errno`优先、兼容pg风格`code`（分支上已提交的`queue.test.ts:206`要求），并排除带数字`errno`/`syscall`/`path`的Node系统错误；测试改用真实形状并新增pg风格与EPERM两条。
- MAJOR（transactions时钟残留+状态漂移新鲜度缺口）：`apps/api/src/modules/transactions/store.ts`的accept/cancel/confirm完成/核销完成四条路径仍写`now()`且不投job；因`freshListingsEmbedding()`（`packages/db/src/embedding-store.ts:256`）按毫秒等值判新鲜、`engine.ts:415`只按内容指纹判目标向量过期，商品被接受/取消/售出后会永久掉出语义候选并退回v1。已修：改`clock_timestamp()`并同事务补投`EMBED_LISTING`（handler走`unchanged`+`refreshEmbeddingSourceVersion()`，不调provider、不重复计费；状态不是匹配输入所以不连投`MATCH_LISTING`）。新回归`apps/api/src/modules/transactions/store.test.ts`修复前2 fail / 修复后2 pass。
- MINOR（已修）：`log.ts`原实现对裸驱动错误fail-open，会把绑定参数值写进`job.last_error`（实测`invalid input syntax for type integer: "PRIVATE_WISH_TEXT"`）；现默认拒绝，只回`database query failed (SQLSTATE XXXXX)`。
- 未修并如实披露：`.m4-evidence/holdout-independent-freeze.json`冻的是旧实现哈希（`2525d827…`≠当前`constraints.ts`的`606aec56…`），且`.m4-evidence/`被`.gitignore:28`忽略，故N组23/24无法从干净checkout复现（日志/结果只在本机）；O组改用独立证据文件`holdout-independent-o-freeze.json`冻结当前实现。
本轮修复后复跑（**当时**计数；其后第二轮修复与新增回归后为 3318/319，见下）：`bun test --isolate` **3312 pass / 0 fail / 318文件**、`bun run typecheck` 9包exit 0、`bun run lint` Checked 1055 files / 4 warnings（来自main既有文件）/ exit 0、`EMBEDDING_TRANSPORT=stub bun run core:smoke` 266断言通过；全程0次live请求（HTTP预算仍为10/200）。
新独立组[O01–O24](issue-322-matching-v2-holdout-3.md)已按Owner裁决纠正O16标签，仍未测量。
尚未提交/推送本轮改动。

第二轮（fresh对抗审查）结论：**BLOCK**，可执行发现F1–F6全部处置；实现再次改变，最终fresh复审与O组live门禁仍未通过，**不报告就绪**。
- F1 MAJOR（日志脱敏漏点）：`apps/worker/src/index.ts`视觉维护catch用`error.message`，而该catch内的`visualBackfill.runPass()`/`cleanupExpiredVisualQueryImages()`都查DB ⇒ drizzle的SQL文本与绑定参数原样进stderr。因该文件顶层有副作用无法被测试import，已抽出`apps/worker/src/jobs/visual-embedding/maintenance.ts`的`createVisualMaintenance()`并改`errorMessage()`；新回归`maintenance.test.ts`失败前2 fail / 修复后4 pass。
- F2 MEDIUM（愿望侧状态漂移）：`wishes/store.ts:217`的`updateStatusIfActive`取`clock_timestamp()`却不投job（实测`similarWishesByIds`1→0条、行仍在）⇒需求2不变式不成立。已在`service.ts`的`transition()`成功分支与“已是目标态”分支补投`enqueue(id)`；新回归失败前1 fail / 修复后9 pass。诚实边界：读接口都过滤`status='ACTIVE'`，终态愿望本就不再被匹配，故不是用户可见回归而是不变式缺口。
- F3 MEDIUM（口径分歧）：Owner裁决维持O16“是（unknown放行）”并显式披露——新增`INDEPENDENT_HOLDOUT_O_KNOWN_DIVERGENCES=['O16']`，经`summary.knownDivergenceIds`进日志与result JSON，holdout-3验收口径写明；FP≤1成立但不得汇报为“0条假阳性”。
- F5 LOW（口径表述）：审查称v1基线不含门禁，经核代码不成立（v1与hybrid都走`scoreConstrainedMatch`，门禁两侧生效，判定严格大于；仅诊断字段`v1Score`不含门禁），holdout-3已补写。
- F4/F6 LOW（证据）：本轮起证据命令固定`EMBEDDING_TRANSPORT=stub`并把命令头写进日志；`embed-holdout.ts`改为任何运行都计算并写出6个算法文件的`algorithmHashes`。
- 范围外只报告未修：`apps/api/src/app.ts:110-125`的`describeError`（取`error.message`首行，由`:678`输出drizzle的`Failed query: <SQL>`）、`apps/api/src/modules/recommendation/service.ts:131,:383`（`console.error(..., error)`打整个对象）；两文件本PR未触碰，按AGENTS.md不在本Issue顺手改，是否开Issue待Owner决定。
本轮修复后复跑（`EMBEDDING_TRANSPORT=stub`）：`bun test --isolate` **3318 pass / 0 fail / 11553 expect / 319文件**（199.64s）、`bun run typecheck` 9包exit 0、`bun run lint` Checked 1057 files / 4 warnings（main既有）/ exit 0、`bun run core:smoke` 266断言通过（47532ms）；全程0次live请求（预算仍10/200）。日志`.m4-evidence/verify-m4-final4-full.log`。
O01–O24仍未测量；尚未提交/推送本轮改动。

第三轮（增量fresh对抗审查，范围=本轮delta的9个文件）结论：**BLOCK**，唯一可执行发现已修，另有2条文档/口径缺口与2条INFO级注释口径已处置。
- F1（需求2不变式，LOW–MEDIUM）：`apps/api/src/modules/wishes/service.ts`并发竞态分支`if (rowStatus(concurrent) === target) return toWishDto(concurrent)`是一次**成功返回**（客户端不重试）却不补投；赢家的`enqueue`若失败/崩溃，该愿望向量行的`source_updated_at`永久停在旧版本（`freshWishesEmbedding()`毫秒等值）。已在该分支return前加`await refreshVectorAfterTransition(id)`；新回归`service.test.ts`的`并发竞态输家返回目标态时同样补投……`（`RacingWishStore`让`updateStatusIfActive`返回null模拟另一连接先提交），失败前**9 pass / 1 fail**、修复后三文件**16 pass / 0 fail / 44 expect**（md5核对还原一致）。
- F5（INFO，注释口径）：原注释称终态愿望"永久掉出语义候选"高估影响；已改为"向量行确实掉出`similarWishesByIds`（`engine.ts:568`），但终态愿望本就被`creatable()`（`engine.ts:584-596`）排除 ⇒ 是不变式与`obs:summary`新鲜度可观测性的缺口，不是用户可见召回回归"。
- F2（LOW，验收口径透明）：脚本`passed`（`embed-holdout.ts:408-417`，退出码同源）除四条已批准口径外还要求`summary.allVectorRecall`、`summary.hardRuleProbeControlValid`、`summary.hardRuleProbeViolations===0`，而文档此前对这些字段零命中。holdout-3验收口径已逐项补写（并区分`hardRuleProbeViolations`与`hardRuleViolationIds`），声明以该节为口径基准。
- F2后半（冻结覆盖面）：`embed-holdout.ts`的`algorithmFiles`由6个扩到9个，加入`apps/worker/src/jobs/embedding/handlers.ts`、`apps/api/src/modules/wishes/match-queue.ts`、`packages/db/src/schema/common.ts`，使冻结记录能发现后续对M4新鲜度修复的改动。
- F3（LOW，证据可复现）：holdout-3的执行命令改为`EMBEDDING_TRANSPORT=live EMBEDDING_MODEL=text-embedding-v4 bun run embed:holdout --independent-o`，并说明`.env`被gitignore、`.env.example`是stub，不写前缀在干净checkout下会在`embed-holdout.ts:121-123`中止。
- F4（INFO，只报告）：`apps/api/src/modules/wishes/store.ts:142`的createWish INSERT仍用`now()`（新行无版本倒退、等价`defaultNow()`、EMBED_WISH同事务）⇒无新鲜度回归；同类非向量写入点`messages/store.ts:434,:478`、`messages/media-store.ts:241`、`core-smoke.ts:1422`。本PR未触碰，按AGENTS.md不顺手改。
- 审查者独立认可：需求1脱敏修复承重且red-before-fix（回退后2 fail，泄漏含`Failed query: select $1::int`与`params: PRIVATE_WISH_TEXT`）；需求4只有`contradicted`归零且唯一入口`engine.ts:449`/`:725`；需求2商品侧`listings/store.ts:816`同事务；O组fixture与文档逐字段一致且`holdout-independent-o-{freeze,result}.json`不存在（标签未因测量改动）。
- 窄口径验证（子代理`00af54f7`，只审本轮4个文件）结论**无blocker**：`transition()`恰有3个成功`return`（`service.ts:127`/`:136`/`:147`）各自紧邻补投、无漏投路径；重复投递被内容指纹prune + `ON CONFLICT DO NOTHING`吸收；新测试去掉那一行即变红；freeze校验在`CREATE DATABASE`(`:206`)与首次`provider.embed()`(`:299`)之前。它提出的3条已处置：①holdout-3验收口径原写"四条+三项=**7项**"与脚本`passed`（`embed-holdout.ts:408-417`，**9个`&&`条件**）不符 ⇒ 已逐条列出9项并修正指代；②过期行号`403-412`⇒`408-417`（三处）；③`algorithmFiles`非严格超集 ⇒ 补入`apps/worker/src/jobs/embedding/providers/index.ts`、`providers/live.ts`、`packages/db/src/schema/embeddings.ts`，由9个扩到**12个**。
本轮修复后复跑（`EMBEDDING_TRANSPORT=stub`，所有写者退出后的最终一次，`date: 2026-10-03T15:21:03+08:00`）：`bun test --isolate` **3319 pass / 0 fail / 11555 expect / 319文件**（185.90s，exit 0）、`bun run typecheck` 9包exit 0、`bun run core:smoke` 266断言通过（31967ms，exit 0）、`bun run lint` **Checked 1057 files / 4 warnings（main既有）/ exit 0**（首次运行曾因并行审查子代理留在仓库内的临时探针目录`apps/worker/.verify-scratch-red/`报2个format error，非本改动，清理后复跑）；全程0次live请求（预算仍10/200）。日志`.m4-evidence/verify-m4-final6-full.log`。
O组（O01–O24）live质量门禁已于2026-10-03测量：命令`EMBEDDING_TRANSPORT=live EMBEDDING_MODEL=text-embedding-v4 bun run embed:holdout --independent-o`，**passed=true**（exit 0），5次HTTP、累计**15/200**；hybrid**23/24**、同组v1**18/24**、FP=**1**（O24，cos 0.7007→总分85，constraint=unknown，真实错配）、FN=0、两方向不一致0、硬规则违反0、`hardRuleProbeViolations=0`、`hardRuleProbeControlValid=true`、`allVectorRecall=true`、`knownDivergenceIds=["O16"]`（按标签计入23/24；按严格读法为**22/24**，两个口径必须一起汇报）。语义召回的边际来自O03/O04/O05/O06/O08/O11（v1裸结构分65<70，hybrid靠语义分达76–85）。冻结`.m4-evidence/holdout-independent-o-freeze.json`（`inputHash 7b927f05…8db8f1f` + 12个算法哈希，建库/出网之前写入）与结果`holdout-independent-o-result.json`的`inputHash`/`algorithmHashes`逐字段一致；进程输出`holdout-o-live.log`；通过后scratch库已DROP。测量后未再改标签/样本/参数。尚未提交/推送本轮改动。

由 AI agent 协助评估和实现，Owner 已确认最终冲突/未知口径。
