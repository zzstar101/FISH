-- #147：面交凭证改为「随交易生命周期」（PENDING_MEETUP 内长期有效），下一步（0016）会
-- 删除 expires_at 列。旧语义下，存在这样的历史行：
--   transactions.status = 'PENDING_MEETUP' AND consumed_at IS NULL AND expires_at <= now()
-- 它们是已过期、不可核销的凭证（服务层派生为 EXPIRED）。若直接 drop column，新代码会把
-- 同一行派生为 ISSUED —— 已失效的历史 6 位码 / QR token 会复活成长期有效凭证。
-- 因此必须在 drop column **之前**显式清理：只删「未消费且已过期」的行。
--
-- 刻意不整表清空：consumed_at 非空的行（核销成功、交易仍 PENDING_MEETUP，等买家 confirm）
-- 承担「买家 confirm 网络失败后恢复确认入口」的语义，删掉会让客户端无法恢复。
-- 终态（COMPLETED / CANCELLED）交易上的遗留行由 getMeetupTokenStatus 的终态守卫兜住
-- （非 PENDING_MEETUP 一律派生 NONE），不在此处删除。
DELETE FROM "transaction_meetup_tokens"
WHERE "consumed_at" IS NULL
  AND "expires_at" <= now();
