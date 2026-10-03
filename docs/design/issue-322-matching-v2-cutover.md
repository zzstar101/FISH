# #322：Embedding 模型切换 / 回滚 runbook

本文件是 Owner 批准的操作流程，**不是 agent 操作生产的授权**。PR 先经 Owner 审核；以下生产步骤仅由部署操作者执行。
服务名称、代码路径与单 Worker 约束沿用 `docs/deployment.md` §5。模型变更不能仅改 `.env` 或仅生成向量就宣布完成。

## 前提与失败门禁

- 新模型必须支持当前固定1536维，与其匹配的语义质量须先通过独立验证；不假定不同模型共用同一cosine尺度。
- 记录旧/新模型名、provider配置来源和发布ref，备份配置到仓库外受限目录；不打印/提交密钥、连接串或完整用户文本。
- 旧模型的endpoint/credentials仍须可用；不删除旧模型向量。内容编辑可能按既有hash失效规则清理旧内容向量，回滚必须重建它们。
- 同一DB只允许一个常驻Worker；单个backfill进程默认并发1、最多4、默认1次HTTP/s（含重试，不积攒突发额度）。
- API保持运行，但 Worker 承担的匹配、通知及其它异步任务会延迟，维护窗口前明确告知Owner。
- 任一步失败，不放宽覆盖率、把FAILED当DONE或跳过重算；修复后重新过门禁。不得用 seed、删除业务实体或清空向量伪造覆盖率。
- 本轮开发验证仅授权 text-embedding-v4 / 1536维、累计≤200次HTTP；本文件中的新模型模板不扩大该授权。

## A. 切换新模型

### A1. 停 Worker，记录切换边界

```bash
sudo systemctl stop fish-worker
sudo systemctl is-active fish-worker   # 应为 inactive；不要停止 fish-api
cd /srv/fish
```

确认没有其它手工启动的Worker或自动重启来源。由DB控制台记录：

```sql
SELECT clock_timestamp() AS cutover_started_at;
```

保存该时间用于区分本次结算失败和历史失败。先保留运行配置中的旧模型；此时Worker不能自动启动。
`NEW_MODEL` 在下文表示经Owner批准的模型名，不是密钥。

### A2. 双侧回填，保留所有其它模型

```bash
# 由操作者先设 NEW_MODEL；Bun 从 /srv/fish/.env 读取已有配置，不把凭据放进命令行。
sudo -u fish -H env NODE_ENV=production /usr/local/bin/bun run embed:backfill --entity=both --model="$NEW_MODEL" --dry-run
sudo -u fish -H env NODE_ENV=production /usr/local/bin/bun run embed:backfill --entity=both --model="$NEW_MODEL" --requests-per-second=1
sudo -u fish -H env NODE_ENV=production /usr/local/bin/bun run obs:summary --model="$NEW_MODEL"
```

- dry-run必须为预期模型/1536维，目标范围是ACTIVE且APPROVED商品 + ACTIVE愿望。
- 正式backfill必须exit 0且failed=0；`stale`、`missing`需核实是否由正常编辑/删除导致，并补齐当前仍可匹配实体。
- `obs.embeddings.coverage.listings` 和 `.wishes` 都须 `withFreshVector == active`。`withAnyVector`/`withVersionFreshVector`不是通过条件。
- 回填期间API新增或编辑会改变目标范围，必要时重跑both（内容命中不再次计费）。不要用固定前缀 `--limit` 宣称全库补齐。
- backfill只投MATCH任务，没有跑完匹配；此时不能宣称切换完成。脚本无purge开关。

### A3. 切换配置，启动唯一新模型 Worker

修改 `/srv/fish/.env` 的 embedding模型/provider配置为批准的新配置，不改维度、ranking权重或阈值。
修改文件不等于刷新已启动进程；Worker必须重新启动。其它域的API若也缓存模型配置，按其部署要求单独核验并提前向Owner说明必要重启影响，本runbook不擅自停止API。

```bash
sudo systemctl start fish-worker
sudo systemctl is-active fish-worker
sudo journalctl -u fish-worker --since today
```

