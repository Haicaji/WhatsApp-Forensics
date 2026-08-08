//! Strict, read-only browser discovery and Chrome `DevTools` Protocol transport.
//!
//! The crate deliberately does not scan ports, read browser profiles, obtain
//! cookies, or start/stop a user's browser. A caller may supply an explicitly
//! authorised loopback CDP endpoint or ask for read-only discovery from the
//! operating system's existing listener table. Only loopback ports owned by a
//! same-session installed Chrome/Edge process are considered; ports are never
//! guessed or iterated.

use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
#[cfg(windows)]
use std::{
    process::{Command, Stdio},
    thread,
    time::Instant,
};

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{Mutex, broadcast, mpsc, oneshot, watch},
    time::timeout,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::{Host, Url};

const MAX_HTTP_HEADERS: usize = 64 * 1024;
const MAX_HTTP_BODY: usize = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const EVENT_BUFFER: usize = 256;

/// Errors raised by browser discovery, endpoint probing, and CDP transport.
#[derive(Debug, Error)]
pub enum BrowserCdpError {
    /// An endpoint or target URL violates the network boundary.
    #[error("unsafe or invalid URL: {0}")]
    InvalidUrl(String),
    /// A direct HTTP response was malformed or unexpected.
    #[error("invalid CDP HTTP response: {0}")]
    Http(String),
    /// A network or process I/O operation failed.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// JSON returned by the browser was malformed.
    #[error("invalid CDP JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// The WebSocket connection failed.
    #[error("CDP WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    /// The browser returned a CDP protocol error.
    #[error("CDP protocol error {code}: {message}")]
    Protocol {
        /// CDP error code.
        code: i64,
        /// CDP error message.
        message: String,
    },
    /// A request did not complete within the configured deadline.
    #[error("CDP request timed out")]
    Timeout,
    /// The CDP connection closed before an operation completed.
    #[error("CDP connection closed")]
    ConnectionClosed,
    /// A background CDP task could not be started or joined.
    #[error("CDP channel closed")]
    ChannelClosed,
    /// A successful response omitted an expected field.
    #[error("CDP response omitted {0}")]
    MissingField(&'static str),
    /// No installed executable was found for a requested browser product.
    #[error("requested Chromium browser is not installed")]
    BrowserNotInstalled,
    /// A dedicated acquisition profile path is unsafe or already populated.
    #[error("dedicated profile is unsafe: {0}")]
    UnsafeProfile(String),
    /// A dedicated browser did not publish its authorized endpoint in time.
    #[error("dedicated browser did not publish DevToolsActivePort before timeout")]
    DedicatedLaunchTimeout,
    /// Read-only discovery of already-authorised browser endpoints failed.
    #[error("authorised browser endpoint discovery failed")]
    EndpointDiscovery,
}

/// Chromium browser products supported by the first Field Collector release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserProduct {
    /// Google Chrome.
    Chrome,
    /// Microsoft Edge.
    Edge,
}

impl BrowserProduct {
    fn executable_name(self) -> &'static str {
        match self {
            Self::Chrome => "chrome.exe",
            Self::Edge => "msedge.exe",
        }
    }
}

/// Result of explicitly launching a non-default acquisition profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedicatedBrowserLaunch {
    /// Browser product selected by the operator.
    pub product: BrowserProduct,
    /// Child process ID returned by Windows.
    pub process_id: u32,
    /// Canonical empty profile directory created for this launch.
    pub profile_dir: PathBuf,
    /// Authorized loopback endpoint published by Chromium.
    #[serde(serialize_with = "serialize_endpoint")]
    pub endpoint: CdpEndpoint,
    /// Domain-separated digest of the canonical dedicated profile path.
    pub profile_reference_sha256: String,
}

/// Verified binding between an explicit dedicated profile and its current CDP endpoint.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedicatedProfileBinding {
    /// Canonical dedicated profile directory.
    pub profile_dir: PathBuf,
    /// Domain-separated digest used in acquisition metadata instead of disclosing the path.
    pub profile_reference_sha256: String,
}

fn serialize_endpoint<S>(endpoint: &CdpEndpoint, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(endpoint.as_url().as_str())
}

