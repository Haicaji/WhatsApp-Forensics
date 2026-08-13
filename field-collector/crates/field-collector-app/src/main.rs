#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

//! Portable Field Collector native application and command-line interface.

mod gui;

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Result as IoResult, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use browser_cdp::CdpEndpoint;
#[cfg(debug_assertions)]
use browser_cdp::{
    BrowserProduct, discover_authorized_endpoints, discover_browsers, get_version,
    launch_dedicated_browser, list_whatsapp_targets,
};
use chrono::{Local, SecondsFormat, Utc};
#[cfg(debug_assertions)]
use collector_core::{
    AccountConfirmationChallenge, TargetInspectionRequest, collect, inspect_target, preflight,
};
use collector_core::{AcquisitionRequest, AcquisitionResult, PortableConfigurationContext};
#[cfg(any(debug_assertions, test))]
use getopts::{Matches, Options};
use portable_config::{PortableAssignment, PortableBundle};
use serde_json::{Value, json};
#[cfg(debug_assertions)]
use zeroize::Zeroizing;

const VERIFIER_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_VERIFIER_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_VERIFIER_STDERR_BYTES: usize = 256 * 1024;
const HANDOFF_SCHEMA_VERSION: &str = "wafc-handoff/1";

struct HandoffData {
    evidence_id: String,
    source_id: String,
    evidence_bag_directory: String,
    manifest_root_sha256: String,
    signer_fingerprint: String,
    record_counts: BTreeMap<String, u64>,
    unresolved_reference_count: usize,
    completeness_overall: String,
    local_snapshot: String,
    history_scope: String,
    media_scope: String,
    completeness_reason_codes: Vec<String>,
    operator_id: String,
    authorization_reference: String,
    authorization_confirmed_at_utc: String,
    verification_status: String,
    signature_trusted: bool,
}

