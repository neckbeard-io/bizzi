import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { App } from './App.tsx';
import { initCodeWrap } from './app/codeWrap.ts';
import { initTheme } from './app/theme.ts';
import { listenForNotificationClicks } from './lib/webPush.ts';

initTheme();
initCodeWrap();
listenForNotificationClicks();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
