//! Read-only discovery and explicit normal launch of existing Chromium profiles.
//!
//! This crate reads only Chromium's bounded `Local State` profile index and
//! filesystem metadata. It never reads cookies, credentials, browser storage,
//! history, or `WhatsApp` data. Launching a selected profile is an explicit
//! operator action and never adds remote-debugging switches.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use browser_cdp::{BrowserObservation, BrowserProduct, discover_browsers};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const MAX_LOCAL_STATE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROFILES: usize = 64;
const MAX_PROFILE_NAME_BYTES: usize = 160;

/// Fail-closed profile discovery and launch errors.
#[derive(Debug, Error)]
pub enum BrowserProfileError {
    /// Required per-user Windows location is unavailable.
    #[error("LOCALAPPDATA is unavailable")]
    LocalAppDataUnavailable,
    /// A filesystem operation failed.
    #[error("browser profile I/O failed: {0}")]
    Io(#[from] std::io::Error),
    /// Chromium's bounded profile index is malformed.
    #[error("browser profile index is malformed")]
    InvalidLocalState,
    /// A discovered profile or executable violates the path boundary.
    #[error("browser profile path is unsafe: {0}")]
    UnsafePath(String),
    /// The selected observation changed after discovery.
    #[error("selected browser profile changed after discovery")]
    ObservationChanged,
}

/// Read-only profile metadata safe to display in the local GUI.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileObservation {
    /// Chrome or Edge.
    pub product: BrowserProduct,
    /// Human-readable profile label from Chromium's profile index.
    pub display_name: String,
    /// Validated relative Chromium profile directory (`Default` or `Profile N`).
    pub directory_name: String,
    /// Installed browser executable selected during discovery.
    pub executable_path: PathBuf,
    /// Canonical user-data root containing `Local State`.
    pub user_data_dir: PathBuf,
    /// Canonical profile directory. This is GUI-local and must not enter logs.
    pub profile_dir: PathBuf,
    /// Domain-separated digest used in evidence metadata instead of the path.
    pub profile_reference_sha256: String,
    /// Whether this browser product had a process in the current session.
    /// This does not claim that this exact profile was already open.
    pub browser_was_running: bool,
}

/// Result of the operator explicitly opening one selected existing profile.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingProfileLaunch {
    /// Product selected by the operator.
    pub product: BrowserProduct,
    /// Process identifier returned by the normal browser launch request.
    pub process_id: u32,
    /// UTC launch-request time.
    pub opened_at_utc: String,
    /// Whether this browser product was already running before the request.
    pub browser_was_running: bool,
    /// Privacy-preserving selected-profile reference.
    pub profile_reference_sha256: String,
}

/// Discovers Chrome/Edge profiles from their ordinary per-user profile index.
///
/// Only installed browser observations returned by `browser-cdp` are used.
/// Missing user-data roots are ignored; an existing malformed or unsafe root
/// fails closed rather than being guessed from directory names.
///
/// # Errors
///
/// Returns an error for unavailable per-user metadata, malformed bounded JSON,
/// unsafe paths, or filesystem failures.
pub fn discover_existing_profiles() -> Result<Vec<BrowserProfileObservation>, BrowserProfileError> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or(BrowserProfileError::LocalAppDataUnavailable)?;
    let mut result = Vec::new();
    for observation in discover_browsers() {
        let Some(executable) = observation.executable_paths.first() else {
            continue;
        };
        let user_data_dir = match observation.product {
            BrowserProduct::Chrome => local_app_data.join(r"Google\Chrome\User Data"),
            BrowserProduct::Edge => local_app_data.join(r"Microsoft\Edge\User Data"),
        };
        if !user_data_dir.exists() {
            continue;
        }
        result.extend(discover_for_root(&observation, executable, &user_data_dir)?);
    }
    result.sort_by(|left, right| {
        left.product
            .cmp(&right.product)
            .then_with(|| left.directory_name.cmp(&right.directory_name))
    });
    Ok(result)
}

/// Opens the selected original profile through the browser's normal launch
/// path and navigates to `WhatsApp` Web.
///
/// No remote-debugging, automation, proxy, extension-installation, or profile-
/// copy switch is supplied. Chromium may route the request to an already
/// running process for the selected profile.
///
/// # Errors
///
/// Returns an error if any observed path changed or became unsafe, or the
/// normal browser process could not be started.
pub fn open_existing_profile(
    profile: &BrowserProfileObservation,
) -> Result<ExistingProfileLaunch, BrowserProfileError> {
    validate_observation(profile)?;
    let child = spawn_normal_profile_page(profile, "https://web.whatsapp.com/")?;
    let process_id = child.id();
    drop(child);
    Ok(ExistingProfileLaunch {
        product: profile.product,
        process_id,
        opened_at_utc: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        browser_was_running: profile.browser_was_running,
        profile_reference_sha256: profile.profile_reference_sha256.clone(),
    })
}

