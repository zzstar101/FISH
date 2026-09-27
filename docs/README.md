# 文档索引

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 系统形态、技术基线、运行时拓扑、HTTP / WebSocket / 异步链路、端口与环境变量、所有权与 Contract 流程 |
| [../apps/web-pc/README.md](../apps/web-pc/README.md) | PC 浏览器 Web 站的开发、构建与 `/pc/` 生产部署约定 |
| [design/issue-89-web-pc-roadmap.md](design/issue-89-web-pc-roadmap.md) | PC Web 剩余任务路线图与依赖顺序 |
| [design/issue-89-web-pc-t3-auth-scope.md](design/issue-89-web-pc-t3-auth-scope.md) | PC Web T3：登录态与账号作用域缓存隔离 |
| [design/issue-89-web-pc-t4-messages.md](design/issue-89-web-pc-t4-messages.md) | PC Web T4：消息中心 |
| [design/issue-89-web-pc-t5-detail-interactions.md](design/issue-89-web-pc-t5-detail-interactions.md) | PC Web T5：商品详情互动 |
| [design/issue-89-web-pc-t6-publish.md](design/issue-89-web-pc-t6-publish.md) | PC Web T6：发布闲置 |
| [design/issue-89-web-pc-t7-notifications.md](design/issue-89-web-pc-t7-notifications.md) | PC Web T7：通知中心 |
| [design/issue-89-web-pc-t8-profile-orders.md](design/issue-89-web-pc-t8-profile-orders.md) | PC Web T8：我的、在售与订单 |
| [design/issue-89-web-pc-t9-wish-match.md](design/issue-89-web-pc-t9-wish-match.md) | PC Web T9：许愿墙与匹配 |
| [design/issue-89-web-pc-t10-release-hardening.md](design/issue-89-web-pc-t10-release-hardening.md) | PC Web T10：发布收口与运行验收 |
| [deployment.md](deployment.md) | 生产部署手册（Ubuntu + Bun 直跑，不用 Docker）：依赖安装、环境变量、systemd、反代与 HTTPS、发布/回滚、备份与硬约束 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 文件所有权、分支与提交规范、PR 要求、Contract 流程、DB CHANGE REQUEST |
| [../AGENTS.md](../AGENTS.md) | 给 AI agent 的命令、编码铁律、范围与实现纪律、对抗性审查流程 |
| [../README.md](../README.md) | 最小启动路径与常用命令 |
| [design/issue-147-transaction-invariants.md](design/issue-147-transaction-invariants.md) | #147 交易 / 面交剩余项设计方案（两个 PR 的切分、不变量清单、验证门禁） |

## 关于文档职责

- **README.md**：给人看的快速上手。
- **AGENTS.md**：给 agent 看的操作规程。
- **CONTRIBUTING.md**：协作与所有权规则（放在根目录，GitHub 会在开 PR 时自动提示）。
- **docs/**：需要展开的系统性说明。

新增文档请放在本目录并在上表登记。
