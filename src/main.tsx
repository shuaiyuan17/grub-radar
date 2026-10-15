import '@fontsource/shantell-sans/latin-400.css';
import '@fontsource/shantell-sans/latin-600.css';
import '@fontsource/shantell-sans/latin-700.css';
import '@fontsource/shantell-sans/latin-800.css';
import '@fontsource/caveat/latin-500.css';
import '@fontsource/caveat/latin-700.css';
import './styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
