import { useRouter } from '@tarojs/taro'
import LegalDocView from '@/components/legal-doc'
import { isEntryFromAuth } from '@/features/legal/entry'
import { PRIVACY_DOC } from '@/features/legal/privacy'

/**
 * 隐私政策（稿 `小程序1版隐私政策.html`）。
 *
 * ⚠️ **未定内容页面**：本页正文来自设计稿的**初稿**，**实际页面内容由 zzstar 决策**。
 * 定稿时只改 `@/features/legal/privacy.ts`（唯一真源），本文件与
 * `@/components/legal-doc` 都不需要动；稿内虚线标出的待填字段
 * （运营者全称 / 联系邮箱 / 联系地址 / 更新与生效日期）不编造，照稿留占位。
 *
 * 比用户协议多一块「一句话说清」摘要卡与六组信息清单（必要 / 非必要 / 未申请 / 保存期限
 * 四种标签）—— 都靠 `LegalDoc` 的数据模型表达，页面代码不变。
 *
 * 入口：登录页协议勾选行（带 `?from=login` → 出现吸底同意条）、
 * 设置页「关于 → 隐私政策」、关于与版本页条目卡、用户协议页页脚互链。
 */
export default function Privacy() {
  const router = useRouter<{ from?: string }>()
  return <LegalDocView doc={PRIVACY_DOC} entry={isEntryFromAuth(router.params)} />
}
