# apps/miniapp 视觉与工程约定（Design Contract）

> 适用对象：`apps/miniapp` 的所有页面与组件实现（人 + AI agent）。
> 本文件是**视觉唯一真源**。改设计先改这里，再改代码。

## 0. 这一版在做什么

把 5 张「冰蓝荧光」设计稿（首页 / 商品详情 / 搜索 / 许愿墙 / 消息）实现成 Taro 小程序页面，
移植到 Taro 4 + React 18 + SCSS。设计稿是原生小程序风格（HTML 盒模型 + CSS 变量）。

数据来源分两类：

- **已接真实 API**：首页（含分类筛选）/ 搜索 / 商品详情 / 我的（只读），消息页的**通知列表 +
  逐条已读回写**（`GET /notifications`、`POST /notifications/:id/read`），
  **我买到的 / 我卖出的**（订单页按视角拆成 `pages/orders-buy` 与 `pages/orders-sell`，
  数据来自 `GET /transactions`）。
  统一走 `src/features/fetchers.ts`（先请求后端，失败或未登录退回 mock），
  由 `src/features/listing/adapt.ts`（商品域）与 `src/features/transaction/adapt.ts`（订单）
  把契约类型投影成页面在用的视图类型。
- **仍是本地 mock**：其余页面（许愿墙、消息页的**会话列表**、会话详情、发布、面交、
  认证、设置等）。它们的写操作与状态机尚未接入，见 `fetchers.ts` 的边界说明。
  （面交页 `/pages/transaction-meetup` 走真实接口，但它是**读写**页面，不在上面的只读清单里。）

## 1. px → rpx：本目录唯一需要记住的换算

Taro 配置 `designWidth: 750` 且 `deviceRatio[750] = 1`，因此 **SCSS 里的 px 就是 rpx**
（Taro 的 pxtransform 会把 `Npx` 写成 `Nrpx`）。

设计稿画在 **390pt 宽**的画布上（iPhone 14/15 逻辑像素）。所以：

```text
设计稿 12px  →  SCSS 写 24px  →  编译成 24rpx
设计稿 23px  →  SCSS 写 46px  →  编译成 46rpx
设计稿 1px   →  SCSS 写 2px   →  编译成 2rpx
```

**换算公式：SCSS 数值 = 设计稿数值 × 2。**

- 只有一个例外：真·物理 1px 描边（需求上极少数）要写 `1PX`（大写），Taro 不会转换。
- 不要用 `rem` / `vw` / `%` 做主体尺寸，保持 rpx 一致的比例缩放。

## 2. 颜色令牌：只能用这些（不要写 `color-mix()`）

小程序 WXSS 不支持 `color-mix()`。设计稿里所有派生色已在 `src/styles/_tokens.scss`
里**预计算成 hex**。请只引用令牌，不要自己调色或内联新色值。

