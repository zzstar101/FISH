import { transactionSystemEventSchema } from '@fish/contracts/transactions/schema'

function parseSystemEvent(content: string): { type: string } | null {
  try {
    const parsed = transactionSystemEventSchema.safeParse(JSON.parse(content))
    return parsed.success ? { type: parsed.data.type } : null
  } catch {
    // 非 JSON 的系统消息按原文渲染。
  }
  return null
}

/** 交易 SYSTEM 事件中文化；解析不了就按原文展示。 */
export function systemMessageText(content: string): string {
  const event = parseSystemEvent(content)
  if (event === null) return content
  if (event.type === 'tx.proposal') return '交易确认待处理'
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