struct BoundedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct CapturedStream {
    bytes: Vec<u8>,
    exceeded_limit: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    match Box::pin(run()).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Field Collector 失败：{error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<ExitCode> {
    let mut arguments = std::env::args().skip(1);
    let Some(command) = arguments.next() else {
        return gui::run();
    };
    #[cfg(debug_assertions)]
    let rest: Vec<String> = arguments.collect();
    match command.as_str() {
        #[cfg(debug_assertions)]
        "discover" => command_discover(&rest),
        #[cfg(debug_assertions)]
        "targets" => command_targets(&rest).await,
        #[cfg(debug_assertions)]
        "inspect-target" => command_inspect_target(&rest).await,
        #[cfg(debug_assertions)]
        "launch-dedicated" => command_launch_dedicated(&rest),
        #[cfg(debug_assertions)]
        "collect" => Box::pin(command_collect(&rest)).await,
        "gui" => gui::run(),
        "help" | "--help" | "-h" => {
            print_root_help();
            Ok(ExitCode::SUCCESS)
        }
        other => {
            eprintln!("未知命令：{other}");
            print_root_help();
            Ok(ExitCode::from(2))
        }
    }
}

#[cfg(debug_assertions)]
fn command_launch_dedicated(arguments: &[String]) -> Result<ExitCode> {
    let mut options = Options::new();
    options.optopt("", "browser", "浏览器：chrome 或 edge", "FAMILY");
    options.optopt(
        "",
        "profile",
        "新建且必须为空的专用采集 Profile 目录",
        "DIR",
    );
    options.optflag("h", "help", "显示帮助");
    let matches = parse_options(&options, arguments)?;
    if matches.opt_present("help") {
        println!(
            "{}",
            options.usage(
                "用法: field-collector launch-dedicated --browser chrome|edge --profile DIR"
            )
        );
        return Ok(ExitCode::SUCCESS);
    }
    reject_free_arguments(&matches)?;
    let product = match required_string(&matches, "browser")?.as_str() {
        "chrome" => BrowserProduct::Chrome,
        "edge" => BrowserProduct::Edge,
        _ => bail!("--browser 只接受 chrome 或 edge"),
    };
    let profile = required_path(&matches, "profile")?;
    let launched = launch_dedicated_browser(product, &profile, Duration::from_secs(20))?;
    print_json(&json!({
        "status": "launched",
        "session": launched,
        "next": "在新窗口完成 WhatsApp 登录后，使用 targets --endpoint <endpoint>",
        "warnings": [
            "dedicated_profile_contains_sensitive_browser_state",
            "collector_does_not_close_or_delete_the_profile",
            "operating_system_and_browser_may_leave_execution_traces"
        ]
    }))?;
    Ok(ExitCode::SUCCESS)
}

#[cfg(debug_assertions)]
fn command_discover(arguments: &[String]) -> Result<ExitCode> {
    if !arguments.is_empty() {
        bail!("discover 不接受参数");
    }
    let authorized_endpoints = discover_authorized_endpoints()?;
    print_json(&json!({
        "collectorVersion": env!("CARGO_PKG_VERSION"),
        "browsers": discover_browsers(),
        "authorizedEndpoints": authorized_endpoints,
        "constraints": {
            "portScanning": false,
            "profileCopy": false,
            "browserTermination": false,
            "supportedProducts": ["chrome", "edge"]
        }
    }))?;
    Ok(ExitCode::SUCCESS)
}

#[cfg(debug_assertions)]
async fn command_targets(arguments: &[String]) -> Result<ExitCode> {
    let mut options = Options::new();
    options.optopt("", "endpoint", "已由操作者授权的回环 CDP endpoint", "URL");
    options.optflag("h", "help", "显示帮助");
    let matches = parse_options(&options, arguments)?;
    if matches.opt_present("help") {
        println!(
            "{}",
            options.usage("用法: field-collector targets --endpoint URL")
        );
        return Ok(ExitCode::SUCCESS);
    }
    reject_free_arguments(&matches)?;
    let endpoint = endpoint_option(&matches)?;
    let version = get_version(&endpoint).await?;
    let targets = list_whatsapp_targets(&endpoint).await?;
    print_json(&json!({
        "endpoint": endpoint.as_url(),
        "browser": version.browser,
        "protocolVersion": version.protocol_version,
        "targets": targets,
        "selectionRequired": targets.len() != 1,
    }))?;
    Ok(ExitCode::SUCCESS)
}

#[cfg(debug_assertions)]
async fn command_inspect_target(arguments: &[String]) -> Result<ExitCode> {
    let mut options = Options::new();
    options.optopt("", "endpoint", "已由操作者授权的回环 CDP endpoint", "URL");
    options.optopt(
        "",
        "dedicated-profile",
        "由 launch-dedicated 启动并与 endpoint 绑定的 Profile 目录",
        "DIR",
    );
    options.optopt(
        "",
        "target-id",
        "targets 命令列出的 WhatsApp target ID",
        "ID",
    );
    options.optflag("h", "help", "显示帮助");
    let matches = parse_options(&options, arguments)?;
    if matches.opt_present("help") {
        println!(
            "{}",
            options.usage(
                "用法: field-collector inspect-target --endpoint URL --target-id ID [--dedicated-profile DIR]"
            )
        );
        return Ok(ExitCode::SUCCESS);
    }
    reject_free_arguments(&matches)?;
    let request = TargetInspectionRequest {
        endpoint: endpoint_option(&matches)?,
        dedicated_profile_dir: matches.opt_str("dedicated-profile").map(PathBuf::from),
        target_id: required_string(&matches, "target-id")?,
    };
    let report = inspect_target(&request).await?;
    let status = if report.ready_for_passive_t0 {
        "ready_for_passive_t0"
    } else {
        "not_ready_for_passive_t0"
    };
    print_json(&json!({
        "status": status,
        "inspection": report,
        "next": if status == "ready_for_passive_t0" {
            "run collect; collection still requires explicit authorization, consent, and same-session visual confirmation"
        } else {
            "keep the selected page open and complete login or update the adapter; do not bypass the capability gate"
        }
    }))?;
    Ok(ExitCode::SUCCESS)
}

#[cfg(debug_assertions)]
fn collect_options() -> Options {
    let mut options = Options::new();
    options.optopt("", "endpoint", "已授权的回环 CDP endpoint", "URL");
    options.optopt(
        "",
        "dedicated-profile",
        "由 launch-dedicated 启动并与 endpoint 绑定的 Profile 目录",
        "DIR",
    );
    options.optopt(
        "",
        "target-id",
        "targets 命令列出的 WhatsApp target ID",
        "ID",
    );
    options.optopt("", "assignment", "已下发且当前有效的任务编号", "ID");
    options.optflag(
        "",
        "i-confirm-read-only-t0",
        "确认已获授权且仅执行不加载历史/媒体、不写页面的被动 T0",
    );
    options.optflag("h", "help", "显示帮助");
    options
}

fn load_portable_bundle() -> Result<PortableBundle> {
    let executable = std::env::current_exe().context("无法确定 Field Collector 所在位置")?;
    PortableBundle::load_from_executable(&executable, Utc::now()).context("U 盘配置或任务校验失败")
}

fn acquisition_request_from_bundle(
    bundle: &PortableBundle,
    assignment: &PortableAssignment,
    endpoint: CdpEndpoint,
    dedicated_profile_dir: Option<PathBuf>,
    target_id: String,
    operator_consent: bool,
) -> AcquisitionRequest {
    let profile = bundle.profile();
    AcquisitionRequest {
        endpoint,
        dedicated_profile_dir,
        existing_profile: None,
        target_id,
        evidence_staging_dir: bundle.paths().evidence_staging.clone(),
        evidence_sealed_dir: bundle.paths().evidence_sealed.clone(),
        keystore_path: bundle.paths().operator_key.clone(),
        operator_id: profile.operator_id.clone(),
        operator_display_name: Some(profile.display_name.clone()),
        authorization_reference: assignment.payload.authorization_reference.clone(),
        authorization_confirmed_at_utc: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        acquisition_mode: assignment.payload.acquisition_mode,
        media_policy: assignment.payload.media_policy,
        operator_consent,
        locale: automatic_locale(),
        time_zone: automatic_time_zone(),
        source_organization: assignment.payload.source_organization.clone(),
        key_id: profile.key_id.clone(),
        portable_configuration: PortableConfigurationContext {
            bundle_id: bundle.bundle_id(),
            bundle_manifest_sha256: bundle.manifest_sha256().to_owned(),
            assignment_id: assignment.payload.assignment_id.clone(),
            assignment_sha256: assignment.document_sha256.clone(),
            workstation_key_fingerprint_sha256: bundle
                .workstation_key_fingerprint_sha256()
                .to_owned(),
            operator_key_fingerprint_sha256: profile
                .evidence_signing_key_fingerprint_sha256
                .clone(),
        },
        resume_evidence_id: None,
    }
}

fn automatic_locale() -> String {
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(name) {
            let value = value
                .split(['.', '@'])
                .next()
                .unwrap_or_default()
                .replace('_', "-");
            if (2..=40).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return value;
            }
        }
    }
    "system-default".to_owned()
}

