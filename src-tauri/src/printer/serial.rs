use super::{
    io_failure, PrinterDeviceConfig, PrinterStats, SendOutcome, TransportFailure, WRITE_TIMEOUT,
};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::io::Write;
use std::time::Instant;

#[derive(Default)]
pub(super) struct SerialConnection {
    port: Option<Box<dyn SerialPort>>,
    endpoint: Option<String>,
    last_write: Option<Instant>,
}

impl SerialConnection {
    pub(super) fn probe(
        &mut self,
        config: &PrinterDeviceConfig,
    ) -> Result<SendOutcome, TransportFailure> {
        let endpoint = config.physical_key();
        let reused = self.port.is_some() && self.endpoint.as_deref() == Some(&endpoint);
        self.ensure_connected(config)?;
        self.last_write = Some(Instant::now());
        Ok(SendOutcome {
            bytes: 0,
            attempts: 1,
            reused_connection: reused,
        })
    }

    pub(super) fn send(
        &mut self,
        config: &PrinterDeviceConfig,
        data: &[u8],
        stats: &PrinterStats,
    ) -> Result<SendOutcome, TransportFailure> {
        let endpoint = config.physical_key();
        let reused = self.port.is_some() && self.endpoint.as_deref() == Some(&endpoint);
        let mut attempts = 0_u8;
        loop {
            attempts += 1;
            if let Err(error) = self.ensure_connected(config) {
                if error.timed_out || attempts >= 2 {
                    return Err(error);
                }
                stats
                    .reconnects
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                self.close();
                continue;
            }
            let result = self
                .port
                .as_mut()
                .expect("connected serial port")
                .write_all(data)
                .and_then(|_| self.port.as_mut().expect("connected serial port").flush());
            match result {
                Ok(()) => {
                    self.last_write = Some(Instant::now());
                    return Ok(SendOutcome {
                        bytes: data.len(),
                        attempts,
                        reused_connection: reused && attempts == 1,
                    });
                }
                Err(error) => {
                    let failure = io_failure("serial printer write", error);
                    self.close();
                    if failure.timed_out || attempts >= 2 {
                        return Err(failure);
                    }
                    stats
                        .reconnects
                        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                }
            }
        }
    }

    /// Runs the protocol status handshake on the held port: the print worker
    /// owns the COM port exclusively on Windows, so a second open from the
    /// status path would always fail.
    pub(super) fn query_status(
        &mut self,
        config: &PrinterDeviceConfig,
    ) -> Result<super::status::PrinterStatusReport, TransportFailure> {
        self.ensure_connected(config)?;
        let port = self.port.as_mut().expect("connected serial port");
        let _ = port.set_timeout(super::status::STATUS_IO_TIMEOUT);
        let result = super::status::query_stream_report(config, port);
        let _ = port.set_timeout(WRITE_TIMEOUT);
        result
    }

    fn ensure_connected(&mut self, config: &PrinterDeviceConfig) -> Result<(), TransportFailure> {
        let endpoint = config.physical_key();
        if self.endpoint.as_deref() != Some(&endpoint) {
            self.close();
        }
        if self.port.is_some() {
            return Ok(());
        }
        let path = config.serial_port.as_deref().unwrap_or_default();
        let baud_rate = config.baud_rate();
        let port = serialport::new(path, baud_rate)
            .timeout(WRITE_TIMEOUT)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .open()
            .map_err(|error| TransportFailure {
                message: format!("serial printer open {path}@{baud_rate}: {error}"),
                timed_out: false,
            })?;
        self.port = Some(port);
        self.endpoint = Some(endpoint);
        Ok(())
    }

    pub(super) fn close_if_idle(&mut self) {
        // Serial devices stay open: reopening a COM port for every label costs hundreds
        // of milliseconds on inexpensive USB bridges and may reset printer firmware.
    }

    pub(super) fn close(&mut self) {
        self.port.take();
        self.endpoint = None;
        self.last_write = None;
    }
}
