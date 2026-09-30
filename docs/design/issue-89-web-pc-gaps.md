# PC Web 未接通能力盘点

> **基线**：`origin/main = b641fd716047e8f11b21b76741e0882028ed0ff4`（2026-09-30 实测）。
> **上一版**：分支 `codex/web-pc-t10-release-hardening` @ `f4e8e3b`（PR #283），盘点日期 2026-09-27。
> **口径**：只核对 `apps/web-pc` 的实际代码，不采信规划文档的承诺。
> - 「完全未接通」= PC 端在该基线里没有实现、也没有入口。
> - 「有缺口」= 已接真实 API，但能力不完整（分页、深链、类型等）。
> - 「演示态」= 前端已接真实接口，但当前环境开关让它返回演示结果。
>
> **证据路径**均相对仓库根；行号对应该基线，代码改动后需重新核对。行号可用 `sed -n '<行>p' <文件>` 复现。

---

## 一、完全未接通（PC 无入口 / 无实现）

### 1.1 后端已就绪，只差 PC 接线（已开票，无需后端改动）

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 举报（商品 / 用户 / 我的举报） | 契约与 API 均已交付，PC 无任何入口 | 契约 `packages/contracts/src/reports/routes.ts`（`POST /reports`、`GET /reports/mine`）+ `apps/api/src/modules/reports`；PC 侧 `grep -rn '举报' apps/web-pc/src` **零命中** → **#367** |
| 他人主页（公开资料 + 在售列表） | `USER_ROUTES` 两个**匿名可读**端点已交付，PC 无入口 | `packages/contracts/src/users/routes.ts`（`/users/:id/public`、`/users/:id/listings`）+ `apps/api/src/modules/users`；PC 侧 `grep -rn 'USER_ROUTES\|/users/' apps/web-pc/src` **零命中**，商品详情卖家块（`apps/web-pc/src/features/listing-detail/detail-page.tsx:189`）只静态展示、不可点 → **#368** |

### 1.2 后端本身未实现（DB 表在，但无契约 / 无 API 模块）—— 不是 PC 单独的欠账

这几项小程序端同样是演示态，要先补后端：

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 收藏 | `favorites` 表在，但 `packages/contracts` 无 favorites 路由 / schema，`apps/api` 无 favorites 模块 | 小程序自述：`apps/miniapp/src/pages/favorites/index.tsx:30` |
| 浏览历史 | 同上 | 小程序 `apps/miniapp/src/pages/history` 走 `fetchDemoRecords`（`pages/history/records.ts:656`） |
| 交易评价 | `transaction_reviews` / `transaction_review_images` 表在，契约层无任何 review 文件 | `git ls-tree -r --name-only origin/main packages/contracts/src \| grep -iE 'review\|rating'` 无输出 |
| Watchers（想要） | 无表、无契约 | — |

### 1.3 其它未接通（PC 无入口，非本阶段目标）

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 校园认证（教育邮箱验证码） | PC 无入口，只有注册页文案 | `apps/web-pc/src/routes/register.tsx:57`「校园认证需另行完成教育邮箱验证」 |
| 手机号绑定 | 个人中心只展示绑定状态，无绑定操作 | `apps/web-pc/src/features/profile/profile-page.tsx:86` |
| 忘记密码 / 重置密码 | 无路由、无入口 | `ls apps/web-pc/src/routes` 无相关路由 |
| 设置页（主题 / 通知偏好 / 协议 / 隐私） | 无该路由 | `ls apps/web-pc/src/routes` 无 `settings*` |
| 分享 / 复制链接 | 无 | `grep -rn '分享\|navigator\.clipboard' apps/web-pc/src` 只命中 `features/auth/form.tsx:68` 一句营销文案 |
| Admin 控制台 / 审核队列 | 无 | roadmap §6「不把 Admin 页面迁到 `/pc/admin`」 |
| 移动端折叠布局 / PWA / 离线 | 非目标；PC 按桌面视口设计 | roadmap §6 |

### 1.4 已在飞、尚未合入 `main`

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 消息图片 / 语音 | **契约已在 `origin/main`**，PC 接线在 PR #351（open） | `packages/contracts/src/chat/schema.ts:17`（`mediaKindSchema`）、`:87`（`MediaMessageDto`） |
| 个性签名 | PC 未接，在 PR #345（open） | PC 侧 `grep -rn '个性签名' apps/web-pc/src` 零命中 |
| 关注 | 未拆 Domain，在 PR #360（open） | `packages/contracts/src/users/schema.ts` 注释：#122 明确不做 |

---

## 二、已接通但有明确缺口