fn automatic_time_zone() -> String {
    let offset = Local::now().offset().to_string();
    format!("UTC{offset}")
}

#[cfg(debug_assertions)]
async fn command_collect(arguments: &[String]) -> Result<ExitCode> {
    let options = collect_options();
    let matches = parse_options(&options, arguments)?;
    if matches.opt_present("help") {
        println!(
            "{}",
            options.usage(
                "用法: field-collector collect --endpoint URL --target-id ID --assignment ID \\\n  --i-confirm-read-only-t0 [--dedicated-profile DIR]"
            )
        );
        return Ok(ExitCode::SUCCESS);
    }
    reject_free_arguments(&matches)?;

    let bundle = load_portable_bundle()?;
    let assignment_id = required_string(&matches, "assignment")?;
    let assignment = bundle.assignment_at(&assignment_id, Utc::now())?;
    let request = acquisition_request_from_bundle(
        &bundle,
        assignment,
        endpoint_option(&matches)?,
        matches.opt_str("dedicated-profile").map(PathBuf::from),
        required_string(&matches, "target-id")?,
        matches.opt_present("i-confirm-read-only-t0"),
    );
    let report = preflight(&request)?;
    eprintln!(
        "预检通过：证据将自动保存到 {}。",
        report.evidence_sealed_dir.display()
    );
    let verifier = resolve_verifier(None)?;
    let trusted_fingerprint = bundle
        .profile()
        .evidence_signing_key_fingerprint_sha256
        .clone();
    let passphrase = Zeroizing::new(rpassword::prompt_password("请输入勘察员密钥口令: ")?);
    let mut result = Box::pin(collect(
        &request,
        &passphrase,
        request_operator_confirmation,
    ))
    .await?;

    match run_external_verifier(
        &verifier,
        &result.evidence_bag_path,
        Some(&trusted_fingerprint),
        &result,
    ) {
        Ok(verification) => {
            if let Err(error) = result.promote_verified() {
                print_json(&json!({
                    "status": "externally_verified_but_promotion_failed",
                    "acquisition": result,
                    "externalVerification": verification,
                    "promotion": {"status": "failed", "error": error.to_string()},
                }))?;
                return Ok(ExitCode::FAILURE);
            }
            let handoff_summary = match write_handoff_summary(
                &result,
                &request,
                &verification,
                &bundle.paths().handoff,
            ) {
                Ok(path) => path,
                Err(error) => {
                    print_json(&json!({
                        "status": "complete_but_handoff_summary_failed",
                        "acquisition": result,
                        "externalVerification": verification,
                        "handoffSummary": {"status": "failed", "error": error.to_string()},
                    }))?;
                    return Ok(ExitCode::FAILURE);
                }
            };
            print_json(&json!({
                "status": "complete",
                "acquisition": result,
                "externalVerification": verification,
                "handoffSummary": handoff_summary,
            }))?;
            Ok(ExitCode::SUCCESS)
        }
        Err(error) => {
            print_json(&json!({
                "status": "sealed_staging_external_verification_failed",
                "acquisition": result,
                "externalVerification": {"status": "invalid_or_not_run", "error": error.to_string()},
            }))?;
            Ok(ExitCode::FAILURE)
        }
    }
}