| 令牌                               | 值                                                                     | 用途                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--brand`                          | `#4285FF`                                                              | 主色（强调、选中态、链接）                                                                               |
| `--electric` / `--cyan` / `--mint` | `#19A7FF` / `#19E6FF` / `#54F5D0`                                      | 品牌渐变的三段                                                                                           |
| `--bg`                             | `#F7FAFF`                                                              | 页面底色                                                                                                 |
| `--surface`                        | `#FFFFFF`                                                              | 卡片                                                                                                     |
| `--fg`                             | `#17233D`                                                              | 主文字                                                                                                   |
| `--muted`                          | `#71809C`                                                              | 次要文字                                                                                                 |
| `--muted-2`                        | `#3E4B66`                                                              | 小字（12pt 以下）需要更高对比时用                                                                        |
| `--border`                         | `#DCE7F5`                                                              | 描边/分割线                                                                                              |
| `--line`                           | `#A8C5FA`                                                              | hover/强调描边、认证勾                                                                                   |
| `--accent-weak`                    | `#EFF5FF`                                                              | 浅色底（图标圆盘、标签底）                                                                               |
| `--accent-mid`                     | `#C6DCFF`                                                              | 渐变中段；会话页气泡内摘引块（「双重气泡」内层）的浅色宿主底色                                           |
| `--bubble-mine`                    | `#779FE5`                                                              | 会话页我方气泡平色底（Owner 头像图主蓝，hue 218.2° / 饱和 68%；无渐变；配白字仅 2.67:1，Owner 观感优先） |
| `--quote-bg-mine`                  | `rgba(255,255,255,.32)`                                                | 会话页我方气泡内摘引块底（白色叠加合成 #A3BEED；配白字 1.88:1，块 vs 气泡 1.42:1 + 1px 白描边）          |
| `--lav` / `--lav-weak`             | `#6B4EE6` / `#EBEBFE`                                                  | 许愿页愿望池卡的「求购」徽章（设计稿 `.badge-lav` 的独立紫，与品牌蓝区分）                               |
| `--danger`                         | `#FF5F6D`                                                              | 价格、警示                                                                                               |
| `--warn`                           | `#FFB84D`                                                              | 提醒                                                                                                     |
| `--price`                          | `#4375E8`                                                              | 带品牌感的蓝价（首页卡片）                                                                               |
| `--ink`                            | `#17233D`                                                              | 深色块底（选中胶囊、深卡）                                                                               |
| `--grad-brand`                     | `linear-gradient(135deg,#4285FF 0%,#19A7FF 55%,#19E6FF 100%)`          | 品牌渐变                                                                                                 |
| `--grad-icon`                      | 145° 三色冰蓝渐变                                                      | 分类图标圆盘                                                                                             |
| `--grad-page`                      | `linear-gradient(165deg,#DCEBFF 0%,#EAF4FF 46%,#F7FAFF 100%)`          | 页头背景（下方圆角 32）                                                                                  |
| `--shadow-card`                    | `0 2px 4px rgba(23,35,61,.05), 0 24px 56px -36px rgba(66,133,255,.45)` | 卡片投影                                                                                                 |

## 3. 圆角与阴影

| 用途                     | 圆角（设计稿值） |
| ------------------------ | ---------------- |
| 胶囊 / 按钮 / 标签       | `999`            |
| 商品卡（首页）           | `18`             |
| 商品卡（搜索/详情相似）  | `20`             |
| 大卡（bento / 许愿吊牌） | `20 ~ 24`        |
| 页头背景                 | 底部 `32`        |

## 4. 玻璃材质（谨慎用）

`backdrop-filter` 在 iOS 微信可用、部分 Android 会退化。**规则：**

- 玻璃层必须**同时**给一个不透明兜底背景（如 `rgba(255,255,255,.72)`），
  不要在玻璃上直接压正文小字。
- 只用于：底部悬浮 TabBar、吸顶筛选条、悬浮主按钮、底部操作栏。

## 5. 字体

- 正文：系统字体（不引外部字体，小程序加载字体成本高）。
- 数字/价格：`font-family: ui-monospace, Menlo, Consolas, monospace`（设计稿的 `--font-mono`），
  并配 `font-variant-numeric: tabular-nums` 不生效时靠等宽字体本身对齐。
- 标题字重 `600`，正文 `400`，价格 `700`。

### 5.1 字号阶梯（唯一允许的档位）

**`font-size` 只写 `var(--fs-*)`，不写字面量 px。** 档位值只在
`src/styles/_token-vars.scss` 改，本表与令牌必须一致（`tests/font-size-scale.test.ts` 校验）。

| 档位         | SCSS px | 折合 | 用途                                   |
| ------------ | ------- | ---- | -------------------------------------- |
| `--fs-h1`    | 54      | 27pt | 页面主标题、巨型数字                   |
| `--fs-h2`    | 48      | 24pt | 金额、统计大数字                       |
| `--fs-h3`    | 40      | 20pt | 卡片大标题、大号数字                   |
| `--fs-lg`    | 34      | 17pt | 价格大号、页面级居中标题、自绘导航标题 |
| `--fs-title` | 32      | 16pt | 区块标题、按钮主文案                   |
| `--fs-lead`  | 28      | 14pt | 强调正文、列表主标题                   |
| `--fs-body`  | 26      | 13pt | 正文（`page` 基准字号）                |
| `--fs-sm`    | 24      | 12pt | 次要正文、表单标签                     |
| `--fs-xs`    | 22      | 11pt | 元信息、时间戳、辅助说明               |
| `--fs-2xs`   | 20      | 10pt | 角标、极小辅助                         |

