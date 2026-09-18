/**
 * #68 后旧 `CampusVerificationProvider`（注册时同步判学号）已删除：
 * 新注册一律 `UNVERIFIED`，认证由校园邮箱验证码流程（`verification-provider.ts`）完成。
 * 本文件暂时只保留类型兼容说明；真实的 Provider 边界见 `verification-provider.ts`。
 */
export type { EmailVerificationProvider } from './verification-provider'
