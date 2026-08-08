//! Explicit fail-closed acquisition lifecycle.

use serde::Serialize;
use thiserror::Error;

/// Observable Field Collector lifecycle state.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionState {
    /// No acquisition has started.
    Idle,
    /// Output/key/environment checks are running.
    Preflight,
    /// The operator-authorized loopback endpoint has been verified.
    EndpointAuthorized,
    /// One `WhatsApp` target has been selected and locked.
    TargetSelected,
    /// The operator explicitly consented to passive T0.
    T0Consent,
    /// A flattened CDP session is attached to the target.
    Attached,
    /// The fixed injector capability probe is running.
    Probe,
    /// Passive T0 records are streaming.
    T0,
    /// Payload files are closed and cryptographic tags are being produced.
    Finalizing,
    /// A sealed bag awaits the independent verifier.
    ExternalVerify,
    /// Collection and independent verification completed.
    Complete,
    /// An error left an explicitly incomplete staging directory or failed handoff.
    FailedStaging,
}

/// Illegal acquisition lifecycle transition.
#[derive(Debug, Error, Eq, PartialEq)]
#[error("illegal acquisition state transition: {from:?} -> {to:?}")]
pub struct StateError {
    /// Current state.
    pub from: AcquisitionState,
    /// Requested next state.
    pub to: AcquisitionState,
}

/// Small deterministic state machine; no transition is inferred from I/O.
#[derive(Debug)]
pub struct StateMachine {
    current: AcquisitionState,
}

impl Default for StateMachine {
    fn default() -> Self {
        Self {
            current: AcquisitionState::Idle,
        }
    }
}

impl StateMachine {
    /// Current lifecycle state.
    #[must_use]
    pub const fn current(&self) -> AcquisitionState {
        self.current
    }

    /// Applies one explicitly allowed transition.
    ///
    /// # Errors
    ///
    /// Returns [`StateError`] when `to` is not an allowed successor of the
    /// current state.
    pub fn transition(&mut self, to: AcquisitionState) -> Result<(), StateError> {
        let allowed = matches!(
            (self.current, to),
            (AcquisitionState::Idle, AcquisitionState::Preflight)
                | (
                    AcquisitionState::Preflight,
                    AcquisitionState::EndpointAuthorized
                )
                | (
                    AcquisitionState::EndpointAuthorized,
                    AcquisitionState::TargetSelected
                )
                | (
                    AcquisitionState::TargetSelected,
                    AcquisitionState::T0Consent
                )
                | (AcquisitionState::T0Consent, AcquisitionState::Attached)
                | (AcquisitionState::Attached, AcquisitionState::Probe)
                | (AcquisitionState::Probe, AcquisitionState::T0)
                | (AcquisitionState::T0, AcquisitionState::Finalizing)
                | (
                    AcquisitionState::Finalizing,
                    AcquisitionState::ExternalVerify
                )
                | (AcquisitionState::ExternalVerify, AcquisitionState::Complete)
                | (
                    AcquisitionState::Preflight
                        | AcquisitionState::EndpointAuthorized
                        | AcquisitionState::TargetSelected
                        | AcquisitionState::T0Consent
                        | AcquisitionState::Attached
                        | AcquisitionState::Probe
                        | AcquisitionState::T0
                        | AcquisitionState::Finalizing
                        | AcquisitionState::ExternalVerify,
                    AcquisitionState::FailedStaging
                )
        );
        if !allowed {
            return Err(StateError {
                from: self.current,
                to,
            });
        }
        self.current = to;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_t0_happy_path() {
        let mut state = StateMachine::default();
        for expected in [
            AcquisitionState::Preflight,
            AcquisitionState::EndpointAuthorized,
            AcquisitionState::TargetSelected,
            AcquisitionState::T0Consent,
            AcquisitionState::Attached,
            AcquisitionState::Probe,
            AcquisitionState::T0,
            AcquisitionState::Finalizing,
            AcquisitionState::ExternalVerify,
            AcquisitionState::Complete,
        ] {
            assert!(state.transition(expected).is_ok());
        }
        assert_eq!(state.current(), AcquisitionState::Complete);
    }

    #[test]
    fn any_active_state_can_fail_closed() {
        let mut state = StateMachine::default();
        assert!(state.transition(AcquisitionState::Preflight).is_ok());
        assert!(state.transition(AcquisitionState::FailedStaging).is_ok());
        assert!(state.transition(AcquisitionState::Complete).is_err());
    }

    #[test]
    fn skips_are_rejected() {
        let mut state = StateMachine::default();
        assert!(state.transition(AcquisitionState::T0).is_err());
        assert_eq!(state.current(), AcquisitionState::Idle);
    }

    #[test]
    fn terminal_states_cannot_be_relabelled_as_failures() {
        let mut complete = StateMachine::default();
        for state in [
            AcquisitionState::Preflight,
            AcquisitionState::EndpointAuthorized,
            AcquisitionState::TargetSelected,
            AcquisitionState::T0Consent,
            AcquisitionState::Attached,
            AcquisitionState::Probe,
            AcquisitionState::T0,
            AcquisitionState::Finalizing,
            AcquisitionState::ExternalVerify,
            AcquisitionState::Complete,
        ] {
            assert!(complete.transition(state).is_ok());
        }
        assert!(
            complete
                .transition(AcquisitionState::FailedStaging)
                .is_err()
        );

        let mut failed = StateMachine::default();
        assert!(failed.transition(AcquisitionState::Preflight).is_ok());
        assert!(failed.transition(AcquisitionState::FailedStaging).is_ok());
        assert!(failed.transition(AcquisitionState::FailedStaging).is_err());
    }
}