档位取值约定：**全部为偶数 px，也就是整 pt**（17pt 的 `--fs-lg` 对齐系统导航栏档，34 = 17 × 2）。
要加档先改本表与令牌，不要在页面里现写 px；`calc()` / SCSS 变量算出来的字号属于例外，必须登记在守门测试的
`CALCULATED_EXCEPTIONS` 里并写理由（纯 px 字面量不许走这条通道）。

### 5.2 归位现状（#628）

历史上有 313 处 `font-size` 写字面量 px（25 种取值，主峰 26px×60、24px×48、20px×46、22px×45），
与令牌并行成了双轨。守门测试用「字面量债务基线」冻结现状 —— 粒度是**文件 → 取值 → 处数**的多重集，
与实际情况严格相等才算通过：改值（如把 26px 改成 33px）、跨文件挪动、新增都会报红，
归位一处就同步下调一处。归位按页面分批推进，基线清零后测试转为硬约束。当前：**291 处 / 48 个文件**。

比 #628 提交时的 297 处少 6 处，**不是本分支顺带归位了新条目**，而是合并最新 `main` 后 #618 统一默认头像：
`pkg-auth/pages/settings`、`pkg-auth/pages/verify`、`pkg-browse/pages/user`、`pkg-browse/pages/watchers`、
`pkg-browse/pages/listing-detail` 里旧头像结构的首字字号（`*-av-tx`、`detail__cav-text`）随整块删除
（38px×2、62px、40px、24px、22px 共 6 处）。债务只下不增，基线按本树实际统计同步下调。

债务里还留着 17/18/19/25/27/29px 这些**奇数 px**（不是整 pt，例如 `pages/sell/index.scss` 的 27px、
`components/review-dialog/index.scss` 的 17px、`pkg-auth/pages/account-deletion/index.scss` 的 25px×3）。
阶梯全是偶数 px，所以这些处归位时**必然要动像素（允许 ±1px 的视觉微调）**，不算改字号决策；
归位时顺手选最近的档即可，不需要为它们保留奇数档。

另有一处**阶梯外尺寸**：`pkg-social/pages/conversation/index.scss` 会话页「在线态文案」的 16px（8pt），
比阶梯最小的 10pt 还小一档（#602 引入）。它已进基线冻结；要不要专门补一档 8pt 待 Owner 定，
在此之前新代码不要再写 16px 这类阶梯外的值。

档位值重排（`--fs-h2` 42→48、`--fs-h3` 36→40、`--fs-title` 30→32、`--fs-body` 28→26、
`--fs-sm` 25→24、`--fs-xs` 23→22、`--fs-2xs` 21→20，`--fs-h1` 54 不变；新增 `--fs-lg`(34)
与 `--fs-lead`(28)）是 #628 里由 Owner 选定的方案（A = 只修 3 个非整 pt 档 / B = 收敛成偶数档，
选 B），代价是既有 481 处 `var(--fs-*)` 调用点的渲染字号随之变化 ——
**合并前必须按 `docs/miniapp-dev-workflow.md` 在微信开发者工具里逐页演示**。
新档不是空档：`--fs-lg` / `--fs-lead` 服务的 15 处既有字面量（13 处 34px + 2 处 28px）同批归位，
`@include num-badge` 的 3 处字号参数也一并改成令牌（20px→`--fs-2xs`、24px→`--fs-sm`，像素值不变）。
另有一处**可见的 1px 变化**要一起演示：`components/top-bar/index.scss` 的一级标题原写 `35px`（17.5pt），
与同组件居中标题的 `--fs-lg`(34px) 差 1px，本批统一到 `--fs-lg` —— 同页两个标题从差 1px 变成同值。

