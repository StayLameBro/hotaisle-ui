import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './iso/iso.css';
import './styles.css';
import { App } from './App';
import { applyTheme } from './prefs';
import { ToastHost } from './ui';

// Apply the saved theme before the first paint.
try {
  applyTheme(JSON.parse(localStorage.getItem('hotaisle-ui:prefs') || '{}').theme ?? 'system');
} catch {
  /* default theme */
}

// Draw once the fonts are in, so text never reflows under the reader (capped at 600 ms).
const fontsReady = Promise.all(
  ['400 16px "Instrument Sans Variable"', '600 16px "Instrument Sans Variable"', '400 15px "IBM Plex Mono"', '16px DSEG7'].map((f) => document.fonts.load(f).catch(() => undefined)),
);
Promise.race([fontsReady, new Promise((r) => setTimeout(r, 600))]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ToastHost>
        <App />
      </ToastHost>
    </StrictMode>,
  );
});
