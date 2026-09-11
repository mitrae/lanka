// app/utils/interruptQuickTest.ts
//
// Target time for the dashboard's dev-only "fire in ~N min" buttons.
//
// `nowMinutes` is the Kyiv wall-clock minute, FLOORED — "now" can be anywhere
// inside it. Aiming at nowMinutes + N would put a "+1 min" test clicked at
// hh:mm:59 one second away: too soon for the SSE kick to land, and far too soon
// for the 30 s manifest poll that covers a box whose stream has gone half-open.
// N + 1 guarantees at least N whole minutes of lead.
export function quickTestAtMinutes(nowMinutes: number, n: number): number {
  return (nowMinutes + n + 1) % 1440
}