## 6. 组件与文件组织

```text
src/
  styles/_tokens.scss        # 颜色/阴影/圆角令牌（唯一真源）
  styles/_mixins.scss        # 常用组合（卡片、胶囊、玻璃、截断）
  assets/lib-icons.ts        # 图标唯一出口（ICONS.xxx），由 tools/icons 从 SVG 生成
  assets/brand/              # 品牌成品图出口（BRAND.*），由 tools/brand 从母版生成
  assets/badge/index.ts      # 认证徽章成品图出口（BADGE.*）：外供设计稿成品图，非生成物、无母版
  custom-tab-bar/            # 自定义 TabBar（固定目录名，见第 9 节）
  mock/types.ts              # 与 packages/contracts 对齐的 Mock 类型
  mock/*.ts                  # fixtures：listings / users / wishes / conversations / notifications
  mock/api.ts                # mock 数据访问入口（返回 Promise，模拟延迟）
  lib/request.ts             # 真实请求入口（统一错误信封 / 会话 cookie）
  lib/session.ts             # 登录态存储（小程序无 cookie jar，手动携带）
  lib/api-base.ts            # API 绝对地址（构建期可注入，默认本机 3000）
  features/listing/adapt.ts  # 契约 → 页面视图的投影（不编契约没有的字段）
  features/*/api.ts          # 各域的契约请求函数
  features/fetchers.ts       # 页面取数统一入口：先真接口、失败退 mock
  components/
    product-card/            # 首页/搜索/相似推荐共用的商品卡（单一版式，变体已收）
    empty-state/             # 空态
    nav-bar/                 # 自绘导航栏（设计稿是吸顶漂浮按钮）
  pages/<name>/index.tsx + index.scss + index.config.ts
```

**约定**

- 页面级样式写在各自 `index.scss`，只允许用令牌色与 `_mixins` 里的组合。
- 组件用目录 + `index.tsx` + `index.scss`。`user-avatar` 是样式接线的明确例外：样式仍在组件目录，
  由 `app.scss` 全局 `@use` 一次，避免跨分包共享时 `mini-css-extract-plugin` 的 CSS 顺序冲突。
- 不新增运行时依赖（出图用的 `@resvg/resvg-wasm` 只是 devDependency）；图标统一从 `@/assets/lib-icons` 的 `ICONS` 取。真源与生成器在仓库内 `tools/icons/`
- **非图标类成品图**不走 `ICONS`：品牌图走 `@/assets/brand` 的 `BRAND.*`（`tools/brand/` 从母版生成），认证徽章走 `@/assets/badge` 的 `BADGE.*`（外供设计稿成品图，无母版、不由生成器产出）
  （`glyphs/*.svg` × `manifest.ts`，`bun run --filter @fish/miniapp icons` 重出图）；命名 = 字形 + 语义色
  （`Brand` / `Fg` / `Muted` / `White` / `Danger`），显示尺寸只用 24 / 32 / 40 / 48 四档。
- 页面数据**不许内联假数据**。取数只有两个合法入口：
  1. 已接接口的页面走 `@/features/fetchers`（内含「真接口失败 → 退 mock」的统一回退），
  2. 未接接口的页面走 `@/mock/api`。
- 契约里没有的字段（`views` / `wants` / `comments` / `spec` / 原价 / 图片比例 …）一律
  **留 `null` 或空**，页面据此不渲染 —— 不允许为了「看起来对称」编一个数字。
  真接口数据的投影规则见 `src/features/listing/adapt.ts`。
- 类型对齐 `packages/contracts`：`ListingCard` / `WishDto` / `ConversationDto` / `MessageDto` 等，
  Mock 层只做「投影」，不改语义（金额一律整数分 `*Cents`）。

### 图标显示尺寸四档的场景口径（草案，待 Owner 拍板）

