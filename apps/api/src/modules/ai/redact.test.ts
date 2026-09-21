import { describe, expect, test } from 'bun:test'
import { createRedactor } from './redact'

describe('脱敏', () => {
  test('七类标识符各替换为对应标记，同一类内计数递增', () => {
    const redactor = createRedactor()

    expect(redactor.redact('电话 13812345678').text).toBe('电话 [fish-phone-1]')
    expect(redactor.redact('另一个 13912345678').text).toBe('另一个 [fish-phone-2]')
    expect(redactor.redact('证件 11010119900307123X').text).toBe('证件 [fish-id-1]')
    expect(redactor.redact('卡号 6222021234567890123').text).toBe('卡号 [fish-card-1]')
    expect(redactor.redact('邮箱 abc@gzasc.edu.cn').text).toBe('邮箱 [fish-mail-1]')
    expect(redactor.redact('加微信 abc_12345').text).toBe('加[fish-contact-1]')
    expect(redactor.redact('住 12号楼').text).toBe('住 [fish-addr-1]')
    expect(redactor.redact('看 https://example.com/x').text).toBe('看 [fish-url-1]')
  })

  test('手机号的分隔与全角变体同样命中', () => {
    expect(createRedactor().redact('138-1234-5678').text).toBe('[fish-phone-1]')
    expect(createRedactor().redact('138 1234 5678').text).toBe('[fish-phone-1]')
    expect(createRedactor().redact('１３８１２３４５６７８').text).toBe('[fish-phone-1]')
  })

  test('零宽字符插在号码里也照样脱敏（不能靠一个不可见字符绕过）', () => {
    // 从网页 / Word / PDF 复制号码时带进不可见字符是现实场景；匹配前不剥掉，手机号就原样送上游。
    // 只枚举 U+200B 那一小撮不够：软连字符、LRM、CGJ、Hangul 填充符都能拆开号码（#141 三次审查）。
    const invisible = [
      '\u200b',
      '\ufeff',
      '\u00ad',
      '\u200e',
      '\u2066',
      '\u034f',
      '\u3164',
      '\ufe0f',
    ]
    for (const ch of invisible) {
      expect(createRedactor().redact(`联系 138${ch}12345678 详聊`).text).toBe(
        '联系 [fish-phone-1] 详聊',
      )
    }
    expect(createRedactor().redact('联系 138\u200b1234\u200b5678 详聊').text).toBe(
      '联系 [fish-phone-1] 详聊',
    )
    expect(createRedactor().redact('邮箱 abc\u200b@qq.com').text).toBe('邮箱 [fish-mail-1]')
  })

  test('描述里的换行与制表符保留（剥的是不可见格式字符，不是控制字符）', () => {
    // 送上游的是用户原文的格式：把 `\p{Cc}` 一起剥掉会把换行吃掉，正文粘成一行。
    expect(createRedactor().redact('九成新\n功能正常\t配件齐').text).toBe(
      '九成新\n功能正常\t配件齐',
    )
  })

  test('联系方式与链接的常见写法都命中', () => {
    expect(createRedactor().redact('QQ 1234567').text).toBe('[fish-contact-1]')
    expect(createRedactor().redact('+v: hello123').text).toBe('[fish-contact-1]')
    // 大写 `V:` 与同组的 `微信` / `vx` 一样要命中（该规则此前漏了 `i`，口径自相矛盾）。
    expect(createRedactor().redact('V: hello123').text).toBe('[fish-contact-1]')
    expect(createRedactor().redact('看 www.example.com').text).toBe('看 [fish-url-1]')
    expect(createRedactor().redact('看 taobao.com/abc').text).toBe('看 [fish-url-1]')
  })

  test('身份证优先于手机号：18 位里那截 1[3-9] 开头的片段不会被手机号规则切走', () => {
    // 若 phone 规则排在 id 之前，这里会变成 [fish-phone-1] + 残留数字，两者都还原不回来。
    expect(createRedactor().redact('11010119900307123X').text).toBe('[fish-id-1]')
  })

  test('不误伤正文里的数字与单位', () => {
    const redactor = createRedactor()
    expect(redactor.redact('九成新 128G 500元 2室1厅 1.5米 K380').text).toBe(
      '九成新 128G 500元 2室1厅 1.5米 K380',
    )
    expect(redactor.redacted).toBe(false)
  })
})

