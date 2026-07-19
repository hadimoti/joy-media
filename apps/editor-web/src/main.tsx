import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { EditorErrorBoundary } from './error-boundary.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorErrorBoundary>
      <App />
    </EditorErrorBoundary>
  </StrictMode>,
);
