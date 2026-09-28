# PC Web 未接通能力盘点

> **基线**：分支 `codex/web-pc-t10-release-hardening` @ `f4e8e3b`（PR #283）。
> **盘点日期**：2026-09-27。
> **口径**：只核对 `apps/web-pc` 的实际代码，不采信规划文档的承诺。
> - 「完全未接通」= PC 端在该基线里没有实现、也没有入口。
> - 「有缺口」= 已接真实 API，但能力不完整（分页、深链、类型等）。
> - 「演示态」= 前端已接真实接口，但当前环境开关让它返回演示结果。
>
> **证据路径**均相对仓库根；行号对应该基线，代码改动后需重新核对。行号可用 `sed -n '<行>p' <文件>` 复现。

---

## 一、完全未接通（PC 无入口 / 无实现）

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 微信登录 / 扫码登录 | 登录页只有学号 + 密码两个输入框 | `apps/web-pc/src/routes/login.tsx:75`（学号 `TextField`）、`:86`（密码 `TextField`）；T3 设计非目标「不实现 #197 微信扫码登录」 |
| 忘记密码 / 重置密码 | 无路由、无入口 | `apps/web-pc/src/features/auth/` 只有 `api / auth-provider / error-messages / form / queries / require-auth`；`ls apps/web-pc/src/routes` 无相关路由 |
| 校园认证（教育邮箱验证码） | PC 无入口，只有注册页文案提示 | `apps/web-pc/src/routes/register.tsx:57`「校园认证需另行完成教育邮箱验证」 |
| 手机号绑定 | 个人中心只展示绑定状态，无绑定操作 | `apps/web-pc/src/features/profile/profile-page.tsx:83`「未绑定手机号」 |
| 收藏 / 关注 | 无任何代码 | `grep -rniE "收藏\|favorite\|关注\|follow" apps/web-pc/src` 无命中；roadmap §6 明确不做 |
| 评价 / 我的留言 | 无任何代码 | T5 设计非目标；同上的 grep 无命中 |
| 浏览历史 | 无任何代码 | T8 设计非目标 |
| 举报入口 | 无任何代码 | `grep -rniE "举报\|report" apps/web-pc/src` 无命中（#217 治理范围） |
| 个性签名 | 编辑资料只提交昵称 + 头像 | `apps/web-pc/src/features/profile/profile-edit.tsx:151` 只组装 `nickname` / `avatarObjectKey`；T8 非目标「真实个性签名 #179」 |
| 设置页（主题 / 通知偏好 / 协议 / 隐私） | 无该路由 | `ls apps/web-pc/src/routes` 无 `settings*` |
| Admin 控制台 / 审核队列 | 无 | roadmap §6「不把 `apps/web` 的 Admin 页面迁到 `/pc/admin`」 |
| 商品图片替换 | 编辑弹窗只改文字 / 价格 / 展示项 | `apps/web-pc/src/features/profile/edit-listing-dialog.tsx:131`「图片替换仍不在 PC 本阶段范围内」 |
| 面交码 / 核销凭证 | 只有「确认完成面交」，无凭证展示与核销 | `apps/web-pc/src/features/profile/order-detail-page.tsx:151`（面交进度）、`:218`（确认完成面交）；T8 设计非目标 |
| 分享 / 复制链接 | 无 | `grep -rniE "navigator\.clipboard\|分享\|share" apps/web-pc/src` 只命中一句营销文案 |
| 通知实时推送 | 无 WebSocket、无轮询，进入页面才刷新 | `grep -rn "refetchInterval\|realtime\|WebSocket" apps/web-pc/src/features/notifications` 无命中；T7 设计非目标 |
| 搜索公开编号（#217） | 只支持关键词 / 分类 / 排序 / cursor | `docs/design/issue-89-web-pc-t10-id-inventory.md` 结论 |
| 移动端折叠布局 / PWA / 离线 | 非目标；PC 按桌面视口设计 | T10 设计 §9；`apps/web-pc/src/styles.css` 的 `body` 最小宽度策略 |

