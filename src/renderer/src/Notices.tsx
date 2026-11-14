import type { NoticesState } from '@shared/notices'
import { api } from './api'

// Messages from the Lazy Edge team and update alerts, above every screen. Text
// from the notices file is shown as plain text; its link opens in the browser.
export function NoticeBar({ state }: { state: NoticesState | null }) {
  if (!state) return null
  const { update, notices } = state
  if (!update && !notices.length) return null
  return (
    <div className="notices">
      {update && (
        <div className={`notice ${update.required ? 'urgent' : 'warn'}`}>
          <div className="notice-text">
            <b>{update.required ? 'This version needs an update' : `Lazy Edge ${update.version} is available`}</b>
            <span>
              {update.required
                ? `${update.reason ?? 'The team asks every install below this version to update.'} Your bots, ledger and keys carry over.`
                : `You have ${__APP_VERSION__}. Download it, close the app and run the new file. Your bots, ledger and keys carry over.`}
            </span>
          </div>
          <a className="btn primary" href={update.url} target="_blank" rel="noreferrer">Download</a>
        </div>
      )}
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.level}`}>
          <div className="notice-text">
            <b>{n.title}</b>
            {n.body && <span>{n.body}</span>}
          </div>
          {n.link && <a className="btn" href={n.link} target="_blank" rel="noreferrer">Read more</a>}
          {n.level !== 'urgent' && <button className="btn" onClick={() => void api.dismissNotice(n.id)}>Dismiss</button>}
        </div>
      ))}
    </div>
  )
}
