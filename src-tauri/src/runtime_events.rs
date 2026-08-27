#[cfg(feature = "desktop")]
use crate::commands::RuntimeState;
#[cfg(feature = "desktop")]
use crate::telemetry;
use serde::Serialize;
#[cfg(feature = "native-ui")]
use serde_json::Value;
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager};

#[cfg(feature = "native-ui")]
#[derive(Clone, Debug)]
pub enum NativeRuntimeEvent {
    Event {
        name: String,
        payload: Value,
    },
    Log {
        subsystem: String,
        level: String,
        message: String,
    },
}

enum RuntimeEventBackend {
    #[cfg(feature = "desktop")]
    Tauri(AppHandle),
    #[cfg(feature = "native-ui")]
    Callback(Arc<dyn Fn(NativeRuntimeEvent) + Send + Sync + 'static>),
}

#[derive(Clone)]
pub(crate) struct RuntimeEventSink {
    backend: Arc<RuntimeEventBackend>,
}

impl RuntimeEventSink {
    #[cfg(feature = "desktop")]
    pub(crate) fn tauri(app: AppHandle) -> Self {
        Self {
            backend: Arc::new(RuntimeEventBackend::Tauri(app)),
        }
    }

    #[cfg(feature = "native-ui")]
    pub(crate) fn callback<F>(callback: F) -> Self
    where
        F: Fn(NativeRuntimeEvent) + Send + Sync + 'static,
    {
        Self {
            backend: Arc::new(RuntimeEventBackend::Callback(Arc::new(callback))),
        }
    }

    pub(crate) fn emit<T>(&self, name: &str, payload: T)
    where
        T: Serialize + Clone,
    {
        match self.backend.as_ref() {
            #[cfg(feature = "desktop")]
            RuntimeEventBackend::Tauri(app) => {
                let _ = app.emit(name, payload);
            }
            #[cfg(feature = "native-ui")]
            RuntimeEventBackend::Callback(callback) => match serde_json::to_value(payload) {
                Ok(payload) => callback(NativeRuntimeEvent::Event {
                    name: name.to_owned(),
                    payload,
                }),
                Err(error) => callback(NativeRuntimeEvent::Log {
                    subsystem: "runtime".to_owned(),
                    level: "ERROR".to_owned(),
                    message: format!("failed to serialize event {name}: {error}"),
                }),
            },
        }
    }

    pub(crate) fn log(&self, subsystem: &str, level: &str, message: &str) {
        match self.backend.as_ref() {
            #[cfg(feature = "desktop")]
            RuntimeEventBackend::Tauri(app) => {
                let _ = app.state::<RuntimeState>().log(level, message);
                telemetry::record_subsystem_log(app, subsystem, level, message);
            }
            #[cfg(feature = "native-ui")]
            RuntimeEventBackend::Callback(callback) => callback(NativeRuntimeEvent::Log {
                subsystem: subsystem.to_owned(),
                level: level.to_owned(),
                message: message.to_owned(),
            }),
        }
    }
}
