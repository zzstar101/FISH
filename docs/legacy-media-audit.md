# #694 M8：存量图片盘点与补审

本模块处理 **上线当前审核链路之前** 就已存在、且仍可能被公开读取的图片（商品图 / 评价图 / 聊天图）。
它只补审核结论与可见性，不物理删除证据。

## 1. 数据模型

`legacy_media_audit_items` 一行 = **一个对象键**，不是一条业务引用：

- `source_kind`：`LISTING` / `REVIEW` / `CHAT`；`source_refs` 记录全部业务引用（商品 / 评价 / 消息）与归属。
- `public_visibility`：`PUBLIC_DIRECT`（`listings/*`）、`LEGACY_PROXY`（历史 raw-UUID 键）、
  `PRIVATE_PROXY`（`reviews/*`）、`PRIVATE`（聊天媒体）。
- `existing_decision`：盘点时已有的审核结论（没有台账的 legacy 图为空）。
- `audit_status`：`PENDING`（待补审 / 可重试失败）、`AUDITED`、`FAILED`（不可重试失败）。
- 补审结论：`decision`、`provider`、`policy_version`、`suggestion` / `label` / `score`、
  `content_digest`（本地 sha256）、`size_bytes`、`mime_type`。
- `reference_count` / `listing_reference_count` / `owner_count`：共享引用画像；`source_refs` 保留逐个引用。
- `version`：人工复核的乐观并发版本。机器补审不碰它，管理端每次放行 / 拒绝 `+1`，过期版本提交返回 409。

**盘点只写本表，不改任何业务行。** 重复执行按 `object_key` upsert 业务引用与可见性，不覆盖已出的补审结论。

范围（票面点名的三类）：

- 商品图：`listing_images.object_key LIKE 'listings/%'`，且 `listing_media_objects.final_key` 无台账；
  排除 seed 键 `listings/seed-*`。
- 评价图：`transaction_review_images.object_key LIKE 'reviews/%'`，且 `review_moderation_records.final_key` 无台账。
- 聊天图：`message_media.kind = 'IMAGE'`，且 `chat_moderation_records.message_id` 无记录。

## 2. 盘点与进度

```bash
bun run legacy:media:inventory     # 只读扫描 + 汇总
bun run legacy:media:status        # 汇总 + 待处理样本
bun run legacy:media:retry-failed  # 把 FAILED 重置为 PENDING，等下一轮重新补审
```

前两个命令输出 JSON；`pendingSample` 最多 100 条，完整进度看 `summary.byStatus` / `byDecision` /
`bySourceKind` / `byPublicVisibility`。盘点可断点续跑：重复执行不会清空或重复插入。

`legacy:media:retry-failed` 默认最多重排 100 条，可用 `--limit <n>` 与 `--before <ISO 时间>` 限定数量与
时间范围（例如 `bun run legacy:media:retry-failed -- --before 2026-11-01T00:00:00Z`）。重排会把
`attempts` 归零，因为那本来就是「这一批不再自动重试」的终态；重排是人工判断后的显式动作。

## 3. 补审 job

worker 的 `SCHEDULES` 按 `LEGACY_MEDIA_AUDIT_INTERVAL_MS` 周期从 inventory 取未审记录（`attempts < 上限`
且 `next_attempt_at <= now`），逐对象 enqueue `LEGACY_MEDIA_AUDIT` job；job 由现有队列认领、重试与回收。

每个 job：

1. 读取对象真实字节（`WorkerMediaStorage.readBytes`，超过 `LEGACY_MEDIA_AUDIT_MAX_IMAGE_BYTES` 视为不可读）；
2. 以魔术字节判定 MIME，计算本地 sha256；
3. 调用 IMS：商品图 / 评价图用 `TENCENT_IMS_UGC_BIZ_TYPE`，聊天图用 `TENCENT_IMS_CHAT_BIZ_TYPE`；
   本地 transport 一律 `REVIEW`（`LOCAL_IMAGE_NOT_AUDITED`）；
4. 校验 IMS `FileMD5` 与本地 MD5 一致，结论 + 摘要落 inventory；
5. 同一事务内落实商品可见性（见下）；失败只更新 inventory，**不改业务可见性**。

