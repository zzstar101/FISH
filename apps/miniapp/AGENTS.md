# AGENTS.md（apps/miniapp）

本目录是 FISH 微信小程序（Taro 4 + React）。**根目录 [AGENTS.md](../../AGENTS.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md) 全部有效，本文件只增加小程序特有的约束，不削弱任何一条。**

## 小程序端上门禁：[docs/miniapp-dev-workflow.md](../../docs/miniapp-dev-workflow.md)

该文档是本目录端上验证的权威口径（冲突时以它为准）。要点：

1. **一批页面 = 一条分支 = 一个 PR**：一个 PR 可以包含一个或多个页面（含样式、组件、交互），不要按页面拆成一堆小 PR。
2. **同一时间只开一个 PR**：上一个小程序 PR 合并（或被 Owner 确认）之前不新开下一个；同一条 PR 内可以继续追加同批页面。
3. **合并前在微信开发者工具里逐页演示一次 + Owner 认可**：把演示结果给 Owner；**提交与推送本身不需要事前演示，也不要求在动手前先报备**。
4. **静态检查**：`bun run --filter '@fish/miniapp' typecheck` 与 `bun run lint` 通过。
5. **微信开发者工具不可用 = 阻塞**：如实告知 Owner，不得用 H5 预览或"代码看起来没问题"充当端上验证，也不在未演示的情况下合并。

## 与根 AGENTS.md 的关系

- 范围纪律、最小改动、测试口径、验证顺序、对抗性审查、危险清单、基线纪律（`git fetch origin --prune`、只信 `origin/main`）、PR 生命周期与署名，一律照根文件执行。
- 小程序是**端上运行时**：`navigationStyle: custom` 的自绘导航、原生 TabBar、safe-area、真机字体与布局，在浏览器里看不出真实效果 —— 静态检查与 H5 预览**不能替代**微信开发者工具里的验证。

## 本流程的边界

- 上述端上门禁**只约束 `apps/miniapp`**：`apps/web`（移动端 PWA）与 `apps/web-pc`（PC 站，Vite :5174、basepath `/pc/`）没有微信端运行时，不受它约束，按根 `AGENTS.md` 的通用纪律走。
