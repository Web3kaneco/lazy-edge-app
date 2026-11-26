// What the window shows when a screen fails (2026-11-23: "app started
// crashing when switching to night mode"). Without this, one screen's error
// blanked the whole window and left nothing to read. Trading runs in the
// background process and is not touched by a screen failing; this says so,
// writes the error to the crash log, and offers a reload.
import { Component, type ReactNode } from 'react'

export function logScreenError(what: string): void {
  try { void window.lazyedge.call('app:logError', what.slice(0, 4000)).catch(() => {}) } catch { /* nothing to log to */ }
}

window.addEventListener('error', (e) => logScreenError(`error: ${e.message} at ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => logScreenError(`unhandled: ${String((e.reason as Error)?.stack ?? e.reason)}`))

export class CrashGuard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    logScreenError(`screen: ${error.stack ?? error.message}\n${info.componentStack ?? ''}`)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <h1>This screen hit an error</h1>
        <p>Your bots keep trading: they run in the background, not in this window. The error is saved in the crash log in the app's logs folder.</p>
        <pre>{this.state.error.message}</pre>
        <div className="row">
          <button className="btn primary" onClick={() => window.location.reload()}>Reload the window</button>
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    )
  }
}
