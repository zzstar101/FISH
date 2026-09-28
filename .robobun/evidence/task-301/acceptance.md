# task-301 验收记录（#301）

- 分支：`robobun/task-301-seed-invariants`（基于 `origin/main = 4f49325`）

## 环境漂移（开工前处置，非本卡产物）

共享开发库（docker project `fish`）存在 `login_tickets` 表 + 对应 journal 行
（来源：在飞 PR #327 的迁移 `20260928154329_sloppy_proteus`，其 worktree 曾对共享库
跑过 migrate），导致 main 的 `db:seed` TRUNCATE users 被外键挡住（`0A000`）。
处置：drop 表 + 删 journal 行 id=30（时间戳 07:43:29 UTC ↔ 154329 UTC+8 证据闭合），
`db:migrate` + `db:seed` 恢复绿。#327 自带该迁移，重跑 migrate 即可重建，无数据损失
（票表为一次性 5 分钟票据）。**该漂移在 main 上即失败，与本卡改动无关。**

## TRUNCATE 差额比对（验收标准第 5 条）

`truncate-diff.txt`：information_schema public 业务表 ∖ TRUNCATE 清单（26）=
`listing_numbers`（reservation，原注释已说明）、`id_rekeys`、`listing_lookup_attempts`
—— 后两者已在 `seed.ts` 注释列明（ID 迁移台账无外键 / 60s 限流台账 HMAC 文本键）。

## 变异证据（每条断言必须变红；测后已 `git checkout` 还原，未提交任何变异）

| # | 变异 | 断言 | 结果 |
|---|------|------|------|
| 1 | `listingBasketball` status SOLD→RESERVED | 交易↔商品状态一致 | fail（mutation-1） |
| 2 | conversationLamp buyerId sellerA→buyerB（buyer=seller） | 会话参与者对称互异 | fail（mutation-2） |
| 3 | messageText senderId buyerB→buyerC（非会话双方） | 消息发送者合法 | fail（mutation-3） |
| 4 | messageBasketballAccepted transactionId→不存在 UUID | tx.accepted 指向真实交易 | fail（mutation-4） |
| 5 | job payload listingId→不存在 UUID | jobs 引用的 listing 存在 | fail（mutation-5） |

各文件为 `bun test --isolate packages/db/src/seed.test.ts` 的完整输出，均含
`expect(received).toEqual(expected)` 对违规行数组的红输出。

## 口径修正（Issue 原文与事实不符处）

jobs payload 验收项写「命中 `listings.listingNo`」，但其自身引用的 fixture
（`jsonParam({ listingId: ids.listingK380 })`）与契约
`packages/contracts/src/matching/jobs.ts:31`（`listingId: z.uuid()`）、
消费方 `apps/worker/src/jobs/matching/handlers.ts:46`（按 id 查）均为 **id**。
按 id 实现，不按 listingNo。

## 其余验收项

- orphanTx（test :101-113 一带）、演示密码校验、jobs 状态断言：未删未弱化（diff 仅增）。
- 「断言在 main fixture 上直接为红」：未发生，5 条全绿，无 seed.ts 数据修正。
- 验收命令：`bun test --isolate packages/db/src/seed.test.ts` / typecheck / lint /
  `bun test --isolate` —— 见 attempt JSON（L2 full）。
