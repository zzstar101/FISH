/** 串行化登录页中所有会设置同一个会话 Cookie 的提交；释放只属于持锁请求。 */
export function createAuthSubmissionGate(onBusyChange: (busy: boolean) => void) {
  let current: symbol | null = null

  return {
    claim(): (() => void) | null {
      if (current !== null) return null
      const token = Symbol('auth-submission')
      current = token
      onBusyChange(true)
      return () => {
        if (current !== token) return
        current = null
        onBusyChange(false)
      }
    },
  }
}

export type AuthSubmissionGate = ReturnType<typeof createAuthSubmissionGate>
