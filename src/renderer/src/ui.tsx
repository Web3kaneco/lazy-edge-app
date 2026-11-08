import type { ReactNode } from 'react'

// A small ? that shows a plain English explanation on hover or focus.
export function Tip({ text }: { text: string }) {
  if (!text) return null
  return <span className="tip" tabIndex={0} data-tip={text} aria-label={text} onClick={(e) => e.stopPropagation()}>?</span>
}

// The terminal's wordmark: a cyan LE tile and LAZY EDGE in Barlow Condensed.
export function BrandMark() {
  return (
    <span className="brandmark">
      <span className="tile">LE</span>
      <span className="word">LAZY EDGE</span>
    </span>
  )
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <span className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="track" />
      {label}
    </span>
  )
}

export function Chips<T extends string>({ options, value, onChange, tips }: { options: readonly T[]; value: T[]; onChange: (v: T[]) => void; tips?: (o: T) => string }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <span
          key={o}
          className={`chip ${value.includes(o) ? 'on' : ''}${tips?.(o) ? ' has-tip' : ''}`}
          data-tip={tips?.(o) || undefined}
          onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}
        >
          {o}
        </span>
      ))}
    </div>
  )
}

// A number setting with its measured default beside it, so loosening a guard
// is always visible as a move away from what was measured.
export function NumberField(props: {
  label: string
  value: number
  onChange: (v: number) => void
  measured?: number
  why?: string
  step?: number
  min?: number
  max?: number
  suffix?: string
  tip?: string
}) {
  const moved = props.measured !== undefined && props.value !== props.measured
  return (
    <div className="field">
      <label>{props.label}{props.suffix ? ` (${props.suffix})` : ''}{props.tip && <Tip text={props.tip} />}</label>
      <input
        type="number"
        value={Number.isFinite(props.value) ? props.value : ''}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
      {props.measured !== undefined && (
        <span className={`hint ${moved ? 'moved' : ''}`}>
          {moved ? `Measured default ${props.measured}. ` : 'Measured default. '}
          {props.why}
        </span>
      )}
    </div>
  )
}

export function Field({ label, children, hint, tip }: { label: string; children: ReactNode; hint?: string; tip?: string }) {
  return (
    <div className="field">
      <label>{label}{tip && <Tip text={tip} />}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}