| 功能 | 缺口 | 证据 |
| --- | --- | --- |
| 我的发布 | 最多 50 条，无分页 | `apps/web-pc/src/features/profile/api.ts:39` 固定 `limit: '50'`；`features/profile/mylist-page.tsx` |
| 订单列表 | 最多 50 条；接口支持 `cursor` 但 PC 不翻页 | `apps/web-pc/src/features/profile/api.ts:50`；`features/profile/orders-page.tsx` |
| 通知列表 | 最多 50 条，无分页 / 删除 / 批量已读 | `apps/web-pc/src/features/notifications/api.ts:14`（`NOTIFICATION_PAGE_LIMIT`） |
| 通知实时推送 | 无 WebSocket、无轮询，进入页面才刷新（聊天有 WS，通知没有） | `grep -rn 'refetchInterval\|WebSocket\|realtime' apps/web-pc/src/features/notifications` 无命中 |
| 只有 `wishId` 的通知 | 不能跳对应愿望，只提示「后续版本开放」（许愿详情页确实不存在） | `apps/web-pc/src/features/notifications/notification-view.ts:45` |
| 订单号 | 直接把内部 UUID 当「订单号」展示 | `apps/web-pc/src/features/profile/order-detail-page.tsx:110`；见 `docs/design/issue-89-web-pc-t10-id-inventory.md`（#217 必办） |
| 商品图片替换 | 编辑弹窗只改文字 / 价格 / 展示项 | `apps/web-pc/src/features/profile/edit-listing-dialog.tsx:131` |
| 面交码 / 核销凭证 | 只有「确认完成面交」，无凭证展示与核销 | `apps/web-pc/src/features/profile/order-detail-page.tsx` |
| 搜索公开编号（#217） | 只支持关键词 / 分类 / 排序 / cursor | `docs/design/issue-89-web-pc-t10-id-inventory.md` 结论 |
| 聊天增强 | 无 typing、撤回、删除、转发、消息搜索 | T4 设计 §7 非目标；grep 无命中 |
| 评论区 | 无多层评论树、编辑、删除、举报、图片留言 | T5 设计 §7 非目标 |
| 愿望 | 无愿望公开主页、无新匹配算法 | T9 设计 §7 非目标 |

> **首页商品流已不在本表**：`apps/web-pc/src/routes/index.tsx:70-77` 已支持「加载更多」（`useHomeFeed` 走 `useInfiniteQuery` + `getNextPageParam`）。

---

## 三、接口已接、当前环境是演示态

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| AI 润色 | 前端已接真实接口，但当前 `AI_POLISH_TRANSPORT=stub`，返回演示文案 | 启动日志 `apps/api/src/index.ts:29`；页面挂「演示文案」徽标 |
| 内容安全审核 | 当前 `CONTENT_MODERATION_TRANSPORT=local`（本地词表，非真实审核）；生产必须 `tencent` | 启动日志 `apps/api/src/index.ts:39`；`apps/api/src/modules/moderation/providers/local.ts:6` |

---

## 四、本版相对上一版的更正

| 上一版结论 | 当前实际 | 证据 |
| --- | --- | --- |
| 「微信登录 / 扫码登录：完全未接通」 | **已接通**：#340 于 2026-09-29 合入 | `apps/web-pc/src/routes/login.tsx:24,102` 已挂 `ScanLoginPanel` |
| 「首页商品流：只取第一页 24 条，无加载更多」 | **已有「加载更多」** | `apps/web-pc/src/routes/index.tsx:70-77` |
| 「收藏 / 关注：无任何代码」 | 关注仍在飞（PR #360）；收藏改归 §1.2「后端本身未实现」 | 见 §1.2 / §1.4 |
| 未单列「后端已就绪、只差接线」这一类 | 新增 §1.1，并已开票 #367 / #368 | 见 §1.1 |

---

## 五、可复现核对命令

```bash
# 路由与页面清单
ls apps/web-pc/src/routes
ls apps/web-pc/src/features

# 显式的「未接通 / 演示」字样
grep -rn '占位\|未接入\|尚未\|后续版本\|暂未\|演示\|fixture\|mock\|stub' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# 后端已就绪但 PC 未接（§1.1）：应当零命中
grep -rn '举报\|REPORT_ROUTES' apps/web-pc/src --include='*.ts' --include='*.tsx'
grep -rn 'USER_ROUTES\|/users/' apps/web-pc/src --include='*.ts' --include='*.tsx'

# 后端本身未实现（§1.2）：契约层应当零命中
git ls-tree -r --name-only origin/main packages/contracts/src | grep -iE 'favor|collect|review|rating'

# 收藏 / 关注 / 评价 / 浏览历史 / 个性签名 / 面交 / 举报 / 分享
grep -rniE '收藏|favorite|关注|follow|评价|浏览历史|个性签名|signature|面交|meetup|举报|report|分享' apps/web-pc/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# 分页能力对比：有 useInfiniteQuery 的地方才算真分页
grep -rn 'useInfiniteQuery\|getNextPageParam\|fetchNextPage' apps/web-pc/src
```

---

## 六、结论来源

- 各任务设计文档的「非目标」章节：`docs/design/issue-89-web-pc-t*.md`。
- 路线图明确不做项：`docs/design/issue-89-web-pc-roadmap.md` §6。
- ID / 编号边界：#217，见 `docs/design/issue-89-web-pc-t10-id-inventory.md`。
- 本次刷新（2026-09-30）另据 #367 / #368 两张已开票的接线缺口。

---

_由 AI agent 协助完成（DSH / deepseek-flash）。_
