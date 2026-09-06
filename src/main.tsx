import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './renderer/App';
import MigrationRuntimeScreen from './renderer/migration/MigrationRuntimeScreen';
import { installTauriDesktopBridge } from './renderer/platform/tauriBridge';

const bridge = installTauriDesktopBridge();

function errorMessage(value: unknown): string {
    const message = value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ''}` : String(value);
    return message.replace(/[\r\n\0]+/g, ' ').slice(0, 2000);
}

window.addEventListener('error', event => {
    bridge.send('log-to-main', {
        level: 'ERROR',
        event: 'renderer_error',
        message: errorMessage(event.error ?? event.message),
    });
});

window.addEventListener('unhandledrejection', event => {
    bridge.send('log-to-main', {
        level: 'ERROR',
        event: 'unhandled_rejection',
        message: errorMessage(event.reason),
    });
});
const diagnostics = new URLSearchParams(window.location.search).get('diagnostics') === 'true';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {diagnostics ? <MigrationRuntimeScreen bridge={bridge} /> : <App />}
    </StrictMode>,
);
