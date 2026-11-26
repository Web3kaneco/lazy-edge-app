import { useEffect, useMemo, useState } from 'react'
import { defaultBot } from '@shared/ruleset'
import { limitsSummary } from '@shared/limits'
import { BotSettings as BotSettingsDoc, Lane, Phase, PropSide, ProviderId, Quarter, Sport, TradeableLabel, type AccountSettings, type BotSettings } from '@shared/schema'
import { auditBots, type Finding } from '@shared/audit'
import { botSentence } from '@shared/sentence'
import { botVenues, liveProblem, REAL_VENUES, VENUE_NAMES, type RealVenue } from '@shared/venues'
import { changesFromDefaults, readShareCode, shareCode, type Change } from '@shared/share'
import { STARTERS, starterChanges, starterOf } from '@shared/starters'
import { changeLines } from '@shared/fields'
import { api, useEngine, type ChatReply, type StarterStatus, type StrategyResult, type Ticket, type WhyAnswer } from '../api'
import { Proposal } from '../Ask'
import { botProblems } from '@shared/validate'
import { botRisk, flatRiskNote } from '@shared/risk'
import { labelName, tip } from '../glossary'
import { Chips, Field, NumberField, Segments, Tip, Toggle } from '../ui'

const M = defaultBot('m', 'm') // the measured defaults, for the hints

// The settings Advanced holds: every leaf of the document but the name, the
// on switch, paper or live, and the two money controls on the card.
const ON_CARD = new Set(['name', 'enabled', 'mode', 'size.maxTradeUsd', 'guards.maxDailyDrawdownUsd'])
function settingCount(b: BotSettings): number {
  let n = 0
  const walk = (o: unknown, path: string): void => {
    if (o && typeof o === 'object' && !Array.isArray(o)) { for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k); return }
    if (!['id', 'trial'].includes(path.split('.')[0]!) && !ON_CARD.has(path)) n++
  }
  walk(b, '')
  return n
}

