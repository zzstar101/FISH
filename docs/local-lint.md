# 本地 lint 与未跟踪文件

`bun run lint` 的结论只应代表**仓库跟踪内容**。Biome 不是 git，默认会把工作区里未跟踪的本地文件一并检查；微信开发者工具生成的 `apps/miniapp/project.private.config.json`、Finder / `cp` 留下的 `* 2.*` 副本、`.robobun/` 本地工具配置都曾把干净工作树误报成 lint 红。

当前 `biome.json` 的口径：

- `vcs.useIgnoreFile: true`：应用 `.gitignore`、`.git/info/exclude` 与嵌套 ignore 文件；
- `files.includes` 显式排除 `**/.robobun`、`**/project.private.config.json`、`**/* 2.*`，不依赖某台机器是否配置了本地 exclude。

因此本地 `bun run lint` 与 CI `static` 使用同一批文件。若本地仍因未跟踪文件报错，先确认它是否命中上述规则；不要把本地垃圾当成 `main` 的门禁坏了，也不要手工搬文件绕过验证。CI 的干净检出结论是权威。