#[cfg(debug_assertions)]
async fn request_operator_confirmation(challenge: AccountConfirmationChallenge) -> Option<String> {
    let rendered = serde_json::to_string_pretty(&challenge).ok()?;
    eprintln!(
        "采集尚未开始，签名密钥尚未解锁，证据 staging 尚未创建。\n\
请目视核对当前浏览器中的目标 WhatsApp Web 页面。以下声明不证明账号真实身份或所有权：\n{rendered}"
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    thread::spawn(move || {
        let entered =
            rpassword::prompt_password("请输入上述一次性确认码（拒绝或 EOF 将取消）: ").ok();
        let _ = sender.send(entered);
    });
    receiver.await.ok().flatten()
}

fn write_handoff_summary(
    acquisition: &AcquisitionResult,
    request: &AcquisitionRequest,
    verification: &Value,
    handoff_dir: &Path,
) -> Result<PathBuf> {
    if acquisition.lifecycle_state != collector_core::AcquisitionState::Complete {
        bail!("handoff summary requires a promoted, complete acquisition");
    }
    ensure_safe_summary_parent(handoff_dir)?;
    let bag_leaf = acquisition
        .evidence_bag_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("promoted Evidence Bag directory name is not valid UTF-8"))?;
    let verification_status = verification
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("bound verifier report omitted status"))?;
    let signature_trusted = verification
        .get("signature")
        .and_then(|value| value.get("trusted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let document = handoff_document(&HandoffData {
        evidence_id: acquisition.evidence_id.to_string(),
        source_id: acquisition.source_id.to_string(),
        evidence_bag_directory: bag_leaf.to_owned(),
        manifest_root_sha256: acquisition.manifest_root_sha256.clone(),
        signer_fingerprint: acquisition.signer_fingerprint.clone(),
        record_counts: acquisition.record_counts.clone(),
        unresolved_reference_count: acquisition.unresolved_reference_count,
        completeness_overall: acquisition.completeness.overall.clone(),
        local_snapshot: acquisition.completeness.local_snapshot.clone(),
        history_scope: acquisition.completeness.history_scope.clone(),
        media_scope: acquisition.completeness.media_scope.clone(),
        completeness_reason_codes: acquisition.completeness.reason_codes.clone(),
        operator_id: request.operator_id.clone(),
        authorization_reference: request.authorization_reference.clone(),
        authorization_confirmed_at_utc: request.authorization_confirmed_at_utc.clone(),
        verification_status: verification_status.to_owned(),
        signature_trusted,
    });
    let leaf = format!("handoff-{}.json", acquisition.evidence_id);
    write_json_atomically(handoff_dir, &leaf, &document)
}

