import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { detectLocale, setLocale } from '@tianshu/locale'
import { App } from './App.tsx'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import '@tianshu/ui-session/styles.css'
import '@tianshu/ui-chat/styles.css'
import '@tianshu/ui-approval/styles.css'
import '@tianshu/ui-settings/styles.css'
import '@tianshu/ui-git/styles.css'
import '@tianshu/ui-files/styles.css'
import '@tianshu/ui-schedule/styles.css'
import './styles.css'

// Resolved before the first render, so `<html lang>` and the dictionary agree from the
// very first paint instead of correcting themselves a frame later.
setLocale(detectLocale())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