---

## 二、已接通但有明确缺口

| 功能 | 缺口 | 证据 |
| --- | --- | --- |
| 首页商品流 | 只取第一页 24 条，无「加载更多」 | `apps/web-pc/src/routes/index.tsx:19`「真实 API · 第一页 24 条」 |
| 我的发布 | 最多 50 条，无分页 | `apps/web-pc/src/features/profile/mylist-page.tsx:67`；`apps/web-pc/src/features/profile/api.ts:39` 固定 `limit: 50` |
| 订单列表 | 最多 50 条；接口支持 `cursor` 但 PC 不翻页 | `apps/web-pc/src/features/profile/orders-page.tsx:69`；`apps/web-pc/src/features/profile/api.ts:45` |
| 通知列表 | 最多 50 条，无分页 / 删除 / 批量已读 | `apps/web-pc/src/features/notifications/api.ts:11`；T7 设计非目标 |
| 只有 `wishId` 的通知 | 不能跳对应愿望，只提示「后续版本开放」 | `apps/web-pc/src/features/notifications/notification-view.ts:45` |
| 订单号 | 直接把内部 UUID 当「订单号」展示 | `apps/web-pc/src/features/profile/order-detail-page.tsx:110`；T10 盘点文档登记为 #217 必办 |
| 消息类型 | 只有 `TEXT` / `SYSTEM`，无图片 / 语音 | `apps/web-pc/src/features/chat/message-bubble.tsx:23`；T4 设计非目标 |
| 聊天增强 | 无 typing、撤回、删除、转发、消息搜索 | T4 设计 §7 非目标；grep 无命中 |
| 评论区 | 无多层评论树、编辑、删除、举报、图片留言 | T5 设计 §7 非目标 |
| 发布 | 无草稿云端同步、图片裁剪压缩、平台支付 / 物流 | T6 设计 §8 非目标 |
| 愿望 | 无愿望公开主页、无新匹配算法 | T9 设计 §7 非目标 |

---

## 三、接口已接、当前环境是演示态

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| AI 润色 | 前端已接真实接口，但当前 `AI_POLISH_TRANSPORT=stub`，返回演示文案（页面挂「演示文案」徽标） | `apps/web-pc/src/features/publish/ai-polish-panel.tsx:57`；API 启动日志 `[api] AI_POLISH_TRANSPORT=stub：润色返回的是演示文案，不是真实模型输出` |
| 内容安全审核 | 当前 `CONTENT_MODERATION_TRANSPORT=local`（本地词表，非真实审核）；生产必须 `tencent` | `apps/api/src/index.ts:37` 的启动日志；`docs/deployment.md` 的 #228 段；`packages/shared/src/env.ts` 的校验 |

---

## 四、可复现核对命令

```bash
cd apps/web-pc

# 路由与页面清单
ls src/routes
ls src/features

# 显式的「未接通 / 演示」字样
grep -rn '占位\|未接入\|尚未\|后续版本\|暂未\|演示\|fixture\|mock\|stub' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# 收藏 / 关注 / 评价 / 浏览历史 / 个性签名 / 面交码 / 举报
grep -rniE '收藏|favorite|关注|follow|评价|浏览历史|签名|signature|面交|meetup|举报|report' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# 分页能力对比：有 useInfiniteQuery 的地方才算真分页
grep -rn 'useInfiniteQuery\|getNextPageParam\|fetchNextPage' src
```

---

## 五、结论来源

- 各任务设计文档的「非目标」章节：`docs/design/issue-89-web-pc-t*.md`。
- 路线图明确不做项：`docs/design/issue-89-web-pc-roadmap.md` §6。
- ID / 编号边界：#217，见 `docs/design/issue-89-web-pc-t10-id-inventory.md`。
