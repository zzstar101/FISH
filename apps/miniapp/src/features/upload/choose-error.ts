/**
 * `Taro.chooseMedia` 的失败判定（**无 Taro 依赖**，所以能在 `tests/` 里直接测）。
 *
 * 为什么单独成文件：`pickPhotos` 过去把**所有** reject 都当成「用户取消」静默吞掉，
 * 于是相册权限被拒、相机异常、平台 API 失败都表现为「点了选图什么都没发生」——
 * 用户既不知道出了什么事，也没有重试入口。取消是正常路径，其它失败必须冒泡成可展示的错误。
 *
 * 判定用 `errMsg` 包含 `cancel`（大小写不敏感）：微信/开发者工具的取消文案有
 * `chooseMedia:fail cancel` 等几种形态，而错误对象本身没有稳定的 code。
 * 判定不出来时**不当作取消** —— 宁可多报一个错，也不要静默吞掉一个真失败。
 */
export function isChooseMediaCancel(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'errMsg' in error &&
    typeof (error as { errMsg?: unknown }).errMsg === 'string'
  ) {
    return (error as { errMsg: string }).errMsg.toLowerCase().includes('cancel')
  }
  return false
}
