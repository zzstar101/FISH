const FIRST = 100_000_000_000n
const COUNT = 900_000_000_000n
// Rejection sampling avoids modulo bias without falling back to a sequence or Math.random.
const MAX_EXCLUSIVE = ((1n << 64n) / COUNT) * COUNT

/** A cryptographically random, non-zero-leading 12-digit human listing reference. */
export function newListingNo(): bigint {
  const bytes = new BigUint64Array(1)
  while (true) {
    crypto.getRandomValues(bytes)
    const value = bytes[0]
    if (value !== undefined && value < MAX_EXCLUSIVE) return FIRST + (value % COUNT)
  }
}
