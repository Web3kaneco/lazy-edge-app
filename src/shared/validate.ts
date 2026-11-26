// What stops a bot's settings from saving, in plain words. The Bots screen
// shows the same list before Save is pressed, and the store refuses with it,
// so a save never fails with a dump of validation code (2026-11-21).
import { plainIssues } from './fields'
import { BotSettings } from './schema'

export function botProblems(input: unknown): string[] {
  const checked = BotSettings.safeParse(input)
  if (!checked.success) return plainIssues(checked.error.issues)
  const doc = checked.data
  const out: string[] = []
  if (doc.entry.priceBandC[0] > doc.entry.priceBandC[1]) out.push(`Price band: the low price, ${doc.entry.priceBandC[0]}c, is above the high price, ${doc.entry.priceBandC[1]}c.`)
  if (doc.decider.kind === 'agent' && !doc.decider.provider) out.push('Decider: the agent needs a provider chosen, or set the decider back to Rules engine.')
  return out
}

export function notSaved(problems: string[], meanwhile = 'the bot keeps running on its last saved settings'): string {
  const n = problems.length
  return `Not saved. ${n === 1 ? 'One setting needs' : `${n} settings need`} fixing first; ${meanwhile}.\n${problems.map((p) => `• ${p}`).join('\n')}`
}
