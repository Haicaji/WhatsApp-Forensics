//! Field Collector acquisition state machine and read-only T0 orchestration.

mod acquisition;
mod checkpoint;
mod normalize;
mod progress;
mod state;

pub use acquisition::{
    AccountConfirmationChallenge, AcquisitionCancellation, AcquisitionCompletenessSummary,
    AcquisitionMediaSummary, AcquisitionRequest, AcquisitionResult, CollectorError,
    ExistingProfileContext, PortableConfigurationContext, PreflightReport, RecoveryCandidate,
    TargetInspectionRequest, TargetReadinessReport, available_space_bytes, collect,
    collect_with_progress, collect_with_progress_and_cancel, inspect_target,
    list_recovery_candidates, preflight,
};
pub use normalize::{NormalizationError, NormalizationSummary};
pub use progress::AcquisitionProgress;
pub use state::{AcquisitionState, StateError, StateMachine};

/// Field Collector semantic version.
pub const COLLECTOR_VERSION: &str = env!("CARGO_PKG_VERSION");
