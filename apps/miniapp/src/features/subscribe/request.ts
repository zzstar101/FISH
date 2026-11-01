/**
 * `wx.requestSubscribeMessage` 的唯一入口（#462）。
 *
 * ## 为什么只能从点击回调里调
 *
 * 微信硬约束：这个接口**必须**由用户点击触发。所以本模块的每个调用点都必须写在
 * `onClick` / `onTap` 里，且**调用之前不能 `await` 任何东西** —— 一旦先等一次网络请求，
 * 调用就脱离了用户手势，微信会直接失败。这也是模板配置在启动时预热、点击时同步读
 * `cachedSubscribeConfig()` 的原因（见 `./api`）。
 *
 * ## 三条纪律
 *
 * 1. **绝不阻塞主流程**：返回的 Promise 内部已经 `catch` 掉一切失败，调用方 `void` 掉即可。
 *    用户点"发送"，消息该发就发；授权框被拒绝不影响交易与聊天。
 * 2. **只请求已开通的 kind**：`config.templates[kind] === null` 的模板一个都不提交
 *    （提交未配置的模板微信会报错，而用户看到的是一个永远不会兑现的授权框）。
 * 3. **结果原样上报**：`accept` / `reject` / `ban` / `filter` 都报给服务端，由它对账
 *    （只认 `accept`）。端上不做"这算不算成功"的判断。
 */
import {
  type SubscribeMessageGrantReport,
  type SubscribeMessageGrantStatus,
  type SubscribeMessageGrantsResponse,
  type SubscribeMessageKind,
  subscribeMessageGrantStatusSchema,
} from '@fish/contracts/subscribe-messages/schema'
import Taro from '@tarojs/taro'
import { cachedSubscribeConfig, loadSubscribeConfig, reportSubscribeGrants } from './api'

/** 一次性订阅一次最多提交 3 个模板（微信限制），首批正好三个 kind。 */
const MAX_TEMPLATES_PER_REQUEST = 3

/**
 * 请求订阅若干 kind 的微信消息。
 *
 * 返回值是「上报后各 kind 的剩余次数」，失败/未开通/无模板时为 `null` —— 只有设置页那种
 * 需要展示状态的地方才会用到它，其余调用点 `void` 掉。
 */
export async function requestSubscribe(
  kinds: readonly SubscribeMessageKind[],
): Promise<SubscribeMessageGrantsResponse | null> {
  // 同步读缓存：这里不能 await（见文件头）。冷启动后第一次点击时缓存可能还没到，
  // 这次就不弹授权，顺手把配置拉起来，下一次点击就正常了。
  const config = cachedSubscribeConfig()
  if (config === null) {
    void loadSubscribeConfig()
    return null
  }

  // 模板 ID → kind 的反查表：微信的返回值是按**模板 ID** 做键的。
  const kindByTemplateId = new Map<string, SubscribeMessageKind>()
  for (const kind of kinds) {
    const templateId = config.templates[kind]
    if (templateId === null || templateId === undefined) continue
    if (kindByTemplateId.size >= MAX_TEMPLATES_PER_REQUEST) break
    kindByTemplateId.set(templateId, kind)
  }
  if (kindByTemplateId.size === 0) return null

  let result: Record<string, unknown>
  try {
    /*
     * 刻意**不** await 之前的任何异步：这一句必须还在用户手势里。
     *
     * 两处 `as` 都是为了绕开 Taro 4.2 的类型缺陷，不是放宽契约：
     * - `Option` 把**支付宝专属**的 `entityIds` 声明成了必填（`BaseOption` 里没有 `?`），
     *   微信侧真实要求的只有 `tmplIds`；
     * - 返回类型是「成功 | 失败」的联合，失败那个成员没有模板 ID 的索引签名。
     *   这里先收成 `Record<string, unknown>`，再用运行期判据取值（未知值一律当拒绝）。
     */
    const option = {
      tmplIds: [...kindByTemplateId.keys()],
    } as unknown as Parameters<typeof Taro.requestSubscribeMessage>[0]
    result = (await Taro.requestSubscribeMessage(option)) as unknown as Record<string, unknown>
  } catch (error) {
    // 用户取消、基础库过低、真机不支持……都只影响站外提醒，不打扰用户。
    console.warn('[miniapp] 订阅消息授权未完成（不影响功能）', error)
    return null
  }

  // 失败回调（`errCode` 是数字）与"什么都没返回"同解：这一次没有结果可上报。
  if (typeof result.errCode === 'number') {
    console.warn('[miniapp] 订阅消息授权未完成（不影响功能）', result.errMsg)
    return null
  }

  const grants: SubscribeMessageGrantReport['grants'] = []
  for (const [templateId, kind] of kindByTemplateId) {
    const raw = result[templateId]
    // 未知值当拒绝：契约侧 `catch('reject')` 是同一口径，这里只是让上报的条目齐全。
    const status: SubscribeMessageGrantStatus =
      typeof raw === 'string' ? subscribeMessageGrantStatusSchema.parse(raw) : 'reject'
    grants.push({ kind, status })
  }
  if (grants.length === 0) return null

  return reportSubscribeGrants({ grants })
}

/**
 * 设置页的「微信消息提醒」入口：一次请求首批三个模板。
 *
 * 单独导出而不是让页面拼数组：这个"一次要三个"的口径来自 Owner 冻结的授权入口清单，
 * 只有名字，不该散在页面里。
 */
export function requestAllSubscribeKinds(): Promise<SubscribeMessageGrantsResponse | null> {
  return requestSubscribe(['CHAT', 'TX', 'REVIEW'])
}
