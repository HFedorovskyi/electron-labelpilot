export const DESKTOP_INVOKE_CHANNELS = [
    'close-box', 'close-pallet', 'complete-print-job', 'delete-box', 'delete-pack',
    'delete-print-job', 'demo:status', 'detect-printer-capabilities', 'exit-demo',
    'get-all-labels', 'get-barcode-template', 'get-containers', 'get-fixed-weight-products',
    'get-identity', 'get-label', 'get-latest-counters', 'get-license-status',
    'get-next-sequence', 'get-numbering-config', 'get-open-pallet-content',
    'get-pallet-render-data', 'get-print-jobs', 'get-printer-config', 'get-printers',
    'get-products', 'get-protocols', 'get-scale-config', 'get-scale-status',
    'get-serial-ports', 'get-server-status', 'get-station-info', 'import-identity-file',
    'import-print-job-file', 'offline-export', 'offline-import', 'operators:list',
    'print-label', 'printer:warmup', 'printer:warmup-bg', 'record-and-print',
    'record-pack', 'reset-database', 'seed-demo-data', 'session:get', 'session:logout',
    'session:set', 'sync-data', 'test-print', 'update-print-job-progress',
    'updater:check', 'updater:download', 'updater:get-version', 'updater:install',
    'updater:install-offline', 'updater:list-backups', 'updater:refresh-server-version',
    'updater:rollback', 'usb-export', 'usb-import',
] as const;

export const DESKTOP_SEND_CHANNELS = [
    'connect-scale', 'disconnect-scale', 'log-to-main', 'open-logs-folder', 'quit-app',
    'ready-to-print', 'renderer-ready', 'save-numbering-config', 'save-printer-config',
    'save-scale-config', 'set-app-mode',
] as const;

export const DESKTOP_EVENT_CHANNELS = [
    'data-updated', 'discovery-event', 'print-data', 'print-jobs-updated',
    'printer-config-updated', 'printer-status-update', 'report-warning', 'scale-error',
    'scale-reading', 'scale-status', 'scale-weight', 'server-status-updated',
    'session-changed', 'sync-complete', 'updater:downloaded', 'updater:error',
    'updater:no-update', 'updater:progress', 'updater:update-available',
] as const;

export type DesktopRuntime = 'tauri';
export type DesktopInvokeChannel = typeof DESKTOP_INVOKE_CHANNELS[number];
export type DesktopSendChannel = typeof DESKTOP_SEND_CHANNELS[number];
export type DesktopEventChannel = typeof DESKTOP_EVENT_CHANNELS[number];
export type DesktopEventListener = (...args: any[]) => void;

export interface DesktopBridge {
    readonly runtime: DesktopRuntime;
    send(channel: DesktopSendChannel, data?: unknown): void;
    on(channel: DesktopEventChannel, listener: DesktopEventListener): () => void;
    invoke<TResult = any>(channel: DesktopInvokeChannel, data?: unknown): Promise<TResult>;
}
