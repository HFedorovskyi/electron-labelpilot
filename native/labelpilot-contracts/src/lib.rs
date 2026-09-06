//! Runtime-neutral desktop command contract shared by the staged Rust migration.

pub const DESKTOP_INVOKE_CHANNELS: &[&str] = &[
    "close-box",
    "close-pallet",
    "complete-print-job",
    "delete-box",
    "delete-pack",
    "delete-print-job",
    "demo:status",
    "detect-printer-capabilities",
    "exit-demo",
    "get-all-labels",
    "get-barcode-template",
    "get-containers",
    "get-fixed-weight-products",
    "get-identity",
    "get-label",
    "get-latest-counters",
    "get-license-status",
    "get-next-sequence",
    "get-numbering-config",
    "get-open-pallet-content",
    "get-pallet-render-data",
    "get-print-jobs",
    "get-printer-config",
    "get-printers",
    "get-products",
    "get-protocols",
    "get-scale-config",
    "get-scale-status",
    "get-serial-ports",
    "get-server-status",
    "get-station-info",
    "import-identity-file",
    "import-print-job-file",
    "offline-export",
    "offline-import",
    "operators:list",
    "print-label",
    "printer:warmup",
    "printer:warmup-bg",
    "record-and-print",
    "record-pack",
    "reset-database",
    "seed-demo-data",
    "session:get",
    "session:logout",
    "session:set",
    "sync-data",
    "test-print",
    "update-print-job-progress",
    "updater:check",
    "updater:download",
    "updater:get-version",
    "updater:install",
    "updater:install-offline",
    "updater:list-backups",
    "updater:refresh-server-version",
    "updater:rollback",
    "usb-export",
    "usb-import",
];

pub const DESKTOP_SEND_CHANNELS: &[&str] = &[
    "connect-scale",
    "disconnect-scale",
    "log-to-main",
    "open-logs-folder",
    "quit-app",
    "ready-to-print",
    "renderer-ready",
    "save-numbering-config",
    "save-printer-config",
    "save-scale-config",
    "set-app-mode",
];

pub const DESKTOP_EVENT_CHANNELS: &[&str] = &[
    "data-updated",
    "discovery-event",
    "print-data",
    "print-jobs-updated",
    "printer-config-updated",
    "printer-status-update",
    "report-warning",
    "scale-error",
    "scale-reading",
    "scale-status",
    "scale-weight",
    "server-status-updated",
    "session-changed",
    "sync-complete",
    "updater:downloaded",
    "updater:error",
    "updater:no-update",
    "updater:progress",
    "updater:update-available",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelKind {
    Invoke,
    Send,
    Event,
}

pub fn channel_kind(channel: &str) -> Option<ChannelKind> {
    if DESKTOP_INVOKE_CHANNELS.contains(&channel) {
        Some(ChannelKind::Invoke)
    } else if DESKTOP_SEND_CHANNELS.contains(&channel) {
        Some(ChannelKind::Send)
    } else if DESKTOP_EVENT_CHANNELS.contains(&channel) {
        Some(ChannelKind::Event)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn channel_sets_are_unique_and_disjoint() {
        let mut all = HashSet::new();
        for channel in DESKTOP_INVOKE_CHANNELS
            .iter()
            .chain(DESKTOP_SEND_CHANNELS)
            .chain(DESKTOP_EVENT_CHANNELS)
        {
            assert!(all.insert(*channel), "duplicate desktop channel: {channel}");
        }
        assert_eq!(DESKTOP_INVOKE_CHANNELS.len(), 59);
        assert_eq!(DESKTOP_SEND_CHANNELS.len(), 11);
        assert_eq!(DESKTOP_EVENT_CHANNELS.len(), 19);
    }

    #[test]
    fn classifies_each_channel_kind() {
        assert_eq!(channel_kind("print-label"), Some(ChannelKind::Invoke));
        assert_eq!(channel_kind("save-printer-config"), Some(ChannelKind::Send));
        assert_eq!(
            channel_kind("printer-status-update"),
            Some(ChannelKind::Event)
        );
        assert_eq!(channel_kind("unknown"), None);
    }
}
