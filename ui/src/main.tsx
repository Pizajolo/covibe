import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { DataProvider } from './data';
import { NotifyProvider } from './notify';
import { UsageProvider } from './components/Usage';
import '@fontsource/pixelify-sans/600.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <DataProvider>
        <NotifyProvider>
          <UsageProvider>
            <App />
          </UsageProvider>
        </NotifyProvider>
      </DataProvider>
    </ToastProvider>
  </StrictMode>,
);