/// Launches an installed Chrome/Edge executable with a fresh, non-default
/// profile and an ephemeral loopback debugging port.
///
/// The directory must be absent or empty. The browser remains visible for the
/// operator to sign in and is never killed by this function. No default profile
/// is copied or read.
///
/// # Errors
///
/// Returns an error when the browser is not installed, the explicit profile is
/// unsafe/non-empty, process launch fails, or `DevToolsActivePort` is not
/// published within `timeout_duration`.
#[cfg(windows)]
pub fn launch_dedicated_browser(
    product: BrowserProduct,
    profile_dir: &Path,
    timeout_duration: Duration,
) -> Result<DedicatedBrowserLaunch, BrowserCdpError> {
    let executable = installed_paths(product)
        .into_iter()
        .next()
        .ok_or(BrowserCdpError::BrowserNotInstalled)?;
    if profile_dir.exists() {
        let metadata = fs::symlink_metadata(profile_dir)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || fs::read_dir(profile_dir)?.next().is_some()
        {
            return Err(BrowserCdpError::UnsafeProfile(
                "path must be a real empty directory".to_owned(),
            ));
        }
    } else {
        fs::create_dir_all(profile_dir)?;
    }
    let profile_dir = fs::canonicalize(profile_dir)?;
    let metadata = fs::symlink_metadata(&profile_dir)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(BrowserCdpError::UnsafeProfile(
            "canonical path is a Windows reparse point".to_owned(),
        ));
    }

    let user_data_argument = format!("--user-data-dir={}", profile_dir.display());
    let child = Command::new(executable)
        .args([
            user_data_argument.as_str(),
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "https://web.whatsapp.com/",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let process_id = child.id();
    drop(child);

    let active_port = profile_dir.join("DevToolsActivePort");
    let deadline = Instant::now() + timeout_duration;
    while Instant::now() < deadline {
        if let Ok(contents) = fs::read_to_string(&active_port) {
            let mut lines = contents.lines();
            if let Some(port) = lines.next().and_then(|line| line.parse::<u16>().ok()) {
                let endpoint = CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?;
                let binding = verify_dedicated_profile_binding(&profile_dir, &endpoint)?;
                return Ok(DedicatedBrowserLaunch {
                    product,
                    process_id,
                    profile_dir: binding.profile_dir,
                    endpoint,
                    profile_reference_sha256: binding.profile_reference_sha256,
                });
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(BrowserCdpError::DedicatedLaunchTimeout)
}

/// Verifies that `profile_dir` is a real directory whose Chromium
/// `DevToolsActivePort` file is bound to the exact authorised endpoint.
///
/// # Errors
///
/// Returns an error for missing/reparse/symlink paths, malformed active-port
/// metadata, an endpoint mismatch, or a non-UTF-8 canonical path.
pub fn verify_dedicated_profile_binding(
    profile_dir: &Path,
    endpoint: &CdpEndpoint,
) -> Result<DedicatedProfileBinding, BrowserCdpError> {
    let metadata = fs::symlink_metadata(profile_dir)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(BrowserCdpError::UnsafeProfile(
            "path must be a real directory".to_owned(),
        ));
    }
    #[cfg(windows)]
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(BrowserCdpError::UnsafeProfile(
            "path cannot be a Windows reparse point".to_owned(),
        ));
    }
    let profile_dir = fs::canonicalize(profile_dir)?;
    let active_port = profile_dir.join("DevToolsActivePort");
    let active_metadata = fs::symlink_metadata(&active_port)?;
    if !active_metadata.is_file()
        || active_metadata.file_type().is_symlink()
        || active_metadata.len() > 4096
    {
        return Err(BrowserCdpError::UnsafeProfile(
            "DevToolsActivePort must be a small regular file".to_owned(),
        ));
    }
    #[cfg(windows)]
    if active_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(BrowserCdpError::UnsafeProfile(
            "DevToolsActivePort cannot be a Windows reparse point".to_owned(),
        ));
    }
    let contents = fs::read_to_string(&active_port)?;
    let mut lines = contents.lines();
    let port = lines
        .next()
        .and_then(|line| line.parse::<u16>().ok())
        .ok_or_else(|| BrowserCdpError::UnsafeProfile("invalid active CDP port".to_owned()))?;
    let browser_path = lines.next().unwrap_or_default();
    if port != endpoint.port() || !browser_path.starts_with("/devtools/browser/") {
        return Err(BrowserCdpError::UnsafeProfile(
            "active profile does not match the authorised endpoint".to_owned(),
        ));
    }
    let path = profile_dir.to_str().ok_or_else(|| {
        BrowserCdpError::UnsafeProfile("canonical profile path is not UTF-8".to_owned())
    })?;
    #[cfg(windows)]
    let path = path.replace('\\', "/").to_lowercase();
    #[cfg(not(windows))]
    let path = path.replace('\\', "/");
    let mut hasher = Sha256::new();
    hasher.update(b"WAFC-DEDICATED-PROFILE-v1\0");
    hasher.update(path.as_bytes());
    Ok(DedicatedProfileBinding {
        profile_dir,
        profile_reference_sha256: hex::encode(hasher.finalize()),
    })
}

/// Non-Windows builds expose the API but fail explicitly.
#[cfg(not(windows))]
pub fn launch_dedicated_browser(
    _product: BrowserProduct,
    _profile_dir: &std::path::Path,
    _timeout_duration: Duration,
) -> Result<DedicatedBrowserLaunch, BrowserCdpError> {
    Err(BrowserCdpError::BrowserNotInstalled)
}

/// A read-only observation about an installed or running browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservation {
    /// Browser product.
    pub product: BrowserProduct,
    /// Existing executable paths found through install metadata or standard
    /// installation directories. No browser profile paths are inspected.
    pub executable_paths: Vec<PathBuf>,
    /// Whether the browser's executable name was present in the process list.
    pub running: bool,
}

/// A loopback endpoint passively observed as owned by an installed, running
/// Chrome/Edge browser process in the current interactive Windows session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedEndpointObservation {
    /// Browser product whose executable declared the port.
    pub product: BrowserProduct,
    /// Browser-process identifier that owns the loopback listener.
    pub process_id: u32,
    /// Strictly validated loopback HTTP endpoint.
    #[serde(serialize_with = "serialize_endpoint")]
    pub endpoint: CdpEndpoint,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizedEndpointWire {
    product: BrowserProduct,
    process_id: u32,
    port: u16,
    executable_path: String,
}

/// Discovers only existing loopback listeners owned by current-session
/// Chrome/Edge processes and later subject to the strict CDP handshake.
///
/// No candidate port is guessed or scanned. The Windows helper emits only a
/// bounded allowlisted record, and Rust independently validates the executable
/// against installed browser paths and the endpoint URL policy.
///
/// # Errors
///
/// Returns [`BrowserCdpError::EndpointDiscovery`] when the fixed read-only
/// Windows query fails or returns malformed/unbounded data.
#[cfg(windows)]
pub fn discover_authorized_endpoints() -> Result<Vec<AuthorizedEndpointObservation>, BrowserCdpError>
{
    const MAX_DISCOVERY_BYTES: usize = 128 * 1024;
    const SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$currentSession = (Get-Process -Id $PID).SessionId
$rows = @()
$processes = @(Get-Process -Name 'chrome','msedge' -ErrorAction SilentlyContinue | Select-Object -First 32)
foreach ($process in $processes) {
    if ($process.SessionId -ne $currentSession) { continue }
    $executablePath = try { [string]$process.Path } catch { '' }
    if ([string]::IsNullOrWhiteSpace($executablePath) -or $executablePath.Length -gt 1024) { continue }
    $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $process.Id -ErrorAction SilentlyContinue | Where-Object {
        $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1'
    })
    $product = if ($process.ProcessName -ieq 'chrome') { 'chrome' } else { 'edge' }
    foreach ($listener in $listeners) {
        if ($listener.LocalPort -lt 1 -or $listener.LocalPort -gt 65535) { continue }
        $rows += [pscustomobject]@{
            product = $product
            processId = [uint32]$process.Id
            port = [uint16]$listener.LocalPort
            executablePath = $executablePath
        }
    }
}
$json = ConvertTo-Json -InputObject @($rows) -Compress
[Console]::Out.Write($json)
";

    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let powershell =
        Path::new(&system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let output = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .output()
        .map_err(|_| BrowserCdpError::EndpointDiscovery)?;
    if !output.status.success() || output.stdout.len() > MAX_DISCOVERY_BYTES {
        return Err(BrowserCdpError::EndpointDiscovery);
    }
    parse_authorized_endpoint_output(&output.stdout)
}

