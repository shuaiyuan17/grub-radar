// All of Shantell's subsets, each behind a unicode-range: the browser fetches only the
// slices on screen (latin for most pages; latin-ext / vietnamese when a place from
// Apple Maps is called "Phở Bắc"). Without them those letters fell back to the CJK font.
import '@fontsource/shantell-sans/400.css';
import '@fontsource/shantell-sans/600.css';
import '@fontsource/shantell-sans/700.css';
import '@fontsource/shantell-sans/800.css';
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
