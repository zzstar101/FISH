# @fish/ui

FISH 的组件库。**组件源码来自 [shadcn/ui](https://ui.shadcn.com/docs/components) 官方注册表**（`new-york-v4` 风格），
不是自己写的控件；只有少数「shadcn 没有对应物」的页面级组合留在本包里（见下）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/*.tsx` | 一个个 shadcn/ui 组件，文件名 = 组件名，逐文件 subpath 导出（本仓库禁止 barrel `index.ts`） |
| `src/lib/utils.ts` | shadcn 的 `cn()`：`clsx` 拼类名 + `tailwind-merge` 消解冲突，调用方传的 `className` 永远能覆盖默认样式 |
| `src/nav-bar.tsx` | FISH 组合组件：`NavBar` / `FormRow`。shadcn 没有导航条，这里是 `Button`(ghost) + `lucide-react` 箭头拼出来的 |
| `src/user-avatar.tsx` | FISH 组合组件：shadcn `Avatar` + `AvatarImage` + `AvatarFallback`（无真实头像时回落成渐变底 + emoji） |
| `src/states.tsx` | FISH 组合组件：shadcn `Empty` + `Spinner` + `Button` 组成的 Loading / Empty / Error 三态 |
| `src/thumb.tsx` | **不是 shadcn 组件**：商品图占位（渐变 + 可选 emoji），等价于「图片本身」，shadcn 里没有对应物 |

> 迁移已完成：`chip` / `segmented` / `icons` 三个自研模块与 `legacy/**` 兼容层都已删除，
> 页面上不再有任何自研 UI 原语。

导入方式（不建 barrel）：

```ts
import { Button } from '@fish/ui/button'
import { Badge } from '@fish/ui/badge'
import { cn } from '@fish/ui/lib/utils'
```

## 配色是怎么接上的

shadcn 的组件源码里只写语义类名（`bg-background` / `text-muted-foreground` / `border-input` /
`ring-ring` …），这些类名的值全部在 `apps/web/src/styles.css` 里被指到 FISH 的设计令牌上：

```
shadcn 语义令牌            来源（FISH design token）
--primary            →    --color-brand      #0005ff
--background         →    --color-surface    #ffffff（刻意不用 --color-bg，见下）
--card / --popover   →    --color-surface    #ffffff
--secondary/--muted/--accent → --color-surface-2 / --color-ink-3
--foreground         →    --color-ink        #101114
--destructive        →    --color-danger     #ef4444
--border / --input   →    --color-line       #ececef
--ring               →    --color-brand
```

两段写法是刻意的，缺一不可：

- `:root { --primary: var(--color-brand); … }` 是**裸 CSS 变量**。组件内联样式需要直接 `var(--primary)`
  （sonner 的 `--normal-bg`、图表配置），只有裸变量才能被这样消费。
- `@theme inline { --color-primary: var(--primary); … }` 让 Tailwind **生成工具类** `bg-primary`、
  `text-muted-foreground` 等；`inline` 表示工具类里内联值而不是再包一层变量。

`@theme static` 也是必须的：Tailwind v4 默认只输出被工具类引用到的令牌，而 shadcn 组件会间接消费
一部分令牌，不强制输出就会出现「变量不存在 → 颜色静默丢失」。

同一段里还有 shadcn 的全局 base 层：

```css
@layer base {
  * { border-color: var(--border); outline-color: color-mix(in oklab, var(--ring) 50%, transparent); }
}
```

这条不能省。Tailwind v4 把 `border` 的默认颜色从 `gray-200` 改成了 `currentColor`，
而 shadcn 源码里大量出现只写宽度不写颜色的 `border`（Select 弹层、Card、Popover…），
没有这条就会渲染成黑色描边。

还有一处语义映射值得单独说：**`--background` 指向白色 `--color-surface`，而不是页面灰 `--color-bg`。**
shadcn 里 `--background` 的意思是「内容所落在的那层表面」，它的 Tabs 选中块、描边按钮底色都用
`bg-background`，在默认主题里就是白色。FISH 的页面灰底由 `body { background-color: var(--color-bg) }`
直接给，不经过这个令牌。如果按字面把它接成页面灰，Tabs 的选中块（#f5f5f5）会压在灰轨道（#f2f3f5）上，
看起来像没有选中。

**换肤只改 `styles.css` 这一段，组件源码一行都不用动。**

## 有意偏离官方源码的地方

组件是为了「保持参考截图视觉」而改过 class 的，只动视觉、不动结构与 API。已知清单：

| 组件 | 偏离 | 原因 |
| --- | --- | --- |
| `button` | 基础圆角改 `rounded-full`；字号从 base 下沉到 `size`；`sm`/`lg` 缩放改为 28/48px；`destructive` 用描边红；新增 `onBrand` 变体 | DESIGN-SPEC.md 规定按钮一律胶囊形 |
| `badge` | 新增 `brand/success/lavender/warn/danger` 柔和色变体与 `shape`（square/pill）轴，替代原自研 `Chip` | 截图里的属性标签有 6 种色调、2 种形态 |
| `input` / `textarea` | 改为 44px 高、`rounded-lg`、浅灰底无边框，聚焦时描边变蓝底变白；去掉 3px 光环 | 对齐截图里的表单外观 |
| `label` | `text-[15px] text-ink`，去掉 `font-medium` | 同上 |
| `avatar` | 尺寸刻度改为 sm 32 / default 40 / lg 56 / xl 64 | 沿用本仓库原有四档 |
| `tabs` | 轨道改成整宽（`flex w-full`）、分段间 `gap-0.5`；内边距 3px→2px（选中块正好 32px）；未选中 `text-ink-2`；选中态补 `ring-1 ring-primary/25` + `font-semibold` | 原自研 `Segmented` 就是块级整宽、`gap-0.5`，选中块白底由 `--background` 令牌保证（见上），页面里不需要再各写一份覆盖 |
| `card` | 去掉描边与投影，`rounded-2xl`，内边距 24px→16px，并加上 `overflow-hidden` | 截图里是纯白平面卡；`overflow-hidden` 是原来卡片外层的写法，移进组件以免每个调用方都写一遍 |
| `empty` | 去掉虚线边框，`px-8 py-14`，标题 18px→14px | 替代原自研 `EmptyState` |
| `sonner` | 去掉 `next-themes`，固定 `theme="light"` | 本仓库是单浅色移动端 Web，没有 `.dark` |
| `field` / `button-group` | `div[role=group]` → `<fieldset>`，并加 `min-w-0` | 让分组语义来自原生元素，同时满足 Biome a11y 规则；`min-w-0` 抵消 `<fieldset>` 默认的 `min-inline-size: min-content` |
| `breadcrumb` | 当前页去掉 `role="link"` / `aria-disabled`，只留 `aria-current="page"` | 同上 |
| `pagination` | 去掉 `<nav>` 上冗余的 `role="navigation"` | 同上 |
| `toggle-group` | `gap-[--spacing(var(--gap))]` → `gap-[var(--gap)]`，并把 `--gap` 换算成 rem 长度 | 官方这行是 Tailwind v3 的 `--spacing()` 语法，v4 下解析不出长度，`spacing` 参数会完全失效（上游 bug） |
| `dropdown-menu` / `select` 等 | 未改动 | 颜色走令牌桥接即可 |

## 新增一个 shadcn 组件

官方注册表是按组件取源码的，取完放进 `src/` 并补 `package.json` 的 `exports` 即可：

```bash
# 1. 取源码（把 <name> 换成 ui.shadcn.com/docs/components 里的 slug，如 dialog、select）
curl -s https://ui.shadcn.com/r/styles/new-york-v4/<name>.json

# 2. 落地时只需要做三件事：
#    - 删掉 "use client"（本仓库不是 RSC）
#    - import { cn } from "cn"            → from './lib/utils'
#    - import { X } from "@/registry/new-york-v4/ui/x" → from './x'
#    - 文件若用到 React. 却没 import React，补 import * as React from "react"

# 3. 补 exports 后跑验证
bunx biome check --write packages/ui/src
bun run typecheck
bunx biome check packages/ui/src apps/web/src   # 不要直接跑 `bun run lint`：
# Windows 检出时 core.autocrlf=true 会让所有被跟踪文件变 CRLF，
# 全仓 biome check 会报一堆与本次改动无关的换行符格式错误。
```

组件用到的 npm 依赖（`radix-ui`、`cmdk`、`vaul`、`sonner`…）装在 `packages/ui`，
由 shadcn 组件的 `dependencies` 字段给出。
