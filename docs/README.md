# 文档索引

| 文档                                                 | 内容                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                   | 系统形态、技术基线、运行时拓扑、HTTP / WebSocket / 异步链路、端口与环境变量、所有权与 Contract 流程                                    |
| [../apps/web-pc/README.md](../apps/web-pc/README.md) | PC 浏览器 Web 站的开发、构建与 `/pc/` 生产部署约定                                                                                     |
| [deployment.md](deployment.md)                       | 生产部署手册（Ubuntu + Bun 直跑，不用 Docker）：依赖安装、环境变量、systemd、反代与 HTTPS、发布/回滚、备份与硬约束                     |
| [dev-db-isolation.md](dev-db-isolation.md)           | 并行 worktree 独立开发数据库：`scripts/dev-db.ts`（`db:dev up/url/drop/list`）的库命名规则、建库/迁移/清理三步、独立容器指向与三条禁令 |
| [local-lint.md](local-lint.md)                       | 本地 `bun run lint` 只检查被跟踪文件：`scripts/lint.ts` 以 `git ls-files` 为唯一输入，避免本地未跟踪文件伪造 lint 红                   |
| [../CONTRIBUTING.md](../CONTRIBUTING.md)             | 文件所有权、分支与提交规范、PR 要求、Contract 流程、DB CHANGE REQUEST                                                                  |
| [../AGENTS.md](../AGENTS.md)                         | 给 AI agent 的命令、编码铁律、范围与实现纪律、对抗性审查流程                                                                           |
| [../README.md](../README.md)                         | 最小启动路径与常用命令                                                                                                                 |

## 关于文档职责

- **README.md**：给人看的快速上手。
- **AGENTS.md**：给 agent 看的操作规程。
- **CONTRIBUTING.md**：协作与所有权规则（放在根目录，GitHub 会在开 PR 时自动提示）。
- **docs/**：需要展开的系统性说明。

新增文档请放在本目录并在上表登记。
