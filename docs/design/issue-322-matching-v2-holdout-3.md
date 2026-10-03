# #322 M4：新独立组 O01–O24（Owner已批准，冻结后测量）

状态：Owner已按草案照准本组输入与12是/12否标签（2026-10-03），标签与输入不得再改 —— 唯一例外是下面这条
经Owner二次裁决的O16标签纠正（同日，测量前）。
标签纠正（2026-10-03，Owner裁决）：本轮 fresh 对抗审查把 O16 判为 BLOCKER —— 冻结实现的完整分句
口径把“不要有线的”判成 unknown（`constraints.ts` 只在 `before === ''` 时把裸字面量当肯定证据；
`constraints.test.ts` 钉住 `['微软有线鼠标','鼠标','有线'] → unknown`），而该条结构分项
（关键词/分类/价格全 100 = 0.32+0.15+0.23 = 70 = `MATCH_SCORE_THRESHOLD`）必然过线，所以
原“否”标签是确定性错配。O16 标签改为“是（unknown 放行）”，与 O07 同口径；其余 23 条输入与
标签未动，纠正后的口径为 13 是 / 11 否。这是**测量前**按实现语义纠正标签，不是据测量结果改标签。
表格已逐字段转写为 `apps/worker/src/jobs/matching/independent-holdout-o-fixture.ts`，并由
`independent-holdout-o-fixture.test.ts` 与本文件表格做等值断言；转写不一致即测试失败。
N组旧冻结实现23/24已留存；第四轮审查后算法发生修复，不能将旧N结果用于当前版本验收。
先完成完整分句修复与fresh审查，冻结最终实现后再测量；测量前本组全部输入未调用provider、
未计算cosine、未运行打分。
累计HTTP预算当前10/200，不因更换样本组重置；只使用人工文本与本地隔离库。
执行命令：`EMBEDDING_TRANSPORT=live EMBEDDING_MODEL=text-embedding-v4 bun run embed:holdout --independent-o`
（真实 `text-embedding-v4` / 1536 维，24 条文本 = **5 次 HTTP**，计入累计预算；禁止与 `--reuse-baseline` / `--independent` 同用）。
传输方式必须显式写进命令：默认值来自 gitignored 的 `.env`（`.env.example` 是 `stub`），不写前缀在干净
checkout 下会在 `embed-holdout.ts:121-123` 直接中止（脚本自身也拒绝非 live，所以产出的证据一定是 live）。
脚本在出网前把
算法文件哈希、`inputHash`、样本与模型维度冻进 `.m4-evidence/holdout-independent-o-freeze.json`，
结果写 `.m4-evidence/holdout-independent-o-result.json`（与 N 组的证据文件互不覆盖）。

## 验收口径

- 全部24条保留：hybrid至少22/24，FP最多1，hybrid一致度**严格大于**同组v1一致度，两方向一致，硬规则零违反。
  “同组v1”是**同口径**对照：同一次运行里、写向量**之前**对同一批实体跑的真实 v1 fallback
  （`engine.matchWish` 落库结果按阈值判定），它与 hybrid 共用同一个打分入口 `scoreConstrainedMatch`
  （`apps/worker/src/jobs/matching/engine.ts:449` 商品方向、`:725` 愿望方向；拿不到 cosine 时
  `similarity` 传 null 走 v1 分支）⇒ 约束门禁在两侧都生效。差别只在语义召回与 v2 权重。
  判定条件是严格大于（`apps/worker/scripts/embed-holdout.ts` 的 `summary.hybridAgreements > summary.v1Agreements`）；
  结果 JSON 里的 `v1Score` 字段是不含门禁的裸结构分（`scoreMatch(..., null)`），只作诊断记录，不参与判定。