export function Bots({ advancedOpen = false }: { advancedOpen?: boolean }) {
  const [bots, setBots] = useState<BotSettings[]>([])
  const [edit, setEdit] = useState<BotSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState('')
  const [sharing, setSharing] = useState(false)
  const [account, setAccount] = useState<AccountSettings | null>(null)
  const engine = useEngine()
  useEffect(() => setSharing(false), [edit?.id])
  useEffect(() => { void api.account().then(setAccount) }, [engine?.limits.capUsd])
  const venueState = engine?.venues ?? {}
  const keyed = REAL_VENUES.filter((v) => venueState[v]?.configured)
  const problem = (b: BotSettings): string | null => account ? liveProblem(b, account, venueState) : null

  const [starters, setStarters] = useState<Record<string, StarterStatus>>({})
  // The last 30 days of trades, for each bot's risk and reward.
  const [tickets, setTickets] = useState<Ticket[]>([])
  useEffect(() => { void api.tickets(30).then(setTickets).catch(() => {}) }, [])
  const load = async (select?: string): Promise<void> => {
    const list = await api.bots()
    setBots(list)
    setStarters(await api.starters())
    const pick = list.find((b) => b.id === (select ?? edit?.id)) ?? list[0] ?? null
    setEdit(pick ? structuredClone(pick) : null)
    setDirty(false)
  }
  useEffect(() => { void load() }, [])

  const set = (fn: (b: BotSettings) => void): void => {
    if (!edit) return
    const next = structuredClone(edit)
    fn(next)
    setEdit(next); setDirty(true); setSaved('')
  }

  const save = async (b = edit): Promise<void> => {
    if (!b) return
    setErr('')
    try {
      const out = await api.saveBot(b)
      await load(out.id)
      setSaved('Saved. The engine reads the new settings on its next cycle.')
    } catch (e) { setErr((e as Error).message) }
  }

  const create = async (): Promise<void> => {
    const b = await api.newBot(`Bot ${bots.length + 1}`)
    await api.saveBot(b)
    await load(b.id)
  }

  const toggle = async (b: BotSettings, on: boolean): Promise<void> => {
    // Switching on a live bot is confirmed by a native dialog in the main process.
    try { await api.saveBot({ ...b, enabled: on }) } catch (e) { setErr((e as Error).message) }
    await load(edit?.id)
  }

  // What the card must say in red or amber: anything in Advanced that stops
  // the bot or cancels what its sentence says (CLAUDE.md rule 3). The audit
  // runs on the card as edited, switched on, so an off bot shows what would
  // stop it once it is on; checks naming two bots show on both.
  const findings = useMemo((): Finding[] => {
    if (!edit || !account) return []
    const asOn = { ...edit, enabled: true }
    const all = auditBots({ bots: [...bots.filter((b) => b.id !== edit.id), asOn], account, venues: venueState, engineRunning: true, tickets })
    return all.filter((f) => f.botId === edit.id || (f.botId === null && f.text.includes(edit.name)))
  }, [edit, bots, account, venueState, tickets])
  const starter = edit ? starterOf(edit.id) : undefined
  const changed = edit ? (starter ? starterChanges(edit, BotSettingsDoc.parse(starter.build())).length : changesFromDefaults(edit).length) : 0
  const savedBot = edit ? bots.find((b) => b.id === edit.id) : undefined
  const problems = useMemo(() => (edit ? botProblems(edit) : []), [edit])

  return (
    <>
      <p className="lede">Each bot follows its settings exactly. Its card says what it does in one line and keeps the few settings that matter most in view; every other setting is under Advanced, and anything there that stops the bot shows on the card in red.</p>
      <div className="split">
        <div className="grid" style={{ alignContent: 'start', gap: 14 }}>
        <BotList bots={bots} problem={problem} selected={edit?.id ?? null} onCreate={create} onToggle={(b, v) => void toggle(b, v)}
          onSelect={(b) => { if (!dirty || confirm('Discard unsaved changes?')) { setEdit(structuredClone(b)); setDirty(false) } }} />
        <details className="advanced">
          <summary>Add or test bots <span className="meta">starters, paper test, import</span></summary>
          <div className="grid" style={{ gap: 14 }}>
            <Starters have={new Set(bots.map((b) => b.id))} onAdd={async (b) => { await api.saveBot(b); await load(b.id) }} />
            <PaperTest onDone={() => load(edit?.id)} />
            <Import onAdd={async (b) => {
              // A name already in the list gets a suffix, so the two are never confused.
              const named = bots.some((x) => x.name === b.name) ? { ...b, name: `${b.name} (imported)`.slice(0, 80) } : b
              await api.saveBot(named); await load(named.id); setSaved(`Imported "${named.name}". It is off and in paper until you switch it on.`)
            }} />
          </div>
        </details>
        </div>

        {edit && (
          <div className="card">
            <div className="bot-head">
              <input className="name-input" type="text" aria-label="Bot name" value={edit.name} onChange={(e) => set((b) => { b.name = e.target.value })} style={{ flex: 1, minWidth: 0 }} />
              {/* Saved at once like the list's switch; with unsaved edits it waits for Save. */}
              <Toggle on={edit.enabled} label={edit.enabled ? 'On' : 'Off'} onChange={(v) => { if (dirty || !savedBot) set((b) => { b.enabled = v }); else void toggle(savedBot, v) }} />
            </div>
            <p className="sentence">{botSentence(edit)}</p>
            {findings.map((f) => (
              <div key={f.text} className={`conflict ${f.level === 'check' ? 'soft' : ''}`}>
                <span className="mark">{f.level === 'problem' ? '!' : '•'}</span>
                <span>{f.text}{f.fix && <span className="fix">To change it: {f.fix}</span>}</span>
              </div>
            ))}
            {edit.enabled && engine && !engine.running && <div className="conflict"><span className="mark">!</span><span>The engine is stopped, so no bot trades, paper or live.<span className="fix">Press Start at the top.</span></span></div>}
            {edit.trial && <div className="note warn" style={{ marginBottom: 12 }}><b>A paper trial.</b> This copy of {bots.find((b) => b.id === edit.trial!.of)?.name ?? 'another bot'} tests: {edit.trial.what}. Compare the two under Home, Suggestions, then accept the change onto the bot or drop it.</div>}

            <div className="simple-grid">
              <Field label="Money" tip={`Paper: ${tip('Paper')} Live: ${tip('Live')}`} hint={edit.mode === 'live'
                ? `Real orders with your money${keyed.length ? ` on ${botVenues(edit, keyed).map((v) => VENUE_NAMES[v]).join(' or ')}` : ''}.`
                : 'Practice money against real prices.'}>
                <Segments options={['Paper', 'Live'] as const} value={edit.mode === 'live' ? 'Live' : 'Paper'} onChange={(v) => set((b) => { b.mode = v === 'Live' ? 'live' : 'paper' })} />
              </Field>
              <NumberField label={edit.size.sizing === 'flat' ? 'Amount per trade' : 'Largest trade'} tip={tip('Maximum per trade')} suffix="$" step={1} value={edit.size.maxTradeUsd} measured={M.size.maxTradeUsd} onChange={(v) => set((b) => { b.size.maxTradeUsd = v })} />
              <NumberField label="Daily loss stop" tip={tip('Daily drawdown stop')} suffix="$" step={5} value={edit.guards.maxDailyDrawdownUsd} measured={M.guards.maxDailyDrawdownUsd} why="Live only. Settled losses after fees since 4 AM." onChange={(v) => set((b) => { b.guards.maxDailyDrawdownUsd = v })} />
            </div>

            <AskAi bot={edit} onSaved={async (id, msg) => { await load(id); setSaved(msg) }} />
            {starter && <StarterNote bot={edit} status={starters[edit.id]} onDone={async (msg) => { await load(edit.id); setSaved(msg) }} />}
            {saved && <p className="small good" style={{ marginTop: 0 }}>{saved}</p>}

            <details className="advanced" key={`${edit.id}-${advancedOpen}`} open={advancedOpen || undefined}>
            <summary>Advanced <span className="meta">{settingCount(edit)} settings, {changed === 0 ? 'all as' : `${changed} changed from`} {starter ? 'the starter' : 'the measured defaults'}</span></summary>
            <p className="small muted" style={{ marginTop: 0 }}>Every number shows its measured default; an amber hint means it has moved off what was measured. Hover any ? for what a setting means.</p>
            <div className="section">Basics</div>
            <div className="grid cols-2">
              <Field label="Decider" tip={`Rules engine: ${tip('Rules engine')} Agent: ${tip('Agent')}`} hint="Rules decides every trade from the numbers. Agent lets a model decline trades that already passed every rule; it can never add one.">
                <select value={edit.decider.kind} onChange={(e) => set((b) => { b.decider.kind = e.target.value as 'rules' | 'agent' })}>
                  <option value="rules">Rules engine</option>
                  <option value="agent">Agent screens approved trades</option>
                </select>
              </Field>
              <NumberField label="Poll every" tip={tip('Poll every')} suffix="s" value={edit.pollS} measured={M.pollS} min={5} max={600} onChange={(v) => set((b) => { b.pollS = v })} />
            </div>
            {edit.decider.kind === 'agent' && (
              <div className="grid cols-2" style={{ marginTop: 10 }}>
                <Field label="Provider">
                  <select value={edit.decider.provider ?? ''} onChange={(e) => set((b) => { b.decider.provider = (e.target.value || undefined) as ProviderId | undefined })}>
                    <option value="">Choose…</option>
                    {ProviderId.options.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
                <Field label="Model" hint="Leave empty for the provider default.">
                  <input type="text" value={edit.decider.model ?? ''} onChange={(e) => set((b) => { b.decider.model = e.target.value || undefined })} />
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label="Instructions for the agent" hint="When it should decline. It sees only trades your settings already approved.">
                    <textarea value={edit.decider.instructions ?? ''} onChange={(e) => set((b) => { b.decider.instructions = e.target.value || undefined })} />
                  </Field>
                </div>
              </div>
            )}

            <div className="section">Market</div>
            <div className="grid">
              <Field label="Sports" tip={tip('Sports')}><Chips options={Sport.options} value={edit.market.sports} onChange={(v) => set((b) => { b.market.sports = v })} /></Field>
              <Field label="Lanes" tip={tip('Lanes')} hint="Team totals are not yet graded by the publisher and are off by default."><Chips options={Lane.options} tips={tip} value={edit.market.lanes} onChange={(v) => set((b) => { b.market.lanes = v })} /></Field>
              <Field label="Phase" tip={`${tip('Phase')} ${tip('Hot play')}`}>
                <select value={edit.market.phase} onChange={(e) => set((b) => { b.market.phase = e.target.value as BotSettings['market']['phase'] })} style={{ width: 200 }}>
                  {Phase.options.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              {edit.market.phase !== 'pregame' && (
                <Field label="Quarters" tip={tip('Quarters')} hint="In game plays trade only in the quarters ticked. Untick the early ones to start later in the game.">
                  <Chips options={Quarter.options} value={edit.market.quarters} onChange={(v) => set((b) => { b.market.quarters = Quarter.options.filter((q) => v.includes(q)) })} />
                </Field>
              )}
              {edit.market.lanes.includes('PROP') && (
                <Field label="Props on the game's top players only" tip="Trades a player's props only when he ranks this high or better in his game by our points projection, so it backs the players carrying the game, not role players. 10 means the top 10 of both teams together. Empty trades every player." hint={edit.market.propTopPlayers === null
                  ? 'Off: every player with a prop is traded.'
                  : `Only the top ${edit.market.propTopPlayers} players in each game, by our points projection.`}>
                  <input type="number" min={1} max={30} step={1} placeholder="off" value={edit.market.propTopPlayers ?? ''} style={{ width: 120 }}
                    onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Math.round(Number(e.target.value)); b.market.propTopPlayers = v === null || !Number.isFinite(v) ? null : Math.min(30, Math.max(1, v)) })} />
                </Field>
              )}
              {edit.market.lanes.includes('PROP') && (
                <Field label="Prop sides switched off" tip="A ticked stat and side is never bought by this bot. Across 503 graded props to 23 November, rebound unders hit 54% where we said 70% and lost $101 over 83, while rebound overs made $34 over 80." hint={edit.market.propSidesOff.length === 0
                  ? 'None: every stat and side is bought.'
                  : `Never buys ${edit.market.propSidesOff.join(', ')}.`}>
                  <Chips options={PropSide.options} value={edit.market.propSidesOff} onChange={(v) => set((b) => { b.market.propSidesOff = PropSide.options.filter((o) => v.includes(o)) })} />
                </Field>
              )}
              <Field label="Labels" tip={tip('Labels')} hint="Too thin to trade, Role already priced in and No price are never traded and cannot be switched on."><Chips options={TradeableLabel.options} tips={tip} names={labelName} value={edit.market.labels} onChange={(v) => set((b) => { b.market.labels = v })} /></Field>
              <Field label="Venues" tip={tip('Venues')} hint={keyed.length === 0
                ? 'No Kalshi or Polymarket key is saved. Paper still prices off the public books; add a key on the Keys screen to trade live.'
                : keyed.length === 1
                  ? `${VENUE_NAMES[keyed[0]!]} is the only venue with a key, so every price and order uses it.`
                  : 'Best price after fees wins among the venues ticked. Tick none to use both.'}>
                <Chips<RealVenue>
                  options={REAL_VENUES}
                  names={(v) => VENUE_NAMES[v]}
                  value={botVenues(edit, keyed)}
                  locked={(v) => keyed.includes(v) ? (keyed.length === 1 ? `${VENUE_NAMES[v]} is your only venue with a key, so it is always used.` : null) : `No ${VENUE_NAMES[v]} key is saved. Add one on the Keys screen to use it.`}
                  onChange={(v) => set((b) => { b.market.venues = v })}
                />
              </Field>
            </div>
            {edit.market.lanes.includes('COMBO') && (
              <>
                <div className="grid cols-2" style={{ marginTop: 10 }}>
                  <Field label="Which combos" hint={edit.combo.source === 'api'
                    ? "The API's own combos, bought as they are: NBA tickets once they lock, and NFL slips and same-game pairs mapped to Kalshi's prop markets, ranked by our chance over the legs one by one, one combo a day per player. Only the largest trade, the combos a day and paper or live apply; legs per combo and the entry settings are not used."
                    : "Ties this bot's own plays together into one Kalshi combo."}>
                    <select value={edit.combo.source} onChange={(e) => set((b) => { b.combo.source = e.target.value as 'built' | 'api' })}>
                      <option value="built">Built from this bot's plays</option>
                      <option value="api">The API's combos (NBA tickets, NFL slips)</option>
                    </select>
                  </Field>
                  {edit.combo.source === 'api'
                    ? <Field label="Buy the API's combos with" hint={`Each is bought exactly as the API built it. ${edit.combo.apiLegs.length === 3 ? 'Every size is ticked.' : `Only ${[...edit.combo.apiLegs].sort().join(' and ')} leg combos.`}`}>
                        <Chips options={['2', '3', '4'] as const} names={(o) => `${o} legs`} value={edit.combo.apiLegs.map(String) as ('2' | '3' | '4')[]}
                          onChange={(v) => set((b) => { b.combo.apiLegs = v.map(Number).sort() as (2 | 3 | 4)[] })} />
                      </Field>
                    : <NumberField label="Legs per combo" tip={tip('COMBO')} step={1} min={2} max={4} value={edit.combo.legs} measured={M.combo.legs} onChange={(v) => set((b) => { b.combo.legs = Math.round(v) })} />}
                  <NumberField label="Combos per day" step={1} min={1} max={50} value={edit.combo.maxPerDay} measured={M.combo.maxPerDay} onChange={(v) => set((b) => { b.combo.maxPerDay = Math.round(v) })} />
                </div>
                <div className="row wrap" style={{ marginTop: 10, gap: 24 }}>
                  <Toggle on={edit.combo.only} onChange={(v) => set((b) => { b.combo.only = v })} label={<>Combos only<Tip text={tip('Combos only')} /></>} />
                </div>
                <p className="small muted" style={{ marginTop: 8 }}>Legs are plays this bot would take on its own, one per game, priced off Kalshi. Each combo is priced by a real quote from Kalshi's market makers and bought only if our chance beats it by the minimum edge after fees. Combos are held to settlement. Paper combos need a Kalshi key to ask for quotes.</p>
              </>
            )}

            <div className="section">Entry</div>
            <div className="grid cols-2">
              <Field label="Buy on" tip={tip('Buy on')} hint={edit.entry.basis === 'pick'
                ? 'Buys only the side our number has winning, at the minimum chance below and inside the price band. The minimum edge and EV are not used. NBA moneylines get a pick on every game.'
                : 'Buys where our chance beats the price by the minimum edge and EV.'}>
                <select value={edit.entry.basis} onChange={(e) => set((b) => {
                  b.entry.basis = e.target.value as BotSettings['entry']['basis']
                  // Kelly sizes a trade with no edge at nothing, so a pick bot sizes flat.
                  if (b.entry.basis === 'pick') b.size.sizing = 'flat'
                })}>
                  <option value="edge">The edge</option>
                  <option value="pick">Our pick</option>
                </select>
              </Field>
              {edit.entry.basis === 'pick' && (
                <Field label="Our chance above the price" tip={tip('Our chance above the price')} hint={edit.entry.pickGapPp === null
                  ? 'Off: the price may be above our chance, up to the top of the band.'
                  : `Buys only when our chance is at least ${edit.entry.pickGapPp} points above the price.`}>
                  <input type="number" min={0} max={50} step={0.5} placeholder="off" value={edit.entry.pickGapPp ?? ''}
                    onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Number(e.target.value); b.entry.pickGapPp = v === null || !Number.isFinite(v) ? null : Math.min(50, Math.max(0, v)) })} />
                </Field>
              )}
              {edit.entry.basis === 'edge' && <>
                <NumberField label="Minimum edge" tip={`${tip('Minimum edge')} ${tip('Edge (pp)')}`} suffix="pp" step={0.5} value={edit.entry.minEdgePp} measured={M.entry.minEdgePp} why="UserConfig.min_edge_threshold." onChange={(v) => set((b) => { b.entry.minEdgePp = v })} />
                <NumberField label="Minimum EV after fees" tip={tip('EV after fees')} suffix="cents" step={0.1} value={edit.entry.minEvCents} measured={M.entry.minEvCents} why="Replaced price caps on 2026-08-31." onChange={(v) => set((b) => { b.entry.minEvCents = v })} />
              </>}
              <Field label="Maximum edge" tip="Our chance minus the price the order would pay, as the most a bot will believe. Far above the market usually means the market knows something our number does not: across 183 settled live bets, edges above 15 points won 9 of 23. Empty is no limit." hint={edit.entry.maxEdgePp === null
                ? 'Off: no play is too good to take.'
                : `Skips a play when our chance is more than ${edit.entry.maxEdgePp} points above the price.`}>
                <input type="number" min={1} max={100} step={0.5} placeholder="off" value={edit.entry.maxEdgePp ?? ''} style={{ width: 120 }}
                  onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Number(e.target.value); b.entry.maxEdgePp = v === null || !Number.isFinite(v) ? null : Math.min(100, Math.max(1, v)) })} />
              </Field>
              {edit.market.lanes.includes('PROP') && (() => {
                const band = edit.entry.underEdgePp
                const lo = band ? Math.max(band[0], edit.entry.basis === 'edge' ? edit.entry.minEdgePp : 0) : null
                const hi = band ? Math.min(band[1], edit.entry.maxEdgePp ?? Infinity) : null
                const empty = lo !== null && hi !== null && lo > hi
                const narrowed = band !== null && (lo !== band[0] || hi !== band[1])
                return (
                  <Field label="Prop unders only at an edge of" tip="Holds player prop unders to their own edge range, at the price the order pays. Overs keep the bot's minimum and maximum edge. Across 280 graded unders to 23 November, 5 to 7 points was the one range that made money. The bot's minimum and maximum edge still apply, so this can only narrow them. Empty holds unders to the bot's own edges." hint={band === null
                    ? "Off: unders use the bot's own edges."
                    : empty
                      ? <span className="bad">No under can pass: the bot's own edges ({edit.entry.minEdgePp} to {edit.entry.maxEdgePp ?? 'no limit'}) leave nothing inside {band[0]} to {band[1]}.</span>
                      : narrowed
                        ? <span className="bad">Unders actually trade at {lo} to {hi === Infinity ? 'no limit' : hi} points: the bot's own minimum or maximum edge is tighter than {band[0]} to {band[1]}.</span>
                        : `Unders only when our chance is ${band[0]} to ${band[1]} points above the price.`}>
                    <div className="row">
                      <input type="number" min={0} max={50} step={0.5} placeholder="off" value={band?.[0] ?? ''} style={{ width: 90 }}
                        onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Number(e.target.value); b.entry.underEdgePp = v === null || !Number.isFinite(v) ? null : [Math.min(50, Math.max(0, v)), Math.max(v, b.entry.underEdgePp?.[1] ?? v + 2)] })} />
                      <span className="muted">to</span>
                      <input type="number" min={0} max={100} step={0.5} placeholder="off" value={band?.[1] ?? ''} style={{ width: 90 }}
                        onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Number(e.target.value); b.entry.underEdgePp = v === null || !Number.isFinite(v) ? null : [Math.min(b.entry.underEdgePp?.[0] ?? 0, v), Math.min(100, Math.max(0, v))] })} />
                    </div>
                  </Field>
                )
              })()}
              {edit.market.lanes.includes('PROP') && edit.market.phase !== 'pregame' && (
                <Field label="In game prop unders only in the first" tip="Buys an in game prop under only in the first this many minutes of a quarter; overs and pregame props are not held to it. Live unders bought in the first 2 minutes of the 3rd quarter won 11 of 12 to 23 November, while those bought 8 or more minutes in hit 59% against our 81% and lost $22.49 over 27. A small sample: a test, not a proven rule. Empty buys unders at any point of the quarter." hint={edit.entry.underFirstMin === null
                  ? 'Off: unders at any point of the quarter.'
                  : `Unders only in the first ${edit.entry.underFirstMin} minutes of each quarter the bot trades.`}>
                  <div className="row">
                    <input type="number" min={1} max={15} step={1} placeholder="off" value={edit.entry.underFirstMin ?? ''} style={{ width: 90 }}
                      onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Number(e.target.value); b.entry.underFirstMin = v === null || !Number.isFinite(v) ? null : Math.min(15, Math.max(1, v)) })} />
                    <span className="muted">minutes of a quarter</span>
                  </div>
                </Field>
              )}
              <NumberField label="Edge haircut" tip={tip('Edge haircut')} step={0.05} min={0} max={1} value={edit.entry.edgeHaircut} measured={M.entry.edgeHaircut} why="811 graded fills: our p ≥ 0.75 bucket won 62%. 1.0 trades the raw claimed edge." onChange={(v) => set((b) => { b.entry.edgeHaircut = v })} />
              <NumberField label="Maximum price age" tip={tip('Maximum price age')} suffix="s" value={edit.entry.maxPriceAgeS} measured={M.entry.maxPriceAgeS} max={180} why="The API nulls an edge against a price older than 180s." onChange={(v) => set((b) => { b.entry.maxPriceAgeS = v })} />
              <NumberField label="Price band low" tip={tip('Price band')} suffix="cents" value={edit.entry.priceBandC[0]} measured={M.entry.priceBandC[0]} min={1} max={99} why="The hot plays work." onChange={(v) => set((b) => { b.entry.priceBandC = [v, b.entry.priceBandC[1]] })} />
              <NumberField label="Price band high" tip={tip('Price band')} suffix="cents" value={edit.entry.priceBandC[1]} measured={M.entry.priceBandC[1]} min={1} max={99} onChange={(v) => set((b) => { b.entry.priceBandC = [b.entry.priceBandC[0], v] })} />
              {edit.market.phase !== 'live' && (
                <Field label="Pregame plays wait until" tip="A pregame play is entered only in the last minutes before the game starts, so the pick and the price have settled. A combos only bot is not held to it, so an early game's leg can go early. Empty enters any time before the start." hint={edit.entry.pregameWindowMin === null
                  ? 'Any time before the start.'
                  : `The last ${edit.entry.pregameWindowMin} minutes before the start.${edit.combo.only && edit.market.lanes.includes('COMBO') ? ' Not used: this bot trades combos only.' : ''}`}>
                  <input type="number" min={1} max={1440} step={5} placeholder="any time" value={edit.entry.pregameWindowMin ?? ''} style={{ width: 120 }}
                    onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Math.round(Number(e.target.value)); b.entry.pregameWindowMin = v === null || !Number.isFinite(v) ? null : Math.min(1440, Math.max(1, v)) })} />
                </Field>
              )}
              <Field label="When the price is above the play's value" tip="Skip leaves an overpriced play alone. Bid places a buy below the ask at the highest price that still clears the minimum edge, and leaves it waiting in case the price comes down. Kalshi's fee on a waiting order is about a quarter of the normal fee, but a waiting order fills most often when the price is falling for a reason, like a player heading to the bench. Kalshi only; paper fills it only if the real ask comes down to it." hint={edit.entry.orderType === 'bid'
                ? `Bids below the ask and waits up to ${edit.entry.bidRestS} seconds for the price to come down.`
                : 'Skips it.'}>
                <select value={edit.entry.orderType} onChange={(e) => set((b) => { b.entry.orderType = e.target.value as 'take' | 'bid' })}>
                  <option value="take">Skip it</option>
                  <option value="bid">Bid at our value and wait</option>
                </select>
              </Field>
              {edit.entry.orderType === 'bid' && <NumberField label="Bid waits" suffix="s" step={30} min={30} max={3600} value={edit.entry.bidRestS} measured={M.entry.bidRestS} onChange={(v) => set((b) => { b.entry.bidRestS = Math.round(v) })} />}
              <Field label="Widest book" tip={tip('Widest book')} hint={edit.entry.maxSpreadC === null
                ? 'Off: buys into a book of any width.'
                : `Buys only where the ask is at most ${edit.entry.maxSpreadC}c above the bid. Kalshi books only.`}>
                <input type="number" min={1} max={50} step={1} placeholder="off" value={edit.entry.maxSpreadC ?? ''}
                  onChange={(e) => set((b) => { const v = e.target.value === '' ? null : Math.round(Number(e.target.value)); b.entry.maxSpreadC = v === null || !Number.isFinite(v) ? null : Math.min(50, Math.max(1, v)) })} />
              </Field>
            </div>
            <div className="row wrap" style={{ marginTop: 10, gap: 24 }}>
              <Toggle on={edit.entry.requireTrigger} onChange={(v) => set((b) => { b.entry.requireTrigger = v })} label={<>Require a game event trigger<Tip text={tip('Require a game event trigger')} /></>} />
              <Toggle on={edit.entry.measuredOnly} onChange={(v) => set((b) => { b.entry.measuredOnly = v })} label={<>Measured edges only<Tip text={tip('Measured edges only')} /></>} />
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>Minimum chance to hit<Tip text={tip('Minimum chance to hit')} /></label>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
                {(['pregame', ...Quarter.options] as const).map((k) => (
                  <NumberField key={k} label={k === 'pregame' ? 'Pregame' : k} suffix="%" step={1} min={0} max={99} value={edit.entry.minChancePct[k]} measured={0}
                    onChange={(v) => set((b) => { b.entry.minChancePct[k] = v })} />
                ))}
              </div>
              <span className="hint">0 means no minimum. Overtime uses Q4.</span>
            </div>
            {(edit.market.lanes.includes('MONEYLINE') || edit.market.lanes.includes('SPREAD')) && (
              <>
                {edit.market.phase !== 'pregame' && (
                  <div className="field" style={{ marginTop: 12 }}>
                    <label>Most points behind<Tip text={tip('Most points behind')} /></label>
                    <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                      {Quarter.options.map((k) => (
                        <NumberField key={k} label={k} suffix="points" step={1} min={0} max={60} value={edit.entry.maxTrailing[k] ?? NaN}
                          onChange={(v) => set((b) => { b.entry.maxTrailing[k] = Number.isFinite(v) ? Math.min(60, Math.max(0, Math.round(v))) : null })} />
                      ))}
                    </div>
                    <span className="hint">Empty means no limit; 0 means never back a team that is behind. Moneyline and spread plays, NBA only for now. Overtime uses Q4.</span>
                  </div>
                )}
                <div className="row wrap" style={{ marginTop: 10, gap: 24 }}>
                  <Toggle on={edit.entry.favoritesOnly} onChange={(v) => set((b) => { b.entry.favoritesOnly = v })} label={<>Favorites only<Tip text={tip('Favorites only')} /></>} />
                </div>
              </>
            )}

            <div className="section">Size</div>
            <div className="grid cols-2">
              <Field label="Sizing" tip={tip('Sizing')} hint={edit.size.sizing === 'flat'
                ? 'Every trade is the maximum per trade, whatever the edge.'
                : edit.entry.basis === 'pick'
                  ? 'Kelly sizes a trade with no edge at nothing, so this pick bot will skip most of its picks. Choose Flat.'
                  : 'Sized by the edge on the honest chance, between the minimum and maximum per trade: a long shot that loses most of the time gets a small stake, a surer play a bigger one.'}>
                <select value={edit.size.sizing} onChange={(e) => set((b) => { b.size.sizing = e.target.value as BotSettings['size']['sizing'] })}>
                  <option value="kelly">Kelly</option>
                  <option value="flat">Flat</option>
                </select>
              </Field>
              {edit.size.sizing === 'kelly' && <NumberField label="Kelly multiplier" tip={`${tip('Kelly')} ${tip('Kelly multiplier')}`} step={0.05} min={0} max={1} value={edit.size.kellyMultiplier} measured={M.size.kellyMultiplier} why="Quarter Kelly." onChange={(v) => set((b) => { b.size.kellyMultiplier = v })} />}
              <NumberField label="Bankroll" tip={tip('Bankroll')} suffix="$, 0 = live balance" step={10} value={edit.size.bankrollUsd} measured={M.size.bankrollUsd} why="Kelly rides the real balance, the 2026-07-23 fluid bankroll." onChange={(v) => set((b) => { b.size.bankrollUsd = v })} />
              {edit.size.sizing === 'kelly' && <NumberField label="Minimum per trade" tip={tip('Minimum per trade')} suffix="$" step={0.5} value={edit.size.minTradeUsd} measured={M.size.minTradeUsd} why="Below this a trade cannot pay its own fee." onChange={(v) => set((b) => { b.size.minTradeUsd = v })} />}
              <NumberField label="Maximum contracts per trade" tip={tip('Maximum contracts per trade')} value={edit.size.maxContracts} measured={M.size.maxContracts} onChange={(v) => set((b) => { b.size.maxContracts = v })} />
              <NumberField label="Maximum share of equity per game" tip={tip('Maximum share of equity per game')} step={0.05} min={0} max={1} value={edit.size.maxGameEquityPct} measured={M.size.maxGameEquityPct} why="The 255 contract single game positions." onChange={(v) => set((b) => { b.size.maxGameEquityPct = v })} />
            </div>
            {(() => {
              const note = flatRiskNote(edit, botRisk(tickets.filter((t) => t.botId === edit.id)))
              return note && (
                <div className="note warn small" style={{ marginTop: 10 }}>
                  {note}
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn ghost" onClick={() => set((b) => { b.size.sizing = 'kelly' })}>Size by Kelly on the honest chance</button>
                    <span className="muted">Keeps the ${edit.size.maxTradeUsd} largest trade. Nothing changes until you save.</span>
                  </div>
                </div>
              )
            })()}

            <div className="section">Guards</div>
            <div className="grid cols-2">
              <NumberField label="No entry in the final" tip={tip('No entry in the final')} suffix="s" value={edit.guards.noEntryFinalS} measured={M.guards.noEntryFinalS} why="The overtime wipeout." onChange={(v) => set((b) => { b.guards.noEntryFinalS = v })} />
              <NumberField label="Cancel unfilled after" tip={tip('Cancel unfilled after')} suffix="s" value={edit.guards.autoCancelS} measured={M.guards.autoCancelS} min={5} onChange={(v) => set((b) => { b.guards.autoCancelS = v })} />
              <NumberField label="Maximum trades per day" tip={tip('Maximum trades per day')} value={edit.guards.maxTradesPerDay} measured={M.guards.maxTradesPerDay} min={1} onChange={(v) => set((b) => { b.guards.maxTradesPerDay = v })} />
            </div>
            <div className="row wrap" style={{ marginTop: 10, gap: 24 }}>
              <Toggle on={edit.guards.noOvertime} onChange={(v) => set((b) => { b.guards.noOvertime = v })} label={<>No entries in overtime<Tip text={tip('No entries in overtime')} /></>} />
              <Toggle on={edit.guards.onePositionPerMarket} onChange={(v) => set((b) => { b.guards.onePositionPerMarket = v })} label={<>One position per market<Tip text={tip('One position per market')} /></>} />
              <Toggle on={edit.guards.noOpposingBets} onChange={(v) => set((b) => { b.guards.noOpposingBets = v })} label={<>Never bet against itself<Tip text={tip('Never bet against itself')} /></>} />
              <Toggle on={edit.guards.oneEntryPerGame} onChange={(v) => set((b) => { b.guards.oneEntryPerGame = v })} label={<>One entry a game<Tip text={tip('One entry a game')} /></>} />
            </div>

            <div className="section">Exit</div>
            <div className="grid cols-2">
              <Field label="Exit" tip={`${tip('Exit')} ${tip('Trading both sides')}`} hint={edit.exit.mode === 'hold' ? 'Held until the market settles.' : edit.exit.mode === 'limit' ? 'A sell rests on the book the moment the entry fills.' : edit.exit.mode === 'time'
                ? `Sells at the bid ${edit.exit.afterMin} minutes after the entry${edit.exit.atQuarterEnd ? ', or at the end of its quarter if that comes first' : ''}, whatever the price.`
                : 'Sells at the bid once the bid reaches the mark.'}>
                <select value={edit.exit.mode} onChange={(e) => set((b) => { b.exit.mode = e.target.value as BotSettings['exit']['mode'] })}>
                  <option value="hold">Hold to settlement</option>
                  <option value="limit">Limit exit at entry + target</option>
                  <option value="mark">Cash out at the mark</option>
                  <option value="time">Sell after a set time</option>
                </select>
              </Field>
              {(edit.exit.mode === 'limit' || edit.exit.mode === 'mark') && (
                <NumberField label="Exit target" tip={tip('Exit target')} suffix="cents above entry" step={1} min={1} max={50} value={edit.exit.targetC} measured={M.exit.targetC} onChange={(v) => set((b) => { b.exit.targetC = Math.round(v) })} />
              )}
              {edit.exit.mode === 'time' && (
                <NumberField label="Sell after" tip={tip('Sell after')} suffix="minutes" step={1} min={1} max={60} value={edit.exit.afterMin} measured={M.exit.afterMin} onChange={(v) => set((b) => { b.exit.afterMin = Math.min(60, Math.max(1, Math.round(v))) })} />
              )}
            </div>
            {edit.exit.mode === 'time' && (
              <div className="row wrap" style={{ marginTop: 10, gap: 24 }}>
                <Toggle on={edit.exit.atQuarterEnd} onChange={(v) => set((b) => { b.exit.atQuarterEnd = v })} label={<>Or at the end of the quarter<Tip text={tip('Or at the end of the quarter')} /></>} />
              </div>
            )}
            {edit.exit.mode !== 'hold' && (
              <p className="small muted" style={{ marginTop: 8 }}>
                {edit.guards.oneEntryPerGame ? 'One entry a game is on, so once it has sold the bot does not enter that game again today.' : 'Once everything held in a market has sold, the bot may enter that game again, either side.'}{edit.guards.onePositionPerMarket ? '' : ' One position per market is off, so it may also add to a position it holds.'} Exits work on paper and Kalshi; anything bought elsewhere is held to settlement.
              </p>
            )}
            {account && <Limits bot={edit} account={account} />}
            </details>

            {dirty && problems.length > 0 && (
              <div className="conflict" style={{ marginTop: 18 }}>
                <span className="mark">!</span>
                <span><b>Not saved yet. {problems.length === 1 ? 'One setting needs' : `${problems.length} settings need`} fixing first.</b> The bot keeps running on its last saved settings until then.
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
                </span>
              </div>
            )}
            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn primary" disabled={!dirty || problems.length > 0} onClick={() => save()}>Save settings</button>
              {dirty && <button className="btn ghost" onClick={() => load(edit.id)}>Discard changes</button>}
              <button className="btn" disabled={dirty} title={dirty ? 'Save first, so the code matches what is saved' : undefined} onClick={() => setSharing(!sharing)}>Share</button>
              <span className="grow" style={{ flex: 1 }} />
              <button className="btn ghost bad" onClick={async () => { if (confirm(`Delete "${edit.name}"? Its ledger history stays.`)) { await api.deleteBot(edit.id); await load() } }}>Delete bot</button>
            </div>
            {sharing && !dirty && <Share bot={edit} />}
            {err && <p className="err">{err}</p>}
            {saved && <p className="small good">{saved}</p>}
          </div>
        )}
      </div>
    </>
  )
}