失败分两类：超时、网络、5xx、限流、读存储瞬时失败属于**可重试**，保持 `PENDING` 并退避到
`next_attempt_at`；MIME / 大小 / 摘要不符、对象确实不存在、上游明确拒绝属于**确定性失败**，直接
`FAILED`。`401 / 403` 视为整批配置问题：记录失败但标为可重试，避免配置修好后仍要靠人工清库；
重试耗尽后仍可 `legacy:media:retry-failed` 重排。

幂等：`object_key` 唯一 + 结论落库；同一对象重复 job 直接返回 `already_audited`，不会重复建记录。
并发：队列 `FOR UPDATE SKIP LOCKED` 认领，同一对象在 `finalize` 时再次 `SELECT ... FOR UPDATE`。

### 配置（全部可选）

| 变量                                 | 默认      | 说明                                   |
| ------------------------------------ | --------- | -------------------------------------- |
| `LEGACY_MEDIA_AUDIT_ENABLED`         | `true`    | `false` 关闭调度（job 仍可被手动入队） |
| `LEGACY_MEDIA_AUDIT_BATCH_SIZE`      | `10`      | 每轮最多入队多少个对象                 |
| `LEGACY_MEDIA_AUDIT_INTERVAL_MS`     | `30000`   | 调度间隔                               |
| `LEGACY_MEDIA_AUDIT_MAX_ATTEMPTS`    | `3`       | 同一对象补审尝试上限                   |
| `LEGACY_MEDIA_AUDIT_RETRY_DELAY_MS`  | `60000`   | 可重试失败后的退避                     |
| `LEGACY_MEDIA_AUDIT_MAX_IMAGE_BYTES` | `5000000` | 读取上限；超过按不可读处理             |

IMS 使用现有 `CONTENT_MODERATION_*` / `TENCENT_*` 策略号，不新增策略号。

## 4. 可见性口径

读路径按 inventory 行判定：**没有行 = 历史兼容（保持原行为）；有行 = 仅 `AUDITED + ALLOW` 可公开读**。
`PENDING` / `FAILED` 与 `REVIEW` / `BLOCK` 一律 fail-closed。

- 商品详情：非本人视角隐藏非 `ALLOW` 的图；封面若不可见则 `coverUrl = null`；Feed / 批量卡片查询由
  listing service 主动过滤封面。其余卡片投影仍拼 legacy 代理 URL，由下面的代理二次判定兜底。
  卖家本人仍看到全部图（改图 / 回出物页）。
- `/api/uploads/legacy/:token`：先按请求者判定。能认证且是该商品**卖家**、**管理员**，或与该商品有
  订单 / 纠纷关系的**当事人**（买家、卖家、纠纷发起人 / 被申请人）时，即使 `PENDING` / `REVIEW` / `BLOCK`
  也允许读取，响应 `Cache-Control: private, no-store`；其余请求回落到公开口径
  `isLegacyMediaPubliclyReadable`（仅 `AUDITED + ALLOW`），不通过直接 404，且不访问对象存储。
- 评价：`review_moderation_records` 优先；没有记录的 legacy `reviews/*` 仍按 #475 默认 `ALLOW`，
  但 inventory 已有结论时以补审结论为准（`REVIEW` / `BLOCK` 隐藏）。
- 聊天：媒体 GET 仍要求会话参与者；补审结论写入审计行，聊天本就没有匿名公开面，因此不改变参与者读取路径。
- 对象存储层：匿名策略只放行 `listings/usr_*/*` 与 `listings/seed-*/*`；历史 raw-UUID 键不再能直读桶，
  只能走 API 的加密 token 代理（代理再套上面的可见性判断）。

`REVIEW` 商品写 `listings.moderation_status = 'REVIEW'` + `listing_moderation_records`（action
`LEGACY_MEDIA_AUDIT`），因此直接进入现有管理端商品审核队列；`BLOCK` 同理写 `BLOCKED` +
`PROHIBITED_CONTENT`。不写 `governance_delisted_at`（那是治理下架，需人工恢复）。

## 5. 暂停 / 回滚

