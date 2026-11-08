import { useState } from 'react'
import { ACKNOWLEDGEMENTS, TERMS, TERMS_VERSION } from '@shared/terms'
import { api } from '../api'

// First launch, and again whenever the terms change. Also readable any time
// from the sidebar, where it shows when they were accepted.
export function Terms({ onAccepted, acceptedAt }: { onAccepted?: () => void; acceptedAt?: string | null }) {
  const [checked, setChecked] = useState<boolean[]>(ACKNOWLEDGEMENTS.map(() => false))
  const [err, setErr] = useState('')
  const all = checked.every(Boolean)
  const reading = Boolean(acceptedAt)

  return (
    <div className={reading ? '' : 'center'} style={reading ? undefined : { overflow: 'auto', padding: '32px 16px' }}>
      <div className="card" style={{ maxWidth: 760, margin: '0 auto' }}>
        <h1 style={{ marginTop: 0 }}>Terms of use and risk</h1>
        <p className="small muted">Version {TERMS_VERSION}{acceptedAt && ` · accepted ${new Date(acceptedAt).toLocaleString()}`}</p>
        <div className="note" style={{ marginBottom: 14 }}>
          This is beta software, version {__APP_VERSION__}. It can place real money orders on your own exchange accounts. Read this before using it.
        </div>

        {TERMS.map((s) => (
          <section key={s.title}>
            <div className="section">{s.title}</div>
            {s.body.map((p, i) => <p key={i} style={{ margin: '0 0 10px' }}>{p}</p>)}
          </section>
        ))}

        {!reading && (
          <>
            <div className="section">Confirm each of these</div>
            <div className="grid" style={{ gap: 10 }}>
              {ACKNOWLEDGEMENTS.map((a, i) => (
                <label key={i} className="row" style={{ alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={checked[i]}
                    onChange={(e) => setChecked(checked.map((c, j) => (j === i ? e.target.checked : c)))}
                    style={{ marginTop: 4 }}
                  />
                  <span>{a}</span>
                </label>
              ))}
            </div>
            <div className="row" style={{ marginTop: 18 }}>
              <button
                className="btn primary"
                disabled={!all}
                onClick={async () => {
                  setErr('')
                  try { await api.acceptTerms(TERMS_VERSION, checked.filter(Boolean).length); onAccepted?.() } catch (e) { setErr((e as Error).message) }
                }}
              >
                I agree
              </button>
              <span className="small muted">You can read these again any time from the sidebar.</span>
            </div>
            {err && <p className="err">{err}</p>}
          </>
        )}
      </div>
    </div>
  )
}
