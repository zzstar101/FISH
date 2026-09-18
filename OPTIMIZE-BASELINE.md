# 小程序前端优化 — 改动前基线快照

> 生成时间：2026-09（fork：`D:\FISH\FISH-main-fork`，HEAD `6270962`）
> 目的：记录优化开始前代码库的健康状态，方便后面对照。

## 1. 分支 / 版本
- 分支：`main`（`--single-branch` clone，最新到 `origin/main`）
- HEAD：`6270962` feat(miniapp): 登录/注册/注册成功三页按 1版稿落地（重建 #102）（#106）
- 总提交数：60

## 2. 工具链
- Bun `1.4.2`（packageManager `bun@1.4.0`）
- Node `v24.14.0`
- Taro `4.2.1`（webpack5 runner）
- React 18.3.1 / TypeScript（仓根 `typescript@7.0.2`，包内按各自 tsconfig）

## 3. 健康度基线（前期检查，全部通过）
| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装 | `bun install` | ✅ 1211 packages |
| 小程序类型检查 | `bun run --filter '@fish/miniapp' typecheck` | ✅ exit 0 |
| 全仓 lint | `bun run lint`（Biome） | ✅ 429 files，no fixes |
| weapp 编译 | `TARO_APP_MOCK=1 bun run build:miniapp` | ✅ Compiled successfully in 1.38m，dist 112 files |

## 4. 编译产物（dist/）
- `miniprogramRoot` = `apps/miniapp/dist`（`project.config.json` 指向）
- dist 内容：`app.js/wxss/json`、`base.wxml`、22 个页面目录、`custom-tab-bar/`、`assets/`、`common/vendors/taro/runtime` 等。
- 开发者工具打开 `dist/` 即可预览。

## 5. 取数策略速览（来自 DESIGN.md / config/index.ts）
- 数据库源分两类：
  - **已接真实 API（只读）**：首页 / 分类 / 搜索 / 商品详情 / 通知 / 我的 —— 走 `src/features/fetchers.ts`（真接口失败 → 退 mock）
  - **仍本地 mock**：许愿 / 消息 / 会话 / 发布 / 订单 / 面交 / 认证 / 设置 等（写操作与状态机尚未接入）
- `__ALLOW_MOCK_FALLBACK__` 默认关；`TARO_APP_MOCK=1` 或 `NODE_ENV=development` 才开。
- 生产语义：后端挂掉应显示错误态，而非假数据。

## 6. 已知工程约定（DESIGN.md，优化须遵守）
- `SCSS 数值 = 设计稿数值 × 2`（designWidth 750，px=rpx）
- 颜色只用 `src/styles/_tokens.scss` 令牌，禁 `color-mix()`/`oklch()`
- 只读页数据入口：`fetchers.ts`；未接页入口：`@/mock/api`；**不允许页面内联假数据**
- 图标统一 `@/assets/lib-icons` 的 `ICONS`
- 自绘导航栏（`navigationStyle: custom`）、自定义 TabBar（`custom-tab-bar/`）
- 底栏只在 5 个 Tab 页出现；其他页底部不留 TabBar 空白、用吸底操作栏

## 7. 待办（用户选定优化方向）
- 视觉/UI 打磨：对照 1改稿 与 DESIGN.md 修页面还原度
- 交互/体验：加载态 / 下拉刷新 / 空态 / 错误态 / 跳转 / 触底分页
- 代码质量/结构：接口层与 mock 切换、类型、公共组件抽取、冗余清理
- （性能暂缓）

## 8. 已完成的优化（改动记录）
### R1（环境 + 基线）
- `bun install` ✅ / weapp 编译 ✅ / typecheck ✅ / lint ✅
- 生成本基线文档

### R2（代码质量/结构 — 清除骨架阶段死代码）
删除 3 个已无引用、仅服务于骨架阶段的文件（`dev-placeholder` 组件 + 其唯一依赖）：

| 删除文件 | 删除前引用 | 依据 |
| --- | --- | --- |
| `apps/miniapp/src/components/dev-placeholder/{index.tsx,index.scss}` | 无任何页面/组件引用 | grep 仅命中自身文件 |
| `apps/miniapp/src/lib/contracts.ts`（`BACKEND_STATUS`） | 仅被 dev-placeholder 引用 | grep 无其他 import |
| `apps/miniapp/src/types/tab.ts`（`TabPageKey`） | 仅被 dev-placeholder 引用 | grep 无其他 import |

- 同时移除清空后的空目录 `src/types/`。
- **验证全绿**：typecheck exit 0 · lint 426 files 无问题 · `TARO_APP_MOCK=1 build:miniapp` exit 0（dist 112 文件，无产物残留）。
- 说明：`@fish/contracts` 的 monorepo 打通由其它 20+ 处 import 继续承载（profile/listing/chat/fetchers/mock），删除不削弱契约接线。

### R3（视觉/代码质量 — 首页搜索胶囊硬编码色 → 令牌）
- 把 `apps/miniapp/src/pages/home/index.scss` 里首页搜索胶囊描边 `border: 2px solid #e6eefc`（内联色）
  改为共享令牌 `var(--field-line)`（#e8efff）。
  - 依据：DESIGN.md §2「请只引用令牌，不要自己调色或内联新色值」；
    `--field-line` 令牌的语义就是「输入胶囊描边」，且搜索页输入框已用它（`search/index.scss`）。
    首页与搜索页是同一枚胶囊形态，两处必须同源，否则必然漂移。值差几个 RGB 单位，视觉无感。
- 复查全仓 108 处 hex：其余均为**有意的** `#fff`/`#ffffff`（深卡/渐变主按钮白字，chat/index.scss
  有注释说明）或令牌定义本身；`wish/index.scss:436` 的 `#e2ecff` 是浅色卡独立描边，
  语义不同、可能是设计稿专属值，**不擅改**（留待设计师确认）。
- **验证全绿**：`TARO_APP_MOCK=1 build:miniapp` exit 0（52.51s），dist 113 文件；
  编译产物 `home/index.wxss` 确认 `border:2rpx solid var(--field-line)` 已解析。