/// Opens the browser's own extension-management page in the same selected
/// original profile.
///
/// The operator remains responsible for enabling developer mode and choosing
/// the Collector's fixed extension directory. This function does not install,
/// enable, update, or pin an extension.
///
/// # Errors
///
/// Returns an error if the profile observation changed or the normal browser
/// process could not be started.
pub fn open_extension_manager(
    profile: &BrowserProfileObservation,
) -> Result<u32, BrowserProfileError> {
    validate_observation(profile)?;
    let page = match profile.product {
        BrowserProduct::Chrome => "chrome://extensions/",
        BrowserProduct::Edge => "edge://extensions/",
    };
    let child = spawn_normal_profile_page(profile, page)?;
    let process_id = child.id();
    drop(child);
    Ok(process_id)
}

fn spawn_normal_profile_page(
    profile: &BrowserProfileObservation,
    page: &str,
) -> Result<std::process::Child, BrowserProfileError> {
    let profile_argument = format!("--profile-directory={}", profile.directory_name);
    Command::new(&profile.executable_path)
        .args([profile_argument.as_str(), page])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(Into::into)
}

fn discover_for_root(
    observation: &BrowserObservation,
    executable: &Path,
    user_data_dir: &Path,
) -> Result<Vec<BrowserProfileObservation>, BrowserProfileError> {
    let executable = canonical_real_file(executable, "browser executable")?;
    let user_data_dir = canonical_real_dir(user_data_dir, "browser user-data root")?;
    let local_state_path = user_data_dir.join("Local State");
    let local_state = read_bounded_file(&local_state_path)?;
    let root: Value =
        serde_json::from_slice(&local_state).map_err(|_| BrowserProfileError::InvalidLocalState)?;
    let info_cache = root
        .get("profile")
        .and_then(|value| value.get("info_cache"))
        .and_then(Value::as_object)
        .ok_or(BrowserProfileError::InvalidLocalState)?;
    if info_cache.len() > MAX_PROFILES {
        return Err(BrowserProfileError::InvalidLocalState);
    }

    let mut profiles = Vec::new();
    for (directory_name, metadata) in info_cache {
        if !valid_profile_directory_name(directory_name) {
            continue;
        }
        let display_name = metadata
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| valid_display_name(value))
            .unwrap_or(directory_name)
            .to_owned();
        let profile_dir = user_data_dir.join(directory_name);
        if !profile_dir.exists() {
            continue;
        }
        let profile_dir = canonical_real_dir(&profile_dir, "profile directory")?;
        let profile_reference_sha256 = profile_reference(&profile_dir)?;
        profiles.push(BrowserProfileObservation {
            product: observation.product,
            display_name,
            directory_name: directory_name.clone(),
            executable_path: executable.clone(),
            user_data_dir: user_data_dir.clone(),
            profile_dir,
            profile_reference_sha256,
            browser_was_running: observation.running,
        });
    }
    Ok(profiles)
}

fn validate_observation(
    observation: &BrowserProfileObservation,
) -> Result<(), BrowserProfileError> {
    if !valid_profile_directory_name(&observation.directory_name)
        || !valid_display_name(&observation.display_name)
    {
        return Err(BrowserProfileError::ObservationChanged);
    }
    let executable = canonical_real_file(&observation.executable_path, "browser executable")?;
    let user_data_dir = canonical_real_dir(&observation.user_data_dir, "browser user-data root")?;
    let profile_dir = canonical_real_dir(&observation.profile_dir, "profile directory")?;
    if executable != observation.executable_path
        || user_data_dir != observation.user_data_dir
        || profile_dir != observation.profile_dir
        || profile_dir.parent() != Some(user_data_dir.as_path())
        || profile_dir.file_name().and_then(|value| value.to_str())
            != Some(observation.directory_name.as_str())
        || profile_reference(&profile_dir)? != observation.profile_reference_sha256
    {
        return Err(BrowserProfileError::ObservationChanged);
    }
    Ok(())
}

fn read_bounded_file(path: &Path) -> Result<Vec<u8>, BrowserProfileError> {
    let path = canonical_real_file(path, "Local State")?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() == 0 || metadata.len() > MAX_LOCAL_STATE_BYTES {
        return Err(BrowserProfileError::InvalidLocalState);
    }
    fs::read(path).map_err(Into::into)
}

