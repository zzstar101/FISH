function parseSystemEvent(content: string): { type: string } | null {
  try {
    const value: unknown = JSON.parse(content)
    if (value && typeof value === 'object' && 'type' in value) {
      const type = (value as { type: unknown }).type
      if (typeof type === 'string') return { type }
    }
  } catch {
    // 非 JSON 的系统消息按原文渲染。
  }
  return null
}

/** 交易 SYSTEM 事件中文化；解析不了就按原文展示。 */
export function systemMessageText(content: string): string {
  const event = parseSystemEvent(content)
  if (event === null) return content
  if (event.type === 'tx.proposal') return '待对方同意'
  if (event.type === 'tx.accepted') return '交易已接受，待面交'
  if (event.type === 'tx.rejected') return '卖家已拒绝这次交易'
  return content
}

export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
