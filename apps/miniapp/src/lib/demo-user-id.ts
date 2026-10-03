/**
 * 演示世界里「我」的用户 id。
 *
 * 为什么单独一个文件、而不留在 `@/mock/users`：详情页要用它做归属比对
 * （`src/pkg-browse/pages/listing-detail/index.tsx` 的 `ownerViewUserId`），而
 * `@/mock/users` 是**有状态的 fixture 模块** —— 它在模块顶层构造 `USERS` 数组与
 * `USER_BY_ID` 映射。页面只要 `import` 它一个常量，整个用户 fixture 就会被拖进
 * 生产包（`USERS` 里每位演示用户的昵称、认证态、成交量都会以字面量形式出现在
 * 产物里）。这个常量本身没有任何依赖，放在 `src/lib` 下当叶子模块，页面取它就不会
 * 顺带把 fixture 带出包。
 *
 * 取值与 `@/mock/users` 的 `ME.id` 严格相同（`ME = getUser(CURRENT_USER_ID)`），
 * `@/mock/users` 也从这里 re-export，因此两处永远不会漂移。
 */
export const CURRENT_USER_ID = 'u-alan'
