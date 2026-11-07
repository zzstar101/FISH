# 本地 lint 只检查被跟踪文件

`bun run lint` 的结论只代表**仓库跟踪内容**。Biome 不是 git，`biome check .` 会把工作区里未跟踪的本地文件一并检查；微信开发者工具生成的 `apps/miniapp/project.private.config.json`、Finder / `cp` 留下的 `* 2.*` 副本、`.robobun/` 本地工具配置都曾把干净工作树误报成 lint 红，而干净检出的 CI `static` 是绿的 —— 本地门禁与 CI 结论不一致，容易被误判成「main 的门禁坏了」。

## 口径：`bun run lint` → `scripts/lint.ts`

`package.json` 的 `lint` 跑的是 [scripts/lint.ts](../scripts/lint.ts)，不是裸 `biome check .`：

1. `git rev-parse --show-toplevel` 定位仓库根，从任意子目录调用都可以；
2. `git ls-files -z` 取**被跟踪文件**（含已 `git add` 的新文件），已在工作区删除的条目会被跳过 —— 否则 biome 会以「文件不存在」报错伪造失败；
3. 以仓库相对路径、按字节数分批（`ARG_MAX` 安全，含空格的路径按单个参数传）调用
   `biome check --no-errors-on-unmatched --vcs-use-ignore-file=false <paths…>`，所有批次都跑完，任一批非零则整体非零退出。

由此得到的性质：

- **未跟踪文件不参与检查**，无论它是否在 `.gitignore` 里 —— 所以本地垃圾无法伪造 lint 红；
- **已跟踪文件的本地改动照样检查**（biome 读工作区内容，不是 `git show HEAD`），不会被漏掉；
- **已跟踪文件不会被任何 ignore 文件裁掉**：`--vcs-use-ignore-file=false` 关掉了这一次 biome 调用的 ignore 读取（见下节）；
- **「适用」仍由 biome 决定**：`biome.json` 的 `files.includes` 继续生效，`packages/db/src/migrations`、`apps/web-pc/src/routeTree.gen.ts` 这类**仓库声明**的生成文件不会因为显式传参又跑起来；`--no-errors-on-unmatched` 兜住「某一批全是排除项」的情况；
- **新增文件要先 `git add`** 才进本地 lint 的输入（`git ls-files` 读的是索引）；还没 add 的文件请用
  `bunx biome check <path>` 自查；
- `git ls-files` 一个文件都没列出时**直接失败**：门禁不允许「什么都没检查」就绿。

CI 的 `static` 跑的也是 `bun run lint`，干净检出里「被跟踪文件」就是全部文件，所以两边是同一批文件、同一套诊断。

## 两层过滤，分清职责

| 层                 | 由谁决定                                          | 只管什么                                                                                                 |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Git 输入选择**   | `scripts/lint.ts`（`git ls-files` + 关掉 ignore） | 哪些文件进入 lint —— 只有被跟踪文件                                                                      |
| **仓库声明的排除** | `biome.json` 的 `files.includes`                  | 仓库有意不 lint 的**生成文件**：`node_modules`、`dist`、`routeTree.gen.ts`、`packages/db/src/migrations` |

**不要再往 `files.includes` 里加「本地垃圾」的路径模式**（曾经有 `!**/.robobun`、`!**/project.private.config.json`、`!**/* 2.*`、`!**/.m4-evidence`，已删除）。`files.includes` 对**已跟踪**文件同样生效，且是静默跳过：一旦有合法文件命中这些模式（例如有人把一个 `foo 2.ts` 提交了），它就会在**本地和 CI 一起**被跳过 —— 那才是真的漏 lint。对 `lint` 而言，本地垃圾由上面第一层挡掉，不需要第二个 Biome 名单。`.robobun/` 等本地产物仍在 `.gitignore` 声明，避免全树 `format` 遍历、改写它们；若用 `git add -f` 强制跟踪，`lint` 仍会检查。

### 为什么还要 `--vcs-use-ignore-file=false`

`biome.json` 保留 `vcs.enabled: true` + `useIgnoreFile: true`，那是给 `bun run format`、编辑器、手工 `bunx biome check .` 这些**以工作区为输入**的场景用的。但 `scripts/lint.ts` 的输入已经是「被跟踪文件」，再让 biome 读一遍 ignore 文件就会把**只存在于本机**的忽略状态叠加到门禁上：

- `.git/info/exclude`（本机文件，不进版本库）写一行 `apps/api/src/x.ts`，该文件即便被跟踪也会被跳过；
- 未跟踪的嵌套 `.gitignore`（本机新建、CI 上不存在）写一行同名规则，同样会裁掉已跟踪文件；
- 根 `.gitignore` 里任何命中已跟踪文件的模式同理。

这些都不影响 `git ls-files`（已跟踪文件仍然会被列出），于是本地绿、CI 红 —— 正是本单要消除的不一致。命令行的 `--vcs-use-ignore-file=false` 只作用于这一次调用，不动全局配置，也不改 `biome.json` 给其它命令的语义。

回归用例：[scripts/lint.test.ts](../scripts/lint.test.ts) 用临时 git 仓库 fixture 覆盖未跟踪 / 已跟踪 / 已删除 / 空格路径 / 分批 / **仓库排除模式命中已跟踪文件** / **`.git/info/exclude`** / **未跟踪嵌套 `.gitignore`** / 暂存后立刻纳入：

```bash
bun test --isolate ./scripts/lint.test.ts
```

## 排查

- 本地 lint 红，先确认报错文件是否被跟踪：`git ls-files --error-unmatch <path>`（非 0 = 未跟踪）；
  `git status --porcelain` 能看到未跟踪项。
- 需要全树检查（含本地垃圾）时用 `bunx biome check .`：它会在本地未跟踪文件上报红，这**不代表** `main` 的门禁坏了，也不要把文件手工挪到 `/tmp` 再挪回来。
- 怀疑某个已跟踪文件「不见了」，先看 `biome.json` 的 `files.includes` 是否排除了它；也检查 Biome 自身的文件大小限制（`files.maxSize`，默认 1 MiB）和是否支持该后缀。过大文件会有 warning，未支持的后缀不会被检查；这些规则在本地与 CI 一致，Git 输入数量不等于实际检查数量。

## 不在本单范围

- `bun run format` 仍是 `biome format --write .`，会把未跟踪文件也格式化（它只按 `.gitignore` 过滤，不再有「已知垃圾」名单）；
- `biome check .` 仍可作为编辑器之外的手工全树检查。
