## 关联 Issue

closed #

## 改动内容

<!-- 简述做了什么，以及为什么这样做 -->

## 改动范围

- [ ] 本次改动是否触碰**跨模块公共文件**或他人正在进行的模块代码（若是，请在下方说明大致影响；改动他人文件无需事先取得同意）

## 验收标准

<!-- 逐条对应 Issue 的验收标准，给出可复现的验证命令与结果 -->

- [ ]
- [ ]

## 验证方式

```bash
bun run typecheck
bun run lint
bun test
```

## DB 变更说明

<!-- 改动 database schema 时填写；必须用 drizzle-kit 生成 migration、禁止手改 migration 历史。无 schema 改动则删除本节 -->

```text
DB 变更说明
- 表/实体：
- 新增/修改的字段与类型：
- 使用场景（对应 Issue）：
- 是否影响已有数据：
```

## 安全检查

- [ ] **未提交任何真实密钥**、Token 或生产连接串
- [ ] 未手改生成文件（`apps/web/src/routeTree.gen.ts`、`packages/db/src/migrations/**`）
- [ ] 未引入 Issue 范围外的新依赖或无关重构
- [ ] 若本次改动过依赖：`bun.lock` 未被镜像源污染（`grep -oE 'https?://[^"]+' bun.lock | grep -vE '^https://registry\.npmjs\.org/' && echo '被污染了' || echo '干净'` 应输出「干净」；加依赖时已带 `--registry https://registry.npmjs.org`，见 CONTRIBUTING.md 第 3.1 节）
