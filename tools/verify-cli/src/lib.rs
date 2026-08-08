mod schema;
mod semantic;
mod strict_json;
mod trusted;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use ed25519_dalek::pkcs8::DecodePublicKey as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256, Sha512};
use unicode_normalization::UnicodeNormalization as _;

const MAX_FILES: usize = 1_000_000;
const MAX_DEPTH: usize = 64;
const MAX_MANIFEST_BYTES: u64 = 128 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
const EXPECTED_BAGIT: &[u8] = b"BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n";

pub type Result<T> = std::result::Result<T, VerifyError>;

#[derive(Debug, Clone, Serialize)]
pub struct VerifyError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for VerifyError {}

pub(crate) fn invalid(code: &'static str, message: impl Into<String>) -> VerifyError {
    VerifyError {
        code,
        message: message.into(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureReport {
    pub mathematical_validity: bool,
    pub trusted: bool,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub status: VerificationStatus,
    pub wa_evidence_bag_version: String,
    pub evidence_id: String,
    pub manifest_root_sha256: String,
    pub payload_files: usize,
    pub payload_bytes: u64,
    pub tag_files: usize,
    pub normalized_records: usize,
    pub datasets: usize,
    pub media_assets: usize,
    pub log_events: usize,
    pub chat_completeness_records: usize,
    pub signature: SignatureReport,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    ValidTrusted,
    ValidUntrusted,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvalidReport {
    pub status: &'static str,
    pub error: VerifyError,
}

impl InvalidReport {
    #[must_use]
    pub fn new(error: VerifyError) -> Self {
        Self {
            status: "invalid",
            error,
        }
    }
}

#[derive(Debug)]
pub(crate) struct FileEntry {
    absolute: PathBuf,
    length: u64,
}

#[derive(Debug)]
pub(crate) struct BagTree {
    files: BTreeMap<String, FileEntry>,
}

impl BagTree {
    fn scan(root: &Path) -> Result<Self> {
        let metadata = fs::symlink_metadata(root).map_err(|error| {
            invalid(
                "bag_not_found",
                format!("cannot inspect {}: {error}", root.display()),
            )
        })?;
        reject_reparse(root, &metadata)?;
        if !metadata.is_dir() {
            return Err(invalid(
                "bag_not_directory",
                format!("bag root is not a directory: {}", root.display()),
            ));
        }

        let mut tree = Self {
            files: BTreeMap::new(),
        };
        let mut collision_keys = HashMap::<String, String>::new();
        let mut components = Vec::new();
        tree.scan_directory(root, &mut components, &mut collision_keys)?;
        Ok(tree)
    }

    fn scan_directory(
        &mut self,
        directory: &Path,
        components: &mut Vec<String>,
        collision_keys: &mut HashMap<String, String>,
    ) -> Result<()> {
        if components.len() > MAX_DEPTH {
            return Err(invalid(
                "tree_too_deep",
                format!("directory nesting exceeds {MAX_DEPTH}"),
            ));
        }
        let entries = fs::read_dir(directory).map_err(|error| {
            invalid(
                "tree_read_error",
                format!("cannot read {}: {error}", directory.display()),
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                invalid(
                    "tree_read_error",
                    format!("cannot read directory entry: {error}"),
                )
            })?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("non_utf8_path", "bag contains a non-UTF-8 path"))?;
            validate_component(&name)?;
            components.push(name);
            let relative = components.join("/");
            validate_relative_path(&relative)?;
            let collision = collision_key(&relative);
            if let Some(existing) = collision_keys.insert(collision, relative.clone()) {
                return Err(invalid(
                    "path_collision",
                    format!(
                        "paths collide under Unicode NFC/case folding: {existing} and {relative}"
                    ),
                ));
            }

            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                invalid(
                    "tree_read_error",
                    format!("cannot inspect {}: {error}", path.display()),
                )
            })?;
            reject_reparse(&path, &metadata)?;
            if metadata.is_dir() {
                self.scan_directory(&path, components, collision_keys)?;
            } else if metadata.is_file() {
                if self.files.len() >= MAX_FILES {
                    return Err(invalid(
                        "too_many_files",
                        format!("bag contains more than {MAX_FILES} files"),
                    ));
                }
                self.files.insert(
                    relative.clone(),
                    FileEntry {
                        absolute: path,
                        length: metadata.len(),
                    },
                );
            } else {
                return Err(invalid(
                    "special_file",
                    format!("bag contains a non-regular file: {relative}"),
                ));
            }
            components.pop();
        }
        Ok(())
    }

    fn file(&self, relative: &str) -> Result<&FileEntry> {
        self.files.get(relative).ok_or_else(|| {
            invalid(
                "missing_file",
                format!("required file is missing: {relative}"),
            )
        })
    }

    pub(crate) fn read_limited(&self, relative: &str, limit: u64) -> Result<Vec<u8>> {
        let entry = self.file(relative)?;
        if entry.length > limit {
            return Err(invalid(
                "file_too_large",
                format!("{relative} exceeds the {limit}-byte limit"),
            ));
        }
        fs::read(&entry.absolute).map_err(|error| {
            invalid(
                "file_read_error",
                format!("cannot read {relative}: {error}"),
            )
        })
    }

    pub(crate) fn sorted_paths_with_prefix(&self, prefix: &str) -> Vec<String> {
        let mut paths: Vec<_> = self
            .files
            .keys()
            .filter(|path| path.starts_with(prefix))
            .cloned()
            .collect();
        sort_utf8(&mut paths);
        paths
    }

    pub(crate) fn file_length(&self, relative: &str) -> Result<u64> {
        Ok(self.file(relative)?.length)
    }

    pub(crate) fn file_path(&self, relative: &str) -> Result<PathBuf> {
        Ok(self.file(relative)?.absolute.clone())
    }
}

#[cfg(windows)]
fn reject_reparse(path: &Path, metadata: &Metadata) -> Result<()> {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid(
            "reparse_point",
            format!("reparse points are forbidden: {}", path.display()),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_reparse(path: &Path, metadata: &Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() {
        return Err(invalid(
            "symlink",
            format!("symbolic links are forbidden: {}", path.display()),
        ));
    }
    Ok(())
}

fn validate_component(component: &str) -> Result<()> {
    if component.is_empty() || component == "." || component == ".." {
        return Err(invalid(
            "unsafe_path",
            format!("unsafe path component: {component:?}"),
        ));
    }
    if component
        .chars()
        .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err(invalid(
            "unsafe_path",
            format!("forbidden character in path component: {component:?}"),
        ));
    }
    if component.ends_with([' ', '.']) {
        return Err(invalid(
            "unsafe_path",
            format!("Windows-ambiguous path component: {component:?}"),
        ));
    }
    let stem = component.split('.').next().unwrap_or_default();
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0');
    if reserved {
        return Err(invalid(
            "unsafe_path",
            format!("reserved Windows device name: {component}"),
        ));
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('\0')
    {
        return Err(invalid(
            "unsafe_path",
            format!("unsafe relative path: {path:?}"),
        ));
    }
    for component in path.split('/') {
        validate_component(component)?;
    }
    Ok(())
}

fn collision_key(path: &str) -> String {
    path.nfc().flat_map(char::to_lowercase).collect()
}

fn sort_utf8(paths: &mut [String]) {
    paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum HashAlgorithm {
    Sha256,
    Sha512,
}

impl HashAlgorithm {
    fn digest_length(self) -> usize {
        match self {
            Self::Sha256 => 64,
            Self::Sha512 => 128,
        }
    }

    pub(crate) fn digest_file(self, path: &Path) -> Result<String> {
        let file = File::open(path).map_err(|error| {
            invalid(
                "file_read_error",
                format!("cannot open {}: {error}", path.display()),
            )
        })?;
        let mut reader = BufReader::new(file);
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        match self {
            Self::Sha256 => {
                let mut hasher = Sha256::new();
                loop {
                    let read = reader.read(&mut buffer).map_err(|error| {
                        invalid(
                            "file_read_error",
                            format!("cannot hash {}: {error}", path.display()),
                        )
                    })?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                }
                Ok(hex::encode(hasher.finalize()))
            }
            Self::Sha512 => {
                let mut hasher = Sha512::new();
                loop {
                    let read = reader.read(&mut buffer).map_err(|error| {
                        invalid(
                            "file_read_error",
                            format!("cannot hash {}: {error}", path.display()),
                        )
                    })?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                }
                Ok(hex::encode(hasher.finalize()))
            }
        }
    }
}

#[derive(Debug)]
struct ManifestEntry {
    digest: String,
    path: String,
}

fn parse_manifest(
    tree: &BagTree,
    manifest_path: &str,
    algorithm: HashAlgorithm,
) -> Result<Vec<ManifestEntry>> {
    let bytes = tree.read_limited(manifest_path, MAX_MANIFEST_BYTES)?;
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(invalid(
            "manifest_bom",
            format!("BOM is forbidden in {manifest_path}"),
        ));
    }
    let text = std::str::from_utf8(&bytes).map_err(|error| {
        invalid(
            "manifest_utf8",
            format!("{manifest_path} is not UTF-8: {error}"),
        )
    })?;
    if text.contains('\r') || !text.ends_with('\n') {
        return Err(invalid(
            "manifest_line_endings",
            format!("{manifest_path} must use LF and end with LF"),
        ));
    }
    let body = &text[..text.len().saturating_sub(1)];
    if body.is_empty() || body.lines().any(str::is_empty) {
        return Err(invalid(
            "manifest_format",
            format!("{manifest_path} contains an empty manifest or blank line"),
        ));
    }

    let mut entries = Vec::new();
    let mut exact_paths = HashSet::new();
    let mut collision_paths = HashMap::<String, String>::new();
    for (index, line) in body.split('\n').enumerate() {
        let (digest, path) = line.split_once("  ").ok_or_else(|| {
            invalid(
                "manifest_format",
                format!("invalid {manifest_path} line {}", index + 1),
            )
        })?;
        if digest.len() != algorithm.digest_length()
            || !digest
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(invalid(
                "manifest_digest",
                format!("invalid digest at {manifest_path}:{}", index + 1),
            ));
        }
        validate_relative_path(path)?;
        if !exact_paths.insert(path.to_owned()) {
            return Err(invalid(
                "duplicate_manifest_path",
                format!("duplicate path in {manifest_path}: {path}"),
            ));
        }
        let collision = collision_key(path);
        if let Some(existing) = collision_paths.insert(collision, path.to_owned()) {
            return Err(invalid(
                "manifest_path_collision",
                format!(
                    "manifest paths collide under Unicode NFC/case folding: {existing} and {path}"
                ),
            ));
        }
        entries.push(ManifestEntry {
            digest: digest.to_owned(),
            path: path.to_owned(),
        });
    }
    if entries
        .windows(2)
        .any(|pair| pair[0].path.as_bytes() >= pair[1].path.as_bytes())
    {
        return Err(invalid(
            "manifest_order",
            format!("{manifest_path} is not strictly UTF-8 byte sorted"),
        ));
    }
    Ok(entries)
}

fn verify_manifest(
    tree: &BagTree,
    manifest_path: &str,
    algorithm: HashAlgorithm,
    expected_paths: &[String],
) -> Result<Vec<ManifestEntry>> {
    let entries = parse_manifest(tree, manifest_path, algorithm)?;
    let paths: Vec<_> = entries.iter().map(|entry| entry.path.clone()).collect();
    if paths != expected_paths {
        return Err(invalid(
            "manifest_coverage",
            format!("{manifest_path} file coverage differs from the bag tree"),
        ));
    }
    for entry in &entries {
        let file = tree.file(&entry.path)?;
        let actual = algorithm.digest_file(&file.absolute)?;
        if actual != entry.digest {
            return Err(invalid(
                "hash_mismatch",
                format!("{manifest_path} digest mismatch for {}", entry.path),
            ));
        }
    }
    Ok(entries)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[derive(Debug)]
struct BagItSummary {
    payload_paths: Vec<String>,
    payload_bytes: u64,
    tag_paths: Vec<String>,
}

fn verify_bagit(tree: &BagTree) -> Result<BagItSummary> {
    let bagit = tree.read_limited("bagit.txt", 1024)?;
    if bagit != EXPECTED_BAGIT {
        return Err(invalid(
            "bagit_header",
            "bagit.txt is not the required BagIt 1.0 UTF-8 header",
        ));
    }

    let payload_paths = tree.sorted_paths_with_prefix("data/");
    if payload_paths.is_empty() {
        return Err(invalid("empty_payload", "data/ contains no payload files"));
    }
    verify_manifest(
        tree,
        "manifest-sha256.txt",
        HashAlgorithm::Sha256,
        &payload_paths,
    )?;
    verify_manifest(
        tree,
        "manifest-sha512.txt",
        HashAlgorithm::Sha512,
        &payload_paths,
    )?;

    let mut expected_tag_paths = expected_tag_manifest_paths();
    sort_utf8(&mut expected_tag_paths);
    verify_exact_tag_tree(tree, &expected_tag_paths)?;
    verify_manifest(
        tree,
        "tagmanifest-sha256.txt",
        HashAlgorithm::Sha256,
        &expected_tag_paths,
    )?;

    verify_required_payload_files(tree)?;
    let payload_bytes = payload_paths.iter().try_fold(0_u64, |sum, path| {
        let length = tree.file(path)?.length;
        sum.checked_add(length)
            .ok_or_else(|| invalid("payload_size_overflow", "payload size exceeds u64"))
    })?;
    verify_bag_info(tree, payload_bytes, payload_paths.len())?;
    Ok(BagItSummary {
        payload_paths,
        payload_bytes,
        tag_paths: expected_tag_paths,
    })
}

fn expected_tag_manifest_paths() -> Vec<String> {
    let mut paths = trusted::core_seal_tag_paths();
    paths.extend([
        "manifest-sha256.txt".to_owned(),
        "manifest-sha512.txt".to_owned(),
        "signatures/seal.ed25519".to_owned(),
        "signatures/seal.json".to_owned(),
    ]);
    paths
}

fn verify_exact_tag_tree(tree: &BagTree, expected_without_tagmanifest: &[String]) -> Result<()> {
    let mut actual: Vec<_> = tree
        .files
        .keys()
        .filter(|path| !path.starts_with("data/") && path.as_str() != "tagmanifest-sha256.txt")
        .cloned()
        .collect();
    sort_utf8(&mut actual);
    if actual != expected_without_tagmanifest {
        return Err(invalid(
            "tag_file_set",
            "bag contains a missing or unexpected v1 tag file",
        ));
    }
    tree.file("tagmanifest-sha256.txt")?;
    Ok(())
}

fn verify_required_payload_files(tree: &BagTree) -> Result<()> {
    const FIXED: &[&str] = &[
        "data/acquisition.json",
        "data/completeness.json",
        "data/completeness/chats.ndjson",
        "data/dataset-inventory.json",
        "data/diagnostics/capabilities.json",
        "data/indexes/media.ndjson",
        "data/logs/acquisition.ndjson",
    ];
    for path in FIXED {
        tree.file(path)?;
    }
    let index =
        strict_json::from_slice(trusted_schema("index.json")?, "trusted schemas/index.json")?;
    let datasets = index
        .get("datasets")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("trusted_contract", "trusted schema index lacks datasets"))?;
    if datasets.len() != 18 {
        return Err(invalid(
            "trusted_contract",
            "trusted v1 contract must contain exactly 18 datasets",
        ));
    }
    let mut names = HashSet::new();
    let mut paths = HashSet::new();
    for dataset in datasets {
        let name = dataset
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("trusted_contract", "dataset lacks name"))?;
        let path = dataset
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("trusted_contract", "dataset lacks path"))?;
        if !names.insert(name) || !paths.insert(path) {
            return Err(invalid(
                "trusted_contract",
                "trusted v1 dataset names and paths must be unique",
            ));
        }
        tree.file(path)?;
    }
    Ok(())
}

