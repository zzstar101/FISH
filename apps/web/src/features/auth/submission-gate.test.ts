import { expect, test } from 'bun:test'
import { createAuthSubmissionGate } from './submission-gate'

test('one login method holds the shared session-writing gate until it finishes', () => {
  const busy: boolean[] = []
  const gate = createAuthSubmissionGate((value) => busy.push(value))

  const finishScan = gate.claim()
  expect(finishScan).not.toBeNull()
  expect(gate.claim()).toBeNull() // password cannot submit during scan exchange
  finishScan?.() // a failed exchange releases the gate

  const finishPassword = gate.claim()
  expect(finishPassword).not.toBeNull()
  expect(gate.claim()).toBeNull() // scan cannot exchange during password login
  finishScan?.() // stale cleanup cannot unlock the newer request
  expect(gate.claim()).toBeNull()
  finishPassword?.()

  expect(busy).toEqual([true, false, true, false])
  expect(gate.claim()).not.toBeNull()
})
