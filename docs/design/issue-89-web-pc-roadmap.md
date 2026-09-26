# PC Web 剩余任务路线图

> 状态：设计文档。实现必须按任务单独开分支和 PR，本文件不授权跨任务一次性开发。
> 主跟踪：GitHub #89 的「B：Web 桌面版前端」。

## 1. 已交付

| 阶段 | 内容 | PR |
| --- | --- | --- |
| T0 | `/pc/` 骨架、认证复用、构建/CI/部署 | #238 |
| T1 | 关键词、分类、排序、URL 恢复、cursor 搜索 | #239 |
| T2 | 商品详情只读页、图片画廊、卖家与状态 | #255 |

## 2. 剩余设计文档

| 阶段 | 设计 | 依赖 |
| --- | --- | --- |
| T3 | [登录态与账号作用域收口](issue-89-web-pc-t3-auth-scope.md) | T2 |
| T4 | [消息中心](issue-89-web-pc-t4-messages.md) | T3 |
| T5 | [商品详情互动](issue-89-web-pc-t5-detail-interactions.md) | T4 |
| T6 | [发布闲置](issue-89-web-pc-t6-publish.md) | T3 |
| T7 | [通知中心](issue-89-web-pc-t7-notifications.md) | T3 |
| T8 | [我的、在售与订单](issue-89-web-pc-t8-profile-orders.md) | T3、T4、T6 |
| T9 | [许愿墙与匹配](issue-89-web-pc-t9-wish-match.md) | T3、T4 |
| T10 | [发布收口与运行验收](issue-89-web-pc-t10-release-hardening.md) | T3–T9 |

## 3. 依赖顺序

```text
T3 账号作用域
├── T4 消息中心
│   ├── T5 详情互动
│   └── T8 我的/订单
├── T6 发布
│   └── T8 我的/订单（复用上传能力）
├── T7 通知
└── T9 许愿/匹配（复用 T4 会话）
        └──────────────┐
T3–T9 ─────────────────┴── T10 发布收口
```

## 4. 分支与 PR 规则

1. 每个 Tn 一个分支，不把多个阶段混在同一 PR。
2. 若前序 PR 未合并，可从上一阶段分支堆叠，PR base 指向前一阶段。
3. 前序 PR 合并后，后续 PR 必须及时改 base 到 `main` 或最新上游分支并 rebase。
4. 不在页面 PR 中顺手增加没有契约支持的后端能力。
5. 页面实现只放 `apps/web-pc`；共享契约从 `@fish/contracts` 读取。

## 5. Contract / ID 边界

- 当前阶段使用仓库现有 DTO 和路由常量，不自行发明 ID 编码。
- #217 的 TypeID / 编号搜索若尚未合入，不得在 PC 页面中提前假设前缀 ID。
- 接入 #217 前，每项任务必须盘点自己的 URL 参数、DTO、query key 和 cursor 是否把 UUID 当稳定展示编号。
- 公开编号、复制编号和搜索编号必须等 #217 冻结契约后另行接；本路线图不替代该任务。

## 6. 明确不做

- 不把 `apps/web` 的 Admin 页面迁到 `/pc/admin`。
- 不做 Electron / Tauri。
- 不在后端未就绪时用 fixture 冒充真实收藏、关注、评价、Watchers 或市场指标。
- 不因 PC 页面需要而重做移动端 PWA。
