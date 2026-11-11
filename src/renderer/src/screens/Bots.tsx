import { useEffect, useMemo, useState } from 'react'
import { defaultBot } from '@shared/ruleset'
import { limitsSummary } from '@shared/limits'
import { Lane, Phase, ProviderId, Sport, TradeableLabel, VenueId, type AccountSettings, type BotSettings } from '@shared/schema'
import { changesFromDefaults, readShareCode, shareCode, type Change } from '@shared/share'
import { STARTERS, starterOf } from '@shared/starters'
import { api, type StrategyResult } from '../api'
import { tip } from '../glossary'
import { Chips, Field, NumberField, Tip, Toggle } from '../ui'

const M = defaultBot('m', 'm') // the measured defaults, for the hints

export function Bots() {
  const [bots, setBots] = useState<BotSettings[]>([])
  const [edit, setEdit] = useState<BotSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState('')
  const [sharing, setSharing] = useState(false)
  const [account, setAccount] = useState<AccountSettings | null>(null)
  useEffect(() => setSharing(false), [edit?.id])
  useEffect(() => { void api.account().then(setAccount) }, [])

  const load = async (select?: string): Promise<void> => {
    const list = await api.bots()
    setBots(list)
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

  return (
    <>
      <h1>Bots</h1>
      <p className="lede">Each bot is a settings document. The engine follows it exactly and refuses anything it does not recognise. Every number shows its measured default; an amber hint means you have moved off what was measured. Hover any ? for what a setting means, or open Help for every term.</p>
      <div className="split">
        <div className="grid" style={{ alignContent: 'start', gap: 14 }}>
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Your bots</h2>
            <button className="btn primary" onClick={create}>New bot</button>
          </div>
          {bots.map((b) => (
            <div key={b.id} className={`list-item ${edit?.id === b.id ? 'on' : ''}`} onClick={() => { if (!dirty || confirm('Discard unsaved changes?')) { setEdit(structuredClone(b)); setDirty(false) } }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{b.name}</strong>
                <span onClick={(e) => e.stopPropagation()}><Toggle on={b.enabled} onChange={(v) => void toggle(b, v)} /></span>
              </div>
              <div className="small muted">
                <span className={b.mode === 'live' ? 'bad' : ''}>{b.mode}</span> · {b.market.sports.join('/')} · {b.decider.kind}{starterOf(b.id) ? ' · starter' : ''}
              </div>
            </div>
          ))}
          {!bots.length && <p className="muted small">No bots yet.</p>}
        </div>
        <Starters have={new Set(bots.map((b) => b.id))} onAdd={async (b) => { await api.saveBot(b); await load(b.id) }} />
        <Import onAdd={async (b) => {
          // A name already in the list gets a suffix, so the two are never confused.
          const named = bots.some((x) => x.name === b.name) ? { ...b, name: `${b.name} (imported)`.slice(0, 80) } : b
          await api.saveBot(named); await load(named.id); setSaved(`Imported "${named.name}". It is off and in paper until you switch it on.`)
        }} />
        </div>

        {edit && (
          <div className="card">
            {starterOf(edit.id) && <div className="note" style={{ marginBottom: 12 }}><b>Starter bot.</b> {starterOf(edit.id)!.summary} Change anything you like; it is yours.</div>}
            <Describe onUse={(d) => { setEdit({ ...d.bot, id: edit.id }); setDirty(true) }} />

            <div className="section">Basics</div>
            <div className="grid cols-2">
              <Field label="Name"><input type="text" value={edit.name} onChange={(e) => set((b) => { b.name = e.target.value })} /></Field>
              <Field label="Mode" tip={`Paper: ${tip('Paper')} Live: ${tip('Live')}`} hint="Paper trades a local ledger against real books. Live sends real orders, still subject to dry run and the kill switch.">
                <select value={edit.mode} onChange={(e) => set((b) => { b.mode = e.target.value as BotSettings['mode'] })}>
                  <option value="paper">Paper</option>
                  <option value="live">Live</option>
                </select>
              </Field>
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
              <Field label="Labels" tip={tip('Labels')} hint="ILLIQUID, ROLE_PRICED and UNPRICED are never traded and cannot be enabled."><Chips options={TradeableLabel.options} tips={tip} value={edit.market.labels} onChange={(v) => set((b) => { b.market.labels = v })} /></Field>
              <Field label="Venues" tip={tip('Venues')} hint="Best price after fees wins among these. A live bot skips any venue without a usable balance."><Chips options={VenueId.options} value={edit.market.venues} onChange={(v) => set((b) => { b.market.venues = v })} /></Field>
            </div>

            <div className="section">Entry</div>
            <div className="grid cols-2">
              <NumberField label="Minimum edge" tip={`${tip('Minimum edge')} ${tip('Edge (pp)')}`} suffix="pp" step={0.5} value={edit.entry.minEdgePp} measured={M.entry.minEdgePp} why="UserConfig.min_edge_threshold." onChange={(v) => set((b) => { b.entry.minEdgePp = v })} />
              <NumberField label="Minimum EV after fees" tip={tip('EV after fees')} suffix="cents" step={0.1} value={edit.entry.minEvCents} measured={M.entry.minEvCents} why="Replaced price caps on 2026-08-31." onChange={(v) => set((b) => { b.entry.minEvCents = v })} />
              <NumberField label="Edge haircut" tip={tip('Edge haircut')} step={0.05} min={0} max={1} value={edit.entry.edgeHaircut} measured={M.entry.edgeHaircut} why="811 graded fills: our p ≥ 0.75 bucket won 62%. 1.0 trades the raw claimed edge." onChange={(v) => set((b) => { b.entry.edgeHaircut = v })} />
              <NumberField label="Maximum price age" tip={tip('Maximum price age')} suffix="s" value={edit.entry.maxPriceAgeS} measured={M.entry.maxPriceAgeS} max={180} why="The API nulls an edge against a price older than 180s." onChange={(v) => set((b) => { b.entry.maxPriceAgeS = v })} />
              <NumberField label="Price band low" tip={tip('Price band')} suffix="cents" value={edit.entry.priceBandC[0]} measured={M.entry.priceBandC[0]} min={1} max={99} why="The hot plays work." onChange={(v) => set((b) => { b.entry.priceBandC = [v, b.entry.priceBandC[1]] })} />
              <NumberField label="Price band high" tip={tip('Price band')} suffix="cents" value={edit.entry.priceBandC[1]} measured={M.entry.priceBandC[1]} min={1} max={99} onChange={(v) => set((b) => { b.entry.priceBandC = [b.entry.priceBandC[0], v] })} />
            </div>
            <div className="row wrap" style={{ marginTop: 10, gap: 24 }}>
              <Toggle on={edit.entry.requireTrigger} onChange={(v) => set((b) => { b.entry.requireTrigger = v })} label={<>Require a game event trigger<Tip text={tip('Require a game event trigger')} /></>} />
              <Toggle on={edit.entry.measuredOnly} onChange={(v) => set((b) => { b.entry.measuredOnly = v })} label={<>Measured edges only<Tip text={tip('Measured edges only')} /></>} />
            </div>

            <div className="section">Size</div>
            <div className="grid cols-2">
              <NumberField label="Kelly multiplier" tip={`${tip('Kelly')} ${tip('Kelly multiplier')}`} step={0.05} min={0} max={1} value={edit.size.kellyMultiplier} measured={M.size.kellyMultiplier} why="Quarter Kelly." onChange={(v) => set((b) => { b.size.kellyMultiplier = v })} />
              <NumberField label="Bankroll" tip={tip('Bankroll')} suffix="$, 0 = live balance" step={10} value={edit.size.bankrollUsd} measured={M.size.bankrollUsd} why="Kelly rides the real balance, the 2026-07-23 fluid bankroll." onChange={(v) => set((b) => { b.size.bankrollUsd = v })} />
              <NumberField label="Maximum per trade" tip={tip('Maximum per trade')} suffix="$" step={1} value={edit.size.maxTradeUsd} measured={M.size.maxTradeUsd} why="MLB_MAX_TRADE_USD." onChange={(v) => set((b) => { b.size.maxTradeUsd = v })} />
              <NumberField label="Minimum per trade" tip={tip('Minimum per trade')} suffix="$" step={0.5} value={edit.size.minTradeUsd} measured={M.size.minTradeUsd} why="Below this a trade cannot pay its own fee." onChange={(v) => set((b) => { b.size.minTradeUsd = v })} />
              <NumberField label="Maximum contracts per trade" tip={tip('Maximum contracts per trade')} value={edit.size.maxContracts} measured={M.size.maxContracts} onChange={(v) => set((b) => { b.size.maxContracts = v })} />
              <NumberField label="Maximum share of equity per game" tip={tip('Maximum share of equity per game')} step={0.05} min={0} max={1} value={edit.size.maxGameEquityPct} measured={M.size.maxGameEquityPct} why="The 255 contract single game positions." onChange={(v) => set((b) => { b.size.maxGameEquityPct = v })} />
            </div>

            <div className="section">Guards</div>
            <div className="grid cols-2">
              <NumberField label="No entry in the final" tip={tip('No entry in the final')} suffix="s" value={edit.guards.noEntryFinalS} measured={M.guards.noEntryFinalS} why="The overtime wipeout." onChange={(v) => set((b) => { b.guards.noEntryFinalS = v })} />
              <NumberField label="Cancel unfilled after" tip={tip('Cancel unfilled after')} suffix="s" value={edit.guards.autoCancelS} measured={M.guards.autoCancelS} min={5} onChange={(v) => set((b) => { b.guards.autoCancelS = v })} />
              <NumberField label="Daily drawdown stop" tip={tip('Daily drawdown stop')} suffix="$" step={5} value={edit.guards.maxDailyDrawdownUsd} measured={M.guards.maxDailyDrawdownUsd} why="Worse of realised loss and the equity drop since the day's first reading." onChange={(v) => set((b) => { b.guards.maxDailyDrawdownUsd = v })} />
              <NumberField label="Maximum trades per day" tip={tip('Maximum trades per day')} value={edit.guards.maxTradesPerDay} measured={M.guards.maxTradesPerDay} min={1} onChange={(v) => set((b) => { b.guards.maxTradesPerDay = v })} />
            </div>
            <div className="row wrap" style={{ marginTop: 10, gap: 24 }}>
              <Toggle on={edit.guards.noOvertime} onChange={(v) => set((b) => { b.guards.noOvertime = v })} label={<>No entries in overtime<Tip text={tip('No entries in overtime')} /></>} />
              <Toggle on={edit.guards.onePositionPerMarket} onChange={(v) => set((b) => { b.guards.onePositionPerMarket = v })} label={<>One position per market<Tip text={tip('One position per market')} /></>} />
            </div>
            <p className="small muted" style={{ marginTop: 12 }}>Every position is held to settlement in this version.<Tip text={tip('Hold to settlement')} /></p>
            {account && <Limits bot={edit} account={account} />}

            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn primary" disabled={!dirty} onClick={() => save()}>Save settings</button>
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

const show = (v: unknown): string => (v === undefined ? '—' : JSON.stringify(v))

function ChangeTable({ changes }: { changes: Change[] }) {
  if (!changes.length) return <p className="small muted">Every setting is at its measured default.</p>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="small">
        <thead><tr><th>Setting</th><th>Measured default</th><th>This bot</th></tr></thead>
        <tbody>{changes.map((c) => <tr key={c.field}><td className="mono">{c.field}</td><td>{show(c.from)}</td><td className="warn">{show(c.to)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

// Preloaded on first launch; one the user deleted can be added back here.
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

function Describe({ onUse }: { onUse: (d: StrategyResult) => void }) {
  const [sentence, setSentence] = useState('')
  const [provider, setProvider] = useState<ProviderId>('anthropic')
  const [configured, setConfigured] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<StrategyResult | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    void api.aiConfigured().then((c) => {
      setConfigured(c)
      const first = ProviderId.options.find((p) => c[p])
      if (first) setProvider(first)
    })
  }, [])
  const any = useMemo(() => Object.values(configured).some(Boolean), [configured])

  return (
    <details>
      <summary>Describe a strategy in plain English and let your AI draft the settings</summary>
      {!any ? (
        <p className="small muted">Add an AI key on the Keys screen first.</p>
      ) : (
        <div className="grid" style={{ marginTop: 10 }}>
          <textarea
            placeholder="Only NFL totals, the under side when our probability is at least 6 points above the market's, never in the final two minutes, $5 a trade at most."
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
          />
          <div className="row">
            <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} style={{ width: 160 }}>
              {ProviderId.options.filter((p) => configured[p]).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button className="btn primary" disabled={busy || sentence.trim().length < 10} onClick={async () => {
              setBusy(true); setErr(''); setDraft(null)
              try { setDraft(await api.draft(sentence, provider)) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
            }}>{busy ? 'Drafting…' : 'Draft settings'}</button>
          </div>
          {err && <p className="err">{err}</p>}
          {draft && (
            <div className="note">
              <p style={{ marginTop: 0 }}>{draft.explanation}</p>
              {draft.changes.length > 0 && (
                <table className="small">
                  <thead><tr><th>Setting</th><th>Measured default</th><th>Draft</th></tr></thead>
                  <tbody>{draft.changes.map((c) => <tr key={c.field}><td className="mono">{c.field}</td><td>{JSON.stringify(c.from)}</td><td className="warn">{JSON.stringify(c.to)}</td></tr>)}</tbody>
                </table>
              )}
              {draft.unsupported.length > 0 && <p className="warn small">Not expressible in settings, left at defaults: {draft.unsupported.join('; ')}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={() => { onUse(draft); setDraft(null) }}>Load into the editor</button>
                <span className="small muted">Nothing is saved or switched on until you save it yourself.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  )
}
