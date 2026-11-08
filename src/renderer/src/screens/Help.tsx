import { useState } from 'react'
import { GATES, GLOSSARY } from '../glossary'

export function Help() {
  const [q, setQ] = useState('')
  const match = (a: string, b: string): boolean => !q.trim() || `${a} ${b}`.toLowerCase().includes(q.trim().toLowerCase())
  const sections = [
    ...GLOSSARY,
    {
      title: 'Why a bot skipped a play',
      intro: 'The Board and Dashboard name the first check a play failed. These are those checks, in plain English.',
      terms: Object.entries(GATES).map(([k, v]) => ({ term: v, text: k }))
    }
  ]
    .map((s) => ({ ...s, terms: s.terms.filter((t) => match(t.term, t.text)) }))
    .filter((s) => s.terms.length)

  return (
    <>
      <h1>Help</h1>
      <p className="lede">Every term on the Bots and Board screens, in plain English. The same explanations appear when you hover a ? anywhere in the app.</p>
      <input type="text" placeholder="Search terms, for example haircut or Kelly" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 420, marginBottom: 14 }} />
      {sections.map((s) => (
        <div key={s.title} className="card" style={{ marginBottom: 12 }}>
          <h2>{s.title}</h2>
          {s.intro && !q && <p className="muted" style={{ marginTop: 0 }}>{s.intro}</p>}
          {s.terms.map((t) => (
            <div key={t.term} className="help-term">
              <span className="k">{t.term}</span>
              <span className={s.title.startsWith('Why') ? 'mono small muted' : ''}>{t.text}</span>
            </div>
          ))}
        </div>
      ))}
      {!sections.length && <p className="muted">No term matches “{q}”.</p>}
    </>
  )
}
