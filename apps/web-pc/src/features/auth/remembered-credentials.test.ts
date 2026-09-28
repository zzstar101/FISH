import { expect, test } from 'bun:test'
import {
  clearRememberedCredentials,
  consumeExplicitLogout,
  decideAutoLogin,
  disableAutoLogin,
  loadRememberedCredentials,
  markExplicitLogout,
  saveRememberedCredentials,
} from './remembered-credentials'

class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

/** 模拟浏览器禁用存储（Chrome「拦截所有 Cookie」）时的 SecurityError。 */
class BrokenStorage implements Storage {
  get length(): number {
    throw new Error('SecurityError')
  }
  clear(): void {
    throw new Error('SecurityError')
  }
  getItem(): string | null {
    throw new Error('SecurityError')
  }
  key(): string | null {
    throw new Error('SecurityError')
  }
  removeItem(): void {
    throw new Error('SecurityError')
  }
  setItem(): void {
    throw new Error('SecurityError')
  }
}

const validCredentials = {
  autoLogin: false,
  password: 'password123',
  studentNo: '202401010101',
}

test('保存后按原样读回', () => {
  const storage = new MemoryStorage()
  saveRememberedCredentials(validCredentials, storage)
  expect(loadRememberedCredentials(storage)).toEqual(validCredentials)
})

test('勾选自动登录的开关状态一起持久化', () => {
  const storage = new MemoryStorage()
  saveRememberedCredentials({ ...validCredentials, autoLogin: true }, storage)
  expect(loadRememberedCredentials(storage)?.autoLogin).toBe(true)
})

test('空存储按无凭据处理', () => {
  expect(loadRememberedCredentials(new MemoryStorage())).toBeNull()
  expect(loadRememberedCredentials(undefined)).toBeNull()
})

test('损坏的 JSON 按无凭据处理，不抛错', () => {
  const storage = new MemoryStorage()
  storage.setItem('fish.pc.login.remember', '{not json')
  expect(loadRememberedCredentials(storage)).toBeNull()
})

test('不合法的凭据（学号位数不足 / 密码过短 / autoLogin 缺失）都不回填', () => {
  const cases = [
    { autoLogin: false, password: 'password123', studentNo: '123' },
    { autoLogin: false, password: 'short', studentNo: '202401010101' },
    { password: 'password123', studentNo: '202401010101' },
    { autoLogin: 'yes', password: 'password123', studentNo: '202401010101' },
    'not an object',
  ]
  for (const raw of cases) {
    const storage = new MemoryStorage()
    storage.setItem('fish.pc.login.remember', JSON.stringify(raw))
    expect(loadRememberedCredentials(storage)).toBeNull()
  }
})

test('清除后不再回填', () => {
  const storage = new MemoryStorage()
  saveRememberedCredentials(validCredentials, storage)
  clearRememberedCredentials(storage)
  expect(loadRememberedCredentials(storage)).toBeNull()
})

test('显式登出标志只抑制一次', () => {
  const storage = new MemoryStorage()
  expect(consumeExplicitLogout(storage)).toBe(false)
  markExplicitLogout(storage)
  expect(consumeExplicitLogout(storage)).toBe(true)
  expect(consumeExplicitLogout(storage)).toBe(false)
})

test('无 session 存储时登出标志按未设置处理', () => {
  expect(consumeExplicitLogout(undefined)).toBe(false)
  markExplicitLogout(undefined)
})

test('存储不可访问（抛 SecurityError）时全部操作按无存储降级，不抛错', () => {
  const broken = new BrokenStorage()
  expect(loadRememberedCredentials(broken)).toBeNull()
  expect(consumeExplicitLogout(broken)).toBe(false)
  expect(() =>
    saveRememberedCredentials({ ...validCredentials, autoLogin: true }, broken),
  ).not.toThrow()
  expect(() => clearRememberedCredentials(broken)).not.toThrow()
  expect(() => markExplicitLogout(broken)).not.toThrow()
})

test('自动登录决策：无凭据 / 未勾自动登录 / 登出标志都不代提交', () => {
  expect(decideAutoLogin(null, false)).toEqual({ action: 'none' })
  expect(decideAutoLogin({ ...validCredentials, autoLogin: false }, false)).toEqual({
    action: 'none',
  })
  expect(decideAutoLogin({ ...validCredentials, autoLogin: true }, true)).toEqual({
    action: 'none',
  })
})

test('自动登录决策：有凭据且勾选自动登录时提交记住的账号密码', () => {
  const stored = { ...validCredentials, autoLogin: true }
  expect(decideAutoLogin(stored, false)).toEqual({
    action: 'submit',
    password: stored.password,
    studentNo: stored.studentNo,
  })
})

test('凭据被 401 拒绝后只关自动登录，账号密码保留', () => {
  expect(disableAutoLogin({ ...validCredentials, autoLogin: true })).toEqual({
    autoLogin: false,
    password: validCredentials.password,
    studentNo: validCredentials.studentNo,
  })
})
