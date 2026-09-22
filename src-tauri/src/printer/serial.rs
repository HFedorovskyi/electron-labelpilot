use super::{
    write::write_job_once, PrinterDeviceConfig, PrinterStats, SendOutcome, TransportFailure,
    WRITE_TIMEOUT,
};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::time::{Duration, Instant};

fn configured_data_bits(config: &PrinterDeviceConfig) -> DataBits {
    match config.data_bits() {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

fn configured_parity(config: &PrinterDeviceConfig) -> Parity {
    match config.parity() {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => Parity::None,
    }
}

fn configured_flow_control(config: &PrinterDeviceConfig) -> FlowControl {
    match config.flow_control() {
        "hardware" => FlowControl::Hardware,
        "software" => FlowControl::Software,
        _ => FlowControl::None,
    }
}

pub(super) fn open_configured(
    config: &PrinterDeviceConfig,
    timeout: Duration,
) -> serialport::Result<Box<dyn SerialPort>> {
    serialport::new(
        config.serial_port.as_deref().unwrap_or_default(),
        config.baud_rate(),
    )
    .timeout(timeout)
    .data_bits(configured_data_bits(config))
    .parity(configured_parity(config))
    .stop_bits(StopBits::One)
    .flow_control(configured_flow_control(config))
    .open()
}

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
            let result = write_job_once(self.port.as_mut().expect("connected serial port"), data);
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
                    let retryable = error.can_retry(attempts);
                    let failure = error.into_transport_failure("serial printer write");
                    self.close();
                    if !retryable {
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
        let result = port
            .set_timeout(super::status::STATUS_IO_TIMEOUT)
            .map_err(|error| {
                TransportFailure::not_started(
                    format!("serial printer status timeout: {error}"),
                    false,
                )
            })
            .and_then(|_| super::status::query_stream_report(config, port));
        if let Err(error) = port.set_timeout(WRITE_TIMEOUT) {
            self.close();
            return Err(TransportFailure::not_started(
                format!("serial printer write timeout restore: {error}"),
                false,
            ));
        }
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
        let port = open_configured(config, WRITE_TIMEOUT).map_err(|error| {
            TransportFailure::not_started(
                format!(
                    "serial printer open {path}@{baud_rate} {}{}1 {} flow control: {error}",
                    config.data_bits(),
                    config
                        .parity()
                        .chars()
                        .next()
                        .unwrap_or('n')
                        .to_ascii_uppercase(),
                    config.flow_control(),
                ),
                false,
            )
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: serde_json::Value) -> PrinterDeviceConfig {
        PrinterDeviceConfig::from_value(value).unwrap()
    }

    #[test]
    fn maps_configured_serial_framing_and_flow_control() {
        let configured = config(json!({
            "id": "configured",
            "connection": "serial",
            "protocol": "zpl",
            "serialPort": "COM8",
            "baudRate": 115200,
            "dataBits": 7,
            "parity": "even",
            "flowControl": "software"
        }));
        assert_eq!(configured_data_bits(&configured), DataBits::Seven);
        assert_eq!(configured_parity(&configured), Parity::Even);
        assert_eq!(configured_flow_control(&configured), FlowControl::Software);

        let raster_default = config(json!({
            "id": "default",
            "connection": "serial",
            "protocol": "epl",
            "serialPort": "COM9"
        }));
        assert_eq!(configured_data_bits(&raster_default), DataBits::Eight);
        assert_eq!(configured_parity(&raster_default), Parity::None);
        assert_eq!(
            configured_flow_control(&raster_default),
            FlowControl::Hardware
        );
    }
}
