use super::*;
use serde_json::json;

fn device(index: usize) -> PrinterDeviceConfig {
    PrinterDeviceConfig::from_value(json!({
        "id": "regression", "connection": "tcp", "protocol": "zpl",
        "ip": "127.0.0.1", "port": 1, "jobIdempotencyKey": format!("job-{index}")
    }))
    .unwrap()
}

fn receipt(config: &PrinterDeviceConfig) -> PrintReceipt {
    PrintReceipt {
        printer_id: config.id.clone(),
        physical_key: config.physical_key(),
        bytes: 5,
        queue_ms: 0,
        send_ms: 0,
        attempts: 1,
        reused_connection: false,
        delivery_state: "transport-accepted".to_owned(),
        confirmation_mode: "transport-write".to_owned(),
        idempotency_key: config.job_idempotency_key.clone(),
        deduplicated: false,
        durable_job_id: None,
        durable_state: None,
        status_report: None,
    }
}

#[test]
fn completed_idempotency_entries_do_not_limit_throughput_and_durable_dedup_survives() {
    let state = PrinterTransportState::new();
    let action = JobAction::Print(b"LABEL".to_vec());
    let fingerprint = action_fingerprint(&action);
    for index in 0..MAX_IDEMPOTENCY_ENTRIES + 3 {
        let config = device(index);
        let key = config.physical_key();
        let IdempotencyReservation::Leader(scope) = state
            .reserve_idempotency(&config, &key, fingerprint)
            .unwrap_or_else(|error| panic!("job {index}: {error}"))
        else {
            panic!("new key")
        };
        let durable::PrepareOutcome::New(id) = state
            .inner
            .durable
            .prepare(&config, &key, fingerprint, &action)
            .unwrap()
        else {
            panic!("new job")
        };
        assert!(state.inner.durable.mark_sending(&id).unwrap());
        let mut accepted = receipt(&config);
        accepted.durable_job_id = Some(id.clone());
        accepted.durable_state = Some("accepted".to_owned());
        state.inner.durable.mark_accepted(&id, &accepted).unwrap();
        state.finish_idempotency(&scope, fingerprint, &Ok(accepted));
        assert!(state.inner.idempotency.lock().unwrap().entries.len() <= MAX_IDEMPOTENCY_ENTRIES);
    }
    let duplicate = state
        .submit_bytes_with_config(RuntimeEventSink::detached(), device(0), b"LABEL".to_vec())
        .unwrap();
    assert!(duplicate.deduplicated);
    assert_eq!(state.summary().submitted_jobs, 0);
    let conflict = state
        .submit_bytes_with_config(RuntimeEventSink::detached(), device(1), b"OTHER".to_vec())
        .unwrap_err();
    assert!(conflict.contains("CONFLICT"), "{conflict}");
}

#[test]
fn in_flight_idempotency_reservations_are_never_evicted() {
    let state = PrinterTransportState::new();
    for index in 0..MAX_IDEMPOTENCY_ENTRIES {
        let config = device(index);
        assert!(matches!(
            state
                .reserve_idempotency(&config, &config.physical_key(), 42)
                .unwrap(),
            IdempotencyReservation::Leader(_)
        ));
    }
    let config = device(MAX_IDEMPOTENCY_ENTRIES);
    assert!(state
        .reserve_idempotency(&config, &config.physical_key(), 42)
        .is_err());
    assert_eq!(
        state.inner.idempotency.lock().unwrap().entries.len(),
        MAX_IDEMPOTENCY_ENTRIES
    );
}