/// Non-Windows builds have no supported Chromium process-discovery contract.
#[cfg(not(windows))]
pub fn discover_authorized_endpoints() -> Result<Vec<AuthorizedEndpointObservation>, BrowserCdpError>
{
    Ok(Vec::new())
}

fn parse_authorized_endpoint_output(
    bytes: &[u8],
) -> Result<Vec<AuthorizedEndpointObservation>, BrowserCdpError> {
    parse_authorized_endpoint_output_with(bytes, installed_executable_matches)
}

fn parse_authorized_endpoint_output_with<F>(
    bytes: &[u8],
    executable_matches: F,
) -> Result<Vec<AuthorizedEndpointObservation>, BrowserCdpError>
where
    F: Fn(BrowserProduct, &str) -> bool,
{
    let records: Vec<AuthorizedEndpointWire> =
        serde_json::from_slice(bytes).map_err(|_| BrowserCdpError::EndpointDiscovery)?;
    if records.len() > 32 {
        return Err(BrowserCdpError::EndpointDiscovery);
    }
    let mut unique = BTreeSet::new();
    let mut observations = Vec::new();
    for record in records {
        if record.process_id == 0
            || record.executable_path.is_empty()
            || record.executable_path.len() > 1024
            || record.executable_path.chars().any(char::is_control)
            || !executable_matches(record.product, &record.executable_path)
            || !unique.insert((record.product, record.process_id, record.port))
        {
            continue;
        }
        let endpoint = CdpEndpoint::parse(&format!("http://127.0.0.1:{}", record.port))
            .map_err(|_| BrowserCdpError::EndpointDiscovery)?;
        observations.push(AuthorizedEndpointObservation {
            product: record.product,
            process_id: record.process_id,
            endpoint,
        });
    }
    Ok(observations)
}

#[cfg(windows)]
fn installed_executable_matches(product: BrowserProduct, candidate: &str) -> bool {
    let Ok(candidate) = fs::canonicalize(candidate) else {
        return false;
    };
    installed_paths(product).into_iter().any(|path| {
        fs::canonicalize(path).is_ok_and(|installed| {
            installed
                .to_string_lossy()
                .eq_ignore_ascii_case(&candidate.to_string_lossy())
        })
    })
}

#[cfg(not(windows))]
fn installed_executable_matches(_product: BrowserProduct, _candidate: &str) -> bool {
    false
}

/// Discover Chrome and Edge installation paths and running state without
/// reading browser profiles or opening network connections.
#[must_use]
pub fn discover_browsers() -> Vec<BrowserObservation> {
    [BrowserProduct::Chrome, BrowserProduct::Edge]
        .into_iter()
        .map(|product| BrowserObservation {
            product,
            executable_paths: installed_paths(product),
            running: process_is_running(product.executable_name()),
        })
        .filter(|item| item.running || !item.executable_paths.is_empty())
        .collect()
}

/// Returns a bounded Windows version label from the documented
/// `CurrentVersion` registry values. Missing or malformed values are rendered
/// explicitly as `unknown`; the OS family is never substituted as a version.
#[must_use]
#[cfg(windows)]
pub fn operating_system_version() -> String {
    use winreg::{RegKey, enums};

    let key = RegKey::predef(enums::HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        enums::KEY_READ | enums::KEY_WOW64_64KEY,
    );
    let component = |name: &str, max_chars: usize| {
        key.as_ref()
            .ok()
            .and_then(|key| key.get_value::<String, _>(name).ok())
            .and_then(|value| bounded_os_component(&value, max_chars))
            .unwrap_or_else(|| "unknown".to_owned())
    };
    let product = component("ProductName", 48);
    let display = component("DisplayVersion", 20);
    let build = component("CurrentBuildNumber", 20);
    format!("{product}; {display}; build {build}")
}

/// Non-Windows builds cannot read the Windows version registry.
#[must_use]
#[cfg(not(windows))]
pub fn operating_system_version() -> String {
    "unknown".to_owned()
}

fn bounded_os_component(value: &str, max_chars: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

#[cfg(windows)]
fn installed_paths(product: BrowserProduct) -> Vec<PathBuf> {
    use winreg::{RegKey, enums};

    let executable = product.executable_name();
    let app_path = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{executable}");
    let mut paths = BTreeSet::new();
    for root in [
        RegKey::predef(enums::HKEY_CURRENT_USER),
        RegKey::predef(enums::HKEY_LOCAL_MACHINE),
    ] {
        for flags in [
            enums::KEY_READ | enums::KEY_WOW64_64KEY,
            enums::KEY_READ | enums::KEY_WOW64_32KEY,
        ] {
            if let Ok(key) = root.open_subkey_with_flags(&app_path, flags)
                && let Ok(value) = key.get_value::<String, _>("")
            {
                insert_existing_file(&mut paths, PathBuf::from(value.trim_matches('"')));
            }
        }
    }

    let suffixes: &[&str] = match product {
        BrowserProduct::Chrome => &[
            r"Google\Chrome\Application\chrome.exe",
            r"Google\Chrome Beta\Application\chrome.exe",
        ],
        BrowserProduct::Edge => &[r"Microsoft\Edge\Application\msedge.exe"],
    };
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable) {
            for suffix in suffixes {
                insert_existing_file(&mut paths, Path::new(&root).join(suffix));
            }
        }
    }
    paths.into_iter().collect()
}

