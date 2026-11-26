import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { CrashGuard } from './Crash'
// The terminal's fonts, bundled into the app so they work offline and need no
// outside request (the page's security policy allows none).
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import './styles.css'
import { applyPrefs } from './prefs'

// The theme before the first paint, so the window never flashes the other one.
applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashGuard>
      <App />
    </CrashGuard>
  </StrictMode>
)
