import type { DesktopBridge } from '../../shared/desktopBridge';

/**
 * Single renderer entry point for desktop-only capabilities. Keeping runtime
 * access here keeps the React application independent from Tauri command names.
 */
export function getDesktopBridge(): DesktopBridge {
    if (!window.desktopBridge) {
        throw new Error('Desktop bridge is not available in this runtime.');
    }
    return window.desktopBridge;
}