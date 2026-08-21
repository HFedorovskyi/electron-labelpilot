mod tspl;
mod types;
mod zpl;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub use types::{
    GenerationPayload, GenerationPlan, MAX_GENERATED_BYTES, MAX_GENERATOR_INPUT_BYTES,
    MAX_LABEL_ELEMENTS,
};

use types::ParsedInput;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationMetadata {
    pub protocol: String,
    pub profile_id: String,
    pub bytes: usize,
    pub width_dots: i64,
    pub height_dots: i64,
    pub element_count: usize,
    pub generate_micros: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGenerationReceipt {
    #[serde(flatten)]
    pub metadata: GenerationMetadata,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorSummary {
    pub generated_jobs: u64,
    pub fallback_jobs: u64,
    pub failed_jobs: u64,
    pub bytes_generated: u64,
    pub fallback_bytes_generated: u64,
    pub max_elements: usize,
    pub max_input_bytes: usize,
    pub max_generated_bytes: usize,
    pub supported_protocols: [&'static str; 6],
}

pub struct NativeGeneration {
    pub metadata: GenerationMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Default)]
pub struct GeneratorState {
    generated_jobs: AtomicU64,
    fallback_jobs: AtomicU64,
    failed_jobs: AtomicU64,
    bytes_generated: AtomicU64,
    fallback_bytes_generated: AtomicU64,
}

impl GeneratorState {
    pub fn plan(&self, payload: &GenerationPayload) -> Result<GenerationPlan, String> {
        Ok(ParsedInput::parse(payload)?.plan())
    }

    pub fn generate(&self, payload: GenerationPayload) -> Result<NativeGeneration, String> {
        let started = Instant::now();
        let input = match ParsedInput::parse(&payload) {
            Ok(input) => input,
            Err(error) => {
                self.failed_jobs.fetch_add(1, Ordering::AcqRel);
                return Err(error);
            }
        };
        let plan = input.plan();
        if !plan.native_eligible {
            self.fallback_jobs.fetch_add(1, Ordering::AcqRel);
            return Err(format!(
                "RUST_BITMAP_FALLBACK_REQUIRED:{}",
                plan.reasons.join(",")
            ));
        }
        let geometry = match input.geometry() {
            Ok(geometry) => geometry,
            Err(error) => {
                self.failed_jobs.fetch_add(1, Ordering::AcqRel);
                return Err(error);
            }
        };
        let bytes = match input.config.protocol.as_str() {
            "zpl" => zpl::generate(&input, geometry),
            "tspl" => tspl::generate(&input, geometry),
            protocol => Err(format!("unsupported native generator protocol: {protocol}")),
        };
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) => {
                self.failed_jobs.fetch_add(1, Ordering::AcqRel);
                return Err(error);
            }
        };
        if bytes.is_empty() || bytes.len() > MAX_GENERATED_BYTES {
            self.failed_jobs.fetch_add(1, Ordering::AcqRel);
            return Err(format!(
                "generated printer stream must contain 1..{} bytes",
                MAX_GENERATED_BYTES
            ));
        }
        self.generated_jobs.fetch_add(1, Ordering::AcqRel);
        self.bytes_generated
            .fetch_add(bytes.len() as u64, Ordering::AcqRel);
        Ok(NativeGeneration {
            metadata: GenerationMetadata {
                protocol: input.config.protocol,
                profile_id: input.profile.id.to_owned(),
                bytes: bytes.len(),
                width_dots: geometry.width_dots,
                height_dots: geometry.height_dots,
                element_count: input.doc.elements.len(),
                generate_micros: started.elapsed().as_micros().min(u64::MAX as u128) as u64,
            },
            bytes,
        })
    }

    pub fn generate_receipt(
        &self,
        payload: GenerationPayload,
    ) -> Result<NativeGenerationReceipt, String> {
        let generated = self.generate(payload)?;
        Ok(NativeGenerationReceipt {
            metadata: generated.metadata,
            data_base64: BASE64_STANDARD.encode(generated.bytes),
        })
    }

    pub fn record_renderer_fallback(&self, bytes: usize) {
        self.fallback_jobs.fetch_add(1, Ordering::AcqRel);
        self.fallback_bytes_generated
            .fetch_add(bytes as u64, Ordering::AcqRel);
    }

    pub fn summary(&self) -> GeneratorSummary {
        GeneratorSummary {
            generated_jobs: self.generated_jobs.load(Ordering::Acquire),
            fallback_jobs: self.fallback_jobs.load(Ordering::Acquire),
            failed_jobs: self.failed_jobs.load(Ordering::Acquire),
            bytes_generated: self.bytes_generated.load(Ordering::Acquire),
            fallback_bytes_generated: self.fallback_bytes_generated.load(Ordering::Acquire),
            max_elements: MAX_LABEL_ELEMENTS,
            max_input_bytes: MAX_GENERATOR_INPUT_BYTES,
            max_generated_bytes: MAX_GENERATED_BYTES,
            supported_protocols: ["zpl", "tspl", "epl", "cpcl", "dpl", "sbpl"],
        }
    }
}

#[cfg(test)]
mod tests;