**四档的取值**已收敛（#513）：显示尺寸只写 24 / 32 / 40 / 48（SCSS px = rpx），守门测试
`apps/miniapp/tests/icon-display-size.test.ts` 拦越档与菱形。**缺的是「哪种场景用哪一档」**。

#### 现状实测（口径写清，别人要能复现）

**怎么数的**（基线 `origin/main = 7cfa1d4f`，与守门测试同一扫描口径）：

1. **点位**：`apps/miniapp/src/**/*.tsx` 里 `<Image>` 的 `src` 取自图标表的两类都算 ——
   字面量 `src={ICONS.x}`（**175 处**），加上守门测试 `INDIRECT_ICON_IMAGES` 登记的 8 类间接点
   （`custom-tab-bar/index.tsx` 的 `tabbar__img` / `tabbar__plus`、`components/empty-state/index.tsx`
   的 `empty__icon-img`、`pkg-social/pages/conversation/index.tsx` 的 `conv__ptile-ic`、
   `pkg-auth/pages/settings/index.tsx` 的 `st__ric-ic`、`pages/chat/index.tsx` 的 `notif__ic-img`、
   `pages/profile/index.tsx` 的 `profile__row-ic` / `profile__cell-ic`）和
   `ICONS[...]` / `HOME_CATEGORY_ICONS[...]` 变量取值点（10 处）—— 合计 **193 处**。
   `src` 为三元表达式、一图多键的 7 处不计入这组统计。
2. **档位**：取该 `<Image>` **自身** className 在 scss 里的 `width`（px 即 rpx）；一个
   `<Image>` 只计一次，不按出现次数或渲染次数累加。尺寸写在 inline style 里的点（自绘导航
   2 处）单列，不进分布，也不进跨档统计。
3. **跨档键**：同一个 `ICONS` 键出现在 **≥2 个不同档位**的点位上就计 1 个；只在多个页面用
   同一档不算跨档，与点位数无关。

**结果**（193 处）：四档 **24 → 32、32 → 88、40 → 25、48 → 46**（合计 191），另有 2 处 inline
自适应例外（见下），**越档 0 处**、解析不出尺寸 0 处。跨档键 **22 个**，其中四档全占 3 个：
`warnFg`、`infoFg`、`plusWhite`（`plusWhite` 的 48 只来自 TabBar 凸起钮这一处间接点；只看
字面量点是 24/32/40）。视觉上「同一种语义在不同页面权重不同」，要不要归位见下文约束 2。

#### ⚠️ 三个图标的跨档描述：Issue 正文不准，以实测为准

Issue #591 正文对这三个键的描述与 `origin/main` 现状不符（逐点核过，可按下面的锚点复核）：

| 键                  | Issue 写的   | 实测                                                           |
| ------------------- | ------------ | -------------------------------------------------------------- |
| `chevronRightMuted` | 24 / 32 / 40 | **24 / 32**（17 处，**没有 40**）                              |
| `cameraMuted`       | 24 / 32 / 48 | **32 / 48**（6 处，**没有 24**）                               |
| `plusWhite`         | 四档全占     | **24 / 32 / 40**（字面量 3 处）+ **48**（TabBar 凸起钮）＝四档 |

- `chevronRightMuted` —— 24：`components/legal-doc/index.tsx:324`、`components/order-list/index.tsx:333`、
  `pages/profile/index.tsx:670` / `:691`、`pkg-browse/pages/listing-detail/index.tsx:1709`；
  32：`components/empty-state/index.tsx:34`、`pages/profile/index.tsx:527` / `:541`、
  `pkg-legal/pages/about/index.tsx:72` / `:76` / `:83` / `:90` / `:97`、
  `pkg-legal/pages/feedback/index.tsx:476`、`pkg-social/pages/conversation/index.tsx:3425`、
  `pkg-trade/pages/my-disputes/index.tsx:225`、`pkg-trade/pages/my-reports/index.tsx:261`