// What the size and guard settings add up to, as they are edited.
function Limits({ bot, account }: { bot: BotSettings; account: AccountSettings }) {
  const { lines, warnings } = limitsSummary(bot, account)
  return (
    <div className="note" style={{ marginTop: 14 }}>
      <b>What these limits add up to</b>
      <ul className="limits small" style={{ marginTop: 6 }}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
      {warnings.map((w) => <div key={w} className="note warn small" style={{ marginTop: 8 }}>{w}</div>)}
    </div>
  )
}


// The bot list, grouped by sport so a long list stays readable: a bot on one
// sport sits under it, a bot on several under Several sports. Within a group,
// live bots come first, then bots that are on, then by name. Search and the
// status filter cut across every group; which groups are folded is remembered
// on this computer only.
const GROUP_ORDER = ['NBA', 'NFL', 'MLB', 'WC', 'Several sports'] as const
const LANE_SHORT: Record<string, string> = { MONEYLINE: 'Moneyline', SPREAD: 'Spread', TOTAL: 'Total', TEAM_TOTAL: 'Team total', PROP: 'Props', COMBO: 'Combos' }
const PHASE_SHORT: Record<string, string> = { pregame: 'Pregame', live: 'In game', both: 'Pregame and in game' }
type StatusFilter = 'all' | 'on' | 'off' | 'live'
const FOLD_KEY = 'bots.folded'

