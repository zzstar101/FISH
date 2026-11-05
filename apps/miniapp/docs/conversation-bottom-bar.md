# 会话底部输入栏 · 端上测量清单（#577）

> 这份文档是给**在微信开发者工具 / 真机上做验收的人**用的记录表，不是设计说明。
> 输入栏的几何在端上跑，单测只能钉口径（`apps/miniapp/tests/conversation-bottom-bar-layout.test.ts`），
> 矩形与安全区必须真机量。三端（iOS / Android / 鸿蒙）真机数据由 Owner 采集后填表。

## 1. 口径：每个数归谁管

| 选择器           | 承担                                                       | 值 / 真源                                                                                                                                         |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.conv`          | 整页弹性列                                                 | `height: 100vh; display: flex; flex-direction: column; overflow: hidden`                                                                          |
| `.conv__scroll`  | 消息流                                                     | `flex: 1; min-height: 120px`（短屏兜底，不参与贴底计算）                                                                                          |
| `.conv__bottom`  | **贴底 + 底栏底色 + 底部安全区（唯一一处）+ 面板定位父级** | `flex: 0 0 auto; background: var(--surface); padding-bottom: env(safe-area-inset-bottom)`                                                         |
| `.conv__bar`     | 输入栏自己的几何                                           | `padding: $bar-gap-px 24px`（=`16px`，**不含** env）                                                                                              |
| `.conv__bar-row` | 输入行                                                     | `display: flex; align-items: flex-end; gap: 16px`                                                                                                 |
| `.conv__cbtn`    | 语音/键盘切换                                              | `68px × 68px` 正圆                                                                                                                                |
| `.conv__plus`    | 「+」                                                      | `68px × 68px` 正圆                                                                                                                                |
| `.conv__send`    | 发送                                                       | `height: 68px`（宽度随文案）                                                                                                                      |
| `.conv__input`   | 输入框                                                     | `min-height: 68px; max-height: 176px; padding: calc((68px - 1.4em) / 2) 24px`                                                                     |
| `.conv__panel`   | 「+」面板（吸底浮层）                                      | 高度由**内容自己撑开**（`height: auto`，内容 ≈ `PANEL_CONTENT_RPX` 194rpx + 安全区）；底座让给它的高度由 `view.ts` 的 `resolvePanelHeightPx()` 算 |

三个 token 在 `apps/miniapp/src/pkg-social/pages/conversation/index.scss` 顶部（`$bar-control-px: 68px`、
`$bar-gap-px: 16px`、`$bar-input-max-px: 176px`）。`apps/miniapp/config/index.ts:34` 是 `designWidth: 750`，
所以 scss 里写 `68px` **落盘就是 `68rpx`** —— 换算成设计稿 34pt、8pt、88pt。

### 为什么安全区只算一次

基线（#597 起）就已经有 `.conv__bottom` 这层底座（`position: relative / z-index: 20 / flex: 0 0 auto`，
无 background、无 padding），但**安全区写在 `.conv__bar` 自己的 `padding-bottom: calc(16px + env(...))` 里**
——所以基线也算 1 次，本单做的是把承载者从 `bar` **搬家**到底座，并让「占用态清零」变成显式的、可断言的规则。
搬家的理由是原来的写法没法表达「占用态不再留安全区」：env 混在 `calc(16px + env())` 里，键盘一开只能整段内联覆盖，
底座有没有留那一份完全看不出来。现在 env 只出现在 `.conv__bottom`，`.conv__bar` 上若再写一次就会与底座
**相加两次**（iPhone 上多 34pt 空白）——这条是**预防性**约束，不是"改前是错的"。所以：

- **收起态**：`.conv__bottom` 的内联样式为 `undefined` → scss 的 env 生效，算 **1 次**；`.conv__bar` 只留
  `$bar-gap-px` 基础间距。底座背景铺到窗口底边，家指示条那一条也是底栏的底色，不再露缝。
- **占用态**（键盘展开 / 「+」面板展开）：`resolveBottomReserveStyles()` 返回
  `{ bottom: { paddingBottom: '0px' }, bar: { paddingBottom: 'calc(占位高度 + 16rpx)' } }` →
  底座 env 被清零（算 **0 次**，因为占用者已经盖住了那块高度），输入栏下内边距一次让够占位高度。
- 面板展开时唯一的 env 在 `.conv__panel` 自己的下内边距里：那一刻底座 env 已清零，所以全局仍然只算 **1 次**。

`apps/miniapp/tests/conversation-bottom-bar-layout.test.ts` 用 `env(safe-area-inset-bottom)` 在 scss 中
出现 **2 次**（`.conv__bottom` + `.conv__panel`）且**不在** `.conv__bar` 里这条断言钉住该口径。

## 2. 怎么量

微信开发者工具的 **Console** 里直接贴（`wx` API 可用）；每个场景量一次，把结果填到第 3 节的表。

```js
// 一次量完：窗口信息 + 六个矩形的 top/bottom/height/width
const q = wx.createSelectorQuery()
const info = wx.getWindowInfo()
for (const sel of [
  '.conv',
  '.conv__scroll',
  '.conv__bottom',
  '.conv__bar',
  '.conv__bar-row',
  '.conv__input',
  '.conv__cbtn',
  '.conv__plus',
  '.conv__send',
]) {
  q.select(sel).boundingClientRect()
}
q.exec((res) => {
  console.log('window', {
    windowHeight: info.windowHeight,
    screenHeight: info.screenHeight,
    safeArea: info.safeArea,
    pixelRatio: info.pixelRatio,
  })
  console.log(
    ['conv', 'scroll', 'bottom', 'bar', 'barRow', 'input', 'cbtn', 'plus', 'send'].map(
      (name, i) => ({
        name,
        top: res[i] && Math.round(res[i].top),
        bottom: res[i] && Math.round(res[i].bottom),
        height: res[i] && Math.round(res[i].height),
        width: res[i] && Math.round(res[i].width),
      }),
    ),
  )
})
```

再补一条：底部安全区的设备指标推导值（单位 px，等于 `Math.max(0, screenHeight - safeArea.bottom)`，与 `panelHeight` 内的 `safeAreaBottom` 屏幕坐标口径一致；不是 CSS 环境变量的直接读取）。

```js
const i = wx.getWindowInfo()
console.log('inset-bottom(device px)', Math.max(0, i.screenHeight - i.safeArea.bottom))
```

## 3. 记录表（待 Owner 采集）

场景定义：

- **S1** 空内容、未聚焦（收起态）
- **S2** 单行有字、未聚焦
- **S3** 四行左右的满内容（到 `176px` 上限，输入框内部滚动）：内容区 = 176 − 2×14.4 = 147.2rpx ≈ **3.75 行**，
  所以第 4 行是**部分可见**（4 整行需要 185.6rpx）—— 这是上限的必然结果，不是截断缺陷
- **S4** 键盘展开（`autoHeight` 单行）
- **S5** 「+」面板展开（键盘收起后）
- **S6** 语音态（按住说话，单行草稿）

| 机型 / 系统 | 构建 | 窗口 h | 安全区 bottom | 场景 | `.conv` bottom | `.conv__bottom` h | `.conv__bar` h | `.conv__bottom` 下内边距 | `.conv__bar-row` h | `.conv__input` h | `.conv__cbtn` h | `.conv__plus` h | `.conv__send` h | 输入行上下间距 |
| ----------- | ---- | ------ | ------------- | ---- | -------------- | ----------------- | -------------- | ------------------------ | ------------------ | ---------------- | --------------- | --------------- | --------------- | -------------- |
| iOS         |      |        |               | S1   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| iOS         |      |        |               | S4   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| iOS         |      |        |               | S5   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| Android     |      |        |               | S1   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| Android     |      |        |               | S2   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| Android     |      |        |               | S3   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| Android     |      |        |               | S4   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| Android     |      |        |               | S5   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| HarmonyOS   |      |        |               | S1   |                |                   |                |                          |                    |                  |                 |                 |                 |                |
| HarmonyOS   |      |        |               | S4   |                |                   |                |                          |                    |                  |                 |                 |                 |                |

## 4. 判定规则

1. **贴底无缝**：S1/S2 下 `.conv.bottom === windowHeight`（容差 1px），且 `.conv__bottom` 的背景一直画到窗口底边
   —— 目视：底栏下沿与屏幕下沿之间**没有**一条异色缝。
2. **四控件同高**：S1/S2/S6 下 `.conv__input.height === .conv__cbtn.height === .conv__plus.height ===
   .conv__send.height`（容差 1px，都应为 34pt × `pixelRatio`）。
3. **间距 16rpx**：S1 下 `.conv__bar-row.top - .conv__bar.top === 16rpx + 2rpx`（**已含** `.conv__bar` 的
   `border-top: 2px`，行盒从 border 内侧算起；按 16rpx 判会假失败）、
   `.conv__bar.bottom - .conv__bar-row.bottom === 16rpx`（rpx→px 按屏宽/750 换算；仅在 `.conv__bottom`
   无内联 padding 时成立）。
4. **安全区只算一次**：S1 下 `.conv__bottom` 的下内边距 = `inset-bottom`（**不是** `inset-bottom + 16rpx`，
   也不是 0）；S4 下 `.conv__bar` 的下内边距 = `键盘高度 + 16rpx`，`.conv__bottom` 的下内边距 = **0**。
5. **多行**：S3 下 `.conv__input.height <= 176px`（≈88pt×`pixelRatio`），继续输入时高度**不再增长**，文字在框内
   滚动且光标可见；同一场景 `.conv__cbtn/.conv__plus/.conv__send` 的 `.bottom` 与 `.conv__input.bottom`
   对齐（容差 1px），高度仍是 S1 的值（没被拉伸）。
6. **键盘跟手**：S4 下 `.conv__bar.bottom` ≈ 键盘上沿（开发者工具里可用「显示键盘」模拟），
   且 `.conv__bottom` 下内边距为 0 —— 键盘上方**没有**额外空白带。
7. **收起复原**：从 S4 退回 S1，`.conv__bottom` 下内边距回到 `inset-bottom`、`.conv` 底边仍贴窗口底边。

## 5. 已知边界（代码侧已定，端上仍需确认）

- **多行超出**靠 `Textarea autoHeight` + `max-height` 夹住，框内滚动是原生行为；「光标始终可见」只在
  真机上可验（不同基础库版本的原生 textarea 滚动策略不完全一致）。
- **手势区**：`inset-bottom` 全量保留（34pt on iPhone），没有为「视觉等距」把它清零 —— 这是 #577 的
  明确要求，不属于缺陷。
- **键盘时序**仍由 #560 的单一真源（`onKeyboardHeightChange` → `nextKeyboardInset` 单调阶梯）负责，
  本次只改了「谁承担安全区/间距」，没有加第二套补偿、没有 `fixed; bottom: 0`、没有写死负偏移或延时。
- **栈式 PR**：本改动基于 #597 的分支尖端（`656ba41b`），`gh pr` 挂在 #597 之上；#597 合入后本条
  自动只剩 #577 的 diff。
- 端上三端数据**尚未采集**：代码侧已统一（单测钉住 token 与安全区归属），像素级对照待 Owner 按上表填写。