describe('回填', () => {
  test('标记原样找回时还原为用户原文', () => {
    const redactor = createRedactor()
    const description = redactor.redact('电话 138-1234-5678，微信 abc_12345')
    expect(description.text).toBe('电话 [fish-phone-1]，[fish-contact-1]')

    expect(redactor.restore(`${description.text} 全新未拆`, description)).toEqual({
      text: '电话 138-1234-5678，微信 abc_12345 全新未拆',
      lost: false,
    })
  })

  test('只要求"这段文本"的标记齐全：标题里的标记不出现在描述候选里不算丢失', () => {
    // 真实上游踩过：标题含可脱敏内容时，若把标题的标记也算"必须找回"，用户自己的联系方式会被
    // 换成提示语、outcome 错记 TOKEN_LOST。
    const redactor = createRedactor()
    const title = redactor.redact('出 12号楼 的键盘')
    const description = redactor.redact('九成新，联系 13812345678 详聊')
    expect(title.text).toBe('出 [fish-addr-1] 的键盘')

    expect(redactor.restore('九成新，联系 [fish-phone-1] 详聊', description)).toEqual({
      text: '九成新，联系 13812345678 详聊',
      lost: false,
    })
  })

  test('模型真把标题的标记带进候选时照样能还原（同一实例的映射共享）', () => {
    const redactor = createRedactor()
    redactor.redact('出 12号楼 的键盘')
    const description = redactor.redact('九成新，联系 13812345678 详聊')

    expect(redactor.restore('12号楼 的键盘，联系 [fish-phone-1]', description)).toEqual({
      text: '12号楼 的键盘，联系 13812345678',
      lost: false,
    })
  })

  test('描述这次的标记丢一个就整条降级为类型化提示语（不按顺序猜）', () => {
    const redactor = createRedactor()
    const description = redactor.redact('电话 13812345678，微信 abc_12345')
    const damaged = description.text.replace('[fish-contact-1]', '')

    expect(redactor.restore(damaged, description)).toEqual({
      text: '电话 （你的联系方式已被移除），',
      lost: true,
    })
  })

  test('模型自造的标记（不是本实例发出的）同样整条降级', () => {
    const redactor = createRedactor()
    const description = redactor.redact('电话 13812345678')

    expect(redactor.restore(`${description.text} 也可以加 [fish-phone-9]`, description)).toEqual({
      text: '电话 （你的联系方式已被移除） 也可以加 （你的联系方式已被移除）',
      lost: true,
    })
  })

  test('标记被改写（插入空格/全角）也整条降级，标记位换成提示语而不是留下字面', () => {
    const redactor = createRedactor()
    const description = redactor.redact('电话 13812345678')

    // 半成品标记既不能当"找回"（内容可能被改过），也不能原样留给用户：换成同类型提示语。
    expect(redactor.restore('电话 [fish-phone- 1] 也可以', description)).toEqual({
      text: '电话 （你的联系方式已被移除） 也可以',
      lost: true,
    })
    expect(redactor.restore('电话 [fish-phone-１] 也可以', description)).toEqual({
      text: '电话 （你的联系方式已被移除） 也可以',
      lost: true,
    })
  })

  test('标记里插了不可见字符 → 归一后仍算"找回"并还原原文（不是半成品降级）', () => {
    const redactor = createRedactor()
    const description = redactor.redact('电话 13812345678')

    // 与"插入空格 / 全角数字"不同：不可见字符在比对前就被剥掉，标记恢复成标准形态，按原样还原
    // 用户自己的号码——这比换成提示语更符合用户预期（设计 §5.7 已按此口径改写）。
    expect(redactor.restore('电话 [fish-pho\u200bne-1] 也可以', description)).toEqual({
      text: '电话 13812345678 也可以',
      lost: false,
    })
  })

  test('正文里形如 `fish+字母+数字` 的普通文字不算标记，不误降级', () => {
    // 识别半成品标记的种类是闭集；宽松到任意字母会把 `fish oil 3` 这类正文当成标记，
    // 把提示语塞进用户拿到的候选里（#141 审查发现）。
    const redactor = createRedactor()
    const description = redactor.redact('电话 13812345678')

    expect(redactor.restore(`${description.text} fish oil 3 瓶`, description)).toEqual({
      text: '电话 13812345678 fish oil 3 瓶',
      lost: false,
    })
    // 种类在闭集里（`mail`）、后面又跟着数字：不带左括号时必须真的有 `-` / `_` 才可能是半成品
    // 标记，否则正文 `fish mail 3 个` 会被替换成"（你的邮箱已被移除）"（#141 二次审查发现）。
    expect(redactor.restore(`${description.text} fish mail 3 个`, description)).toEqual({
      text: '电话 13812345678 fish mail 3 个',
      lost: false,
    })
    // 真·半成品标记（无括号、带连字符）仍要识别并整条降级：原本的标记位与半成品都换提示语。
    expect(redactor.restore(`${description.text} fish-phone-1`, description)).toEqual({
      text: '电话 （你的联系方式已被移除） （你的联系方式已被移除）',
      lost: true,
    })
  })

  test('没有标记时原样返回且不降级', () => {
    const redactor = createRedactor()
    const empty = redactor.redact('无标记的普通描述')

    expect(redactor.restore('无标记的普通描述', empty)).toEqual({
      text: '无标记的普通描述',
      lost: false,
    })
  })
})