fn canonical_real_file(path: &Path, label: &str) -> Result<PathBuf, BrowserProfileError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
        return Err(BrowserProfileError::UnsafePath(label.to_owned()));
    }
    let canonical = fs::canonicalize(path)?;
    let canonical_metadata = fs::symlink_metadata(&canonical)?;
    if !canonical_metadata.is_file()
        || canonical_metadata.file_type().is_symlink()
        || is_reparse(&canonical_metadata)
    {
        return Err(BrowserProfileError::UnsafePath(label.to_owned()));
    }
    Ok(canonical)
}

fn canonical_real_dir(path: &Path, label: &str) -> Result<PathBuf, BrowserProfileError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
        return Err(BrowserProfileError::UnsafePath(label.to_owned()));
    }
    let canonical = fs::canonicalize(path)?;
    let canonical_metadata = fs::symlink_metadata(&canonical)?;
    if !canonical_metadata.is_dir()
        || canonical_metadata.file_type().is_symlink()
        || is_reparse(&canonical_metadata)
    {
        return Err(BrowserProfileError::UnsafePath(label.to_owned()));
    }
    Ok(canonical)
}

fn valid_profile_directory_name(value: &str) -> bool {
    if value == "Default" {
        return true;
    }
    let Some(number) = value.strip_prefix("Profile ") else {
        return false;
    };
    !number.is_empty()
        && number.len() <= 3
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_display_name(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_PROFILE_NAME_BYTES
        && !value.chars().any(char::is_control)
}

fn profile_reference(profile_dir: &Path) -> Result<String, BrowserProfileError> {
    let value = profile_dir
        .to_str()
        .ok_or_else(|| BrowserProfileError::UnsafePath("non-UTF-8 profile path".to_owned()))?
        .replace('\\', "/")
        .to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(b"WAFC-EXISTING-PROFILE-v1\0");
    hasher.update(value.as_bytes());
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("wafc-profile-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap_or_else(|error| panic!("create test root: {error}"));
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TestRoot, BrowserObservation, PathBuf, PathBuf) {
        let root = TestRoot::new();
        let executable = root.0.join("chrome.exe");
        fs::write(&executable, b"synthetic executable")
            .unwrap_or_else(|error| panic!("write executable: {error}"));
        let user_data = root.0.join("User Data");
        fs::create_dir_all(user_data.join("Default"))
            .unwrap_or_else(|error| panic!("create Default: {error}"));
        fs::create_dir_all(user_data.join("Profile 1"))
            .unwrap_or_else(|error| panic!("create Profile 1: {error}"));
        fs::create_dir_all(user_data.join("System Profile"))
            .unwrap_or_else(|error| panic!("create System Profile: {error}"));
        fs::write(
            user_data.join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"现场 A"},"Profile 1":{"name":"现场 B"},"System Profile":{"name":"系统"},"../escape":{"name":"禁止"}}}}"#,
        )
        .unwrap_or_else(|error| panic!("write Local State: {error}"));
        let observation = BrowserObservation {
            product: BrowserProduct::Chrome,
            executable_paths: vec![executable.clone()],
            running: true,
        };
        (root, observation, executable, user_data)
    }

    #[test]
    fn discovers_only_bounded_real_user_profiles() {
        let (_root, observation, executable, user_data) = fixture();
        let profiles = discover_for_root(&observation, &executable, &user_data)
            .unwrap_or_else(|error| panic!("discover fixture: {error}"));
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].directory_name, "Default");
        assert_eq!(profiles[1].directory_name, "Profile 1");
        assert!(
            profiles
                .iter()
                .all(|profile| profile.profile_reference_sha256.len() == 64)
        );
    }

    #[test]
    fn rejects_unbounded_or_malformed_profile_index() {
        let (_root, observation, executable, user_data) = fixture();
        fs::write(user_data.join("Local State"), br#"{"profile":{}}"#)
            .unwrap_or_else(|error| panic!("rewrite Local State: {error}"));
        assert!(discover_for_root(&observation, &executable, &user_data).is_err());
    }

    #[test]
    fn profile_directory_names_never_accept_paths() {
        for accepted in ["Default", "Profile 1", "Profile 999"] {
            assert!(valid_profile_directory_name(accepted));
        }
        for rejected in [
            "Profile 0",
            "Profile 01",
            "Profile 1000",
            "../Default",
            r"Profile 1\\child",
            "Guest Profile",
            "System Profile",
        ] {
            assert!(!valid_profile_directory_name(rejected), "{rejected}");
        }
    }

    #[test]
    fn observation_revalidation_detects_profile_substitution() {
        let (_root, observation, executable, user_data) = fixture();
        let mut profiles = discover_for_root(&observation, &executable, &user_data)
            .unwrap_or_else(|error| panic!("discover fixture: {error}"));
        let mut profile = profiles.remove(0);
        profile.profile_reference_sha256 = "0".repeat(64);
        assert!(matches!(
            validate_observation(&profile),
            Err(BrowserProfileError::ObservationChanged)
        ));
    }
}
