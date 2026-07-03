// Slim entry for the hidden print worker window (see print.html). Deliberately does
// NOT import App/stations/i18n — only what a printable label needs. index.css is also
// skipped: PrintView injects its own @page/body styles, and label elements are fully
// inline-styled by LabelRenderer.
import { createRoot } from 'react-dom/client';
import PrintView from './renderer/components/PrintView';

createRoot(document.getElementById('root')!).render(<PrintView />);
