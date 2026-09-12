## 关联 Issue

closed #

## 改动内容

<!-- 简述做了什么，以及为什么这样做 -->

## 文件所有权

- [ ] 本次改动**未**修改他人拥有的目录（所有权见 CONTRIBUTING.md 第 2 节）
- [ ] 若修改了他人目录，已在该 Issue/PR 说明并取得 Owner 同意（Owner：）

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

## DB CHANGE REQUEST

<!-- 需要 zzstar101 修改 schema/migration 时填写；无则删除本节 -->

```text
DB CHANGE REQUEST
- 表/实体：
- 需要的字段与类型：
- 使用场景（对应 Issue）：
- 是否影响已有数据：
```

## 安全检查

- [ ] **未提交任何真实密钥**、Token 或生产连接串
- [ ] 未手改生成文件（`apps/web/src/routeTree.gen.ts`、`packages/db/src/migrations/**`）
- [ ] 未引入 Issue 范围外的新依赖或无关重构
