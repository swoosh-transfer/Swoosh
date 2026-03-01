import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initializeDatabase } from './infrastructure/database/client.js'
import logger from './utils/logger.js'

// Initialize IndexedDB at app startup
initializeDatabase().then((result) => {
  if (result.success) {
    logger.log('[App] IndexedDB ready with stores:', result.stores);
  } else {
    logger.error('[App] IndexedDB initialization failed:', result.error);
  }
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