#[cfg(not(windows))]
fn installed_paths(_product: BrowserProduct) -> Vec<PathBuf> {
    Vec::new()
}

fn insert_existing_file(paths: &mut BTreeSet<PathBuf>, path: PathBuf) {
    if path.is_file() {
        paths.insert(path);
    }
}

#[cfg(windows)]
fn process_is_running(executable_name: &str) -> bool {
    // Invoke the system binary directly (never through a shell). `tasklist` is
    // read-only and avoids unsafe process-memory APIs in this safe-Rust crate.
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let tasklist = Path::new(&system_root).join(r"System32\tasklist.exe");
    let filter = format!("IMAGENAME eq {executable_name}");
    let tasklist_observation = Command::new(tasklist)
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .is_some_and(|stdout| {
            stdout.lines().any(|line| {
                line.trim_start_matches('\u{feff}')
                    .trim_start()
                    .strip_prefix('"')
                    .and_then(|line| line.split('"').next())
                    .is_some_and(|name| name.eq_ignore_ascii_case(executable_name))
            })
        });
    if tasklist_observation {
        return true;
    }

    // Some locked-down Windows environments deny `tasklist` while allowing
    // ordinary same-user process enumeration. Keep a fixed, non-interpolated
    // PowerShell fallback for the two compile-time executable names only.
    let process_stem = match executable_name {
        "chrome.exe" => "chrome",
        "msedge.exe" => "msedge",
        _ => return false,
    };
    let powershell =
        Path::new(&system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let script = format!(
        "if (Get-Process -Name '{process_stem}' -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
    );
    Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(windows))]
fn process_is_running(_executable_name: &str) -> bool {
    false
}

/// An explicitly authorised, loopback-only HTTP CDP endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CdpEndpoint {
    url: Url,
}

impl CdpEndpoint {
    /// Validate an explicit endpoint URL. Only `http://127.0.0.1[:port]` and
    /// `http://[::1][:port]` are accepted. Credentials, query strings,
    /// fragments, and non-root paths are rejected.
    ///
    /// # Errors
    ///
    /// Returns [`BrowserCdpError::InvalidUrl`] when the URL is malformed or
    /// violates the loopback-only endpoint policy.
    pub fn parse(value: &str) -> Result<Self, BrowserCdpError> {
        let url =
            Url::parse(value).map_err(|error| BrowserCdpError::InvalidUrl(error.to_string()))?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
            || !is_permitted_loopback(url.host().as_ref())
        {
            return Err(BrowserCdpError::InvalidUrl(value.to_owned()));
        }
        Ok(Self { url })
    }

    /// Normalized endpoint URL.
    #[must_use]
    pub fn as_url(&self) -> &Url {
        &self.url
    }

    fn port(&self) -> u16 {
        self.url.port_or_known_default().unwrap_or(80)
    }

    fn socket_host(&self) -> &'static str {
        match self.url.host() {
            Some(Host::Ipv4(_)) => "127.0.0.1",
            Some(Host::Ipv6(_)) => "::1",
            _ => unreachable!("validated endpoint has a supported host"),
        }
    }

    fn host_header(&self) -> String {
        match self.url.host() {
            Some(Host::Ipv6(_)) => format!("[::1]:{}", self.port()),
            _ => format!("127.0.0.1:{}", self.port()),
        }
    }

    fn validate_websocket_url(&self, value: &str) -> Result<Url, BrowserCdpError> {
        let url =
            Url::parse(value).map_err(|error| BrowserCdpError::InvalidUrl(error.to_string()))?;
        if url.scheme() != "ws"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !is_permitted_loopback(url.host().as_ref())
            || url.port_or_known_default() != Some(self.port())
            || url.host() != self.url.host()
        {
            return Err(BrowserCdpError::InvalidUrl(value.to_owned()));
        }
        Ok(url)
    }
}

fn is_permitted_loopback(host: Option<&Host<&str>>) -> bool {
    match host {
        Some(Host::Ipv4(address)) => address.octets() == [127, 0, 0, 1],
        Some(Host::Ipv6(address)) => *address == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    }
}

/// Selected fields returned by Chromium's `/json/version` endpoint.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVersion {
    /// Browser product/version string.
    #[serde(rename = "Browser")]
    pub browser: String,
    /// CDP protocol version.
    #[serde(rename = "Protocol-Version")]
    pub protocol_version: String,
    /// Browser-level WebSocket debugger URL.
    #[serde(rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: String,
}

/// A target returned by Chromium's `/json/list` endpoint.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpTarget {
    /// Target identifier.
    pub id: String,
    /// Target type, normally `page` for an eligible `WhatsApp` tab.
    #[serde(rename = "type")]
    pub target_type: String,
    /// Current page URL.
    pub url: String,
    /// Page title, provided only for operator selection/display.
    #[serde(default)]
    pub title: String,
    /// Target WebSocket URL.
    pub web_socket_debugger_url: String,
}

/// Directly query `/json/version` without proxy or redirect support.
///
/// # Errors
///
/// Returns an error when the direct loopback request fails, the response is
/// malformed, or the reported WebSocket URL violates the endpoint boundary.
pub async fn get_version(endpoint: &CdpEndpoint) -> Result<BrowserVersion, BrowserCdpError> {
    let body = direct_http_get(endpoint, "/json/version").await?;
    let version: BrowserVersion = serde_json::from_slice(&body)?;
    endpoint.validate_websocket_url(&version.web_socket_debugger_url)?;
    Ok(version)
}

/// Directly query `/json/list` and retain only `WhatsApp` Web page targets.
///
/// # Errors
///
/// Returns an error when the direct loopback request fails, JSON is malformed,
/// or an otherwise eligible target reports an unsafe WebSocket URL.
pub async fn list_whatsapp_targets(
    endpoint: &CdpEndpoint,
) -> Result<Vec<CdpTarget>, BrowserCdpError> {
    let body = direct_http_get(endpoint, "/json/list").await?;
    let targets: Vec<CdpTarget> = serde_json::from_slice(&body)?;
    targets
        .into_iter()
        .filter(|target| target.target_type == "page" && is_whatsapp_web_url(&target.url))
        .map(|target| {
            endpoint.validate_websocket_url(&target.web_socket_debugger_url)?;
            Ok(target)
        })
        .collect()
}

