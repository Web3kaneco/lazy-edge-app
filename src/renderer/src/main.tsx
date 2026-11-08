import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
