# apps/miniapp 视觉与工程约定（Design Contract）

> 适用对象：`apps/miniapp` 的所有页面与组件实现（人 + AI agent）。
> 本文件是**视觉唯一真源**。改设计先改这里，再改代码。

## 0. 这一版在做什么

把 5 张「冰蓝荧光」设计稿（首页 / 商品详情 / 搜索 / 许愿墙 / 消息）实现成 Taro 小程序页面，
数据全部走本地 Mock，**不接真实 API**。设计稿是原生小程序风格（HTML 盒模型 + CSS 变量），
这里移植到 Taro 4 + React 18 + SCSS。

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

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--brand` | `#4285FF` | 主色（强调、选中态、链接） |
| `--electric` / `--cyan` / `--mint` | `#19A7FF` / `#19E6FF` / `#54F5D0` | 品牌渐变的三段 |
| `--bg` | `#F7FAFF` | 页面底色 |
| `--surface` | `#FFFFFF` | 卡片 |
| `--fg` | `#17233D` | 主文字 |
| `--muted` | `#71809C` | 次要文字 |
| `--muted-2` | `#3E4B66` | 小字（12pt 以下）需要更高对比时用 |
| `--border` | `#DCE7F5` | 描边/分割线 |
| `--line` | `#A8C5FA` | hover/强调描边、认证勾 |
| `--accent-weak` | `#EFF5FF` | 浅色底（图标圆盘、标签底） |
| `--accent-mid` | `#C6DCFF` | 渐变中段 |
| `--danger` | `#FF5F6D` | 价格、警示 |
| `--warn` | `#FFB84D` | 提醒 |
| `--price` | `#4375E8` | 带品牌感的蓝价（首页卡片） |
| `--ink` | `#17233D` | 深色块底（选中胶囊、深卡） |
| `--grad-brand` | `linear-gradient(135deg,#4285FF 0%,#19A7FF 55%,#19E6FF 100%)` | 品牌渐变 |
| `--grad-icon` | 145° 三色冰蓝渐变 | 分类图标圆盘 |
| `--grad-page` | `linear-gradient(165deg,#DCEBFF 0%,#EAF4FF 46%,#F7FAFF 100%)` | 页头背景（下方圆角 32） |
| `--shadow-card` | `0 2px 4px rgba(23,35,61,.05), 0 24px 56px -36px rgba(66,133,255,.45)` | 卡片投影 |

## 3. 圆角与阴影

| 用途 | 圆角（设计稿值） |
| --- | --- |
| 胶囊 / 按钮 / 标签 | `999` |
| 商品卡（首页） | `18` |
| 商品卡（搜索/详情相似） | `20` |
| 大卡（bento / 许愿吊牌） | `20 ~ 24` |
| 页头背景 | 底部 `32` |

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

## 6. 组件与文件组织

```text
src/
  styles/_tokens.scss        # 颜色/阴影/圆角令牌（唯一真源）
  styles/_mixins.scss        # 常用组合（卡片、胶囊、玻璃、截断）
  assets/lib-icons.ts        # 图标唯一出口（ICONS.xxx）
  custom-tab-bar/            # 自定义 TabBar（固定目录名，见第 9 节）
  mock/types.ts              # 与 packages/contracts 对齐的 Mock 类型
  mock/*.ts                  # fixtures：listings / users / wishes / conversations / notifications
  mock/api.ts                # 统一数据访问入口（返回 Promise，模拟延迟）
  components/
    product-card/            # 首页/搜索共用的商品卡（两个 variant）
    empty-state/             # 空态
    nav-bar/                 # 自绘导航栏（设计稿是吸顶漂浮按钮）
  pages/<name>/index.tsx + index.scss + index.config.ts
```

**约定**

- 页面级样式写在各自 `index.scss`，只允许用令牌色与 `_mixins` 里的组合。
- 组件用目录 + `index.tsx` + `index.scss`。
- 不新增依赖；图标统一从 `@/assets/lib-icons` 的 `ICONS` 取（真源与生成器在 `D:\FISH\miniprogram`）。
- 页面数据一律从 `@/mock/api` 取，禁止在页面里内联假数据。
- 类型对齐 `packages/contracts`：`ListingCard` / `WishDto` / `ConversationDto` / `MessageDto` 等，
  Mock 层只做「投影」，不改语义（金额一律整数分 `*Cents`）。

## 7. 导航结构

**自定义 TabBar**（`app.config.ts` 里 `tabBar.custom: true`）：
`首页 pages/home/index` → `许愿 pages/wish/index` → `出物 pages/sell/index` → `消息 pages/chat/index` → `我的 pages/profile/index`

非 Tab 页面（`navigateTo`）：`pages/search/index`、`pages/listing-detail/index`、`pages/conversation/index`、`pages/notifications/index`。

## 9. 自定义 TabBar 的两个硬约束（改之前先读）

1. **目录名必须是 `src/custom-tab-bar/`**。这是小程序的固定约定，Taro 4 会按它编译
   （`@tarojs/webpack5-runner` 的 `MiniPlugin.js`「自定义 tabBar」）。产物是
   `dist/custom-tab-bar/{index.js,json,wxml,wxss}`，且必须用 `Component()` 注册
   （Taro 会自动这么做）——写成页面会编译通过但运行时白屏。
2. **不要在任何页面里再手写 TabBar**。自定义 TabBar 由框架渲染成真正的固定浮层，
   页面里再挂一个就是两套底栏叠加。页面对应的底部留白是 `padding-bottom: 176px`
   （悬浮胶囊高度 + 安全区 ≈ 88pt）。

> 历史坑：早期方案是「保留原生栏 + 页面里 `Taro.hideTabBar()` + 页面内 `position: sticky` 的胶囊」。
> 那个方案有两个问题：`hideTabBar()` 对首个 Tab 页不稳定；sticky 会被页面根节点的
> `overflow` 破坏（`.wish` 曾被 `overflow-x: hidden` 搞到 TabBar 跑到文档末尾）。
> 现在这套彻底绕开了两者。

## 8. 验收口径

1. 每个页面与设计稿逐区块对照（区块顺序、文案、层级、留白、圆角、颜色）。
2. `bun run --filter '@fish/miniapp' build:weapp` 必须成功。
3. 真机/模拟器可点：Tab 切换、卡片进详情、搜索出结果、许愿「我要许愿」、消息进会话。
4. 图片一律用 `mode="aspectFill"`，裂图不能出现（`src/assets/mock/**` 已就位）。
