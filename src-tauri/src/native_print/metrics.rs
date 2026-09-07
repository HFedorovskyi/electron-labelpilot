use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

pub(super) const METRIC_WINDOW_CAPACITY: usize = 512;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintStageTimings {
    pub snapshot_us: u64,
    pub data_us: u64,
    pub render_us: u64,
    pub encode_us: u64,
    pub outbox_us: u64,
    pub dispatch_us: u64,
    pub completion_wait_us: u64,
    pub finalize_us: u64,
    pub box_close_us: u64,
    pub total_us: u64,
    /// Receipt timings keep the transport's original millisecond precision.
    pub queue_ms: u64,
    pub send_ms: u64,
    pub bytes: usize,
}

impl PrintStageTimings {
    pub(super) fn add_preparation(&mut self, previous: &Self) {
        self.snapshot_us = self.snapshot_us.saturating_add(previous.snapshot_us);
        self.data_us = self.data_us.saturating_add(previous.data_us);
        self.render_us = self.render_us.saturating_add(previous.render_us);
        self.encode_us = self.encode_us.saturating_add(previous.encode_us);
        self.outbox_us = self.outbox_us.saturating_add(previous.outbox_us);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrintTimingRecord {
    pub job_id: String,
    pub status: &'static str,
    pub prepared_ahead: bool,
    pub timings: PrintStageTimings,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingDistribution {
    pub samples: usize,
    pub p50: u64,
    pub p95: u64,
    pub max: u64,
}

impl TimingDistribution {
    fn from_values(mut values: Vec<u64>) -> Self {
        if values.is_empty() {
            return Self::default();
        }
        values.sort_unstable();
        let at = |percent: usize| values[(values.len() * percent).div_ceil(100).saturating_sub(1)];
        Self {
            samples: values.len(),
            p50: at(50),
            p95: at(95),
            max: *values.last().unwrap(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintPerformanceSummary {
    pub window_capacity: usize,
    pub retained_samples: usize,
    pub accepted_total: u64,
    pub failed_total: u64,
    pub stages: BTreeMap<&'static str, TimingDistribution>,
}

#[derive(Default)]
struct MetricWindow {
    samples: VecDeque<PrintStageTimings>,
    accepted: u64,
    failed: u64,
}

#[derive(Default)]
pub(super) struct PrintMetrics {
    window: Mutex<MetricWindow>,
}

impl PrintMetrics {
    pub(super) fn record(&self, record: &PrintTimingRecord) {
        // Diagnostics must not change an accepted business/transport outcome.
        let mut window = self
            .window
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if record.status == "accepted" {
            window.accepted = window.accepted.saturating_add(1);
        } else {
            window.failed = window.failed.saturating_add(1);
        }
        if window.samples.len() == METRIC_WINDOW_CAPACITY {
            window.samples.pop_front();
        }
        window.samples.push_back(record.timings.clone());
    }

    pub(super) fn summary(&self) -> PrintPerformanceSummary {
        let (samples, accepted, failed) = {
            let window = self
                .window
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            (
                window.samples.iter().cloned().collect::<Vec<_>>(),
                window.accepted,
                window.failed,
            )
        };
        let fields: [(&str, fn(&PrintStageTimings) -> u64); 12] = [
            ("snapshotUs", |s| s.snapshot_us),
            ("dataUs", |s| s.data_us),
            ("renderUs", |s| s.render_us),
            ("encodeUs", |s| s.encode_us),
            ("outboxUs", |s| s.outbox_us),
            ("dispatchUs", |s| s.dispatch_us),
            ("completionWaitUs", |s| s.completion_wait_us),
            ("finalizeUs", |s| s.finalize_us),
            ("boxCloseUs", |s| s.box_close_us),
            ("totalUs", |s| s.total_us),
            ("queueMs", |s| s.queue_ms),
            ("sendMs", |s| s.send_ms),
        ];
        PrintPerformanceSummary {
            window_capacity: METRIC_WINDOW_CAPACITY,
            retained_samples: samples.len(),
            accepted_total: accepted,
            failed_total: failed,
            stages: fields
                .into_iter()
                .map(|(name, field)| {
                    (
                        name,
                        TimingDistribution::from_values(samples.iter().map(field).collect()),
                    )
                })
                .collect(),
        }
    }
}

pub(super) fn elapsed_us(start: Instant) -> u64 {
    start.elapsed().as_micros().min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipeline_timing_window_is_bounded_and_uses_nearest_rank_percentiles() {
        let metrics = PrintMetrics::default();
        assert_eq!(metrics.summary().stages["renderUs"].samples, 0);
        for value in 1..=1024 {
            metrics.record(&PrintTimingRecord {
                job_id: String::new(),
                status: if value % 2 == 0 { "accepted" } else { "failed" },
                prepared_ahead: false,
                timings: PrintStageTimings {
                    render_us: value,
                    ..PrintStageTimings::default()
                },
            });
        }
        let summary = metrics.summary();
        assert_eq!(
            (
                summary.retained_samples,
                summary.accepted_total,
                summary.failed_total
            ),
            (512, 512, 512)
        );
        let render = &summary.stages["renderUs"];
        assert_eq!((render.p50, render.p95, render.max), (768, 999, 1024));
    }
}
