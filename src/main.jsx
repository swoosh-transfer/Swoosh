import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initializeDatabase } from './utils/indexedDB.js'

// Initialize IndexedDB at app startup
initializeDatabase().then((result) => {
  if (result.success) {
    console.log('[App] IndexedDB ready with stores:', result.stores);
  } else {
    console.error('[App] IndexedDB initialization failed:', result.error);
  }
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
