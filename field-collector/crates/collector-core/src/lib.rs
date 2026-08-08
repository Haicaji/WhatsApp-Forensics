//! Field Collector acquisition state machine and read-only T0 orchestration.

mod acquisition;
mod normalize;
mod state;

pub use acquisition::{
    AccountConfirmationChallenge, AcquisitionRequest, AcquisitionResult, CollectorError,
    ExistingProfileContext, PortableConfigurationContext, PreflightReport, TargetInspectionRequest,
    TargetReadinessReport, available_space_bytes, collect_t0, inspect_target, preflight,
};
pub use normalize::{NormalizationError, NormalizationSummary};
pub use state::{AcquisitionState, StateError, StateMachine};

/// Field Collector semantic version.
pub const COLLECTOR_VERSION: &str = env!("CARGO_PKG_VERSION");