fn verify_bag_info(tree: &BagTree, payload_bytes: u64, payload_files: usize) -> Result<()> {
    let bytes = tree.read_limited("bag-info.txt", 1024 * 1024)?;
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(invalid("bag_info_bom", "BOM is forbidden in bag-info.txt"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|error| {
        invalid(
            "bag_info_utf8",
            format!("bag-info.txt is not UTF-8: {error}"),
        )
    })?;
    if text.contains('\r') || !text.ends_with('\n') {
        return Err(invalid(
            "bag_info_line_endings",
            "bag-info.txt must use LF and end with LF",
        ));
    }
    let mut fields = HashMap::new();
    for (index, line) in text[..text.len().saturating_sub(1)].split('\n').enumerate() {
        let (name, value) = line.split_once(": ").ok_or_else(|| {
            invalid(
                "bag_info_format",
                format!("invalid bag-info.txt line {}", index + 1),
            )
        })?;
        if name.is_empty() || fields.insert(name, value).is_some() {
            return Err(invalid(
                "bag_info_duplicate",
                format!("duplicate or empty bag-info field: {name}"),
            ));
        }
    }
    let oxum = fields
        .get("Payload-Oxum")
        .ok_or_else(|| invalid("payload_oxum", "Payload-Oxum is missing"))?;
    let (bytes_text, files_text) = oxum
        .split_once('.')
        .ok_or_else(|| invalid("payload_oxum", "Payload-Oxum must be <bytes>.<files>"))?;
    let declared_bytes = bytes_text
        .parse::<u64>()
        .map_err(|_| invalid("payload_oxum", "invalid Payload-Oxum byte count"))?;
    let declared_files = files_text
        .parse::<usize>()
        .map_err(|_| invalid("payload_oxum", "invalid Payload-Oxum file count"))?;
    if declared_bytes != payload_bytes || declared_files != payload_files {
        return Err(invalid(
            "payload_oxum",
            "Payload-Oxum does not match payload bytes and files",
        ));
    }
    if fields.get("WAEvidenceBag-Version").copied() != Some(trusted::WAEB_VERSION) {
        return Err(invalid(
            "waeb_version",
            "bag-info.txt has an unsupported WA Evidence Bag version",
        ));
    }
    Ok(())
}

pub(crate) fn trusted_schema(relative: &str) -> Result<&'static [u8]> {
    trusted::SCHEMAS
        .iter()
        .find_map(|(path, bytes)| (*path == relative).then_some(*bytes))
        .ok_or_else(|| {
            invalid(
                "trusted_contract",
                format!("trusted schema not registered: {relative}"),
            )
        })
}