fn handoff_document(data: &HandoffData) -> Value {
    json!({
        "schemaVersion": HANDOFF_SCHEMA_VERSION,
        "createdAtUtc": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "collector": {
            "name": "wafc-field-collector",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "evidence": {
            "evidenceId": data.evidence_id,
            "sourceId": data.source_id,
            "evidenceBagDirectory": data.evidence_bag_directory,
            "manifestRootSha256": data.manifest_root_sha256,
            "signerFingerprint": data.signer_fingerprint,
        },
        "operator": {"id": data.operator_id},
        "authorization": {
            "reference": data.authorization_reference,
            "confirmedAtUtc": data.authorization_confirmed_at_utc,
        },
        "observedScope": {
            "claimScope": "browser_page_observation",
            "accountAuthenticity": "unverified",
            "accountScope": "unverifiable",
            "recordCounts": data.record_counts,
            "unresolvedReferenceCount": data.unresolved_reference_count,
            "completeness": {
                "overall": data.completeness_overall,
                "localSnapshot": data.local_snapshot,
                "historyScope": data.history_scope,
                "mediaScope": data.media_scope,
                "reasonCodes": data.completeness_reason_codes,
            },
        },
        "independentVerification": {
            "status": data.verification_status,
            "signatureTrusted": data.signature_trusted,
        },
        "warnings": [
            "client_observable_scope_only",
            "not_account_level_absolute_completeness",
            "contains_no_chat_body_or_account_identifier"
        ]
    })
}

fn ensure_safe_summary_parent(parent: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("handoff summary parent must be a real directory");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            bail!("handoff summary parent cannot be a Windows reparse point");
        }
    }
    Ok(())
}

fn write_json_atomically(parent: &Path, leaf: &str, document: &Value) -> Result<PathBuf> {
    if leaf.is_empty()
        || leaf.len() > 180
        || !leaf.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
        })
    {
        bail!("handoff summary filename is invalid");
    }
    let target = parent.join(leaf);
    let temporary = parent.join(format!(".{leaf}.partial"));
    if target.exists() || temporary.exists() {
        bail!("handoff summary or its staging file already exists");
    }
    let write_result = (|| -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(document)?;
        bytes.push(b'\n');
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if target.exists() {
            bail!("handoff summary target appeared before promotion");
        }
        fs::rename(&temporary, &target)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(target)
}

fn run_external_verifier(
    executable: &Path,
    bag: &Path,
    trusted_fingerprint: Option<&str>,
    acquisition: &AcquisitionResult,
) -> Result<Value> {
    if let Some(fingerprint) = trusted_fingerprint {
        validate_trusted_fingerprint(fingerprint)?;
    }
    let mut command = Command::new(executable);
    configure_hidden_child(&mut command);
    command.arg(bag);
    if let Some(fingerprint) = trusted_fingerprint {
        command.args(["--trusted-fingerprint", fingerprint]);
    }
    let output = run_bounded_command(
        &mut command,
        VERIFIER_TIMEOUT,
        MAX_VERIFIER_STDOUT_BYTES,
        MAX_VERIFIER_STDERR_BYTES,
    )
    .with_context(|| format!("独立校验器 {} 执行失败", executable.display()))?;
    let mut report: Value = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "独立校验器没有返回有效 JSON；stderr={}",
            bounded_utf8(&output.stderr, 2000)
        )
    })?;
    let status = report.get("status").and_then(Value::as_str);
    let accepted = if trusted_fingerprint.is_some() {
        status == Some("valid_trusted")
    } else {
        matches!(status, Some("valid_untrusted" | "valid_trusted"))
    };
    if !output.status.success() || !accepted {
        bail!("独立校验器拒绝证据包：{report}");
    }
    bind_verification_report(
        &mut report,
        bag,
        &acquisition.evidence_id.to_string(),
        &acquisition.manifest_root_sha256,
        &acquisition.signer_fingerprint,
    )?;
    Ok(report)
}

#[cfg(windows)]
fn configure_hidden_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_hidden_child(_command: &mut Command) {}

fn run_bounded_command(
    command: &mut Command,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<BoundedOutput> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("无法启动子进程")?;
    let stdout = child.stdout.take().context("无法捕获子进程 stdout")?;
    let stderr = child.stderr.take().context("无法捕获子进程 stderr")?;
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = stdout_sender.send(capture_stream(stdout, stdout_limit));
    });
    thread::spawn(move || {
        let _ = stderr_sender.send(capture_stream(stderr, stderr_limit));
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).context("无法轮询子进程状态");
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("独立校验器超过 {} 秒执行时限", timeout.as_secs());
        }
        thread::sleep(Duration::from_millis(20));
    };

    let drain_timeout = Duration::from_secs(2);
    let stdout = stdout_receiver
        .recv_timeout(drain_timeout)
        .map_err(|_| anyhow!("独立校验器 stdout 管道未在退出后关闭"))??;
    let stderr = stderr_receiver
        .recv_timeout(drain_timeout)
        .map_err(|_| anyhow!("独立校验器 stderr 管道未在退出后关闭"))??;
    if stdout.exceeded_limit || stderr.exceeded_limit {
        bail!(
            "独立校验器输出超过上限（stdout {} 字节，stderr {} 字节）",
            stdout_limit,
            stderr_limit
        );
    }
    Ok(BoundedOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn capture_stream(mut stream: impl Read, limit: usize) -> IoResult<CapturedStream> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut exceeded_limit = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&buffer[..retained]);
        exceeded_limit |= retained < read;
    }
    Ok(CapturedStream {
        bytes,
        exceeded_limit,
    })
}

