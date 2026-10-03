import { useRouter } from '@tarojs/taro'
import LegalDocView from '@/components/legal-doc'
import { isEntryFromAuth } from '@/features/legal/entry'
import { TERMS_DOC } from '@/features/legal/terms'

/**
 * 用户协议（稿 `小程序1版用户协议.html`）。
 *
 * ⚠️ **未定内容页面**：本页正文来自设计稿的**初稿**，**实际页面内容由 zzstar 决策**。
 * 定稿时只改 `@/features/legal/terms.ts`（唯一真源），本文件与
 * `@/components/legal-doc` 都不需要动；稿内虚线标出的待填字段
 * （运营者全称 / 联系邮箱 / 联系地址 / 更新与生效日期）不编造，照稿留占位。
 *
 * 页面本体（文档头 / 目录 / 12 章 / 页脚 / 阅读进度条 / 回到顶部 / 目录抽屉 / 吸底同意条）
 * 与隐私政策同构，收在 `@/components/legal-doc` 里，这里只负责取数 + 判定入口来源。
 *
 * 入口：登录页协议勾选行（带 `?from=login` → 出现吸底同意条）、
 * 设置页「关于 → 用户协议」、关于与版本页条目卡、隐私政策页页脚互链。
 */
export default function Terms() {
  const router = useRouter<{ from?: string }>()
  return <LegalDocView doc={TERMS_DOC} entry={isEntryFromAuth(router.params)} />
}
