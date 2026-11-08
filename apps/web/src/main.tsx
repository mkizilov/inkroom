import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element');
}

// Lets the app open without a connection once it has loaded online. See docs/offline.md.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
