/**
 * payload 不合法：重试没有意义，worker 应当直接置 FAILED。
 *
 * 放在 job 层而不是某个 domain 目录下：队列的 `isFatalError` 判据必须对所有 domain 生效
 * （匹配域与 embedding 域各自抛同一个类），否则新 domain 的坏 payload 会被重试 3 次才失败。
 */
export class InvalidJobPayloadError extends Error {
  constructor(jobType: string, detail: string) {
    super(`job ${jobType} 的 payload 不合法：${detail}`)
    this.name = 'InvalidJobPayloadError'
  }
}