/// Whether a page URL has exactly the `https://web.whatsapp.com` origin.
#[must_use]
pub fn is_whatsapp_web_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("web.whatsapp.com")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
    })
}

async fn direct_http_get(endpoint: &CdpEndpoint, path: &str) -> Result<Vec<u8>, BrowserCdpError> {
    let mut stream = timeout(
        DEFAULT_REQUEST_TIMEOUT,
        TcpStream::connect((endpoint.socket_host(), endpoint.port())),
    )
    .await
    .map_err(|_| BrowserCdpError::Timeout)??;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        endpoint.host_header()
    );
    timeout(
        DEFAULT_REQUEST_TIMEOUT,
        stream.write_all(request.as_bytes()),
    )
    .await
    .map_err(|_| BrowserCdpError::Timeout)??;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = timeout(DEFAULT_REQUEST_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| BrowserCdpError::Timeout)??;
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read]);
        if response.len() > MAX_HTTP_HEADERS + MAX_HTTP_BODY {
            return Err(BrowserCdpError::Http(
                "response exceeds size limit".to_owned(),
            ));
        }
        if content_length_response_end(&response)?.is_some_and(|end| end == response.len()) {
            break;
        }
    }
    parse_http_response(&response)
}

fn content_length_response_end(response: &[u8]) -> Result<Option<usize>, BrowserCdpError> {
    let Some(header_end) = find_bytes(response, b"\r\n\r\n") else {
        if response.len() > MAX_HTTP_HEADERS {
            return Err(BrowserCdpError::Http(
                "headers exceed size limit".to_owned(),
            ));
        }
        return Ok(None);
    };
    if header_end > MAX_HTTP_HEADERS {
        return Err(BrowserCdpError::Http(
            "headers exceed size limit".to_owned(),
        ));
    }
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| BrowserCdpError::Http("headers are not UTF-8/ASCII".to_owned()))?;
    let mut content_length = None;
    let mut chunked = false;
    for line in headers.split("\r\n").skip(1) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| BrowserCdpError::Http("malformed header".to_owned()))?;
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = value
                .trim()
                .parse::<usize>()
                .map_err(|_| BrowserCdpError::Http("invalid Content-Length".to_owned()))?;
            if content_length.replace(parsed).is_some() {
                return Err(BrowserCdpError::Http("duplicate Content-Length".to_owned()));
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value
                .split(',')
                .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
        }
    }
    if chunked && content_length.is_some() {
        return Err(BrowserCdpError::Http(
            "ambiguous Transfer-Encoding and Content-Length".to_owned(),
        ));
    }
    if chunked {
        return Ok(None);
    }
    let Some(length) = content_length else {
        return Ok(None);
    };
    if length > MAX_HTTP_BODY {
        return Err(BrowserCdpError::Http("body exceeds size limit".to_owned()));
    }
    let end = header_end
        .checked_add(4)
        .and_then(|value| value.checked_add(length))
        .ok_or_else(|| BrowserCdpError::Http("response length overflow".to_owned()))?;
    if response.len() > end {
        return Err(BrowserCdpError::Http(
            "response exceeds Content-Length".to_owned(),
        ));
    }
    Ok(Some(end))
}

fn parse_http_response(response: &[u8]) -> Result<Vec<u8>, BrowserCdpError> {
    let header_end = find_bytes(response, b"\r\n\r\n")
        .ok_or_else(|| BrowserCdpError::Http("missing header terminator".to_owned()))?;
    if header_end > MAX_HTTP_HEADERS {
        return Err(BrowserCdpError::Http(
            "headers exceed size limit".to_owned(),
        ));
    }
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| BrowserCdpError::Http("headers are not UTF-8/ASCII".to_owned()))?;
    let mut lines = headers.split("\r\n");
    let status = lines
        .next()
        .ok_or_else(|| BrowserCdpError::Http("missing status line".to_owned()))?;
    let mut status_parts = status.split_ascii_whitespace();
    let version = status_parts.next().unwrap_or_default();
    let status_code = status_parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| BrowserCdpError::Http("malformed status line".to_owned()))?;
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(BrowserCdpError::Http("unsupported HTTP version".to_owned()));
    }
    if status_code != 200 {
        return Err(BrowserCdpError::Http(format!(
            "status {status_code}; redirects are not followed"
        )));
    }

    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| BrowserCdpError::Http("malformed header".to_owned()))?;
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = value
                .trim()
                .parse::<usize>()
                .map_err(|_| BrowserCdpError::Http("invalid Content-Length".to_owned()))?;
            if content_length.replace(parsed).is_some() {
                return Err(BrowserCdpError::Http("duplicate Content-Length".to_owned()));
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value
                .split(',')
                .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
        }
    }
    let body = &response[header_end + 4..];
    if chunked && content_length.is_some() {
        return Err(BrowserCdpError::Http(
            "ambiguous Transfer-Encoding and Content-Length".to_owned(),
        ));
    }
    let decoded = if chunked {
        decode_chunked(body)?
    } else if let Some(length) = content_length {
        if length != body.len() {
            return Err(BrowserCdpError::Http("Content-Length mismatch".to_owned()));
        }
        body.to_vec()
    } else {
        body.to_vec()
    };
    if decoded.len() > MAX_HTTP_BODY {
        return Err(BrowserCdpError::Http("body exceeds size limit".to_owned()));
    }
    Ok(decoded)
}

