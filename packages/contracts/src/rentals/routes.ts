/**
 * 租赁域路由常量（#706）。与 `LISTING_ROUTES` 同一取舍：API 路径集中在这里，
 * 端上写相对路径 `/api` + 常量，禁止在别处硬编码。
 *
 * 为什么单开 `/rentals` 而不是给 `/listings` 加 `?type=RENTAL`：
 * 两者的列表语义不同（出租有日租价、押金、可用租期），查询参数也不同（`days` vs `free`），
 * 塞进同一个端点会让每个筛选条件都要先判类型。独立路径也让「关闭租赁入口」这档开关
 * （#713 的灰度）只影响这一个前缀。
 */
export const RENTAL_ROUTES = {
  /** 租赁广场（公开）。 */
  base: '/rentals',
  detail: (id: string) => `/rentals/${id}`,
  /** 下架：ACTIVE → OFFLINE；对已 OFFLINE 幂等。 */
  offline: (id: string) => `/rentals/${id}/offline`,
  /** 重新上架：OFFLINE → ACTIVE；对已 ACTIVE 幂等。 */
  online: (id: string) => `/rentals/${id}/online`,
  /** 「我发布的出租」（本人作用域，含待审 / 已下架）。 */
  mine: '/rentals/mine',
} as const
