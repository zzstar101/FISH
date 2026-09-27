# AGENTS.md（apps/miniapp）

本目录是 FISH 微信小程序（Taro 4 + React）。**根目录 [AGENTS.md](../../AGENTS.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md) 全部有效，本文件只增加小程序特有的强制约束，不削弱任何一条。**

## 最高优先级：[docs/miniapp-dev-workflow.md](../../docs/miniapp-dev-workflow.md)

对 `apps/miniapp/src/**` 的任何改动（人或 AI agent）之前，**先完整读该文档**。要点如下，冲突时以该文档为准：

1. **动手前必须告知 Owner 并等确认**：说明「改哪个页面、改什么、预期效果」，Owner 确认后才改代码。
2. **一个页面 = 一条分支**：`feat/miniapp-<页面名>-<要点>-<序号>`，从最新 `origin/main` 切出；一根分支只做一件事，不在一根分支里改多个页面。
3. **串行门禁**：上一个分支「端上验证通过 + 已提交 + 已合入/已被 Owner 确认」之前，不得开下一个页面分支；不许叠分支。
4. **提交前必须过端上验证**：在微信开发者工具里实际打开该页面演示（渲染、交互、loading/error 态、无视觉回归）→ 把结果给 Owner → Owner 认可 → `bun run --filter '@fish/miniapp' typecheck` 与 `bun run lint` 通过 → 才允许提交。
5. **微信开发者工具不可用 = 阻塞**：如实告知 Owner，不得用 H5 预览或"代码看起来没问题"充当端上验证，也不得绕过门禁提交。
6. **豁免范围**：纯文档 / 纯配置 / 纯类型改动可豁免开发者工具演示，但串行门禁与"改前提醒 Owner"仍然有效；不确定算不算页面改动时，**按"算"处理**。

## 与根 AGENTS.md 的关系

- 范围纪律、最小改动、测试口径、验证顺序、对抗性审查、危险清单、基线纪律（`git fetch origin --prune`、只信 `origin/main`）、PR 生命周期与署名，一律照根文件执行。
- 小程序是**端上运行时**：`navigationStyle: custom` 的自绘导航、原生 TabBar、safe-area、真机字体与布局，在浏览器里看不出真实效果 —— 静态检查与 H5 预览**不能替代**微信开发者工具里的验证。
