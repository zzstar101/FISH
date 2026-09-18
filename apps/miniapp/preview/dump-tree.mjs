/**
 * 诊断：把某个元素子树里每个节点的计算尺寸/盒模型倒出来。
 *
 * 为什么需要它：`.profile__row` 那一行出现「子元素宽度只有 3px」的怪现象，
 * 只量单个选择器看不出是 flex 分配、intrinsic 宽度还是 padding 在作怪。
 * 这里一次性把子树摊平，避免反复「猜 → 改 → 截图」。
 *
 * 用法：bun preview/dump-tree.mjs --route /pages/profile/index --selector ".profile__row"
 */
import { spawn } from 'node:child_process'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}

const BASE = args.get('base') ?? 'http://127.0.0.1:4599/index.html'
const ROUTE = args.get('route') ?? '/pages/home/index'
const SELECTOR = args.get('selector') ?? 'body'
const WIDTH = Number(args.get('width') ?? 375)
const HEIGHT = Number(args.get('height') ?? 812)
const EDGE = args.get('edge') ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = Number(args.get('port') ?? 9344)

const profile = `${process.env.TEMP ?? '.'}/fish-dump-${Date.now()}`
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 等启动 */
    }
    await sleep(250)
  }
  throw new Error('连不上调试端口')
}

const page = await findPage()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  socket.addEventListener('open', res)
  socket.addEventListener('error', rej)
})

let id = 1
const pending = new Map()
socket.addEventListener('message', (e) => {
  const data = JSON.parse(e.data)
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) reject(new Error(JSON.stringify(data.error)))
    else resolve(data.result)
  }
})
const send = (method, params = {}) => {
  const current = id
  id += 1
  return new Promise((resolve, reject) => {
    pending.set(current, { resolve, reject })
    socket.send(JSON.stringify({ id: current, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: true,
})
await send('Page.navigate', { url: `${BASE}#${ROUTE}` })
await sleep(2500)

const script = `
(() => {
  const root = document.querySelector(${JSON.stringify(SELECTOR)});
  if (!root) return 'NO MATCH: ' + ${JSON.stringify(SELECTOR)};
  const lines = [];
  const walk = (el, depth) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const label = (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).join('.') : el.tagName.toLowerCase());
    lines.push([
      '  '.repeat(depth) + label,
      'box=' + r.width.toFixed(1) + 'x' + r.height.toFixed(1),
      'display=' + cs.display,
      'flex=' + cs.flex,
      'minW=' + cs.minWidth,
      'maxW=' + cs.maxWidth,
      'pad=' + cs.paddingTop + '/' + cs.paddingRight + '/' + cs.paddingBottom + '/' + cs.paddingLeft,
      'ws=' + cs.whiteSpace,
      'w=' + cs.width,
    ].join('  '));
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return lines.join('\\n');
})()
`

const result = await send('Runtime.evaluate', { expression: script, returnByValue: true })
console.log(result.result.value)

socket.close()
child.kill()
process.exit(0)
