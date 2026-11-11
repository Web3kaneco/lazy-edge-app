// The trading day: what "today" means for every daily limit, stop and total.
// It runs from 4 AM to 4 AM on this computer's own clock, so a West Coast
// game that ends after midnight on the East Coast still belongs to the night
// it started. Midnight UTC split an East Coast evening at 7 or 8 PM.
export const DAY_START_HOUR = 4

const pad = (n: number): string => String(n).padStart(2, '0')

// YYYY-MM-DD of the trading day `t` falls in. Built from local date parts, so
// a daylight saving change moves the boundary with the clock, not an hour off.
export function tradingDay(t = Date.now()): string {
  const d = new Date(t)
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
