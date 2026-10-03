import { expect, test } from 'bun:test'
import { createEmbeddingRequestGate } from './request-gate'

test('并发 admission 均匀限速；空闲后不积攒突发额度', async () => {
  let clock = 0
  const sleeps: number[] = []
  const gate = createEmbeddingRequestGate({
    requestsPerSecond: 1,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  })
  await Promise.all([gate.beforeRequest(), gate.beforeRequest(), gate.beforeRequest()])
  expect(sleeps).toEqual([1000, 1000])
  clock += 10_000
  await Promise.all([gate.beforeRequest(), gate.beforeRequest()])
  expect(sleeps).toEqual([1000, 1000, 1000])
  expect(gate.requests).toBe(5)
})

test('并发 admission 不能超预算，拒绝后的额度不会重置', async () => {
  let clock = 0
  const gate = createEmbeddingRequestGate({
    requestsPerSecond: 2,
    maxRequests: 2,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  })
  const results = await Promise.allSettled([
    gate.beforeRequest(),
    gate.beforeRequest(),
    gate.beforeRequest(),
  ])
  expect(results.map((row) => row.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
  await expect(gate.beforeRequest()).rejects.toThrow('budget exhausted (2)')
  expect(gate.requests).toBe(2)
  expect(clock).toBe(500)
})

test('限速和预算不能用 NaN、Infinity、负值或小数预算绕过', () => {
  for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => createEmbeddingRequestGate({ requestsPerSecond: rate })).toThrow()
  }
  for (const maxRequests of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    expect(() => createEmbeddingRequestGate({ requestsPerSecond: 1, maxRequests })).toThrow()
  }
})
