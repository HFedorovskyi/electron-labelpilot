use super::{io_failure, TransportFailure};
use std::io::{self, Write};

#[derive(Debug)]
pub(super) struct JobWriteError {
    error: io::Error,
    bytes_written: usize,
    flushing: bool,
}

impl JobWriteError {
    pub(super) fn can_retry(&self, attempts: u8) -> bool {
        // A successful write followed by an error is not an unstarted job.
        self.bytes_written == 0
            && !self.flushing
            && attempts < 2
            && !matches!(
                self.error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            )
    }

    pub(super) fn into_transport_failure(self, context: &str) -> TransportFailure {
        let mut failure = io_failure(context, self.error);
        if self.bytes_written > 0 || self.flushing {
            failure.message =
                format!(
                "DELIVERY_UNCERTAIN: {} ({} bytes written, phase={}); automatic replay suppressed",
                failure.message, self.bytes_written, if self.flushing { "flush" } else { "write" },
            );
        }
        failure
    }
}

/// Send one job, preserving evidence of partial delivery for the reconnect policy.
/// The caller owns connection teardown and retries; this never replays data.
pub(super) fn write_job_once<W: Write + ?Sized>(
    writer: &mut W,
    data: &[u8],
) -> Result<(), JobWriteError> {
    let mut bytes_written = 0;
    while bytes_written < data.len() {
        let error = match writer.write(&data[bytes_written..]) {
            Ok(0) => io::Error::new(
                io::ErrorKind::WriteZero,
                "printer write returned zero bytes",
            ),
            Ok(count) => {
                bytes_written += count;
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => error,
        };
        return Err(JobWriteError {
            error,
            bytes_written,
            flushing: false,
        });
    }
    writer.flush().map_err(|error| JobWriteError {
        error,
        bytes_written,
        flushing: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Writer {
        steps: VecDeque<io::Result<usize>>,
        written: Vec<u8>,
        fail_flush: bool,
        flush_calls: usize,
    }
    impl Write for Writer {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            let count = self.steps.pop_front().unwrap_or(Ok(data.len()))?;
            assert!(count <= data.len());
            self.written.extend_from_slice(&data[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.flush_calls += 1;
            if self.fail_flush {
                Err(io::ErrorKind::BrokenPipe.into())
            } else {
                Ok(())
            }
        }
    }
    fn writer(steps: Vec<io::Result<usize>>) -> Writer {
        Writer {
            steps: steps.into(),
            written: Vec::new(),
            fail_flush: false,
            flush_calls: 0,
        }
    }

    #[test]
    fn short_writes_and_interrupted_continue_without_replaying_prefix() {
        let mut writer = writer(vec![Ok(2), Err(io::ErrorKind::Interrupted.into()), Ok(1)]);
        write_job_once(&mut writer, b"LABEL").unwrap();
        assert_eq!(writer.written, b"LABEL");
        assert_eq!(writer.flush_calls, 1);
    }
    #[test]
    fn zero_byte_failure_can_retry_only_once_and_timeout_never_retries() {
        for kind in [
            io::ErrorKind::BrokenPipe,
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::WriteZero,
        ] {
            let step = if kind == io::ErrorKind::WriteZero {
                Ok(0)
            } else {
                Err(kind.into())
            };
            let mut writer = writer(vec![step]);
            let error = write_job_once(&mut writer, b"LABEL").unwrap_err();
            assert!(error.can_retry(1));
            assert!(!error.can_retry(2));
            assert!(writer.written.is_empty());
        }
        for kind in [io::ErrorKind::TimedOut, io::ErrorKind::WouldBlock] {
            let mut writer = writer(vec![Err(kind.into())]);
            assert!(!write_job_once(&mut writer, b"LABEL")
                .unwrap_err()
                .can_retry(1));
        }
    }
    #[test]
    fn partial_delivery_is_uncertain_and_never_retried() {
        for kind in [
            io::ErrorKind::BrokenPipe,
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::TimedOut,
        ] {
            let mut writer = writer(vec![Ok(5), Err(kind.into())]);
            let error = write_job_once(&mut writer, b"LABELNEXT").unwrap_err();
            assert_eq!(writer.written, b"LABEL");
            assert_eq!(writer.flush_calls, 0);
            assert!(!error.can_retry(1));
            assert!(error
                .into_transport_failure("test")
                .message
                .starts_with("DELIVERY_UNCERTAIN:"));
        }
    }
    #[test]
    fn flush_failure_after_delivery_is_uncertain_and_never_retried() {
        let mut writer = writer(vec![]);
        writer.fail_flush = true;
        let error = write_job_once(&mut writer, b"LABEL").unwrap_err();
        assert_eq!(writer.written, b"LABEL");
        assert!(!error.can_retry(1));
        let failure = error.into_transport_failure("test");
        assert!(failure.message.contains("5 bytes written, phase=flush"));
    }
}
