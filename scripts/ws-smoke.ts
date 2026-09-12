const url = process.env.WS_URL ?? 'ws://localhost:3000/ws'
const payload = `ping-${Date.now()}`

const timeout = setTimeout(() => {
  console.error(`[ws-smoke] 超时：未在 5s 内收到 ${url} 的回显`)
  process.exit(1)
}, 5000)

const ws = new WebSocket(url)

ws.onopen = () => ws.send(payload)

ws.onmessage = (event) => {
  if (event.data !== payload) {
    console.error(`[ws-smoke] 回显不匹配：期望 ${payload}，收到 ${String(event.data)}`)
    process.exit(1)
  }
  clearTimeout(timeout)
  console.log(`[ws-smoke] ok — ${url} 回显 "${payload}"`)
  ws.close()
  process.exit(0)
}

ws.onerror = () => {
  console.error(`[ws-smoke] 连接失败：${url}（请先启动 bun run dev:api）`)
  process.exit(1)
}
