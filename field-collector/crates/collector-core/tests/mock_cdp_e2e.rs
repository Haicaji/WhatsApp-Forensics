//! Synthetic loopback-CDP integration test for the complete passive T0 path.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use browser_cdp::CdpEndpoint;
use collector_core::{
    AcquisitionRequest, AcquisitionState, CollectorError, ExistingProfileContext,
    PortableConfigurationContext, TargetInspectionRequest, collect_t0, inspect_target,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use uuid::Uuid;

type TestError = Box<dyn Error + Send + Sync>;
type TestResult<T> = Result<T, TestError>;

const TARGET_ID: &str = "synthetic-whatsapp-target";
const TARGET_SESSION_ID: &str = "synthetic-target-session-0001";
const BRIDGE_SESSION_ID: &str = "synthetic-bridge-session-0001";
const CONTROLLER_OBJECT_ID: &str = "synthetic-controller-object-0001";
const PASSPHRASE: &str = "synthetic-test-passphrase-0001";
const OBSERVED_AT: &str = "2026-08-08T00:00:00.000Z";
const COMPLETED_AT: &str = "2026-08-08T00:00:00.010Z";
const LOST_ACK_SEQUENCE: &str = "2";
const ACCOUNT_BINDING: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOSTILE_JID_MARKER: &str = "15551234567@c.us";
const HOSTILE_BODY_MARKER: &str = "WAFC_HOSTILE_PAGE_BODY_MARKER_7f91c20d";
const OPERATOR_ID: &str = "synthetic_operator";
const KEY_ID: &str = "synthetic-test-key";
const ADAPTER_BYTES: &[u8] = include_bytes!("../../../injector/dist/collector.iife.js");

#[derive(Debug, Default)]
struct MockReport {
    http_paths: Vec<String>,
    cdp_methods: Vec<String>,
    dispatch_commands: Vec<String>,
    ack_request_sequences: Vec<String>,
    acknowledged_sequences: Vec<String>,
    dropped_ack_responses: usize,
    origin_evaluations: usize,
    injector_evaluations: usize,
    binding_checks: usize,
    frame_deliveries: usize,
    released_object: bool,
    detached: bool,
    detach_response_rejected: bool,
    frames_drained: usize,
}

#[derive(Clone, Copy)]
enum MockMode {
    FullT0,
    ProbeOnly,
    UnsupportedProbe,
    InspectionBindingMismatch,
    FinalBindingMismatch,
    HostileErrorMarker,
}

struct TempTree {
    path: PathBuf,
}

impl TempTree {
    fn create() -> io::Result<Self> {
        let path = std::env::temp_dir().join(format!("wafc-mock-cdp-e2e-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self { path })
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct PortableTestLayout {
    staging: PathBuf,
    sealed: PathBuf,
    keystore: PathBuf,
}

impl PortableTestLayout {
    fn create(temp: &TempTree) -> io::Result<Self> {
        let root = temp.path.join("portable");
        let config = root.join("config");
        let evidence = root.join("evidence");
        let staging = evidence.join("staging");
        let sealed = evidence.join("sealed");
        fs::create_dir(&root)?;
        fs::create_dir(&config)?;
        fs::create_dir(&evidence)?;
        fs::create_dir(&staging)?;
        fs::create_dir(&sealed)?;
        Ok(Self {
            staging,
            sealed,
            keystore: config.join("operator-key.enc"),
        })
    }
}

fn test_binding() -> portable_keystore::KeystoreBinding {
    portable_keystore::KeystoreBinding {
        operator_id: OPERATOR_ID.to_owned(),
        key_id: KEY_ID.to_owned(),
        workstation_key_fingerprint_sha256: format!("sha256:{}", "b".repeat(64)),
    }
}

fn portable_context(operator_fingerprint: &str) -> PortableConfigurationContext {
    PortableConfigurationContext {
        bundle_id: Uuid::from_u128(1),
        bundle_manifest_sha256: "c".repeat(64),
        assignment_id: "assignment-synthetic-001".to_owned(),
        assignment_sha256: "d".repeat(64),
        workstation_key_fingerprint_sha256: test_binding().workstation_key_fingerprint_sha256,
        operator_key_fingerprint_sha256: operator_fingerprint.to_owned(),
    }
}

fn acquisition_request(
    endpoint: CdpEndpoint,
    layout: &PortableTestLayout,
    operator_fingerprint: &str,
) -> AcquisitionRequest {
    AcquisitionRequest {
        endpoint,
        dedicated_profile_dir: None,
        existing_profile: None,
        target_id: TARGET_ID.to_owned(),
        evidence_staging_dir: layout.staging.clone(),
        evidence_sealed_dir: layout.sealed.clone(),
        keystore_path: layout.keystore.clone(),
        operator_id: OPERATOR_ID.to_owned(),
        operator_display_name: Some("Synthetic Test Operator".to_owned()),
        authorization_reference: "synthetic-test-authorization".to_owned(),
        authorization_confirmed_at_utc: OBSERVED_AT.to_owned(),
        passive_t0_consent: true,
        locale: "zh-CN".to_owned(),
        time_zone: "Asia/Shanghai".to_owned(),
        source_organization: "Synthetic Test Laboratory".to_owned(),
        key_id: KEY_ID.to_owned(),
        portable_configuration: portable_context(operator_fingerprint),
    }
}

fn bind_original_profile_extension(request: &mut AcquisitionRequest) {
    request.existing_profile = Some(ExistingProfileContext {
        profile_reference_sha256: "e".repeat(64),
        browser_family: "chrome".to_owned(),
        browser_product_was_running: true,
        browser_opened_at_utc: OBSERVED_AT.to_owned(),
        extension_paired_at_utc: OBSERVED_AT.to_owned(),
        extension_version: "0.1.0".to_owned(),
        transport_protocol: "wafc-extension-relay/1".to_owned(),
        adapter_id: "wa-private-collections-v1".to_owned(),
        adapter_version: "1.0.0".to_owned(),
        adapter_sha256: waeb_writer::sha256_hex(ADAPTER_BYTES),
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passive_t0_seals_a_signed_bag_through_the_real_public_entrypoint() -> TestResult<()> {
    let temp = TempTree::create()?;
    let layout = PortableTestLayout::create(&temp)?;
    let created_key = portable_keystore::create(&layout.keystore, PASSPHRASE, &test_binding())?;

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut server = spawn_mock_cdp(listener, port, MockMode::FullT0);
    let endpoint = CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?;
    let mut request = acquisition_request(
        endpoint,
        &layout,
        &created_key.public_key_fingerprint_sha256,
    );
    bind_original_profile_extension(&mut request);

    let mut acquisition = match timeout(
        Duration::from_secs(45),
        collect_t0(&request, PASSPHRASE, |challenge| async move {
            assert_eq!(challenge.claim_scope, "browser_page_observation");
            assert_eq!(challenge.account_authenticity, "unverified");
            assert!(
                !serde_json::to_string(&challenge)
                    .unwrap_or_default()
                    .contains(ACCOUNT_BINDING)
            );
            Some(challenge.confirmation_code)
        }),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            server.abort();
            return Err(Box::new(error) as TestError);
        }
        Err(error) => {
            server.abort();
            return Err(Box::new(error) as TestError);
        }
    };
    let report = timeout(Duration::from_secs(10), &mut server).await???;

    assert_eq!(
        acquisition.lifecycle_state,
        AcquisitionState::ExternalVerify
    );
    assert!(acquisition.evidence_bag_path.is_dir());
    let canonical_staging = fs::canonicalize(&layout.staging)?;
    let canonical_sealed = fs::canonicalize(&layout.sealed)?;
    let staging_wrapper = acquisition
        .evidence_bag_path
        .parent()
        .ok_or_else(|| invalid_data("sealed staging bag has no wrapper"))?;
    assert!(staging_wrapper.to_string_lossy().ends_with(".partial"));
    assert_eq!(staging_wrapper.parent(), Some(canonical_staging.as_path()));
    let formal_path = canonical_sealed.join(
        acquisition
            .evidence_bag_path
            .file_name()
            .ok_or_else(|| invalid_data("sealed staging bag has no leaf"))?,
    );
    assert!(!formal_path.exists());
    assert_eq!(acquisition.record_counts.len(), 4);
    for dataset in ["accounts", "contacts", "chats", "messages"] {
        assert_eq!(acquisition.record_counts.get(dataset).copied(), Some(1));
    }
    assert_eq!(acquisition.record_counts.values().sum::<u64>(), 4);
    assert_eq!(acquisition.unresolved_reference_count, 0);
    assert_eq!(
        acquisition.signer_fingerprint,
        created_key.public_key_fingerprint_sha256
    );
    assert!(acquisition.manifest_root_sha256.len() == 64);
    assert!(!serde_json::to_string(&acquisition)?.contains(ACCOUNT_BINDING));

    assert_mock_report(&report);
    assert_audit_log(&acquisition)?;
    assert_portable_configuration_metadata(&acquisition)?;
    assert_binding_absent_from_tree(&acquisition.evidence_bag_path)?;

    verify_with_repository_node_tool_if_available(&acquisition.evidence_bag_path)?;
    verify_with_independent_rust_cli_if_configured(&acquisition.evidence_bag_path)?;
    acquisition.promote_verified()?;
    assert_eq!(acquisition.lifecycle_state, AcquisitionState::Complete);
    assert_eq!(
        fs::canonicalize(&acquisition.evidence_bag_path)?,
        formal_path
    );
    assert_no_partial_staging_directories(&layout.staging)?;
    Ok(())
}

fn assert_portable_configuration_metadata(
    acquisition: &collector_core::AcquisitionResult,
) -> TestResult<()> {
    let document: Value = serde_json::from_slice(&fs::read(
        acquisition.evidence_bag_path.join("data/acquisition.json"),
    )?)?;
    assert_eq!(
        document
            .pointer("/portableConfiguration/assignmentId")
            .and_then(Value::as_str),
        Some("assignment-synthetic-001")
    );
    for pointer in [
        "/portableConfiguration/bundleManifestSha256",
        "/portableConfiguration/assignmentSha256",
    ] {
        assert!(
            document
                .pointer(pointer)
                .and_then(Value::as_str)
                .is_some_and(is_sha256)
        );
    }
    assert!(
        document
            .pointer("/portableConfiguration/workstationKeyFingerprintSha256")
            .and_then(Value::as_str)
            .and_then(|value| value.strip_prefix("sha256:"))
            .is_some_and(is_sha256)
    );
    assert!(
        document
            .pointer("/portableConfiguration/workstationPublicKey")
            .is_none()
    );
    assert!(
        document
            .pointer("/portableConfiguration/operatorPublicKey")
            .is_none()
    );
    assert_eq!(
        document
            .pointer("/environment/browser/profileReferenceSha256")
            .and_then(Value::as_str),
        Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
    );
    assert_eq!(
        document
            .pointer("/extensions/org.whatsapp-forensics.wafc/acquisitionTransport")
            .and_then(Value::as_str),
        Some("mv3_active_tab_loopback")
    );
    assert_eq!(
        document.pointer("/adapter/version").and_then(Value::as_str),
        Some("1.0.0")
    );
    Ok(())
}

fn assert_mock_report(report: &MockReport) {
    assert_eq!(report.http_paths, ["/json/version", "/json/list"]);
    for expected in [
        "Target.attachToTarget",
        "Runtime.enable",
        "Page.enable",
        "Page.getFrameTree",
        "Runtime.evaluate",
        "Runtime.callFunctionOn",
        "Runtime.releaseObject",
        "Target.detachFromTarget",
    ] {
        assert!(report.cdp_methods.iter().any(|method| method == expected));
    }
    assert_eq!(report.dispatch_commands, ["probe", "start_t0"]);
    assert_eq!(
        report.acknowledged_sequences,
        ["0", "1", "2", "3", "4", "5", "6"]
    );
    assert_eq!(
        report.ack_request_sequences,
        ["0", "1", "2", "2", "3", "4", "5", "6"]
    );
    assert_eq!(report.dropped_ack_responses, 1);
    assert_eq!(report.origin_evaluations, 3);
    assert_eq!(report.injector_evaluations, 1);
    assert_eq!(report.binding_checks, 2);
    assert!(report.released_object);
    assert!(report.detached);
    assert!(report.detach_response_rejected);
    assert_eq!(report.frames_drained, 7);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn target_inspection_is_probe_only_and_exposes_no_account_binding() -> TestResult<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut server = spawn_mock_cdp(listener, port, MockMode::ProbeOnly);
    let request = TargetInspectionRequest {
        endpoint: CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?,
        dedicated_profile_dir: None,
        target_id: TARGET_ID.to_owned(),
    };

    let inspection = inspect_target(&request).await?;
    let serialized = serde_json::to_string(&inspection)?;
    assert!(inspection.ready_for_passive_t0);
    assert_eq!(inspection.claim_scope, "browser_page_observation");
    assert_eq!(inspection.account_authenticity, "unverified");
    assert_eq!(inspection.authorization_assessment, "not_assessed");
    assert!(!inspection.collection_started);
    assert!(!inspection.evidence_bag_created);
    assert!(!serialized.contains(ACCOUNT_BINDING));
    assert!(!serialized.contains("accountBinding"));
    assert!(!serialized.contains("@c.us"));

    let report = timeout(Duration::from_secs(10), &mut server).await???;
    assert_eq!(report.http_paths, ["/json/version", "/json/list"]);
    assert_eq!(report.dispatch_commands, ["probe"]);
    assert_eq!(report.acknowledged_sequences, ["0"]);
    assert_eq!(report.binding_checks, 1);
    assert_eq!(report.frames_drained, 1);
    assert!(report.released_object);
    assert!(report.detached);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_target_inspection_returns_only_allowlisted_readiness_reasons() -> TestResult<()>
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut server = spawn_mock_cdp(listener, port, MockMode::UnsupportedProbe);
    let request = TargetInspectionRequest {
        endpoint: CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?,
        dedicated_profile_dir: None,
        target_id: TARGET_ID.to_owned(),
    };

    let inspection = inspect_target(&request).await?;
    let serialized = serde_json::to_string(&inspection)?;
    assert!(!inspection.ready_for_passive_t0);
    assert_eq!(inspection.reason_codes, ["unknown_build"]);
    assert!(inspection.adapter_id.is_none());
    assert!(!serialized.contains(ACCOUNT_BINDING));
    assert!(!serialized.contains("accountBinding"));

    let report = timeout(Duration::from_secs(10), &mut server).await???;
    assert_eq!(report.dispatch_commands, ["probe"]);
    assert_eq!(report.acknowledged_sequences, ["0"]);
    assert_eq!(report.binding_checks, 0);
    assert!(report.released_object);
    assert!(report.detached);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn target_inspection_fails_closed_when_live_binding_changes() -> TestResult<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut server = spawn_mock_cdp(listener, port, MockMode::InspectionBindingMismatch);
    let request = TargetInspectionRequest {
        endpoint: CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?,
        dedicated_profile_dir: None,
        target_id: TARGET_ID.to_owned(),
    };

    let result = inspect_target(&request).await;
    assert!(matches!(result, Err(CollectorError::Protocol(_))));
    let report = timeout(Duration::from_secs(10), &mut server).await???;
    assert_eq!(report.dispatch_commands, ["probe"]);
    assert_eq!(report.binding_checks, 1);
    assert!(report.released_object);
    assert!(report.detached);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_confirmation_releases_and_closes_without_touching_key_or_output() -> TestResult<()>
{
    let temp = TempTree::create()?;
    let layout = PortableTestLayout::create(&temp)?;
    fs::write(&layout.keystore, b"must-not-be-opened-after-rejection")?;

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut server = spawn_mock_cdp(listener, port, MockMode::ProbeOnly);
    let request = acquisition_request(
        CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?,
        &layout,
        &format!("sha256:{}", "e".repeat(64)),
    );

    let result = collect_t0(&request, "deliberately-wrong", |_| async { None }).await;
    assert!(matches!(
        result,
        Err(CollectorError::AccountConfirmationRejected)
    ));
    let report = timeout(Duration::from_secs(10), &mut server).await???;
    assert_eq!(report.dispatch_commands, ["probe"]);
    assert_eq!(report.acknowledged_sequences, ["0"]);
    assert_eq!(report.frames_drained, 1);
    assert!(report.released_object);
    assert!(report.detached);
    let release = report
        .cdp_methods
        .iter()
        .position(|method| method == "Runtime.releaseObject")
        .ok_or_else(|| invalid_data("releaseObject not observed"))?;
    let detach = report
        .cdp_methods
        .iter()
        .position(|method| method == "Target.detachFromTarget")
        .ok_or_else(|| invalid_data("detach not observed"))?;
    assert!(release < detach);
    assert_eq!(
        fs::read(&layout.keystore)?,
        b"must-not-be-opened-after-rejection"
    );
    assert_no_partial_staging_directories(&layout.staging)?;
    assert_eq!(fs::read_dir(&layout.staging)?.count(), 0);
    assert_eq!(fs::read_dir(&layout.sealed)?.count(), 0);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn final_live_binding_mismatch_fails_before_seal_and_keeps_only_staging() -> TestResult<()> {
    let temp = TempTree::create()?;
    let layout = PortableTestLayout::create(&temp)?;
    let created_key = portable_keystore::create(&layout.keystore, PASSPHRASE, &test_binding())?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut server = spawn_mock_cdp(listener, port, MockMode::FinalBindingMismatch);
    let request = acquisition_request(
        CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?,
        &layout,
        &created_key.public_key_fingerprint_sha256,
    );
    let result = collect_t0(&request, PASSPHRASE, |challenge| async move {
        Some(challenge.confirmation_code)
    })
    .await;
    assert!(matches!(result, Err(CollectorError::Protocol(_))));
    let report = timeout(Duration::from_secs(10), &mut server).await???;
    assert_eq!(report.dispatch_commands, ["probe", "start_t0"]);
    assert_eq!(report.binding_checks, 2);
    assert!(report.released_object);
    assert!(report.detached);
    let entries = fs::read_dir(&layout.staging)?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0]
            .file_name()
            .to_string_lossy()
            .ends_with(".partial")
    );
    assert!(!tree_contains_leaf(&entries[0].path(), "seal.json")?);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hostile_page_error_markers_are_rejected_without_host_or_staging_leakage() -> TestResult<()>
{
    let temp = TempTree::create()?;
    let layout = PortableTestLayout::create(&temp)?;
    let created_key = portable_keystore::create(&layout.keystore, PASSPHRASE, &test_binding())?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut server = spawn_mock_cdp(listener, port, MockMode::HostileErrorMarker);
    let request = acquisition_request(
        CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?,
        &layout,
        &created_key.public_key_fingerprint_sha256,
    );

    let result = collect_t0(&request, PASSPHRASE, |challenge| async move {
        Some(challenge.confirmation_code)
    })
    .await;
    let error = match result {
        Ok(acquisition) => {
            let observable = serde_json::to_string(&acquisition)?;
            assert_hostile_markers_absent("AcquisitionResult", observable.as_bytes())?;
            return Err(invalid_data(
                "host accepted an error frame containing hostile diagnostic markers",
            ));
        }
        Err(error) => error,
    };
    assert!(matches!(error, CollectorError::Bridge(_)));

    let error_display = error.to_string();
    let error_debug = format!("{error:?}");
    let stdout_equivalent = json!({"status": "error", "error": error_display}).to_string();
    assert_hostile_markers_absent("error display", error_display.as_bytes())?;
    assert_hostile_markers_absent("error debug", error_debug.as_bytes())?;
    assert_hostile_markers_absent("stdout-equivalent JSON", stdout_equivalent.as_bytes())?;

    let report = timeout(Duration::from_secs(10), &mut server).await???;
    assert_eq!(report.dispatch_commands, ["probe", "start_t0"]);
    assert_eq!(report.acknowledged_sequences, ["0", "1"]);
    assert_eq!(report.frame_deliveries, 3);
    assert_eq!(report.frames_drained, 2);
    assert_eq!(report.binding_checks, 1);
    assert!(report.released_object);
    assert!(report.detached);

    let entries = fs::read_dir(&layout.staging)?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(entries.len(), 1);
    let staging = entries[0].path();
    assert!(
        entries[0]
            .file_name()
            .to_string_lossy()
            .ends_with(".partial")
    );
    let audit_path = find_leaf_path(&staging, "acquisition.ndjson")?
        .ok_or_else(|| invalid_data("partial staging omitted its acquisition audit log"))?;
    let audit = fs::read(audit_path)?;
    assert_hostile_markers_absent("partial audit log", &audit)?;
    assert_hostile_markers_absent_from_tree(&staging)?;
    assert!(!tree_contains_leaf(&staging, "seal.json")?);
    Ok(())
}

fn assert_audit_log(acquisition: &collector_core::AcquisitionResult) -> TestResult<()> {
    let path = acquisition
        .evidence_bag_path
        .join("data/logs/acquisition.ndjson");
    let contents = fs::read_to_string(path)?;
    assert!(!contents.contains("synthetic_operator"));
    assert!(!contents.contains("synthetic-test-authorization"));
    assert!(!contents.contains(ACCOUNT_BINDING));
    let mut saw_ack_retry = false;
    let mut saw_teardown = false;
    let mut saw_degraded_teardown = false;
    let mut saw_pending_seal_completion = false;
    for line in contents.lines() {
        let event: Value = serde_json::from_str(line)?;
        let summary = event
            .pointer("/event/summary")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid_data("audit event summary is missing"))?;
        assert_eq!(
            summary.get("evidence_id").and_then(Value::as_str),
            Some(acquisition.evidence_id.to_string().as_str())
        );
        assert_eq!(
            summary.get("source_id").and_then(Value::as_str),
            Some(acquisition.source_id.to_string().as_str())
        );
        for name in [
            "operator_id_sha256",
            "authorization_reference_sha256",
            "collector_sha256",
            "injector_sha256",
            "portable_manifest_sha256",
            "assignment_sha256",
        ] {
            assert!(
                summary
                    .get(name)
                    .and_then(Value::as_str)
                    .is_some_and(is_sha256)
            );
        }
        assert_eq!(
            summary.get("assignment_id").and_then(Value::as_str),
            Some("assignment-synthetic-001")
        );
        assert!(
            summary
                .get("portable_bundle_id")
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value).ok())
                .is_some()
        );
        for name in [
            "workstation_key_fingerprint_sha256",
            "operator_key_fingerprint_sha256",
        ] {
            assert!(
                summary
                    .get(name)
                    .and_then(Value::as_str)
                    .and_then(|value| value.strip_prefix("sha256:"))
                    .is_some_and(is_sha256)
            );
        }
        assert!(
            summary
                .get("collector_version")
                .and_then(Value::as_str)
                .is_some()
        );
        assert!(
            summary
                .get("browser_version")
                .and_then(Value::as_str)
                .is_some()
        );
        saw_ack_retry |=
            summary.get("code").and_then(Value::as_str) == Some("bridge_ack_timeout_retry");
        saw_teardown |= summary.get("phase").and_then(Value::as_str) == Some("teardown");
        saw_degraded_teardown |= summary.get("code").and_then(Value::as_str)
            == Some("cdp_teardown_degraded")
            && summary
                .get("detach_error")
                .and_then(Value::as_str)
                .is_some();
        saw_pending_seal_completion |= event.pointer("/event/type").and_then(Value::as_str)
            == Some("acquisition_completed")
            && summary.get("seal_status").and_then(Value::as_str) == Some("pending")
            && summary
                .get("transport_close_status")
                .and_then(Value::as_str)
                == Some("confirmed")
            && summary.get("detach_status").and_then(Value::as_str)
                == Some("failed_transport_closed");
    }
    assert!(saw_ack_retry);
    assert!(saw_teardown);
    assert!(saw_degraded_teardown);
    assert!(saw_pending_seal_completion);
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn spawn_mock_cdp(
    listener: TcpListener,
    port: u16,
    mode: MockMode,
) -> JoinHandle<TestResult<MockReport>> {
    tokio::spawn(async move { run_mock_cdp(listener, port, mode).await })
}

async fn run_mock_cdp(listener: TcpListener, port: u16, mode: MockMode) -> TestResult<MockReport> {
    let mut report = MockReport::default();
    loop {
        let (stream, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            return Err(invalid_data("mock received a non-loopback connection"));
        }
        let first_line = peek_first_request_line(&stream).await?;
        if first_line == "GET /devtools/browser/synthetic HTTP/1.1" {
            handle_websocket(stream, &mut report, mode).await?;
            return Ok(report);
        }
        handle_http(stream, &first_line, port, &mut report).await?;
    }
}

async fn peek_first_request_line(stream: &TcpStream) -> TestResult<String> {
    let mut preview = [0_u8; 4096];
    loop {
        let count = stream.peek(&mut preview).await?;
        if count == 0 {
            return Err(invalid_data("connection closed before a request line"));
        }
        if let Some(end) = find_bytes(&preview[..count], b"\r\n") {
            return std::str::from_utf8(&preview[..end])
                .map(str::to_owned)
                .map_err(|error| Box::new(error) as TestError);
        }
        if count == preview.len() {
            return Err(invalid_data("request line exceeds mock limit"));
        }
        tokio::task::yield_now().await;
    }
}

async fn handle_http(
    mut stream: TcpStream,
    first_line: &str,
    port: u16,
    report: &mut MockReport,
) -> TestResult<()> {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 1024];
    while find_bytes(&request, b"\r\n\r\n").is_none() {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err(invalid_data("HTTP request ended before its headers"));
        }
        request.extend_from_slice(&chunk[..count]);
        if request.len() > 16 * 1024 {
            return Err(invalid_data("HTTP request exceeds mock limit"));
        }
    }

    let (path, body) = match first_line {
        "GET /json/version HTTP/1.1" => (
            "/json/version",
            json!({
                "Browser": "Chrome/151.0.7922.108",
                "Protocol-Version": "1.3",
                "webSocketDebuggerUrl": format!(
                    "ws://127.0.0.1:{port}/devtools/browser/synthetic"
                )
            }),
        ),
        "GET /json/list HTTP/1.1" => (
            "/json/list",
            json!([{
                "id": TARGET_ID,
                "type": "page",
                "url": "https://web.whatsapp.com/",
                "title": "Synthetic WhatsApp Web Target",
                "webSocketDebuggerUrl": format!(
                    "ws://127.0.0.1:{port}/devtools/page/{TARGET_ID}"
                )
            }]),
        ),
        _ => {
            return Err(invalid_data(format!(
                "unexpected HTTP request: {first_line}"
            )));
        }
    };
    report.http_paths.push(path.to_owned());
    let bytes = serde_json::to_vec(&body)?;
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(&bytes).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn handle_websocket(
    stream: TcpStream,
    report: &mut MockReport,
    mode: MockMode,
) -> TestResult<()> {
    let mut frames = bridge_frames()?;
    match mode {
        MockMode::ProbeOnly | MockMode::InspectionBindingMismatch => frames.truncate(1),
        MockMode::UnsupportedProbe => {
            frames.truncate(1);
            frames[0] = unsupported_probe_frame()?;
        }
        MockMode::HostileErrorMarker => {
            frames.truncate(2);
            let hostile = json!({
                "code": "snapshot_failed",
                "message": format!("{HOSTILE_JID_MARKER}:{HOSTILE_BODY_MARKER}")
            });
            frames.push(bridge_frame(2, "control", "error", &hostile, None)?);
        }
        MockMode::FullT0 | MockMode::FinalBindingMismatch => {}
    }
    let mut cursor = 0_usize;
    let mut socket = accept_async(stream).await?;
    while let Some(incoming) = socket.next().await {
        match incoming? {
            Message::Text(text) => {
                let request: Value = serde_json::from_str(text.as_ref())?;
                let id = request
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| invalid_data("CDP request omitted numeric id"))?;
                let drop_response = ack_request_sequence(&request) == Some(LOST_ACK_SEQUENCE)
                    && report.dropped_ack_responses == 0;
                let result = handle_cdp_request(&request, &frames, &mut cursor, report, mode)?;
                if drop_response {
                    report.dropped_ack_responses += 1;
                    continue;
                }
                if matches!(mode, MockMode::FullT0)
                    && request.get("method").and_then(Value::as_str)
                        == Some("Target.detachFromTarget")
                {
                    report.detach_response_rejected = true;
                    socket
                        .send(Message::Text(
                            json!({
                                "id": id,
                                "error": {
                                    "code": -32000,
                                    "message": "synthetic detach rejection"
                                }
                            })
                            .to_string()
                            .into(),
                        ))
                        .await?;
                    continue;
                }
                socket
                    .send(Message::Text(
                        json!({"id": id, "result": result}).to_string().into(),
                    ))
                    .await?;
            }
            Message::Close(frame) => {
                let _ = socket.send(Message::Close(frame)).await;
                break;
            }
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
            Message::Pong(_) => {}
            Message::Binary(_) | Message::Frame(_) => {
                return Err(invalid_data("unexpected non-text WebSocket message"));
            }
        }
    }
    report.frames_drained = cursor;
    let fully_consumed = if matches!(mode, MockMode::HostileErrorMarker) {
        cursor + 1 == frames.len() && report.frame_deliveries == frames.len()
    } else {
        cursor == frames.len()
    };
    if !fully_consumed {
        return Err(invalid_data(
            "client closed before draining all bridge frames",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn handle_cdp_request(
    request: &Value,
    frames: &[Value],
    cursor: &mut usize,
    report: &mut MockReport,
    mode: MockMode,
) -> TestResult<Value> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_data("CDP request omitted method"))?;
    let params = request
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_data("CDP request omitted params"))?;
    report.cdp_methods.push(method.to_owned());

    match method {
        "Target.attachToTarget" => {
            if params.get("targetId").and_then(Value::as_str) != Some(TARGET_ID)
                || params.get("flatten").and_then(Value::as_bool) != Some(true)
                || request.get("sessionId").is_some()
            {
                return Err(invalid_data("invalid target attachment request"));
            }
            Ok(json!({"sessionId": TARGET_SESSION_ID}))
        }
        "Runtime.enable" | "Page.enable" => {
            require_target_session(request)?;
            Ok(json!({}))
        }
        "Page.getFrameTree" => {
            require_target_session(request)?;
            Ok(json!({
                "frameTree": {
                    "frame": {
                        "id": "main-frame-1",
                        "loaderId": "loader-1",
                        "url": "https://web.whatsapp.com/",
                        "securityOrigin": "https://web.whatsapp.com",
                        "mimeType": "text/html"
                    }
                }
            }))
        }
        "Runtime.evaluate" => {
            require_target_session(request)?;
            let expression = params
                .get("expression")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_data("Runtime.evaluate omitted expression"))?;
            if expression == "window.location.origin" {
                report.origin_evaluations += 1;
                Ok(remote_value(&json!("https://web.whatsapp.com")))
            } else {
                if params.get("returnByValue").and_then(Value::as_bool) != Some(false) {
                    return Err(invalid_data("injector must be retained as a remote object"));
                }
                report.injector_evaluations += 1;
                Ok(json!({
                    "result": {
                        "type": "object",
                        "className": "Object",
                        "objectId": CONTROLLER_OBJECT_ID
                    }
                }))
            }
        }
        "Runtime.callFunctionOn" => {
            require_target_session(request)?;
            if params.get("objectId").and_then(Value::as_str) != Some(CONTROLLER_OBJECT_ID) {
                return Err(invalid_data(
                    "callFunctionOn used an unexpected remote object",
                ));
            }
            let function = params
                .get("functionDeclaration")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_data("callFunctionOn omitted its fixed function"))?;
            if function.contains("this.dispatch") {
                let command = first_argument_value(params)?;
                if command != "probe" && command != "start_t0" {
                    return Err(invalid_data("unexpected bridge dispatch command"));
                }
                report.dispatch_commands.push(command.to_owned());
                Ok(remote_value(&json!({
                    "ok": true,
                    "sessionId": BRIDGE_SESSION_ID
                })))
            } else if function.contains("this.next") {
                let frame = frames
                    .get(*cursor)
                    .cloned()
                    .ok_or_else(|| invalid_data("bridge next called after stream completion"))?;
                report.frame_deliveries += 1;
                Ok(remote_value(&frame))
            } else if function.contains("this.ack") {
                let sequence = first_argument_value(params)?;
                report.ack_request_sequences.push(sequence.to_owned());
                if report.acknowledged_sequences.last().map(String::as_str) == Some(sequence) {
                    return Ok(remote_value(&Value::Bool(true)));
                }
                let expected = frames
                    .get(*cursor)
                    .and_then(|frame| frame.get("sequence"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid_data("bridge ack called without a pending frame"))?;
                if sequence != expected {
                    return Err(invalid_data("bridge ack sequence mismatch"));
                }
                report.acknowledged_sequences.push(sequence.to_owned());
                *cursor += 1;
                Ok(remote_value(&Value::Bool(true)))
            } else if function.contains("this.checkAccountBinding") {
                report.binding_checks += 1;
                let binding = if (matches!(mode, MockMode::FinalBindingMismatch)
                    && report.binding_checks == 2)
                    || matches!(mode, MockMode::InspectionBindingMismatch)
                {
                    "b".repeat(64)
                } else {
                    ACCOUNT_BINDING.to_owned()
                };
                Ok(remote_value(&json!({
                    "ok": true,
                    "protocol": "wafc-bridge/1",
                    "sessionId": BRIDGE_SESSION_ID,
                    "accountBindingSha256": binding
                })))
            } else {
                Err(invalid_data("unexpected callFunctionOn function"))
            }
        }
        "Runtime.releaseObject" => {
            require_target_session(request)?;
            if params.get("objectId").and_then(Value::as_str) != Some(CONTROLLER_OBJECT_ID) {
                return Err(invalid_data("releaseObject used an unexpected object"));
            }
            report.released_object = true;
            Ok(json!({}))
        }
        "Target.detachFromTarget" => {
            if request.get("sessionId").is_some()
                || params.get("sessionId").and_then(Value::as_str) != Some(TARGET_SESSION_ID)
            {
                return Err(invalid_data("invalid target detach request"));
            }
            report.detached = true;
            Ok(json!({}))
        }
        _ => Err(invalid_data(format!("unexpected CDP method: {method}"))),
    }
}

fn ack_request_sequence(request: &Value) -> Option<&str> {
    if request.get("method").and_then(Value::as_str) != Some("Runtime.callFunctionOn") {
        return None;
    }
    let params = request.get("params")?.as_object()?;
    params
        .get("functionDeclaration")?
        .as_str()?
        .contains("this.ack")
        .then(|| first_argument_value(params).ok())
        .flatten()
}

fn require_target_session(request: &Value) -> TestResult<()> {
    if request.get("sessionId").and_then(Value::as_str) == Some(TARGET_SESSION_ID) {
        Ok(())
    } else {
        Err(invalid_data(
            "runtime/page call used the wrong target session",
        ))
    }
}

fn first_argument_value(params: &serde_json::Map<String, Value>) -> TestResult<&str> {
    params
        .get("arguments")
        .and_then(Value::as_array)
        .and_then(|arguments| arguments.first())
        .and_then(|argument| argument.get("value"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_data("bridge call omitted its first value argument"))
}

fn remote_value(value: &Value) -> Value {
    json!({"result": {"type": remote_type(value), "value": value}})
}

fn remote_type(value: &Value) -> &'static str {
    match value {
        Value::Null | Value::Object(_) | Value::Array(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    }
}

fn unsupported_probe_frame() -> TestResult<Value> {
    let probe = json!({
        "protocol": "wafc-bridge/1",
        "controllerVersion": "0.1.0",
        "supported": false,
        "adapterId": null,
        "build": "synthetic-unsupported-build",
        "accountBindingSha256": null,
        "reasons": ["unknown_build"],
        "capabilities": {
            "passiveT0": false,
            "accounts": false,
            "contacts": false,
            "chats": false,
            "messages": false,
            "media": false,
            "historyLoading": false,
            "networkActions": false,
            "domWrites": false
        }
    });
    bridge_frame(0, "control", "probe_result", &probe, None)
}

#[allow(clippy::too_many_lines)]
fn bridge_frames() -> TestResult<Vec<Value>> {
    let probe = json!({
        "protocol": "wafc-bridge/1",
        "controllerVersion": "0.1.0",
        "supported": true,
        "adapterId": "wa-private-collections-v1",
        "build": "synthetic-whatsapp-build",
        "accountBindingSha256": ACCOUNT_BINDING,
        "reasons": [],
        "capabilities": {
            "passiveT0": true,
            "accounts": true,
            "contacts": true,
            "chats": true,
            "messages": true,
            "media": false,
            "historyLoading": false,
            "networkActions": false,
            "domWrites": false
        }
    });
    let stream_start = json!({
        "operation": "t0",
        "observedAt": OBSERVED_AT,
        "accountBindingSha256": ACCOUNT_BINDING,
        "datasets": [
            {"dataset": "accounts", "observedRecords": 1},
            {"dataset": "contacts", "observedRecords": 1},
            {"dataset": "chats", "observedRecords": 1},
            {"dataset": "messages", "observedRecords": 1}
        ]
    });
    let account = json!({
        "dataset": "accounts",
        "accountBindingSha256": ACCOUNT_BINDING,
        "records": [{
            "id": "synthetic-self@c.us",
            "displayName": "Synthetic Account Alpha",
            "isBusiness": false,
            "isEnterprise": false
        }]
    });
    let contact = json!({
        "dataset": "contacts",
        "records": [{
            "id": "synthetic-peer@c.us",
            "name": "Synthetic Peer Beta",
            "pushName": "Synthetic Peer",
            "isUser": true,
            "isGroup": false,
            "isWhatsAppContact": true,
            "isMyContact": true,
            "isBlocked": false
        }]
    });
    let chat = json!({
        "dataset": "chats",
        "records": [{
            "id": "synthetic-peer@c.us",
            "name": "Synthetic Direct Chat",
            "isGroup": false,
            "isReadOnly": false,
            "archived": false,
            "pinned": false,
            "unreadCount": 0,
            "timestamp": 1_786_147_200,
            "muteExpiration": 0,
            "lastMessageId": "synthetic-message-0001",
            "participantCount": 2
        }]
    });
    let message = json!({
        "dataset": "messages",
        "records": [{
            "id": "synthetic-message-0001",
            "chatId": "synthetic-peer@c.us",
            "senderId": "synthetic-self@c.us",
            "recipientId": "synthetic-peer@c.us",
            "timestamp": 1_786_147_200,
            "type": "image",
            "body": null,
            "caption": "SYNTHETIC_MOCK_CDP_T0_MEDIA",
            "fromMe": true,
            "isStarred": false,
            "isForwarded": false,
            "isViewOnce": false,
            "isEdited": false,
            "isRevoked": false,
            "hasMedia": true,
            "mediaMimeType": "image/png",
            "mediaSize": 68,
            "acknowledgement": 3
        }]
    });
    let stream_end = json!({
        "operation": "t0",
        "observedAt": OBSERVED_AT,
        "completedAt": COMPLETED_AT,
        "accountBindingSha256": ACCOUNT_BINDING,
        "totals": {"accounts": 1, "contacts": 1, "chats": 1, "messages": 1},
        "completeness": {
            "localSnapshot": "verified",
            "historyScope": "not_run",
            "mediaScope": "not_requested",
            "accountScope": "unverifiable",
            "reasons": [
                "passive_t0_only",
                "history_not_run",
                "media_not_requested",
                "account_scope_unverifiable"
            ]
        }
    });

    Ok(vec![
        bridge_frame(0, "control", "probe_result", &probe, None)?,
        bridge_frame(1, "control", "stream_start", &stream_start, None)?,
        bridge_frame(2, "record", "records", &account, Some(1))?,
        bridge_frame(3, "record", "records", &contact, Some(1))?,
        bridge_frame(4, "record", "records", &chat, Some(1))?,
        bridge_frame(5, "record", "records", &message, Some(1))?,
        bridge_frame(6, "control", "stream_end", &stream_end, None)?,
    ])
}

fn bridge_frame(
    sequence: u64,
    stream: &str,
    kind: &str,
    payload_value: &Value,
    record_count: Option<u16>,
) -> TestResult<Value> {
    let payload = serde_json::to_string(&payload_value)?;
    let payload_sha256 = hex::encode(Sha256::digest(payload.as_bytes()));
    let mut frame = json!({
        "protocol": "wafc-bridge/1",
        "sessionId": BRIDGE_SESSION_ID,
        "sequence": sequence.to_string(),
        "stream": stream,
        "kind": kind,
        "encoding": "utf8_json",
        "payloadBytes": payload.len(),
        "payloadSha256": payload_sha256,
        "payload": payload
    });
    if let Some(count) = record_count {
        frame["recordCount"] = json!(count);
    }
    Ok(frame)
}

fn assert_no_partial_staging_directories(output_dir: &Path) -> TestResult<()> {
    for entry in fs::read_dir(output_dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().ends_with(".partial") {
            return Err(invalid_data(
                "successful acquisition retained a .partial directory",
            ));
        }
    }
    Ok(())
}

fn assert_binding_absent_from_tree(root: &Path) -> TestResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            assert_binding_absent_from_tree(&path)?;
        } else if fs::read(&path)?
            .windows(ACCOUNT_BINDING.len())
            .any(|window| window == ACCOUNT_BINDING.as_bytes())
        {
            return Err(invalid_data(format!(
                "internal account binding leaked into {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn assert_hostile_markers_absent(label: &str, bytes: &[u8]) -> TestResult<()> {
    for marker in [HOSTILE_JID_MARKER, HOSTILE_BODY_MARKER] {
        if bytes
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
        {
            return Err(invalid_data(format!(
                "hostile page marker leaked into {label}"
            )));
        }
    }
    Ok(())
}

fn assert_hostile_markers_absent_from_tree(root: &Path) -> TestResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        assert_hostile_markers_absent("staging path", path.to_string_lossy().as_bytes())?;
        if path.is_dir() {
            assert_hostile_markers_absent_from_tree(&path)?;
        } else {
            assert_hostile_markers_absent("staging file", &fs::read(path)?)?;
        }
    }
    Ok(())
}

fn tree_contains_leaf(root: &Path, leaf: &str) -> TestResult<bool> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name() == std::ffi::OsStr::new(leaf) {
            return Ok(true);
        }
        if path.is_dir() && tree_contains_leaf(&path, leaf)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn find_leaf_path(root: &Path, leaf: &str) -> TestResult<Option<PathBuf>> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name() == std::ffi::OsStr::new(leaf) {
            return Ok(Some(path));
        }
        if path.is_dir()
            && let Some(found) = find_leaf_path(&path, leaf)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn verify_with_repository_node_tool_if_available(bag: &Path) -> TestResult<()> {
    let node_probe = Command::new("node").arg("--version").output();
    let Ok(node_probe) = node_probe else {
        return Ok(());
    };
    if !node_probe.status.success() {
        return Ok(());
    }

    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let verifier = repository_root.join("spec/wa-evidence-bag/v1/tools/verify-example.mjs");
    if !verifier.is_file() {
        return Ok(());
    }
    let output = Command::new("node").arg(&verifier).arg(bag).output()?;
    if !output.status.success() {
        return Err(invalid_data(format!(
            "repository WAEB verifier rejected the sealed bag: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let stdout = String::from_utf8(output.stdout)?;
    if !stdout.contains("\"status\": \"valid_untrusted\"")
        || !stdout.contains("\"normalizedRecords\": 4")
    {
        return Err(invalid_data(
            "repository WAEB verifier returned unexpected output",
        ));
    }
    Ok(())
}

fn verify_with_independent_rust_cli_if_configured(bag: &Path) -> TestResult<()> {
    let Some(verifier) = std::env::var_os("WAFC_INDEPENDENT_VERIFIER") else {
        return Ok(());
    };
    let verifier = PathBuf::from(verifier);
    if !verifier.is_file() {
        return Err(invalid_data(format!(
            "configured independent verifier is not a file: {}",
            verifier.display()
        )));
    }

    let output = Command::new(&verifier).arg(bag).output()?;
    if !output.status.success() {
        return Err(invalid_data(format!(
            "independent Rust verifier rejected the collector bag: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let report: Value = serde_json::from_slice(&output.stdout)?;
    if report.get("status").and_then(Value::as_str) != Some("valid_untrusted")
        || report.get("normalizedRecords").and_then(Value::as_u64) != Some(4)
        || report.get("datasets").and_then(Value::as_u64) != Some(18)
        || report.get("mediaAssets").and_then(Value::as_u64) != Some(1)
        || report
            .get("chatCompletenessRecords")
            .and_then(Value::as_u64)
            != Some(1)
    {
        return Err(invalid_data(format!(
            "independent Rust verifier returned unexpected output: {report}"
        )));
    }
    Ok(())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn invalid_data(message: impl Into<String>) -> TestError {
    Box::new(io::Error::new(io::ErrorKind::InvalidData, message.into()))
}