检查本次 `worker.started`：transport=live、model=NEW_MODEL、dimensions=1536、rankingVersion=2。
如果启动失败或model不符，立即停止该Worker，修正配置；不能让旧模型Worker处理新模型阶段的重算并宣称已升级。

### A4. 补齐增量，结算并核对匹配

在新模型Worker运行时再执行一次A2的双侧backfill，让暂停/初次回填期间新增或编辑的实体补齐并投重算。
继续用当前模型的obs摘要检查两侧新鲜覆盖率。模型名不同的向量不会进入同一cosine查询。

在DB控制台执行（`:cutover_started_at` 需设置为A1记录的值；下例采用psql变量写法）：

```sql
SELECT type, status, count(*)
FROM jobs
WHERE type IN ('EMBED_LISTING','EMBED_WISH','MATCH_LISTING','MATCH_WISH')
  AND (status IN ('PENDING','RUNNING') OR created_at >= :'cutover_started_at'::timestamptz)
GROUP BY type, status ORDER BY type, status;
```

门禁：所有本次任务完成且没有尚未处理的匹配/生成任务；本次FAILED必须逐条处理。历史FAILED不能被默认为成功，也不要误认为它们都是本次切换产生。
核验本次 `job.settled` 的模型与NEW_MODEL一致；常驻Worker只处理一个当前模型。API持续写入时要记录核验快照/时刻，出现新的pending就不能声称那个快照已全部结算。

检查当前有效ACTIVE对没有残留v1/空semantic（业务硬约束不能被这个检查替代）：

```sql
SELECT count(*) AS unresolved_active_matches
FROM matches m
JOIN wishes w ON w.id=m.wish_id
JOIN listings l ON l.id=m.listing_id
WHERE w.status='ACTIVE' AND l.status='ACTIVE' AND l.moderation_status='APPROVED'
  AND w.user_id<>l.seller_id AND (w.category IS NULL OR w.category=l.category)
  AND (w.budget_max_cents IS NULL OR l.price_cents::bigint<=2::bigint*w.budget_max_cents)
  AND m.score>=70 AND (m.ranking_version<>2 OR m.semantic_score IS NULL);
```

应为0。`ranking_version=2`本身不记录embedding模型，因此**不能单独证明新模型重算完成**；还必须满足两侧指定模型新鲜覆盖、任务结算与model日志。
抽查本次匹配的两方向口径、明确冲突降级、首次有效通知幂等；保存脱敏计数、版本、任务ID和必要分项。
上述门禁全部通过才可结束维护窗口。持续编辑导致stale/pending时继续补齐，不靠删数据或改阈值过门禁。

## B. 回滚旧模型（不是只恢复配置）

1. 再暂停唯一Worker，记录新的回滚开始DB时间。API仍运行，明确告知异步延迟。
2. 检查OLD_MODEL的原provider配置和1536维输出仍可用。**旧向量存在不等于新鲜**；恢复旧endpoint/credentials供backfill使用，但Worker仍保持停止。
3. 执行A2，换成 `--model="$OLD_MODEL"`：both回填、exit 0/failed 0、两侧旧模型withFreshVector==active；新模型向量也不purge。
4. 将运行配置切回OLD_MODEL，再启动唯一Worker，确认启动model正确。
5. 按A4重跑both补增量、等待旧模型重算结算、核对当前有效对、检查model日志与通知幂等。
6. 所有回滚门禁通过后才宣称回滚完成；如果旧模型不可用、覆盖不齐或出现FAILED，报告阻塞并保持维护状态，不能用错误模型混查。

## C. 交付证据

至少保存：旧/新模型标识与ref、两个DB开始时刻、Worker停止/启动状态、两侧回填摘要、按指定模型覆盖率、队列结算计数与失败处理、当前有效对版本核对、两方向及通知抽查。不得记录密钥、完整私密描述或向量。

当前开发验收尚无生产切换/回滚操作记录，不声称已经在生产执行。隔离库里的模型共存与生命周期回归只验证软件行为，不代替Owner上线操作。

由 AI agent 协助编写，遵循Owner已确认的维护窗口、保留旧向量与双侧重算门禁。