- 明确冲突才拦截；unknown沿用hybrid且不宣称满足；偏好不硬过滤。
- 不据本组结果修算法、改标签、删行或扩展词表。若再次改变算法，另建独立组。
- 除表格注明外，商品ACTIVE/APPROVED，愿望ACTIVE，不同用户；“不限”=category null，“—”=空描述。
- 金额单位元，转为整数分；价格硬边界为price<=2×budget。
- O07与O16按未知放行口径标“是”；O23为DB引擎零预算边界，不声称API接受零预算创建。
- O24兼容性不匹配必须计入错误，不因别名未解释而豁免。不预设算法结果。
- **O16 是 Owner 裁决显式披露的已知口径分歧**（2026-10-03）：它按“unknown 放行”标“是”（与 O07 同口径），
  但严格读法下是**确定性错配** —— 完整分句口径把“不要有线的”判成 unknown，而该条结构分项
  0.32+0.15+0.23 = 70 = `MATCH_SCORE_THRESHOLD`，任何语义分都会过线。因为它按标签判定，
  `falsePositiveIds`（`hybridMatch && !expected`）**不会**把它计进去，所以单列在证据 JSON 的
  `summary.knownDivergenceIds`（来自 `INDEPENDENT_HOLDOUT_O_KNOWN_DIVERGENCES`）里，避免这个已知错配
  在唯一剩下的独立 live 门禁里不可见；本组验收（hybrid≥22/24、FP≤1、严格大于同组 v1、硬规则零违反）
  不变，但**不得**把这个已知错配当作 0 条假阳性来汇报。
- 脚本退出码（`embed-holdout.ts:408-417` 的 `passed`）是 **9 个 `&&` 条件**的合取，任何一项不满足即为**门禁未通过**。
  第 1–6 项来自上面第一条验收口径，第 7–9 项来自下面三项：
  1. `summary.samples === 24`（"全部24条保留"）；
  2. `summary.hybridAgreements >= 22`；
  3. `summary.falsePositiveIds.length <= 1`；
  4. `summary.hybridAgreements > summary.v1Agreements`（严格大于同组 v1）；
  5. `summary.hardRuleViolationIds.length === 0`（本组样本的分类/预算负例零违反）；
  6. `summary.directionMismatchIds.length === 0`（两方向一致）；
  7. `summary.hardRuleProbeControlValid`：硬规则探针的对照 pair 必须既是有效词法匹配、hybrid 也命中
     （对照失效时探针结果无意义）；
  8. `summary.hardRuleProbeViolations === 0`：硬规则探针零违反（与第 5 项的 `hardRuleViolationIds`
     是不同字段：这一项是探针施加状态/归属/审核变更后的结果）；
  9. `summary.allVectorRecall`：24 条的两个方向都必须走 `vector-topk` 召回（任一条落回 v1 fallback 即失败）。
  结果 JSON 的 `passed` 与进程退出码都按这 9 项计算，文档口径与脚本判定以本节为准。

## 输入与建议标签