const groupOf = (b: BotSettings): string => (b.market.sports.length === 1 ? b.market.sports[0]! : 'Several sports')
const rank = (b: BotSettings): number => (b.mode === 'live' ? 0 : b.enabled ? 1 : 2)

function BotList({ bots, problem, selected, onSelect, onToggle, onCreate }: {
  bots: BotSettings[]; problem: (b: BotSettings) => string | null; selected: string | null
  onSelect: (b: BotSettings) => void; onToggle: (b: BotSettings, on: boolean) => void; onCreate: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [folded, setFolded] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
  })
  const fold = (g: string): void => {
    const next = folded.includes(g) ? folded.filter((x) => x !== g) : [...folded, g]
    setFolded(next)
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)) } catch { /* a convenience only */ }
  }

  const q = query.trim().toLowerCase()
  const shown = bots.filter((b) =>
    (status === 'all' || (status === 'on' ? b.enabled : status === 'off' ? !b.enabled : b.mode === 'live')) &&
    (!q || `${b.name} ${b.market.sports.join(' ')} ${b.market.lanes.map((l) => LANE_SHORT[l]).join(' ')}`.toLowerCase().includes(q)))
  const groups = GROUP_ORDER.map((g) => ({
    g, list: shown.filter((b) => groupOf(b) === g).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  })).filter((x) => x.list.length)
  const on = bots.filter((b) => b.enabled).length
  const live = bots.filter((b) => b.mode === 'live').length
  const counts: Record<StatusFilter, number> = { all: bots.length, on, off: bots.length - on, live }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Your bots</h2>
        <button className="btn primary" onClick={() => void onCreate()}>New bot</button>
      </div>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        {bots.length} bots, {on} on{live ? <>, <span className="bad">{live} live</span></> : ', all in paper'}.
      </p>
      <input type="text" placeholder="Search by name, sport or lane" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="chips" style={{ margin: '8px 0 4px' }}>
        {(['all', 'on', 'off', 'live'] as const).map((s) => (
          <span key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>
            {s === 'all' ? 'All' : s === 'on' ? 'On' : s === 'off' ? 'Off' : 'Live'} {counts[s]}
          </span>
        ))}
      </div>

      {groups.map(({ g, list }) => {
        // A search shows every match, folded or not, and the open bot's group
        // never hides it.
        const open = Boolean(q) || !folded.includes(g) || list.some((b) => b.id === selected)
        const groupOn = list.filter((b) => b.enabled).length
        return (
          <div key={g} className="bot-group">
            <div className="bot-group-head" onClick={() => fold(g)} role="button" aria-expanded={open}>
              <span className="caret">{open ? '▾' : '▸'}</span>
              <span className="name">{g}</span>
              <span className="meta">{list.length} {list.length === 1 ? 'bot' : 'bots'}{groupOn ? `, ${groupOn} on` : ''}</span>
            </div>
            {open && list.map((b) => (
              <div key={b.id} className={`list-item ${selected === b.id ? 'on' : ''}`} onClick={() => onSelect(b)}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
                  <strong style={{ minWidth: 0 }}>{b.name}</strong>
                  <span onClick={(e) => e.stopPropagation()}><Toggle on={b.enabled} onChange={(v) => onToggle(b, v)} /></span>
                </div>
                <div className="small muted">
                  {PHASE_SHORT[b.market.phase]} · {b.market.lanes.map((l) => LANE_SHORT[l]).join(', ')}
                  {g === 'Several sports' ? ` · ${b.market.sports.join(', ')}` : ''}
                </div>
                <div className="bot-tags">
                  {/* A live bot that cannot send says so, never a plain LIVE. */}
                  {problem(b)
                    ? <span className="pill warn has-tip" data-tip={problem(b)!}>live, not trading</span>
                    : <span className={`pill ${b.mode === 'live' ? 'live' : ''}`}>{b.mode}</span>}
                  {b.trial && <span className="pill hot has-tip" data-tip={`A paper trial: ${b.trial.what}. Accept or drop it on the Desk.`}>trial</span>}
                  {b.entry.basis === 'pick' && <span className="pill lane">our pick</span>}
                  {b.size.sizing === 'flat' && <span className="pill lane">flat ${b.size.maxTradeUsd}</span>}
                  {(b.exit.mode === 'limit' || b.exit.mode === 'mark') && <span className="pill lane">exit +{b.exit.targetC}c</span>}
                  {b.exit.mode === 'time' && <span className="pill lane">sell after {b.exit.afterMin}m</span>}
                  {b.decider.kind === 'agent' && <span className="pill lane">agent</span>}
                  {starterOf(b.id) && <span className="pill">starter</span>}
                </div>
              </div>
            ))}
          </div>
        )
      })}
      {!bots.length && <p className="muted small">No bots yet.</p>}
      {bots.length > 0 && !shown.length && <p className="muted small">No bot matches. <a onClick={() => { setQuery(''); setStatus('all') }} style={{ cursor: 'pointer' }}>Show all</a></p>}
    </div>
  )
}

