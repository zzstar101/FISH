/**
 * User Domain 公开路由常量（Issue #122）。
 *
 * 这些是 **API 侧路径**（根级）。与 `listings/routes.ts` / `comments/routes.ts` 同口径：
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 两个端点都是**匿名可读**的公开读模型（整条不挂 `requireAuth`）：他人主页对未登录
 * 访客也要能看，这与 `GET /listings` 的「读公开、写必须登录」同一条分界。
 */
export const USER_ROUTES = {
  /**
   * GET 某个用户的公开资料（昵称 / 头像 / 认证状态 / 加入天数 / 在售数 / 卖出数）。
   *
   * 非法 uuid 与不存在的用户都返回 404 `USER_NOT_FOUND`。
   */
  publicProfile: (userId: string) => `/users/${userId}/public`,
  /**
   * GET 某个用户的商品（时间倒序，游标分页）。
   *
   * 用可选查询参数 `status` 选口径（#565）：缺省 / `ACTIVE` = **在售**（`status = 'ACTIVE'`
   * 且审核通过）；`SOLD` = **已售出**。已下架（OFFLINE，含审核中 / 不过审 / 平台下架）与
   * 已预定（RESERVED）不属于公开读模型，传进来一律 422。
   *
   * 不存在的 userId 同样是 404 `USER_NOT_FOUND`，**不返回空列表**——否则端上会把
   * 「用户不存在」渲染成「TA 暂无在售商品」。
   */
  activeListings: (userId: string) => `/users/${userId}/listings`,
} as const
