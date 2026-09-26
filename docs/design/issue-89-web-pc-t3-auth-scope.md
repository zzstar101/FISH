# PC Web T3：登录态与账号作用域收口

> 状态：设计，待实现。依赖 T2；不包含 #197 扫码登录。
> 主跟踪：GitHub #89「B：Web 桌面版前端」。

## 1. 背景

PC Web 已接入登录、搜索和商品详情。后续消息、通知、个人中心会引入账号私有数据。

如果登出或换号时只把 `auth/me` 写成 `null`，旧账号的 Query 缓存仍可能留在内存中，新账号在相同 query key 命中时看到上一账号的数据。

仓库没有独立 T3 Issue；本文件冻结当前实现口径。

## 2. 目标

1. 所有账号/业务数据 Query 统一使用 `pc` 前缀；`auth/me` 是唯一认证控制 key，保留 `['auth', 'me']`。
2. 登录、注册、登出和全局 `401 UNAUTHENTICATED` 时清空 PC Query 缓存。
3. 清理后只写入当前用户，未登录写 `null`。
4. 同一浏览器内换账号时，旧账号数据不能被新账号命中。

## 3. 实现方案

### 3.1 会话缓存边界

新增 `apps/web-pc/src/lib/session-cache.ts`：

- 定义 `PC_QUERY_PREFIX = 'pc'`。
- 定义唯一例外认证查询 key `['auth', 'me']`；它不属于业务数据缓存。
- 提供 `resetPcSession(queryClient, user)`：
  - `removeQueries` 删除 `queryKey[0] === 'pc'` 的 Query；
  - `setQueryData` 写入当前用户或 `null`。

清空公开 Feed 会多一次请求，但比跨账号串数据安全；这是刻意取舍。

### 3.2 接入点

- `useLogin().onSuccess`：清旧账号 → 写新用户。
- `useRegister().onSuccess`：同上。
- `useLogout().onSuccess`：清 PC Query → 写 `null`。
- 全局 `401 + UNAUTHENTICATED`：先清会话，再跳登录页并保留回跳地址。

## 4. 文件范围

```text
apps/web-pc/src/
├── lib/session-cache.ts
├── lib/session-cache.test.ts
├── lib/query-client.ts
└── features/auth/queries.ts
```

## 5. 验收标准

- [ ] 登出后所有 `pc` Query 消失，`auth/me` 为 `null`。
- [ ] 登录 A 后再登录 B，A 的 Query 不能被 B 命中。
- [ ] 登录/注册成功后 `auth/me` 是新响应用户。
- [ ] 401 清账号态后回登录页，回跳路径仍正常。
- [ ] 非 `pc` key 不被误删。
- [ ] 搜索、详情、登录链路无回归。

## 6. 测试

- 单元测试 `session-cache.test.ts`：
  - 清 `pc`、保留其它 key、写用户；
  - 登出写 `null`。
- 运行时：
  - A 登录 → 打开搜索/详情 → 登出；
  - B 登录 → 确认页面不出现 A 的昵称或私有数据。

## 7. 非目标

- 不实现 #197 微信扫码登录；合并后再单独接 PC。
- 不退出学号登录契约。
- 不做离线持久化缓存。
- 不实现个人中心业务。

## 8. 风险

| 风险 | 处理 |
| --- | --- |
| 清理过宽导致公开页重新请求 | 接受；账号隔离优先于缓存命中 |
| 401 回调中清 Query 引发循环 | 只用 `removeQueries`，不重新触发当前请求 |
| 新页面忘记 `pc` 前缀 | T4 起把 query key 前缀作为代码审查项 |