- `cameraMuted` —— 32：`pages/home/index.tsx:469`、`pkg-auth/pages/profile-edit/index.tsx:257`、
  `pkg-browse/pages/search/index.tsx:316`、`pkg-vision/pages/vision-result/index.tsx:490` / `:606`；
  48：`pages/sell/index.tsx:1356`（出物徽章缩略图占位）。会话「+」面板的拍照格是变量点
  （`conv__ptile-ic`，48），仍落 32/48，不引入 24。
- `plusWhite` —— 24：`pages/wish/index.tsx:360`；32：`pkg-browse/pages/user/index.tsx:931`；
  40：`pages/sell/index.tsx:1390`；48：`custom-tab-bar/index.tsx:76`（渲染处 `tabbar__plus`，
  见 `custom-tab-bar/index.scss:170`）。结论「四档全占」成立，但支撑 48 的只有 TabBar 这一处，
  容易被读成「这个键到处乱用」。

下面这张表是**草案**，Owner 拍板后才成为规范：

| 档位 | 折合 | 适用场景（草案）                                     | 现在的主用场（实测）                         |
| ---- | ---- | ---------------------------------------------------- | -------------------------------------------- |
| 24   | 12pt | 列表行内辅助图标、气泡内动作、密排元信息、输入框内嵌 | 许愿 / 出物 / 搜索 / 我的 / 空态内联         |
| 32   | 16pt | **主力档**：列表左侧、设置行、按钮内、正文区块头     | 设置页、法务长文、出物、反馈、订单列表、会话 |
| 40   | 20pt | 区块标题、强调入口、卡片动作、报告/申诉类页头        | 商品详情、举报/申诉、账号注销、关注者        |
| 48   | 24pt | 空状态、上传占位、结果页主图、交易状态大图           | 交易见面、我的宫格、登录确认、关注者空态     |

两条配套约束：

1. **「图标看不清」先改 `GLYPH_ZOOM`（`tools/icons/build.ts`），不要抬显示尺寸。** 字形在 72px
   画布里占 83%–93%（`GLYPH_ZOOM = 1.2`），四档显示框本身不动；抬档位会连带改布局留白。
2. **逐处归位上面那批跨档图标是视觉决策，不在 #591 范围**：口径定稿后再按表归位，归位时改的是
   `.scss` 的 `width/height`，一次一批，不夹带其它改动。

**放大的代价：描边同比变粗（待 Owner 拍板）。** `tools/icons/glyphs/*.svg` 统一是
`stroke-width="1.75"`（24 单位网格）。`GLYPH_ZOOM` 把 viewBox 裁成 20 单位后整幅等比放大，
**线宽也跟着放大 1.2 倍**：等效 2.1 网格单位，72px 画布上从 5.25px 变成 **6.3px**
（在 `plus-white@3x.png` 上量实测线厚：5px → 6px，alpha 加权 5.25 → 6.5px）。
这与「字形大 20%」是同一笔账（放大的是整幅图，不是只放字形轮廓），视觉上线会明显更「重」。

若 Owner 认为线宽应保持原视觉重量，改法是在 `zoomViewBox` 里同时把 `stroke-width` 除以
`GLYPH_ZOOM`（`1.75 → 1.46`），让「字形放大、线宽不变」；这属视觉决策，**本轮不做**——
#591 只做字形放大，线宽保持同比。注意 `tests/lib-icons.test.ts` 目前没有守 `stroke-width`
的断言；将来若补，期望值要跟 `build.ts` 的实际换算一起改。

**不走四档的两处例外**（自绘导航，随微信胶囊高度等比缩放，scss 里没有固定尺寸）：
`pkg-auth/pages/profile-edit/index.tsx` 的返回钮与 `pkg-browse/pages/user/index.tsx` 的举报钮，
尺寸写的是 `Math.round(backGeo.size * (40 / 72))`，已在守门测试的 `INLINE_SIZED_ICONS` 里登记。

## 7. 导航结构

