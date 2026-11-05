/** Decorative motion only: page selection always comes from the actual onShow route. */
export const TAB_TRANSITION_MS = 160
export const TAB_SLOT_RPX = 130.8
const INTENT_TTL_MS = 750

export type TabTransition = {
  id: number
  route: string
  from: number
  to: number
  startedAt: number
}

type Intent = { id: number; from: string; to: string; at: number }

function position(route: string): number | undefined {
  switch (route) {
    case 'pages/home/index':
      return 0
    case 'pages/wish/index':
      return TAB_SLOT_RPX
    case 'pages/chat/index':
      return TAB_SLOT_RPX * 3
    case 'pages/profile/index':
      return TAB_SLOT_RPX * 4
    default:
      return undefined
  }
}

export function createTabTransition() {
  let sequence = 0
  let pending: Intent | null = null
  let motion: TabTransition | null = null

  return {
    begin(from: string, to: string, now: number): number {
      const id = ++sequence
      pending =
        from !== to && position(from) !== undefined && position(to) !== undefined
          ? { id, from, to, at: now }
          : null
      return id
    },
    arrive(route: string, now: number): TabTransition | null {
      const intent = pending
      pending = null
      const previous = motion
      motion = null
      if (!intent || intent.to !== route || now - intent.at > INTENT_TTL_MS || now < intent.at) {
        return null
      }
      const to = position(route)
      let from = position(intent.from)
      if (from === undefined || to === undefined) return null
      if (previous?.route === intent.from) {
        const progress = Math.max(0, Math.min(1, (now - previous.startedAt) / TAB_TRANSITION_MS))
        // Matches cubic-bezier(1/3, 1, 2/3, 1); sample at arrival, not at click time.
        from = previous.from + (previous.to - previous.from) * (1 - (1 - progress) ** 3)
      }
      motion = { id: intent.id, route, from, to, startedAt: now }
      return motion
    },
    read(route: string, now: number): TabTransition | null {
      return motion?.route === route &&
        now >= motion.startedAt &&
        now - motion.startedAt < TAB_TRANSITION_MS
        ? motion
        : null
    },
    cancel(id: number): void {
      // A delayed rejection from an earlier switch must not cancel a newer click.
      if (pending?.id === id) pending = null
    },
    reset(): void {
      pending = null
      motion = null
    },
  }
}