// Preloaded on first launch; one the user deleted can be added back here.
// Every bot on in paper at once, and the data it makes written to files.
function PaperTest({ onDone }: { onDone: () => Promise<void> }) {
  const [cap, setCap] = useState(2)
  const [days, setDays] = useState(30)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const run = async (fn: () => Promise<string>): Promise<void> => {
    setErr(''); setMsg('')
    try { setMsg(await fn()); await onDone() } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="card">
      <h2>Paper test<Tip text="Switches every paper bot on at once and adds back any starter bot that is missing, so every strategy runs side by side on practice money. Each bot keeps its own rules and limits. Live bots are never touched. Every change is written to the ledger, so the old settings can be read back." /></h2>
      <p className="small muted">Runs while the app is open and the engine is started. Change any bot's settings as it runs; each change is logged, and every trade records the rules it ran under.</p>
      <div className="row" style={{ alignItems: 'end', gap: 10 }}>
        <NumberField label="Largest trade, $" value={cap} min={0} step={1} onChange={setCap} />
        <button className="btn primary" onClick={() => void run(async () => {
          if (!confirm(`Switch every paper bot on${cap > 0 ? ` and hold each to $${cap} a trade at most` : ''}? Missing starter bots are added back. Live bots are left as they are.`)) return ''
          const r = await api.paperTest(cap > 0 ? cap : null)
          return `${r.on} bots are on in paper.${r.live.length ? ` Left alone because they are live: ${r.live.join(', ')}.` : ''} Press Start engine on the Dashboard if it is not running.`
        })}>Paper test every bot</button>
        <button className="btn ghost" onClick={() => void run(async () => `${(await api.paperStop()).off} paper bots switched off.`)}>Switch paper bots off</button>
      </div>
      <div className="row" style={{ alignItems: 'end', gap: 10, marginTop: 10 }}>
        <NumberField label="Days of data" value={days} min={1} step={1} onChange={setDays} />
        <button className="btn" onClick={() => void run(async () => {
          const folder = await api.exportTest(days)
          return folder ? `Saved to ${folder}. summary.txt reads it out; the CSV files open in Excel.` : ''
        })}>Export test data</button>
      </div>
      {msg && <p className="small good">{msg}</p>}
      {err && <p className="small bad">{err}</p>}
    </div>
  )
}

