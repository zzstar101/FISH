import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import { type ChatWatchersResponse, chatWatchersResponseSchema } from '@fish/contracts/chat/schema'
import { apiRequest } from '@/lib/request'

/** 商品会话买家：服务端校验卖家身份；人数是全量而非当前页行数。 */
export async function fetchChatWatchers(
  listingId: string,
  cursor?: string,
): Promise<ChatWatchersResponse> {
  const payload = await apiRequest(CHAT_ROUTES.watchers(listingId), {
    query: { limit: 20, cursor },
  })
  return chatWatchersResponseSchema.parse(payload)
}