fn decode_chunked(mut input: &[u8]) -> Result<Vec<u8>, BrowserCdpError> {
    let mut output = Vec::new();
    loop {
        let line_end = find_bytes(input, b"\r\n")
            .ok_or_else(|| BrowserCdpError::Http("malformed chunk header".to_owned()))?;
        let size_text = std::str::from_utf8(&input[..line_end])
            .map_err(|_| BrowserCdpError::Http("invalid chunk size".to_owned()))?
            .split(';')
            .next()
            .unwrap_or_default()
            .trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| BrowserCdpError::Http("invalid chunk size".to_owned()))?;
        input = &input[line_end + 2..];
        if size == 0 {
            if input == b"\r\n" || input.starts_with(b"\r\n") {
                return Ok(output);
            }
            return Err(BrowserCdpError::Http("malformed final chunk".to_owned()));
        }
        if size > input.len() || input.len() < size + 2 || &input[size..size + 2] != b"\r\n" {
            return Err(BrowserCdpError::Http("truncated chunk".to_owned()));
        }
        if output.len().saturating_add(size) > MAX_HTTP_BODY {
            return Err(BrowserCdpError::Http("body exceeds size limit".to_owned()));
        }
        output.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// An asynchronous CDP event. Flattened target sessions are identified by
/// `session_id`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpEvent {
    /// CDP method name.
    pub method: String,
    /// Event parameters.
    pub params: Value,
    /// Flattened target session identifier, when present.
    pub session_id: Option<String>,
}

type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, BrowserCdpError>>>>>;

/// Minimal multiplexed Chrome `DevTools` Protocol session.
pub struct CdpSession {
    outbound: mpsc::Sender<Message>,
    pending: PendingRequests,
    events: broadcast::Sender<CdpEvent>,
    closed: watch::Receiver<bool>,
    next_id: AtomicU64,
    request_timeout: Duration,
}

impl CdpSession {
    /// Connect to a target or browser WebSocket URL after enforcing the same
    /// loopback host and port boundary as the authorised HTTP endpoint.
    ///
    /// # Errors
    ///
    /// Returns an error when the URL violates the endpoint boundary or the
    /// WebSocket handshake fails.
    pub async fn connect(
        endpoint: &CdpEndpoint,
        websocket_url: &str,
    ) -> Result<Self, BrowserCdpError> {
        let websocket_url = endpoint.validate_websocket_url(websocket_url)?;
        let (socket, _) = connect_async(websocket_url.as_str()).await?;
        let (mut writer, mut reader) = socket.split();
        let (outbound, mut outbound_rx) = mpsc::channel::<Message>(64);
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let (closed_tx, closed) = watch::channel(false);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));

        let writer_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            while let Some(message) = outbound_rx.recv().await {
                if writer.send(message).await.is_err() {
                    break;
                }
            }
            fail_all_pending(&writer_pending).await;
        });

        let reader_pending = Arc::clone(&pending);
        let reader_events = events.clone();
        tokio::spawn(async move {
            while let Some(message) = reader.next().await {
                match message {
                    Ok(Message::Text(text)) => {
                        if let Ok(value) = serde_json::from_str::<Value>(text.as_ref()) {
                            dispatch_cdp_message(value, &reader_pending, &reader_events).await;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            fail_all_pending(&reader_pending).await;
            let _ = closed_tx.send(true);
        });

        Ok(Self {
            outbound,
            pending,
            events,
            closed,
            next_id: AtomicU64::new(1),
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        })
    }

    /// Subscribe to asynchronous CDP events.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    /// Send a raw CDP request and wait for the response with the matching ID.
    ///
    /// # Errors
    ///
    /// Returns a protocol, timeout, or connection error. A timed-out request is
    /// removed from the pending request table.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, BrowserCdpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session_id) = session_id {
            message["sessionId"] = Value::String(session_id.to_owned());
        }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if self
            .outbound
            .send(Message::Text(message.to_string().into()))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err(BrowserCdpError::ChannelClosed);
        }
        match timeout(self.request_timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BrowserCdpError::ConnectionClosed),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(BrowserCdpError::Timeout)
            }
        }
    }

    /// Evaluate JavaScript in a page's Main World through a flattened target
    /// session. The caller controls the expression and result handling.
    ///
    /// # Errors
    ///
    /// Returns any transport or CDP error produced by `Runtime.evaluate`.
    pub async fn runtime_evaluate(
        &self,
        session_id: &str,
        expression: &str,
        await_promise: bool,
        return_by_value: bool,
    ) -> Result<Value, BrowserCdpError> {
        self.request(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": return_by_value,
                "userGesture": false
            }),
            Some(session_id),
        )
        .await
    }

    /// Call a JavaScript function through `Runtime.callFunctionOn`.
    ///
    /// # Errors
    ///
    /// Returns any transport or CDP error produced by
    /// `Runtime.callFunctionOn`.
    pub async fn runtime_call_function_on(
        &self,
        session_id: &str,
        function_declaration: &str,
        object_id: Option<&str>,
        arguments: &[Value],
        await_promise: bool,
        return_by_value: bool,
    ) -> Result<Value, BrowserCdpError> {
        let mut params = json!({
            "functionDeclaration": function_declaration,
            "arguments": arguments,
            "awaitPromise": await_promise,
            "returnByValue": return_by_value,
            "userGesture": false
        });
        if let Some(object_id) = object_id {
            params["objectId"] = Value::String(object_id.to_owned());
        }
        self.request("Runtime.callFunctionOn", params, Some(session_id))
            .await
    }

    /// Attach to a target using CDP's flattened session mode.
    ///
    /// # Errors
    ///
    /// Returns any transport/protocol error, or [`BrowserCdpError::MissingField`]
    /// if Chromium omits the new session identifier.
    pub async fn attach_to_target(&self, target_id: &str) -> Result<String, BrowserCdpError> {
        let response = self
            .request(
                "Target.attachToTarget",
                json!({"targetId": target_id, "flatten": true}),
                None,
            )
            .await?;
        response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or(BrowserCdpError::MissingField("sessionId"))
    }

    /// Detach a previously attached flattened target session.
    ///
    /// # Errors
    ///
    /// Returns any transport or CDP error produced by `Target.detachFromTarget`.
    pub async fn detach_from_target(&self, session_id: &str) -> Result<(), BrowserCdpError> {
        self.request(
            "Target.detachFromTarget",
            json!({"sessionId": session_id}),
            None,
        )
        .await?;
        Ok(())
    }

    /// Request a clean WebSocket close and wait for the reader to observe
    /// transport termination. Pending operations fail closed.
    ///
    /// # Errors
    ///
    /// Returns [`BrowserCdpError::ChannelClosed`] if the writer/reader task has
    /// stopped without publishing closure, or [`BrowserCdpError::Timeout`] if
    /// the peer does not close the transport before the fixed deadline.
    pub async fn close(&self) -> Result<(), BrowserCdpError> {
        self.close_with_timeout(DEFAULT_REQUEST_TIMEOUT).await
    }

    async fn close_with_timeout(&self, close_timeout: Duration) -> Result<(), BrowserCdpError> {
        let mut closed = self.closed.clone();
        if *closed.borrow() {
            return Ok(());
        }
        self.outbound
            .send(Message::Close(None))
            .await
            .map_err(|_| BrowserCdpError::ChannelClosed)?;
        timeout(close_timeout, async move {
            loop {
                closed
                    .changed()
                    .await
                    .map_err(|_| BrowserCdpError::ChannelClosed)?;
                if *closed.borrow() {
                    return Ok(());
                }
            }
        })
        .await
        .map_err(|_| BrowserCdpError::Timeout)?
    }
}