function Starters({ have, onAdd }: { have: Set<string>; onAdd: (b: BotSettings) => Promise<void> }) {
  const missing = STARTERS.filter((s) => !have.has(`starter-${s.key}`))
  return (
    <div className="card">
      <h2>Starter bots<Tip text="Ready made settings documents, each the measured defaults with a few settings moved. They arrive switched off and in paper. Run one in paper and judge it on the Results screen before trusting it with money." /></h2>
      {missing.length ? missing.map((s) => (
        <div key={s.key} className="list-item">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{s.name}</strong>
            <button className="btn" onClick={() => void onAdd(s.build())}>Add</button>
          </div>
          <div className="small muted">{s.summary}</div>
        </div>
      )) : <p className="small muted" style={{ margin: 0 }}>All {STARTERS.length} starters are in your list, switched off and in paper. Switch any on to try it.</p>}
    </div>
  )
}

function Import({ onAdd }: { onAdd: (b: BotSettings) => Promise<void> }) {
  const [code, setCode] = useState('')
  const [bot, setBot] = useState<BotSettings | null>(null)
  const [err, setErr] = useState('')
  const read = (): void => {
    setErr(''); setBot(null)
    try { setBot(readShareCode(code, `bot-${Date.now().toString(36)}`)) } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="card">
      <details>
        <summary>Import a bot from a share code</summary>
        <div className="grid" style={{ marginTop: 10 }}>
          <textarea placeholder="LEBOT1:…" value={code} onChange={(e) => { setCode(e.target.value); setBot(null) }} />
          <div className="row"><button className="btn" disabled={!code.trim()} onClick={read}>Read code</button></div>
          {err && <p className="err">{err}</p>}
          {bot && (
            <div className="note">
              <p style={{ marginTop: 0 }}><b>{bot.name}</b>, {bot.market.sports.join('/')}, {bot.market.phase}. It will be added switched off and in paper. Read what it changes before you switch it on:</p>
              <ChangeTable changes={changesFromDefaults(bot)} />
              {bot.decider.kind === 'agent' && <p className="small warn">Uses the agent decider ({bot.decider.provider ?? 'no provider'}) with these instructions: {bot.decider.instructions || '(none)'}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={() => void onAdd(bot).then(() => { setCode(''); setBot(null) })}>Add as a new bot</button>
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

function Share({ bot }: { bot: BotSettings }) {
  const code = useMemo(() => shareCode(bot), [bot])
  const [copied, setCopied] = useState(false)
  return (
    <div className="note" style={{ marginTop: 14 }}>
      <p style={{ marginTop: 0 }}>Share code for <b>{bot.name}</b>. It holds this bot's settings and nothing else: no trades, results, balances or keys. Whoever imports it gets a new bot, switched off and in paper.</p>
      <textarea readOnly value={code} onFocus={(e) => e.target.select()} style={{ minHeight: 70, fontFamily: 'var(--mono)', fontSize: 11 }} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={() => void api.copy(code).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy code'}</button>
        <span className="small muted">If a bot is doing well for you, post the code with a line on how it ran, and it can be considered for the starter bots everyone gets.</span>
      </div>
    </div>
  )
}

const PROVIDER_NAME: Record<ProviderId, string> = { anthropic: 'Claude', openai: 'OpenAI', xai: 'Grok', ollama: 'Ollama' }

// What changed, in plain words: the setting, what it was, what it becomes.
function ChangeTable({ changes, before = 'Measured default', after = 'This bot' }: { changes: Change[]; before?: string; after?: string }) {
  if (!changes.length) return <p className="small muted">{before === 'Measured default' ? 'Every setting is at its measured default.' : 'Nothing changes.'}</p>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="small">
        <thead><tr><th>Setting</th><th>{before}</th><th>{after}</th></tr></thead>
        <tbody>{changeLines(changes).map((c) => <tr key={c.field}><td>{c.name}</td><td>{c.from}</td><td className="warn">{c.to}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

// Type what you want and the AI sets the bot (2026-11-20). It edits the
// bot that is open, keeps its money settings and whether it runs, and shows
// every change before anything is saved.
function AskAi({ bot, onSaved }: { bot: BotSettings; onSaved: (id: string, msg: string) => Promise<void> }) {
  const [sentence, setSentence] = useState('')
  const [provider, setProvider] = useState<ProviderId | null>(null)
  const [busy, setBusy] = useState<'edit' | 'new' | null>(null)
  const [draft, setDraft] = useState<(StrategyResult & { isNew: boolean }) | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { void api.aiConfigured().then((c) => setProvider(ProviderId.options.find((p) => c[p]) ?? null)) }, [])
  const [why, setWhy] = useState<WhyAnswer | null>(null)
  const [whyBusy, setWhyBusy] = useState(false)
  // A new bot starts with an empty box, so a request typed for one bot is
  // never sent for another (2026-11-21).
  useEffect(() => { setDraft(null); setErr(''); setWhy(null); setSentence(''); setUndo(null); setAnswer(null) }, [bot.id])
  const explain = async (): Promise<void> => {
    setWhyBusy(true); setErr('')
    try { setWhy(await api.aiWhy(bot.id)) } catch (e) { setErr((e as Error).message) } finally { setWhyBusy(false) }
  }

  // A question is not a settings change (2026-11-21: "it should hit
  // the API and get that data"). When the draft would change nothing, the same
  // words go to Ask Lazy Edge, which looks things up with its tools, and its
  // answer shows here in place of a refusal.
  const [answer, setAnswer] = useState<ChatReply | null>(null)
  const ask = async (isNew: boolean): Promise<void> => {
    if (!provider) return
    setBusy(isNew ? 'new' : 'edit'); setErr(''); setDraft(null); setAnswer(null)
    try {
      const d = await api.draft(sentence, provider, isNew ? undefined : bot)
      if (!isNew && d.changes.length === 0) setAnswer(await api.deskChat(`About my bot "${bot.name}": ${sentence}`, []))
      else setDraft({ ...d, isNew })
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const question = async (): Promise<void> => {
    setBusy('edit'); setErr(''); setDraft(null); setAnswer(null)
    try { setAnswer(await api.deskChat(`About my bot "${bot.name}": ${sentence}`, [])) } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const [undo, setUndo] = useState<{ id: string; botId: string } | null>(null)
  // Through the confirmation levels: a live bot asked to trade more gets a
  // second window by name. Every change can be put back.
  const save = async (): Promise<void> => {
    if (!draft) return
    try {
      const out = await api.aiSave(draft.bot, sentence)
      setDraft(null); setSentence('')
      setUndo(out.changeId ? { id: out.changeId, botId: out.bot.id } : null)
      await onSaved(out.bot.id, draft.isNew ? `Saved "${out.bot.name}" as a new bot, in paper.` : `Saved. ${out.bot.name} runs on the new settings from its next cycle.`)
    } catch (e) { if ((e as Error).message !== 'Cancelled.') setErr((e as Error).message) }
  }
  const trial = async (): Promise<void> => {
    if (!draft) return
    try {
      const t = await api.trialStart(draft.bot, sentence)
      setDraft(null); setSentence('')
      await onSaved(bot.id, `Started "${t.name}", a paper copy running the change beside this bot. Compare them on the Desk, then accept or drop it.`)
    } catch (e) { setErr((e as Error).message) }
  }
  const putBack = async (): Promise<void> => {
    if (!undo) return
    try { await api.aiUndo(undo.id); setUndo(null); await onSaved(undo.botId, 'Put the settings back as they were before the AI change.') } catch (e) { if ((e as Error).message !== 'Cancelled.') setErr((e as Error).message) }
  }

  return (
    <div className="note" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Tell the AI what you want</b>
        <button className="btn ghost" disabled={whyBusy} onClick={() => void explain()}>{whyBusy ? 'Checking…' : bot.enabled ? 'Why is it not trading?' : 'What would it do?'}</button>
      </div>
      {why && (
        <div className="note warn small" style={{ margin: '8px 0' }}>
          <b>{why.by === 'ai' ? why.text : why.headline}</b>
          {why.lines.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{why.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
        </div>
      )}
      {!provider ? (
        <p className="small muted" style={{ marginBottom: 0 }}>Add an AI key on the Keys screen and you can set any bot by typing what you want.</p>
      ) : (
        <div className="grid" style={{ marginTop: 8 }}>
          <textarea
            placeholder="For example: only props in the 2nd, 3rd and 4th quarters that are 60% or more to hit, priced at least 3 points under our number."
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
          />
          <div className="row">
            <button className="btn primary" disabled={busy !== null || sentence.trim().length < 6} onClick={() => void ask(false)}>{busy === 'edit' ? 'Working…' : `Change ${bot.name}`}</button>
            <button className="btn ghost" disabled={busy !== null || sentence.trim().length < 6} onClick={() => void ask(true)}>{busy === 'new' ? 'Working…' : 'Make a new bot'}</button>
            <button className="btn ghost" disabled={busy !== null || sentence.trim().length < 6} onClick={() => void question()} title="Looks up what the question needs from the Lazy Edge API and your own record, and answers. Changes nothing.">Ask a question</button>
          </div>
          <span className="small muted">{PROVIDER_NAME[provider]} sets everything but money: trade size, the loss stop and paper or live stay yours. A question is answered from the Lazy Edge data and your record.</span>
          {err && <p className="err" style={{ whiteSpace: 'pre-line' }}>{err}</p>}
          {answer && (
            <div className="note" style={{ whiteSpace: 'pre-wrap' }}>
              {answer.answer}
              {answer.proposals.map((p) => <div key={p.id} style={{ marginTop: 8 }}><Proposal p={p} /></div>)}
            </div>
          )}
          {draft && (
            <div>
              <p style={{ marginTop: 0 }}>{draft.explanation}</p>
              {draft.recommendation && <div className="note small" style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}><b>The AI recommends.</b> {draft.recommendation}</div>}
              <ChangeTable changes={draft.changes} before={draft.isNew ? 'Measured default' : 'Now'} after={draft.isNew ? 'New bot' : 'After'} />
              {draft.unsupported.length > 0 && <p className="warn small">Not done: {draft.unsupported.join('; ')}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={() => void save()}>{draft.isNew ? 'Save as a new bot' : 'Save these changes'}</button>
                {!draft.isNew && <button className="btn ghost" title="Runs the change on a paper copy beside this bot, so you can compare before it touches this one." onClick={() => void trial()}>Try it in paper first</button>}
                <button className="btn ghost" onClick={() => setDraft(null)}>Discard</button>
              </div>
              {!draft.isNew && bot.mode === 'live' && <p className="small muted" style={{ marginBottom: 0 }}>This bot is live. A change that lets it trade more asks you once more before it is saved.</p>}
            </div>
          )}
          {undo && undo.botId === bot.id && !draft && (
            <div className="row"><span className="small">Saved from the AI.</span><button className="btn ghost" onClick={() => void putBack()}>Put it back</button></div>
          )}
        </div>
      )}
    </div>
  )
}

// A starter bot's update: what this version's starter settings changed on it
// and the way back, a live bot's waiting choice, or a reset to the starter.
function StarterNote({ bot, status, onDone }: { bot: BotSettings; status: StarterStatus | undefined; onDone: (msg: string) => Promise<void> }) {
  const s = starterOf(bot.id)!
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const act = async (fn: () => Promise<void>, msg: string): Promise<void> => {
    setErr('')
    try { await fn(); await onDone(msg) } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="note" style={{ marginBottom: 12 }}>
      <b>Starter bot.</b> {s.summary}
      {status?.pending && (
        <div className="note warn" style={{ marginTop: 10 }}>
          <b>This update changed these settings on the starter.</b> Only these; everything else you set stays, and money never changes. The bot is live, so nothing changed until you choose.
          <ChangeTable changes={status.pending} before="Yours" after="New starter" />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => void act(() => api.starterUse(bot.id), 'Took the new starter settings. Your old ones can be put back.')}>Use the new settings</button>
            <button className="btn ghost" onClick={() => void act(() => api.starterKeep(bot.id), 'Kept your settings.')}>Keep mine</button>
          </div>
        </div>
      )}
      {status?.replaced && (
        <div style={{ marginTop: 10 }}>
          <span className="small">This bot took this version's starter settings{status.replaced.length ? `, ${status.replaced.length} ${status.replaced.length === 1 ? 'change' : 'changes'}` : ''}. </span>
          <span className="small" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'See what changed'}</span>
          {open && <ChangeTable changes={status.replaced} before="Yours before" after="Now" />}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={() => void act(() => api.starterUndo(bot.id), 'Put your old settings back.')}>Put my settings back</button>
            <button className="btn ghost" onClick={() => void act(() => api.starterDismiss(bot.id), 'Keeping the starter settings.')}>Keep the new ones</button>
          </div>
        </div>
      )}
      {!status?.pending && !status?.replaced && status?.reset && (
        <div style={{ marginTop: 10 }}>
          <span className="small">You have changed {status.reset.length} {status.reset.length === 1 ? 'setting' : 'settings'} from the starter. </span>
          <span className="small" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'See them'}</span>
          {open && <ChangeTable changes={status.reset} before="Yours" after="Starter" />}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={() => void act(() => api.starterReset(bot.id), 'Reset to the starter settings, your money settings kept. Your old ones can be put back.')}>Reset to the starter</button>
          </div>
        </div>
      )}
      {err && <p className="err small">{err}</p>}
    </div>
  )
}
