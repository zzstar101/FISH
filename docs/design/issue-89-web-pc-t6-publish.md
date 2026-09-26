# PC Web T6：发布闲置

> 状态：设计，待实现。依赖 T3。图片编辑另归 #74。
> 主跟踪：GitHub #89「B：Web 桌面版前端」。

## 1. 范围

交付 PC 发布页：

- 选择 1–9 张图片并直传对象存储。
- 填写标题、描述、价格、分类、成色、急出/可小刀/免费送。
- AI 文案润色。
- 提交 `POST /listings`。
- 发布成功进入商品详情或“我的在售”目标页。

不实现编辑换图、删除图片或多商品批量发布。

## 2. 后端契约

上传：

- `POST /uploads/presign`
- 浏览器直传返回的 `uploadUrl`
- `POST /uploads/confirm`

创建：

- `POST /listings`

AI：

- `POST /ai/polish-candidates`

所有请求与响应用 `@fish/contracts` schema 收口。

## 3. 图片流程

单张图片状态：

```text
idle → uploading → uploaded
              └── failed → retry
```

每个槽位：

1. 本地校验 MIME、大小、数量。
2. 调 presign。
3. PUT 到对象存储，使用响应 `headers`。
4. confirm。
5. 保存 `objectKey`；仅 uploaded 槽位参与提交。

重试会生成新对象键；旧对象作为孤儿对象处理，客户端不自行删除。

## 4. 表单与 AI

- 标题 2–40 字，描述 1–500 字。
- 价格为整数分，上限契约为准。
- 勾选免费送时价格必须为 0。
- 分类、成色使用契约枚举。
- AI 请求只在用户显式触发时发送。
- 候选切换不重复请求；采用候选前原表单不变。
- `provider=stub` 必须显示“演示文案”标识。

## 5. 错误语义

- `LISTING_CONTENT_BLOCKED`：字段级错误，保留表单。
- `LISTING_CONTENT_REVIEW`：成功提交但状态审核中，明确说明未进入公开列表。
- `AI_POLISH_QUOTA`：显示重试时间，不自动重试。
- `AI_TIMEOUT` / `AI_UPSTREAM_ERROR` / `AI_RESULT_EMPTY`：保留原文，可手动重试；空结果显示“没有可用候选”。
- `AI_NOT_CONFIGURED`：显示能力未开通，不自动重试。
- 上传/创建失败不得显示成功。

## 6. 文件结构

```text
apps/web-pc/src/features/publish/
├── api.ts
├── queries.ts
├── publish-page.tsx
├── image-uploader.tsx
├── ai-polish-panel.tsx
└── form-model.ts
apps/web-pc/src/routes/publish.tsx
```

## 7. 验收标准

- [ ] 1–9 张图片可上传、失败可单独重试。
- [ ] 未上传完成的图片不能提交。
- [ ] 免费送价格约束正确。
- [ ] AI 候选正常、超时、限流、空结果均有明确状态。
- [ ] REVIEW / BLOCK 与移动端语义一致。
- [ ] 发布成功与失败不混淆。
- [ ] 切号或离开页面后迟到上传/AI 响应不写回新账号。

## 8. 非目标

- 编辑已有商品的图片。
- 草稿云端同步。
- 图片裁剪和压缩后端能力。
- 平台支付或物流。
