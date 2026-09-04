import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/vazirmatn/wght.css';
import '@fontsource/noto-sans-arabic/arabic-400.css';
import '@fontsource/noto-sans-arabic/arabic-700.css';
import '@fontsource/noto-sans-arabic/latin-400.css';
import '@fontsource/noto-sans-arabic/latin-700.css';
import '@fontsource/noto-sans-arabic/latin-ext-400.css';
import '@fontsource/noto-sans-arabic/latin-ext-700.css';
import '@fontsource/noto-naskh-arabic/arabic-400.css';
import '@fontsource/noto-naskh-arabic/arabic-700.css';
import '@fontsource/noto-naskh-arabic/latin-400.css';
import '@fontsource/noto-naskh-arabic/latin-700.css';
import '@fontsource/noto-naskh-arabic/latin-ext-400.css';
import '@fontsource/noto-naskh-arabic/latin-ext-700.css';
import { App } from './App.js';
import { EditorErrorBoundary } from './error-boundary.js';
import { LoginGate } from './LoginGate.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorErrorBoundary>
      <LoginGate>
        <App />
      </LoginGate>
    </EditorErrorBoundary>
  </StrictMode>,
);