fn verify_schemas(tree: &BagTree) -> Result<()> {
    let mut actual: Vec<_> = tree
        .files
        .keys()
        .filter_map(|path| path.strip_prefix("schemas/").map(str::to_owned))
        .collect();
    let mut expected: Vec<_> = trusted::SCHEMAS
        .iter()
        .map(|(path, _)| (*path).to_owned())
        .collect();
    sort_utf8(&mut actual);
    sort_utf8(&mut expected);
    if actual != expected {
        return Err(invalid(
            "schema_file_set",
            "embedded schema file set differs from the trusted v1 contract",
        ));
    }
    for (relative, trusted_bytes) in trusted::SCHEMAS {
        let bag_path = format!("schemas/{relative}");
        let embedded = tree.read_limited(&bag_path, MAX_JSON_BYTES)?;
        if embedded.as_slice() != *trusted_bytes {
            return Err(invalid(
                "schema_mismatch",
                format!("embedded schema differs from trusted bytes: {relative}"),
            ));
        }
        strict_json::from_slice(&embedded, &bag_path)?;
    }
    let index = strict_json::from_slice(trusted_schema("index.json")?, "schemas/index.json")?;
    if index.get("waEvidenceBagVersion").and_then(Value::as_str) != Some(trusted::WAEB_VERSION) {
        return Err(invalid(
            "waeb_version",
            "trusted schema index version is unsupported",
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignerDocument {
    schema_version: String,
    algorithm: String,
    public_key_format: String,
    public_key_spki_base64: String,
    public_key_fingerprint: String,
    key_id: String,
    #[serde(rename = "synthetic")]
    _synthetic: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FileDigest {
    path: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignatureMetadata {
    algorithm: String,
    signer_fingerprint: String,
    signature_path: String,
    signed_bytes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SealDocument {
    schema_version: String,
    wa_evidence_bag_version: String,
    evidence_id: String,
    created_at_utc: String,
    manifest_root_sha256: String,
    payload_manifests: Vec<FileDigest>,
    tag_files: Vec<FileDigest>,
    signature: SignatureMetadata,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestRoot<'a> {
    payload_manifests: &'a [FileDigest],
    tag_files: &'a [FileDigest],
}

#[derive(Debug)]
struct SealSummary {
    evidence_id: String,
    fingerprint: String,
    manifest_root_sha256: String,
}

fn parse_typed_json<T: for<'de> Deserialize<'de>>(
    tree: &BagTree,
    path: &str,
    limit: u64,
) -> Result<(T, Vec<u8>)> {
    let bytes = tree.read_limited(path, limit)?;
    let value = strict_json::from_slice(&bytes, path)?;
    let typed = serde_json::from_value(value).map_err(|error| {
        invalid(
            "json_contract",
            format!("{path} violates the v1 contract: {error}"),
        )
    })?;
    Ok((typed, bytes))
}

fn verify_signer(tree: &BagTree) -> Result<(VerifyingKey, String)> {
    let (signer, _) =
        parse_typed_json::<SignerDocument>(tree, "signatures/signer.json", 64 * 1024)?;
    if signer.schema_version != "1.0.0"
        || signer.algorithm != "Ed25519"
        || signer.public_key_format != "DER-SPKI"
        || signer.key_id.len() < 3
        || signer.key_id.len() > 120
        || !signer
            .key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(invalid(
            "signer_contract",
            "signer.json contains unsupported signer metadata",
        ));
    }
    let spki = base64::engine::general_purpose::STANDARD
        .decode(&signer.public_key_spki_base64)
        .map_err(|error| invalid("signer_public_key", format!("invalid SPKI base64: {error}")))?;
    if base64::engine::general_purpose::STANDARD.encode(&spki) != signer.public_key_spki_base64 {
        return Err(invalid("signer_public_key", "SPKI base64 is not canonical"));
    }
    let fingerprint = format!("sha256:{}", sha256_bytes(&spki));
    if signer.public_key_fingerprint != fingerprint {
        return Err(invalid(
            "signer_fingerprint",
            "signer fingerprint does not match DER-SPKI bytes",
        ));
    }
    let verifying_key = VerifyingKey::from_public_key_der(&spki).map_err(|error| {
        invalid(
            "signer_public_key",
            format!("invalid Ed25519 DER-SPKI: {error}"),
        )
    })?;
    Ok((verifying_key, fingerprint))
}

fn verify_seal(tree: &BagTree) -> Result<SealSummary> {
    let (verifying_key, fingerprint) = verify_signer(tree)?;
    let (seal, seal_bytes) =
        parse_typed_json::<SealDocument>(tree, "signatures/seal.json", 2 * 1024 * 1024)?;
    if seal.schema_version != "1.0.0"
        || seal.wa_evidence_bag_version != trusted::WAEB_VERSION
        || !valid_uuid(&seal.evidence_id)
        || !seal.created_at_utc.ends_with('Z')
        || seal.signature.algorithm != "Ed25519"
        || seal.signature.signature_path != "signatures/seal.ed25519"
        || seal.signature.signed_bytes != "exact-seal-json-utf8"
    {
        return Err(invalid(
            "seal_contract",
            "seal.json contains unsupported v1 metadata",
        ));
    }
    if seal.signature.signer_fingerprint != fingerprint {
        return Err(invalid(
            "seal_signer",
            "seal signer fingerprint differs from signer.json",
        ));
    }
    let signature_bytes = tree.read_limited("signatures/seal.ed25519", 64)?;
    if signature_bytes.len() != 64 {
        return Err(invalid(
            "signature_length",
            "Ed25519 signature must be exactly 64 bytes",
        ));
    }
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| {
        invalid(
            "signature_format",
            format!("invalid Ed25519 signature: {error}"),
        )
    })?;
    verifying_key
        .verify_strict(&seal_bytes, &signature)
        .map_err(|error| {
            invalid(
                "invalid_signature",
                format!("seal signature verification failed: {error}"),
            )
        })?;

    let expected_payload = vec![
        "manifest-sha256.txt".to_owned(),
        "manifest-sha512.txt".to_owned(),
    ];
    verify_seal_entries(
        tree,
        &seal.payload_manifests,
        &expected_payload,
        "payload manifests",
    )?;
    let expected_tags = trusted::core_seal_tag_paths();
    verify_seal_entries(tree, &seal.tag_files, &expected_tags, "core tag files")?;

    let root = ManifestRoot {
        payload_manifests: &seal.payload_manifests,
        tag_files: &seal.tag_files,
    };
    let canonical = serde_jcs::to_vec(&root).map_err(|error| {
        invalid(
            "jcs_error",
            format!("cannot canonicalize seal manifest root: {error}"),
        )
    })?;
    let expected_root = sha256_bytes(&canonical);
    if seal.manifest_root_sha256 != expected_root {
        return Err(invalid("manifest_root", "seal manifestRootSha256 mismatch"));
    }
    Ok(SealSummary {
        evidence_id: seal.evidence_id,
        fingerprint,
        manifest_root_sha256: expected_root,
    })
}

fn verify_seal_entries(
    tree: &BagTree,
    entries: &[FileDigest],
    expected_paths: &[String],
    label: &str,
) -> Result<()> {
    let actual_paths: Vec<_> = entries.iter().map(|entry| entry.path.clone()).collect();
    if actual_paths != expected_paths
        || actual_paths.iter().collect::<HashSet<_>>().len() != actual_paths.len()
    {
        return Err(invalid(
            "seal_coverage",
            format!("seal {label} coverage/order mismatch"),
        ));
    }
    for entry in entries {
        validate_relative_path(&entry.path)?;
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(invalid(
                "seal_digest",
                format!("invalid seal digest for {}", entry.path),
            ));
        }
        let file = tree.file(&entry.path)?;
        let actual = HashAlgorithm::Sha256.digest_file(&file.absolute)?;
        if actual != entry.sha256 {
            return Err(invalid(
                "seal_digest",
                format!("seal digest mismatch for {}", entry.path),
            ));
        }
    }
    Ok(())
}

fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 || [8, 13, 18, 23].iter().any(|index| bytes[*index] != b'-') {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if [8, 13, 18, 23].contains(&index) {
            continue;
        }
        if !byte.is_ascii_digit() && !matches!(byte, b'a'..=b'f') {
            return false;
        }
    }
    matches!(bytes[14], b'1'..=b'8') && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

/// Verify one directory-form WA Evidence Bag v1 using schemas embedded in this binary.
///
/// Trust is deliberately external: fingerprints in `trusted_fingerprints` must already be
/// authenticated through a hand-off record or laboratory trust store.
///
/// # Errors
///
/// Returns a coded [`VerifyError`] when any tree-safety, `BagIt`, digest, embedded-schema,
/// seal, signature, identity, or trust-independent contract check fails.
pub fn verify_directory(
    root: &Path,
    trusted_fingerprints: &[String],
) -> Result<VerificationReport> {
    let tree = BagTree::scan(root)?;
    let bag = verify_bagit(&tree)?;
    verify_schemas(&tree)?;
    let seal = verify_seal(&tree)?;
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("bag_root_name", "bag root has no UTF-8 directory name"))?;
    if root_name != format!("waeb-{}", seal.evidence_id) {
        return Err(invalid(
            "bag_root_name",
            "bag directory name does not match the sealed evidenceId",
        ));
    }
    let semantic = semantic::verify(&tree, &seal.evidence_id)?;
    let trusted = trusted_fingerprints
        .iter()
        .any(|candidate| candidate == &seal.fingerprint);
    Ok(VerificationReport {
        status: if trusted {
            VerificationStatus::ValidTrusted
        } else {
            VerificationStatus::ValidUntrusted
        },
        wa_evidence_bag_version: trusted::WAEB_VERSION.to_owned(),
        evidence_id: seal.evidence_id,
        manifest_root_sha256: seal.manifest_root_sha256,
        payload_files: bag.payload_paths.len(),
        payload_bytes: bag.payload_bytes,
        tag_files: bag.tag_paths.len(),
        normalized_records: semantic.normalized_records,
        datasets: semantic.datasets,
        media_assets: semantic.media_assets,
        log_events: semantic.log_events,
        chat_completeness_records: semantic.chat_completeness_records,
        signature: SignatureReport {
            mathematical_validity: true,
            trusted,
            fingerprint: seal.fingerprint,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{valid_uuid, validate_relative_path};

    #[test]
    fn rejects_unsafe_manifest_paths() {
        for path in [
            "../x",
            "data/../x",
            "/absolute",
            "C:/drive",
            "data\\x",
            "data/CON",
        ] {
            assert!(validate_relative_path(path).is_err(), "accepted {path}");
        }
        assert!(validate_relative_path("data/normalized/messages.ndjson").is_ok());
    }

    #[test]
    fn uuid_contract_is_strict() {
        assert!(valid_uuid("11111111-1111-4111-8111-111111111111"));
        assert!(!valid_uuid("11111111-1111-0111-8111-111111111111"));
        assert!(!valid_uuid("11111111-1111-4111-7111-111111111111"));
        assert!(!valid_uuid("11111111-1111-4111-8111-11111111111G"));
    }
}