**自定义 TabBar**（`app.config.ts` 里 `tabBar.custom: true`）：
`首页 pages/home/index` → `许愿 pages/wish/index` → `出物 pages/sell/index` → `消息 pages/chat/index` → `我的 pages/profile/index`

非 Tab 页面（`navigateTo`）：`pages/search/index`、`pages/listing-detail/index`、`pages/conversation/index`、`pages/orders-buy/index`（我买到的）、`pages/orders-sell/index`（我卖出的）。

**两个订单页是唯一的例外：它们用微信原生导航栏**（各自的 `index.config.ts` 写
`navigationStyle: 'default'`，覆盖 app 级的 `custom`），标题就是视角本身，页内因此没有
自绘顶栏、也没有视角切换控件 —— 两个视角是两个页面，入口在「我的」页的图标栏。
其余 `navigateTo` 进入的二级页一律走 `components/nav-bar` 的自绘漂浮导航栏
（`pages/search` 与一级页走 `components/top-bar`）。

## 9. 自定义 TabBar 的三个硬约束（改之前先读）

1. **目录名必须是 `src/custom-tab-bar/`**。这是小程序的固定约定，Taro 4 会按它编译
   （`@tarojs/webpack5-runner` 的 `MiniPlugin.js`「自定义 tabBar」）。产物是
   `dist/custom-tab-bar/{index.js,json,wxml,wxss}`，且必须用 `Component()` 注册
   （Taro 会自动这么做）——写成页面会编译通过但运行时白屏。
2. **不要在任何页面里再手写 TabBar**。自定义 TabBar 由框架渲染成真正的固定浮层，
   页面里再挂一个就是两套底栏叠加。仍显示底栏的 4 个 Tab 页底部留白是
   `padding-bottom: 157px`（= 底栏顶边距屏底 53 + 101 = 154rpx，取整）。底栏自身**不含**安全区：
   距底按瑞幸稿悬浮位 26.7pt（80px@3x）计，是从屏幕物理底边量起的（稿内自绘了 home indicator），
   再叠 `env()` 等于算两遍（见 `custom-tab-bar/index.scss` 文件头）。
   底栏的高度比 1改 稿收紧过（稿：图标行 42pt / 凸起钮 34pt；现值：28 / 28pt，
   整条栏 101rpx ≈ 50pt，与原生栏一致）；**位置（左右 30rpx / 距底 53rpx）2026-09-26 起
   Owner 拍板改用瑞幸稿悬浮位，栏体形态不变**，
   **改这几个值必须同步改这 4 处 `padding-bottom`**。
   **出物页不渲染底栏**（该页设计稿没有底栏），该页留白只让出安全区。
3. **令牌要在组件内自己声明**。令牌靠 CSS 自定义属性继承下发，而自定义 TabBar 由框架
   挂在 `<page>` 之外，`page` 上的变量继承不到它 —— 组件根节点必须 `@include vars`
   （`@use '@/styles/token-vars'`）。不这么做的话 `var(--r-pill)`（圆角）、
   `var(--grad-brand)`（凸起钮渐变）、`var(--brand)` / `var(--muted)`（文字色）会**静默失效**。

> 历史坑：早期方案是「保留原生栏 + 页面里 `Taro.hideTabBar()` + 页面内 `position: sticky` 的胶囊」。
> 那个方案有两个问题：`hideTabBar()` 对首个 Tab 页不稳定；sticky 会被页面根节点的
> `overflow` 破坏（`.wish` 曾被 `overflow-x: hidden` 搞到 TabBar 跑到文档末尾）。
> 现在这套彻底绕开了两者。

## 8. 验收口径

1. 每个页面与设计稿逐区块对照（区块顺序、文案、层级、留白、圆角、颜色）。
2. `bun run --filter '@fish/miniapp' build:weapp` 必须成功。
3. 真机/模拟器可点：Tab 切换、卡片进详情、搜索出结果、许愿「我要许愿」、消息进会话。
4. 图片一律用 `mode="aspectFill"`，裂图不能出现（`src/assets/mock/**` 已就位）。
