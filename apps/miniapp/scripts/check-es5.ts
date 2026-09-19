import { resolve } from 'node:path'
import { parse } from 'acorn'

const dist = resolve(import.meta.dir, '../dist')
const files = Array.from(new Bun.Glob('**/*.js').scanSync(dist)).sort()
if (files.length === 0) throw new Error('No miniapp JavaScript output; build first.')

let failures = 0
for (const file of files) {
  try {
    parse(await Bun.file(resolve(dist, file)).text(), { ecmaVersion: 5 })
  } catch (error) {
    failures++
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failures) throw new Error(`${failures} miniapp JavaScript files failed ES5 validation`)
console.log(`ES5 syntax verified: ${files.length} JavaScript files`)