- **暂停补审**：`LEGACY_MEDIA_AUDIT_ENABLED=false` 后重启 worker；已在跑的 job 会自然结束，
  不再产生新批次。已出的结论与可见性保持。
- **回滚可见性**：不要直接删 inventory 行（会丢失审计证据）。管理端有两处入口，二者都会同步审计行：
  - `/admin/legacy-media/audit`：按审计记录复核商品图 / 评价图 / 聊天图。决定写
    `admin_audit_logs`（`LEGACY_MEDIA_AUDIT_DECISION`），并把该行 `decision` 改为 `ALLOW` / `BLOCK`、
    `version + 1`；`BLOCK → ALLOW` 也走这里恢复。
  - 现有商品审核队列：对 `REVIEW` 商品放行 / 拒绝时，同一事务把该商品引用的、结论为 `REVIEW` 的审计行
    一并改为 `ALLOW` / `BLOCK`，随后 legacy 代理立即按新结论放行或继续 404。
    需要批量恢复时按上述入口处理，不要绕过审核直接改库。
- **回滚部署**：先暂停 worker，再回滚代码；如需撤销 schema，可在确认无证据保留需求后执行

  ```sql
  DROP INDEX IF EXISTS jobs_legacy_media_audit_object_key_pending_uidx;
  DROP TABLE IF EXISTS legacy_media_audit_items;
  DROP TYPE IF EXISTS legacy_media_audit_status;
  DROP TYPE IF EXISTS legacy_media_public_visibility;
  DROP TYPE IF EXISTS legacy_media_source_kind;
  ```

  删除后读路径回到"无行 = 历史兼容"，商品审核状态仍是已写入的 `REVIEW` / `BLOCKED`，需按上一条单独处理。

## 6. 观测

worker 只打结构化元数据：

- `legacy_media_audit.audited`：`objectKey`、`sourceKind`、`decision`、`listingsAffected`；
- `legacy_media_audit.failed`：`objectKey`、`sourceKind`、`reason`、`retryable`、`attempts`、`auditStatus`；
- `legacy_media_audit.storage_read_error`：读对象抛出瞬时异常（超时 / 网络 / 5xx / 限流），随后按可重试失败处理；
- `legacy_media_audit.missing`：job 指向的对象已不在 inventory。

**不记录图片字节、base64、上游原始响应或用户文本。** 需要定位图片时用 `object_key` 与
`content_digest`（sha256）。

## 7. 上线顺序

1. `bun run db:migrate`（新增表 / 枚举 / job 去重索引）；
2. 重新应用 MinIO 匿名策略（`docker compose run --rm minio-init` 或部署机脚本），确认只放行
   `listings/usr_*/*`、`listings/seed-*/*`；
3. 部署 API（读路径开始按新表 fail-closed）；
4. 跑 `bun run legacy:media:inventory` 建立基线；
5. 启动 / 重启 worker 开补审，用 `bun run legacy:media:status` 看进度。

## 8. 边界

- 票面 M8 的第 4 步「确认无遗留后再移除 `storedKeys` 历史豁免」不在本次改动内：inventory 与补审先把存量
  收口，移除豁免需要确认盘点结果后再单独改，避免新对象伪装成 legacy 键。
- 不做对象迁移 / 物理删除；`ALLOW` 的 legacy 对象保留原键，`REVIEW` / `BLOCK` 只改可见性与业务引用状态。
- 聊天图没有匿名公开面；补审结论不改变参与者读取，也不做物理删除。
- 三类来源的人工复核都走 `/admin/legacy-media/audit`（单独的审计队列，按 `lma_` 公开 ID 定位，媒体字节
  由 `/admin/legacy-media/audit/:id/media` 代理，响应 `private, no-store`，DTO 不返回 `objectKey`）。
  评价图 / 聊天图**不伪造** `review_moderation_records` / `chat_moderation_records`：它们的 `staging_key`、
  私有快照与放行流程假定当前链路生成的键，硬塞 legacy 键会绕过现有迁移与校验。
- 商品图仍保留两层入口：补审发现 `REVIEW` 会把商品送进现有商品审核队列；该队列的放行 / 拒绝会同步
  审计行，因此不需要两边各处理一次。
