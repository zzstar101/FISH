# 本地 lint 只检查被跟踪文件

`bun run lint` 的结论只代表**仓库跟踪内容**。Biome 不是 git，`biome check .` 会把工作区里未跟踪的本地文件一并检查；微信开发者工具生成的 `apps/miniapp/project.private.config.json`、Finder / `cp` 留下的 `* 2.*` 副本、`.robobun/` 本地工具配置都曾把干净工作树误报成 lint 红，而干净检出的 CI `static` 是绿的 —— 本地门禁与 CI 结论不一致，容易被误判成「main 的门禁坏了」。

## 口径：`bun run lint` → `scripts/lint.ts`

`package.json` 的 `lint` 跑的是 [scripts/lint.ts](../scripts/lint.ts)，不是裸 `biome check .`：

1. `git rev-parse --show-toplevel` 定位仓库根，从任意子目录调用都可以；
2. `git ls-files -z` 取**被跟踪文件**（含已 `git add` 的新文件），已在工作区删除的条目会被跳过 —— 否则 biome 会以「文件不存在」报错伪造失败；
3. 以仓库相对路径、按字节数分批（`ARG_MAX` 安全，含空格的路径按单个参数传）调用
   `biome check --no-errors-on-unmatched <paths…>`，所有批次都跑完，任一批非零则整体非零退出。

由此得到的性质：

- **未跟踪文件不参与检查**，无论它是否在 `.gitignore` 里 —— 所以本地垃圾无法伪造 lint 红；
- **已跟踪文件的本地改动照样检查**（biome 读工作区内容，不是 `git show HEAD`），不会被漏掉；
- **「适用」仍由 biome 决定**：`biome.json` 的 `files.includes` 与 vcs ignore 继续生效，`packages/db/src/migrations`、`apps/web-pc/src/routeTree.gen.ts` 这类被排除的路径不会因为显式传参又跑起来；`--no-errors-on-unmatched` 兜住「某一批全是排除项」的情况；
- **新增文件要先 `git add`** 才进本地 lint 的输入（`git ls-files` 读的是索引）；还没 add 的文件请用
  `bunx biome check <path>` 自查；
- `git ls-files` 一个文件都没列出时**直接失败**：门禁不允许「什么都没检查」就绿。

CI 的 `static` 跑的也是 `bun run lint`，干净检出里「被跟踪文件」就是全部文件，所以两边是同一批文件、同一套诊断。

## `biome.json` 里的 `vcs.useIgnoreFile` 与显式排除

`biome.json` 仍开着 `vcs.useIgnoreFile: true`，并显式排除 `**/.robobun`、`**/project.private.config.json`、`**/* 2.*`。这是**第二道过滤**，只挡已知垃圾，**不等于 tracked-only**：没进 ignore 的未跟踪文件照样会被 `biome check .` 检查到。真正的口径来自 `scripts/lint.ts`。

反向代价：被这些规则命中的**已跟踪**文件会被静默跳过。调整 `biome.json` 的 `files.includes` / ignore 时，先确认没有跟踪文件命中新规则。

## 排查

- 本地 lint 红，先确认报错文件是否被跟踪：`git ls-files --error-unmatch <path>`（非 0 = 未跟踪）；
  `git status --porcelain` 能看到未跟踪项。
- 需要全树检查（含本地垃圾）时用 `bunx biome check .`：它会在本地未跟踪文件上报红，这**不代表** `main` 的门禁坏了，也不要把文件手工挪到 `/tmp` 再挪回来。
- 回归用例：[scripts/lint.test.ts](../scripts/lint.test.ts)（临时 git 仓库 fixture 覆盖未跟踪 / 已跟踪 / 已删除 / 空格路径 / 分批 / 排除项）：

  ```bash
  bun test --isolate ./scripts/lint.test.ts
  ```

## 不在本单范围

- `bun run format` 仍是 `biome format --write .`，会把未跟踪文件也格式化；
- `biome check .` 仍可作为编辑器之外的手工全树检查。