| ID | 愿望 keyword / description | 愿望分类 / 预算 / acceptSimilar | 商品 title / description | 商品分类 / 价格 | 建议匹配 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| O01 | 电饭煲 / — | DAILY / 150 / false | 迷你电饭煲 / 容量1.2升，煮饭和保温功能正常，内胆已洗净。 | DAILY / 100 | 是 | 完整词法命中。 |
| O02 | 离散数学 / — | BOOKS / 50 / false | 离散数学教材 / 含集合、图论与逻辑习题，有少量笔记。 | BOOKS / 25 | 是 | 完整词法命中。 |
| O03 | 智能运动腕表 / — | DIGITAL / 600 / true | Garmin Forerunner 55 / 佩戴在手腕上，记录跑步、步数和心率，GPS定位正常。 | DIGITAL / 450 | 是 | 型号与运动腕表需求对应。 |
| O04 | 便携外置固态盘 / — | DIGITAL / 300 / true | Kingston XS1000 移动SSD / USB接口连接电脑，存储容量1TB，适合随身备份文件。 | DIGITAL / 200 | 是 | 同义产品与用途。 |
| O05 | 头戴式降噪耳机 / — | DIGITAL / 500 / true | Sony WH-CH720N / 罩耳式蓝牙设备，主动降噪可开启，适合通勤听音乐。 | DIGITAL / 350 | 是 | 品牌型号与功能对应。 |
| O06 | 帐篷 / — | SPORTS / 180 / true | Naturehike 双人野营小屋 / 户外露营使用，附撑杆与地钉，两人可以在里面睡卧。 | SPORTS / 120 | 是 | 同用途同义产品。 |
| O07 | 电动牙刷 / 不要声波的 | DIGITAL / 100 / true | 电动牙刷 / 包装上有“声波”标记，驱动原理尚未核实，刷头可以更换。 | DIGITAL / 60 | 是 | 引文与未知不是确认属性；词法命中。 |
| O08 | 数据库课程参考书 / 希望包含关系模型和SQL查询练习，附解析更好。 | BOOKS / 60 / true | 数据库原理练习册 / 包含关系模型、SQL查询习题及解析，有少量铅笔笔记。 | BOOKS / 30 | 是 | 描述参与语义，偏好不硬过滤。 |
| O09 | 手电筒 / — | DIGITAL / 60 / false | 宿舍闲置照明 / 手电筒，三档亮度，充电和开关正常。 | DIGITAL / 30 | 是 | 商品描述精确命中。 |
| O10 | 马克杯 / 塑料最好，不介意陶瓷，不要求带盖。 | DAILY / 50 / false | 陶瓷马克杯 / 可装热饮，杯口完整，已经洗净。 | DAILY / 20 | 是 | 偏好/不介意/不要求不构成排除。 |
| O11 | 便携烧水壶 / — | DAILY / 100 / true | 摩飞600ml旅行电热杯 / 插电加热清水，烧开后可以倒出饮用，适合旅行携带。 | DAILY / 70 | 是 | 接受相同烧水用途的便携产品。 |
| O12 | 显示转接器 / 必须支持VGA输出 | DIGITAL / 100 / false | USB显示转接器 / 支持VGA输出，附连接线，使用正常。 | DIGITAL / 60 | 是 | 词法命中且简单陈述证实必需条件。 |
| O13 | 便携烧水壶 / — | DAILY / 100 / false | 摩飞600ml旅行电热杯 / 插电加热清水，烧开后可以倒出饮用，适合旅行携带。 | DAILY / 70 | 否 | 与O11仅开关不同；严格模式无完整关键词。 |
| O14 | 电饭煲 / — | SPORTS / 150 / true | 迷你电饭煲 / 容量1.2升，煮饭和保温功能正常，内胆已洗净。 | DAILY / 100 | 否 | 分类硬过滤。 |
| O15 | 离散数学 / — | BOOKS / 50 / true | 离散数学教材 / 含集合、图论与逻辑习题，有少量笔记。 | BOOKS / 101 | 否 | 超过2倍预算硬边界。 |
| O16 | 录音笔 / 不要有线的 | DIGITAL / 120 / true | 有线录音笔 / 通过线缆连接电脑传输录音，麦克风收音正常。 | DIGITAL / 60 | 是 | 完整分句口径下“不要有线的”是unknown（不构成完整分句否定）→ 按未知放行；词法命中。 |
| O17 | 耳机 / 必须支持主动降噪 | DIGITAL / 200 / true | 蓝牙耳机 / 不支持主动降噪，配备通话麦克风，播放正常。 | DIGITAL / 100 | 否 | 简单直接否定必需功能。 |
| O18 | 工程数学教材 / 只要第三版，不接受第五版 | BOOKS / 50 / true | 工程数学教材第五版 / 第五版，非第三版，书页完整。 | BOOKS / 25 | 否 | 指定版次冲突。 |
| O19 | 相机三脚架 / — | DIGITAL / 150 / true | USB充电头 / 可给手机补充电量，插脚与接口完好。 | DIGITAL / 20 | 否 | 同分类无关商品。 |
| O20 | 运动护腕 / — | 不限 / 80 / true | 厨房抹布 / 五条装，可擦洗餐桌和灶台，未使用。 | DAILY / 10 | 否 | 不限分类仍需产品相关。 |
| O21 | 彩色喷墨打印机 / — | DIGITAL / 300 / false | Canon PIXMA MG3680 / 彩色无线喷印，适合打印照片和家庭作业。 | DIGITAL / 200 | 否 | 严格模式没有完整关键词支撑。 |
| O22 | 无线网卡 / 必须支持5GHz | DIGITAL / 80 / true | USB无线网卡 / 不支持5GHz，仅使用2.4GHz频段，连接正常。 | DIGITAL / 40 | 否 | 高词法分不能绕过直接否定。 |
| O23 | 学习资料 / — | BOOKS / 0 / true | 课程讲义 / 含课堂重点与课后习题，书页完整。 | BOOKS / 0.01 | 否 | DB引擎零预算边界。 |
| O24 | 安卓平板手写笔 / 必须支持华为平板 | DIGITAL / 400 / true | Apple Pencil 第二代 / 仅用于指定苹果iPad，不支持安卓平板，笔尖完好。 | DIGITAL / 250 | 否 | 不兼容需求设备；未解释别名不能豁免错误。 |

建议标签13是/11否（O16已按Owner裁决从“否”纠正为“是”）。Owner可逐项纠正，批准前不得测量；算法结果未知。

## 测量结果（2026-10-03，Owner批准后首次也是唯一一次运行）

