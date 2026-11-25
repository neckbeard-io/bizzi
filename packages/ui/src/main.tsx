import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.tsx';
import { initTheme } from './app/theme.ts';
import { listenForNotificationClicks } from './lib/webPush.ts';

initTheme();
listenForNotificationClicks();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
