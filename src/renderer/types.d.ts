import type { DesktopBridge } from '../shared/desktopBridge';

declare global {
    interface Window {
        desktopBridge: DesktopBridge;
    }
}