fn bounded_utf8(bytes: &[u8], characters: usize) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .take(characters)
        .collect()
}

fn bind_verification_report(
    report: &mut Value,
    bag: &Path,
    evidence_id: &str,
    manifest_root_sha256: &str,
    signer_fingerprint: &str,
) -> Result<()> {
    let reported_evidence_id = report.get("evidenceId").and_then(Value::as_str);
    if reported_evidence_id != Some(evidence_id)
        || report.get("manifestRootSha256").and_then(Value::as_str) != Some(manifest_root_sha256)
    {
        bail!("独立校验报告 evidenceId 或 manifestRootSha256 与本次采集不一致");
    }
    let signature = report
        .get("signature")
        .and_then(Value::as_object)
        .context("独立校验报告缺少 signature 对象")?;
    if signature
        .get("mathematicalValidity")
        .and_then(Value::as_bool)
        != Some(true)
        || signature.get("fingerprint").and_then(Value::as_str) != Some(signer_fingerprint)
    {
        bail!("独立校验报告的签名结论或 signerFingerprint 与本次采集不一致");
    }

    let seal_path = bag.join("signatures/seal.json");
    let metadata = fs::symlink_metadata(&seal_path)
        .with_context(|| format!("无法检查已验证的 seal {}", seal_path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 128 * 1024 {
        bail!("已验证的 seal 不是安全的有限大小普通文件");
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    File::open(&seal_path)
        .with_context(|| format!("无法打开已验证的 seal {}", seal_path.display()))?
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 128 * 1024 {
        bail!("已验证的 seal 超过大小上限");
    }
    let seal: Value = serde_json::from_slice(&bytes).context("已验证的 seal 不是有效 JSON")?;
    if seal.get("evidenceId").and_then(Value::as_str) != Some(evidence_id)
        || seal.get("manifestRootSha256").and_then(Value::as_str) != Some(manifest_root_sha256)
        || seal
            .pointer("/signature/signerFingerprint")
            .and_then(Value::as_str)
            != Some(signer_fingerprint)
    {
        bail!("已验证 seal 的 evidenceId、manifestRoot 或 signerFingerprint 与本次采集不一致");
    }

    let object = report
        .as_object_mut()
        .context("独立校验报告根必须为 JSON 对象")?;
    object.insert(
        "signerFingerprint".to_owned(),
        Value::String(signer_fingerprint.to_owned()),
    );
    Ok(())
}

fn validate_trusted_fingerprint(fingerprint: &str) -> Result<()> {
    let Some(hex) = fingerprint.strip_prefix("sha256:") else {
        bail!("可信指纹必须使用 sha256:<64位小写十六进制> 格式");
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("可信指纹必须使用 sha256:<64位小写十六进制> 格式");
    }
    Ok(())
}

fn resolve_verifier(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        if is_safe_executable_file(&path) {
            return Ok(path);
        }
        bail!("指定的独立校验器不是安全的普通文件：{}", path.display());
    }
    let executable = std::env::current_exe()?;
    let sibling = executable
        .parent()
        .ok_or_else(|| anyhow!("无法确定 Field Collector 所在目录"))?
        .join(if cfg!(windows) {
            "waeb-verify.exe"
        } else {
            "waeb-verify"
        });
    if !is_safe_executable_file(&sibling) {
        bail!(
            "未找到同目录安全的独立校验器 {}；请使用 --verifier 明确指定",
            sibling.display()
        );
    }
    Ok(sibling)
}

fn is_safe_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

#[cfg(debug_assertions)]
fn parse_options(options: &Options, arguments: &[String]) -> Result<Matches> {
    options.parse(arguments).map_err(|error| anyhow!(error))
}

#[cfg(debug_assertions)]
fn reject_free_arguments(matches: &Matches) -> Result<()> {
    if matches.free.is_empty() {
        Ok(())
    } else {
        bail!("不支持的位置参数：{}", matches.free.join(" "))
    }
}

#[cfg(debug_assertions)]
fn endpoint_option(matches: &Matches) -> Result<CdpEndpoint> {
    let raw = required_string(matches, "endpoint")?;
    CdpEndpoint::parse(&raw).map_err(Into::into)
}

#[cfg(any(debug_assertions, test))]
fn required_string(matches: &Matches, name: &str) -> Result<String> {
    matches
        .opt_str(name)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("缺少必需参数 --{name}"))
}

#[cfg(debug_assertions)]
fn required_path(matches: &Matches, name: &str) -> Result<PathBuf> {
    required_string(matches, name).map(PathBuf::from)
}

#[cfg(debug_assertions)]
fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_root_help() {
    #[cfg(not(debug_assertions))]
    println!(
        "WAFC Field Collector {}\n\n双击或运行 field-collector.exe 启动中文现场向导。\n\
正式版只提供中文向导；无需填写任何网络参数、目录路径或脚本。",
        env!("CARGO_PKG_VERSION")
    );
    #[cfg(debug_assertions)]
    println!(
        "WAFC Field Collector {}（开发构建）\n\n\
现场流程:\n  gui       启动原 Profile + 只读取证扩展中文向导\n\n\
仅开发测试命令（正式版不可用）:\n  discover  只读发现 Chrome/Edge 安装与运行状态\n  \
launch-dedicated  启动空的非默认采集 Profile 并输出授权 endpoint\n  \
targets   列出显式回环 CDP endpoint 上的 WhatsApp 页面\n  \
  inspect-target  固定只读探测一个页面是否满足已签名任务的能力契约\n  \
  collect   对一个已确认 target 执行任务指定的只读模式并封存证据包\n\n\
生产采集器不包含发送消息、建群、任意 JavaScript 或页面点击能力；综合任务可调用固定的 WhatsApp 历史/媒体读取器。",
        env!("CARGO_PKG_VERSION")
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "wafc-app-verification-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap_or_else(|error| panic!("create temp: {error}"));
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn verifier_is_never_resolved_from_path() {
        let missing = PathBuf::from("definitely-missing-waeb-verify.exe");
        assert!(resolve_verifier(Some(missing)).is_err());
    }

    #[test]
    fn required_option_rejects_empty_value() {
        let mut options = Options::new();
        options.optopt("", "value", "test", "VALUE");
        let parsed = options.parse(["--value", ""]);
        assert!(parsed.is_ok());
        if let Ok(matches) = parsed {
            assert!(required_string(&matches, "value").is_err());
        }
    }

    #[test]
    fn trusted_fingerprint_requires_prefixed_lowercase_sha256() {
        assert!(
            validate_trusted_fingerprint(
                "sha256:17f1694d3f0457248236d70a2346d7eece8862bab742a05d60d0dc1d9dc87591"
            )
            .is_ok()
        );
        assert!(
            validate_trusted_fingerprint(
                "17f1694d3f0457248236d70a2346d7eece8862bab742a05d60d0dc1d9dc87591"
            )
            .is_err()
        );
        assert!(
            validate_trusted_fingerprint(
                "sha256:17F1694D3F0457248236D70A2346D7EECE8862BAB742A05D60D0DC1D9DC87591"
            )
            .is_err()
        );
    }

    #[test]
    fn verification_binding_requires_all_sealed_identities() {
        let temp = TempDir::new();
        let signatures = temp.0.join("signatures");
        fs::create_dir(&signatures).unwrap_or_else(|error| panic!("signatures: {error}"));
        let evidence_id = "018f47e0-7b5b-7abc-8def-0123456789ab";
        let manifest_root = "a".repeat(64);
        let fingerprint = format!("sha256:{}", "b".repeat(64));
        fs::write(
            signatures.join("seal.json"),
            serde_json::to_vec(&json!({
                "evidenceId": evidence_id,
                "manifestRootSha256": manifest_root,
                "signature": {"signerFingerprint": fingerprint},
            }))
            .unwrap_or_else(|error| panic!("serialize seal: {error}")),
        )
        .unwrap_or_else(|error| panic!("write seal: {error}"));
        let mut report = json!({
            "status": "valid_untrusted",
            "evidenceId": evidence_id,
            "manifestRootSha256": manifest_root,
            "signature": {
                "mathematicalValidity": true,
                "trusted": false,
                "fingerprint": fingerprint,
            }
        });

        assert!(
            bind_verification_report(
                &mut report,
                &temp.0,
                evidence_id,
                &manifest_root,
                &fingerprint,
            )
            .is_ok()
        );
        assert_eq!(
            report.get("manifestRootSha256").and_then(Value::as_str),
            Some(manifest_root.as_str())
        );
        assert_eq!(
            report.get("signerFingerprint").and_then(Value::as_str),
            Some(fingerprint.as_str())
        );

        let mut wrong_report = report.clone();
        wrong_report["evidenceId"] = Value::String("wrong-evidence-id".to_owned());
        assert!(
            bind_verification_report(
                &mut wrong_report,
                &temp.0,
                evidence_id,
                &manifest_root,
                &fingerprint,
            )
            .is_err()
        );
        assert!(
            bind_verification_report(
                &mut report,
                &temp.0,
                evidence_id,
                &"c".repeat(64),
                &fingerprint,
            )
            .is_err()
        );
    }

    #[test]
    fn stream_capture_drains_but_flags_excess_output() {
        let captured = capture_stream(std::io::Cursor::new(b"123456"), 4)
            .unwrap_or_else(|error| panic!("capture: {error}"));
        assert_eq!(captured.bytes, b"1234");
        assert!(captured.exceeded_limit);

        let exact = capture_stream(std::io::Cursor::new(b"1234"), 4)
            .unwrap_or_else(|error| panic!("capture exact: {error}"));
        assert_eq!(exact.bytes, b"1234");
        assert!(!exact.exceeded_limit);
    }

    #[test]
    fn handoff_document_is_non_content_summary_with_explicit_scope_limits() {
        let mut record_counts = BTreeMap::new();
        record_counts.insert("accounts".to_owned(), 1);
        record_counts.insert("messages".to_owned(), 42);
        let document = handoff_document(&HandoffData {
            evidence_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            source_id: "00000000-0000-4000-8000-000000000002".to_owned(),
            evidence_bag_directory: "waeb-00000000-0000-4000-8000-000000000001".to_owned(),
            manifest_root_sha256: "a".repeat(64),
            signer_fingerprint: format!("sha256:{}", "b".repeat(64)),
            record_counts,
            unresolved_reference_count: 0,
            completeness_overall: "partial".to_owned(),
            local_snapshot: "partial".to_owned(),
            history_scope: "stable_no_growth".to_owned(),
            media_scope: "complete".to_owned(),
            completeness_reason_codes: vec!["history_stable_no_growth".to_owned()],
            operator_id: "operator_001".to_owned(),
            authorization_reference: "synthetic-authorization".to_owned(),
            authorization_confirmed_at_utc: "2026-08-08T00:00:00.000Z".to_owned(),
            verification_status: "valid_untrusted".to_owned(),
            signature_trusted: false,
        });
        assert_eq!(
            document.get("schemaVersion").and_then(Value::as_str),
            Some(HANDOFF_SCHEMA_VERSION)
        );
        assert_eq!(
            document
                .pointer("/observedScope/accountScope")
                .and_then(Value::as_str),
            Some("unverifiable")
        );
        assert_eq!(
            document
                .pointer("/observedScope/completeness/overall")
                .and_then(Value::as_str),
            Some("partial")
        );
        let serialized = serde_json::to_string(&document)
            .unwrap_or_else(|error| panic!("serialize handoff document: {error}"));
        for forbidden in [
            "@c.us",
            "chatBody",
            "messageBody",
            "targetId",
            "endpoint",
            "accountBinding",
        ] {
            assert!(!serialized.contains(forbidden), "leaked field: {forbidden}");
        }
    }

    #[test]
    fn handoff_file_is_promoted_once_without_overwrite() {
        let temp = TempDir::new();
        let document = json!({"schemaVersion": HANDOFF_SCHEMA_VERSION});
        let written = write_json_atomically(&temp.0, "handoff-synthetic.json", &document)
            .unwrap_or_else(|error| panic!("write handoff: {error}"));
        assert!(written.is_file());
        assert!(!temp.0.join(".handoff-synthetic.json.partial").exists());
        assert!(write_json_atomically(&temp.0, "handoff-synthetic.json", &document).is_err());
        assert_eq!(
            fs::read(&written).unwrap_or_else(|error| panic!("read handoff: {error}")),
            b"{\n  \"schemaVersion\": \"wafc-handoff/1\"\n}\n"
        );
    }
}