async fn dispatch_cdp_message(
    value: Value,
    pending: &PendingRequests,
    events: &broadcast::Sender<CdpEvent>,
) {
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        if let Some(sender) = pending.lock().await.remove(&id) {
            let response = if let Some(error) = value.get("error") {
                Err(BrowserCdpError::Protocol {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(-1),
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown CDP error")
                        .to_owned(),
                })
            } else {
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(response);
        }
    } else if let Some(method) = value.get("method").and_then(Value::as_str) {
        let event = CdpEvent {
            method: method.to_owned(),
            params: value.get("params").cloned().unwrap_or_else(|| json!({})),
            session_id: value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        };
        let _ = events.send(event);
    }
}

async fn fail_all_pending(pending: &PendingRequests) {
    for (_, sender) in std::mem::take(&mut *pending.lock().await) {
        let _ = sender.send(Err(BrowserCdpError::ConnectionClosed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    fn target(target_type: &str, url: &str) -> CdpTarget {
        CdpTarget {
            id: "target-1".to_owned(),
            target_type: target_type.to_owned(),
            url: url.to_owned(),
            title: "synthetic".to_owned(),
            web_socket_debugger_url: "ws://127.0.0.1:9222/devtools/page/target-1".to_owned(),
        }
    }

    #[test]
    fn endpoint_accepts_only_exact_loopback_http_origins() {
        for accepted in [
            "http://127.0.0.1:9222",
            "http://127.0.0.1:9222/",
            "http://[::1]:9222/",
        ] {
            assert!(CdpEndpoint::parse(accepted).is_ok(), "{accepted}");
        }
        for rejected in [
            "https://127.0.0.1:9222",
            "http://localhost:9222",
            "http://127.0.0.2:9222",
            "http://0.0.0.0:9222",
            "http://user@127.0.0.1:9222",
            "http://127.0.0.1:9222/path",
            "http://127.0.0.1:9222/?x=1",
            "http://127.0.0.1:9222/#fragment",
        ] {
            assert!(CdpEndpoint::parse(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn authorised_endpoint_records_are_bounded_deduplicated_and_executable_bound() {
        let records = serde_json::to_vec(&json!([
            {
                "product": "chrome",
                "processId": 42,
                "port": 9222,
                "executablePath": "C:\\Program Files\\Chrome\\chrome.exe"
            },
            {
                "product": "chrome",
                "processId": 42,
                "port": 9222,
                "executablePath": "C:\\Program Files\\Chrome\\chrome.exe"
            },
            {
                "product": "edge",
                "processId": 99,
                "port": 9333,
                "executablePath": "C:\\untrusted\\msedge.exe"
            }
        ]))
        .unwrap_or_else(|error| panic!("serialize discovery fixture: {error}"));
        let parsed = parse_authorized_endpoint_output_with(&records, |product, path| {
            product == BrowserProduct::Chrome && path == r"C:\Program Files\Chrome\chrome.exe"
        })
        .unwrap_or_else(|error| panic!("parse discovery fixture: {error}"));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].process_id, 42);
        assert_eq!(parsed[0].endpoint.port(), 9222);
    }

    #[test]
    fn authorised_endpoint_parser_fails_closed_on_shape_and_count() {
        let unknown = br#"[{"product":"chrome","processId":42,"port":9222,"executablePath":"x","extra":true}]"#;
        assert!(parse_authorized_endpoint_output_with(unknown, |_, _| true).is_err());

        let too_many = (0..33)
            .map(|index| {
                json!({
                    "product": "chrome",
                    "processId": index + 1,
                    "port": 9000 + index,
                    "executablePath": "x"
                })
            })
            .collect::<Vec<_>>();
        let bytes = serde_json::to_vec(&too_many)
            .unwrap_or_else(|error| panic!("serialize oversized fixture: {error}"));
        assert!(parse_authorized_endpoint_output_with(&bytes, |_, _| true).is_err());
    }

    #[test]
    fn dedicated_profile_binding_requires_matching_active_port()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!("wafc-browser-cdp-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir(&root)?;
        let mut active = fs::File::create(root.join("DevToolsActivePort"))?;
        active.write_all(b"9222\n/devtools/browser/synthetic\n")?;
        active.sync_all()?;

        let matching = CdpEndpoint::parse("http://127.0.0.1:9222")?;
        let binding = verify_dedicated_profile_binding(&root, &matching)?;
        assert_eq!(binding.profile_reference_sha256.len(), 64);
        let different = CdpEndpoint::parse("http://127.0.0.1:9333")?;
        assert!(verify_dedicated_profile_binding(&root, &different).is_err());

        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[test]
    fn websocket_must_remain_on_authorised_loopback_port() {
        let Ok(endpoint) = CdpEndpoint::parse("http://127.0.0.1:9222") else {
            panic!("synthetic endpoint must be valid");
        };
        assert!(
            endpoint
                .validate_websocket_url("ws://127.0.0.1:9222/devtools/browser/id")
                .is_ok()
        );
        assert!(
            endpoint
                .validate_websocket_url("ws://127.0.0.1:9333/devtools/browser/id")
                .is_err()
        );
        assert!(
            endpoint
                .validate_websocket_url("ws://192.0.2.1:9222/devtools/browser/id")
                .is_err()
        );
    }

    #[test]
    fn whatsapp_origin_is_exact() {
        for accepted in [
            "https://web.whatsapp.com/",
            "https://web.whatsapp.com/app/?synthetic=1",
            "https://web.whatsapp.com:443/",
        ] {
            assert!(is_whatsapp_web_url(accepted), "{accepted}");
        }
        for rejected in [
            "http://web.whatsapp.com/",
            "https://web.whatsapp.com:444/",
            "https://web.whatsapp.com.example/",
            "https://example.com/?next=https://web.whatsapp.com",
            "https://user@web.whatsapp.com/",
            "not a URL",
        ] {
            assert!(!is_whatsapp_web_url(rejected), "{rejected}");
        }
    }

    #[test]
    fn target_filter_requires_page_and_whatsapp_origin() {
        let targets = [
            target("page", "https://web.whatsapp.com/"),
            target("service_worker", "https://web.whatsapp.com/"),
            target("page", "https://example.invalid/"),
        ];
        let selected: Vec<_> = targets
            .iter()
            .filter(|item| item.target_type == "page" && is_whatsapp_web_url(&item.url))
            .collect();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].target_type, "page");
    }

    #[test]
    fn os_version_components_are_bounded_and_control_free() {
        assert_eq!(
            bounded_os_component("  Windows 11 Pro  ", 48).as_deref(),
            Some("Windows 11 Pro")
        );
        assert!(bounded_os_component("\r\n", 48).is_none());
        assert!(bounded_os_component("bad\0value", 48).is_none());
        assert_eq!(
            bounded_os_component(&"x".repeat(80), 20)
                .unwrap_or_default()
                .len(),
            20
        );
        let observed = operating_system_version();
        assert!(!observed.is_empty());
        assert!(observed.len() <= 120);
        assert!(!observed.chars().any(char::is_control));
    }

    #[test]
    fn parses_content_length_response() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        assert!(matches!(
            parse_http_response(response),
            Ok(body) if body == b"{}"
        ));
    }

    #[tokio::test]
    async fn content_length_response_does_not_wait_for_connection_close()
    -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while find_bytes(&request, b"\r\n\r\n").is_none() {
                let read = stream.read(&mut buffer).await?;
                if read == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "request closed before headers",
                    ));
                }
                request.extend_from_slice(&buffer[..read]);
            }
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
                )
                .await?;
            tokio::time::sleep(Duration::from_secs(3)).await;
            Ok::<(), std::io::Error>(())
        });
        let endpoint = CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?;
        let body = tokio::time::timeout(
            Duration::from_secs(1),
            direct_http_get(&endpoint, "/json/version"),
        )
        .await??;
        assert_eq!(body, b"{}");
        server.abort();
        Ok(())
    }

    #[test]
    fn parses_chunked_response() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n";
        assert!(matches!(
            parse_http_response(response),
            Ok(body) if body == b"{}"
        ));
    }

    #[test]
    fn rejects_redirects_and_ambiguous_lengths() {
        let redirect =
            b"HTTP/1.1 302 Found\r\nLocation: http://192.0.2.1/\r\nContent-Length: 0\r\n\r\n";
        assert!(parse_http_response(redirect).is_err());
        let duplicate = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}";
        assert!(parse_http_response(duplicate).is_err());
        let smuggled = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n";
        assert!(parse_http_response(smuggled).is_err());
    }

    #[tokio::test]
    async fn matches_out_of_order_responses_and_delivers_events()
    -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let mut socket = accept_async(stream).await?;
            let mut requests = Vec::new();
            for _ in 0..2 {
                let Some(message) = socket.next().await else {
                    return Err::<(), Box<dyn std::error::Error + Send + Sync>>(
                        "client closed before sending two requests".into(),
                    );
                };
                let Message::Text(text) = message? else {
                    return Err("expected text request".into());
                };
                requests.push(serde_json::from_str::<Value>(text.as_ref())?);
            }

            socket
                .send(Message::Text(
                    json!({
                        "method": "Runtime.consoleAPICalled",
                        "params": {"type": "log"},
                        "sessionId": "synthetic-session"
                    })
                    .to_string()
                    .into(),
                ))
                .await?;
            for request in requests.into_iter().rev() {
                socket
                    .send(Message::Text(
                        json!({
                            "id": request["id"],
                            "result": {"echo": request["method"]}
                        })
                        .to_string()
                        .into(),
                    ))
                    .await?;
            }
            socket.close(None).await?;
            Ok(())
        });

        let endpoint = CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?;
        let session = CdpSession::connect(
            &endpoint,
            &format!("ws://127.0.0.1:{port}/devtools/browser/synthetic"),
        )
        .await?;
        let mut events = session.subscribe();
        let (first, second) = tokio::join!(
            session.request("Synthetic.first", json!({}), None),
            session.request("Synthetic.second", json!({}), None)
        );
        assert_eq!(first?["echo"], "Synthetic.first");
        assert_eq!(second?["echo"], "Synthetic.second");

        let event = timeout(Duration::from_secs(1), events.recv()).await??;
        assert_eq!(event.method, "Runtime.consoleAPICalled");
        assert_eq!(event.session_id.as_deref(), Some("synthetic-session"));
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn close_requires_observed_transport_termination()
    -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let _socket = accept_async(stream).await?;
            tokio::time::sleep(Duration::from_millis(150)).await;
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        });
        let endpoint = CdpEndpoint::parse(&format!("http://127.0.0.1:{port}"))?;
        let session = CdpSession::connect(
            &endpoint,
            &format!("ws://127.0.0.1:{port}/devtools/browser/synthetic"),
        )
        .await?;
        assert!(matches!(
            session.close_with_timeout(Duration::from_millis(25)).await,
            Err(BrowserCdpError::Timeout)
        ));
        server.await??;
        Ok(())
    }
}