命令（传输方式显式固定，理由见上文）：`EMBEDDING_TRANSPORT=live EMBEDDING_MODEL=text-embedding-v4 bun run embed:holdout --independent-o`

- 模型/维度：`text-embedding-v4` / 1536；HTTP **5 次**（48 条文本 ÷ 10 条/批），累计 **15/200**；进程输出留档 `.m4-evidence/holdout-o-live.log`。
- 冻结：`.m4-evidence/holdout-independent-o-freeze.json` —— 在**任何建库与出网之前**写入，含 24 条样本、
  `inputHash 7b927f0517df576041d2f5d964d4827a526eac2002c2feedf464ccafd8db8f1f` 与 12 个算法文件哈希。
- 结果：`.m4-evidence/holdout-independent-o-result.json`（`inputHash` 与 `algorithmHashes` 与 freeze **逐字段相同**）；
  通过后 scratch 库 `fish322_holdout_1791012360760_1324` 已 DROP（既有 N 组留存库 `fish322_holdout_1790935893294_2188` 未动）。
- 门禁：`passed = true`，进程 exit 0。

| 指标 | 实测 | 阈值 | 结论 |
| --- | --- | --- | --- |
| hybrid 一致 | **23/24** | ≥22 | 通过 |
| 同组 v1 一致 | 18/24 | 严格小于 hybrid | 通过（23 > 18） |
| FP | **1**（O24） | ≤1 | 通过 |
| FN | 0 | — | 通过 |
| 两方向不一致 | 0 | 0 | 通过 |
| 硬规则违反（`hardRuleViolationIds`） | 0 | 0 | 通过 |
| 硬规则探针 | `hardRuleProbeViolations=0`、`hardRuleProbeControlValid=true` | 0 / true | 通过 |
| 向量召回 | `allVectorRecall=true`（24 条两方向都走 `vector-topk`） | true | 通过 |
| 已知口径分歧（不计入 FP） | `knownDivergenceIds=["O16"]` | 显式披露 | 已披露 |

逐条事实（除 `summary` 外可直接从结果 JSON 的 `results` 核对）：

- **语义召回的边际来自 O03/O04/O05/O06/O08/O11**：这 6 条关键词分 0、v1 裸结构分 65（< 70）因此 v1 漏判，
  hybrid 靠语义分（cos 0.616–0.729 → 语义分 70–100）达到总分 76–85 而判为匹配 —— 正是 v2 要拿下的
  “描述不同但语义相同”的那类对子。
- **O24 是真实假阳性**：cos 0.7007 → 语义分 100、总分 85；愿望“必须支持华为平板”被落成 `unknown`
  （约束门禁未识别该需求谓词），而结构分项本身已达 70，因此过线。这与审查阶段的预测一致
  （O24 需要 cos ≳ 0.56 才会过线，实测 0.70）。按本组口径 FP = 1 仍在上限内，但**它是真实错配，必须计入**。
- **O16 是已披露的已知口径分歧**（不是新发现）：完整分句口径下“不要有线的”是 `unknown` ⇒ 按未知放行、
  词法命中，cos 0.7563、总分 100。按标签它计入 hybrid 一致，按严格读法它是错配，故单列 `knownDivergenceIds`。
- **两个口径的诚实账**：按标签口径 = **23/24** 一致（13 条“是”全中；11 条“否”中 10 条正确拒绝 + O24 一个 FP）；
  若把 O16 按严格读法也算作错配 = **22/24**。汇报 `passed=true` 时必须同时给出这两个数，
  **不得**只报 23/24 或声称“FP=1 且无已知分歧”。
- 正确拒绝的样本：O13/O21 语义分 0（总分 55 < 70）、O19（cos 0.493）/O20（cos 0.433）/O23（cos 0.570）
  都落在阈值下；O14（分类不符）/O15（超 2 倍预算）/O23（零预算）在结构层 `eligible=false` 不参与匹配；
  O17/O18/O22 命中 `contradicted`（`required_literal_denied`）被门禁归零。
- `semanticOnlyAgreements=18`、`v1Agreements=18` 是诊断字段，判定只用 `hybridAgreements > v1Agreements`。

结论：**本组门禁通过（`passed=true`）**；标签与输入未因结果改动（冻结在任何测量之前写入，且 freeze 与 result
的 `inputHash`/`algorithmHashes` 一致）。O16 的已知分歧与 O24 的真实假阳性都如实入账。
