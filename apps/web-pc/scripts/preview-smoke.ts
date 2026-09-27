const baseUrl = 'http://127.0.0.1:4175'
const appRoot = new URL('..', import.meta.url).pathname

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const server = Bun.spawn(
  ['bunx', 'vite', 'preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort'],
  { cwd: appRoot, stderr: 'pipe', stdout: 'ignore' },
)

try {
  let ready = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/pc/`)
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // preview 尚未监听，继续等待。
    }
    await Bun.sleep(100)
  }

  assert(ready, 'Vite preview 未在 5 秒内就绪')

  const redirect = await fetch(`${baseUrl}/pc`, { redirect: 'manual' })
  assert(redirect.status === 308, `/pc 期望 308，实际 ${redirect.status}`)
  assert(redirect.headers.get('location') === '/pc/', '/pc 未规范化到 /pc/')

  const deepLink = await fetch(`${baseUrl}/pc/search?q=keyboard`)
  const deepHtml = await deepLink.text()
  assert(deepLink.status === 200, `/pc/search 期望 200，实际 ${deepLink.status}`)
  assert(deepHtml.includes('<title>FISH · 校园二手</title>'), '深链未回落到 PC index')

  const missing = await fetch(`${baseUrl}/pc/no-such-route`)
  const missingHtml = await missing.text()
  assert(missing.status === 200, `/pc/no-such-route 期望 200，实际 ${missing.status}`)
  assert(missingHtml.includes('<title>FISH · 校园二手</title>'), '未知路径未回落到 PC index')

  console.log('PC preview smoke passed')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  server.kill()
  await server.exited
}
