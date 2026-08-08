use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256, Sha512};
use tempfile::TempDir;
use waeb_verify::{VerificationStatus, verify_directory};

const FIXTURE_NAME: &str = "waeb-11111111-1111-4111-8111-111111111111";
const FIXTURE_FINGERPRINT: &str =
    "sha256:17f1694d3f0457248236d70a2346d7eece8862bab742a05d60d0dc1d9dc87591";
const TEST_PRIVATE_SCALAR_BASE64URL: &str = "qHRRl9ypzzCks60WUiWhyWOtxezLAMuJC0KWa6KJmPg";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/wa-evidence-bag/v1/examples/minimal-valid-signed")
        .join(FIXTURE_NAME)
}

fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn copied_fixture() -> Result<(TempDir, PathBuf), Box<dyn std::error::Error>> {
    let temporary = tempfile::tempdir()?;
    let bag = temporary.path().join(FIXTURE_NAME);
    copy_tree(&fixture(), &bag)?;
    Ok((temporary, bag))
}

fn rewrite_tagmanifest_digest(
    bag: &Path,
    relative: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = relative
        .split('/')
        .fold(bag.to_path_buf(), |current, component| {
            current.join(component)
        });
    let bytes = fs::read(path)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    let manifest_path = bag.join("tagmanifest-sha256.txt");
    let text = fs::read_to_string(&manifest_path)?;
    let mut found = false;
    let mut output = String::new();
    for line in text.lines() {
        if line.ends_with(&format!("  {relative}")) {
            writeln!(&mut output, "{digest}  {relative}")?;
            found = true;
        } else {
            output.push_str(line);
            output.push('\n');
        }
    }
    if !found {
        return Err(format!("tagmanifest entry not found: {relative}").into());
    }
    fs::write(manifest_path, output)?;
    Ok(())
}

fn relative_files(root: &Path, current: &Path) -> std::io::Result<Vec<String>> {
    let mut output = Vec::new();
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            output.extend(relative_files(root, &entry.path())?);
        } else if metadata.is_file() {
            output.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(std::io::Error::other)?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    output.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(output)
}

fn file_at(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    Ok(hex::encode(Sha256::digest(fs::read(path)?)))
}

fn rewrite_payload_manifests(bag: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let data_root = bag.join("data");
    let payload = relative_files(&data_root, &data_root)?
        .into_iter()
        .map(|path| format!("data/{path}"))
        .collect::<Vec<_>>();
    let payload_bytes = payload.iter().try_fold(0_u64, |sum, relative| {
        let length = fs::metadata(file_at(bag, relative))?.len();
        sum.checked_add(length)
            .ok_or_else(|| std::io::Error::other("payload size overflow"))
    })?;
    let bag_info_path = bag.join("bag-info.txt");
    let bag_info = fs::read_to_string(&bag_info_path)?;
    let mut rewritten = String::new();
    for line in bag_info.lines() {
        if line.starts_with("Payload-Oxum: ") {
            writeln!(
                &mut rewritten,
                "Payload-Oxum: {payload_bytes}.{}",
                payload.len()
            )?;
        } else {
            writeln!(&mut rewritten, "{line}")?;
        }
    }
    fs::write(bag_info_path, rewritten)?;

    let mut sha256_manifest = String::new();
    let mut sha512_manifest = String::new();
    for relative in &payload {
        let bytes = fs::read(file_at(bag, relative))?;
        writeln!(
            &mut sha256_manifest,
            "{}  {relative}",
            hex::encode(Sha256::digest(&bytes))
        )?;
        writeln!(
            &mut sha512_manifest,
            "{}  {relative}",
            hex::encode(Sha512::digest(&bytes))
        )?;
    }
    fs::write(bag.join("manifest-sha256.txt"), sha256_manifest)?;
    fs::write(bag.join("manifest-sha512.txt"), sha512_manifest)?;
    Ok(())
}

fn resign_semantically_invalid_bag(bag: &Path) -> Result<(), Box<dyn std::error::Error>> {
    rewrite_payload_manifests(bag)?;
    let previous_seal: Value =
        serde_json::from_slice(&fs::read(bag.join("signatures/seal.json"))?)?;
    let tag_paths = previous_seal
        .get("tagFiles")
        .and_then(Value::as_array)
        .ok_or("seal tagFiles missing")?
        .iter()
        .map(|entry| {
            entry
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or("seal tag path missing")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let payload_manifests = ["manifest-sha256.txt", "manifest-sha512.txt"]
        .iter()
        .map(|relative| {
            Ok(json!({
                "path": relative,
                "sha256": sha256_file(&bag.join(relative))?,
            }))
        })
        .collect::<Result<Vec<Value>, std::io::Error>>()?;
    let tag_files = tag_paths
        .iter()
        .map(|relative| {
            Ok(json!({
                "path": relative,
                "sha256": sha256_file(&file_at(bag, relative))?,
            }))
        })
        .collect::<Result<Vec<Value>, std::io::Error>>()?;
    let root = json!({
        "payloadManifests": payload_manifests,
        "tagFiles": tag_files,
    });
    let manifest_root = hex::encode(Sha256::digest(serde_jcs::to_vec(&root)?));
    let seal = json!({
        "createdAtUtc": previous_seal["createdAtUtc"],
        "evidenceId": previous_seal["evidenceId"],
        "manifestRootSha256": manifest_root,
        "payloadManifests": root["payloadManifests"],
        "schemaVersion": previous_seal["schemaVersion"],
        "signature": previous_seal["signature"],
        "tagFiles": root["tagFiles"],
        "waEvidenceBagVersion": previous_seal["waEvidenceBagVersion"],
    });
    let seal_bytes = serde_jcs::to_vec(&seal)?;
    fs::write(bag.join("signatures/seal.json"), &seal_bytes)?;
    let scalar =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(TEST_PRIVATE_SCALAR_BASE64URL)?;
    let scalar: [u8; 32] = scalar
        .try_into()
        .map_err(|_| "bad fixture private scalar")?;
    let signature = SigningKey::from_bytes(&scalar).sign(&seal_bytes);
    fs::write(bag.join("signatures/seal.ed25519"), signature.to_bytes())?;

    let mut tag_paths = relative_files(bag, bag)?;
    tag_paths
        .retain(|relative| !relative.starts_with("data/") && relative != "tagmanifest-sha256.txt");
    let mut tagmanifest = String::new();
    for relative in tag_paths {
        writeln!(
            &mut tagmanifest,
            "{}  {relative}",
            sha256_file(&file_at(bag, &relative))?
        )?;
    }
    fs::write(bag.join("tagmanifest-sha256.txt"), tagmanifest)?;
    Ok(())
}

fn rewrite_ndjson(
    path: &Path,
    mutate: impl FnOnce(&mut Vec<Value>) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut records = fs::read_to_string(path)?
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    mutate(&mut records)?;
    let mut output = Vec::new();
    for record in records {
        output.extend(serde_jcs::to_vec(&record)?);
        output.push(b'\n');
    }
    fs::write(path, output)?;
    Ok(())
}

fn refresh_normalized_content_hash(record: &mut Value) -> Result<(), Box<dyn std::error::Error>> {
    record["contentSha256"] = json!(hex::encode(Sha256::digest(serde_jcs::to_vec(
        &record["data"],
    )?)));
    Ok(())
}

#[test]
fn verifies_reference_fixture_as_untrusted_and_trusted() -> Result<(), Box<dyn std::error::Error>> {
    let untrusted = verify_directory(&fixture(), &[])?;
    assert_eq!(untrusted.status, VerificationStatus::ValidUntrusted);
    assert!(untrusted.signature.mathematical_validity);
    assert!(!untrusted.signature.trusted);
    assert_eq!(
        untrusted.manifest_root_sha256,
        "5d32ea6188e95a8203df277dc3054d71ab086c759144b555f9dd4ae34aae798d"
    );

    let trusted = verify_directory(&fixture(), &[FIXTURE_FINGERPRINT.to_owned()])?;
    assert_eq!(trusted.status, VerificationStatus::ValidTrusted);
    assert!(trusted.signature.trusted);
    assert_eq!(trusted.manifest_root_sha256, untrusted.manifest_root_sha256);
    Ok(())
}

#[test]
fn detects_one_byte_payload_tamper() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let path = bag.join("data/acquisition.json");
    let mut file = OpenOptions::new().append(true).open(path)?;
    file.write_all(b" ")?;
    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("tampered payload passed")?;
    assert_eq!(error.code, "hash_mismatch");
    Ok(())
}

#[test]
fn detects_signature_tamper_even_when_tagmanifest_is_rehashed()
-> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let signature_path = bag.join("signatures/seal.ed25519");
    let mut signature = fs::read(&signature_path)?;
    let first = signature.first_mut().ok_or("empty fixture signature")?;
    *first ^= 0x01;
    fs::write(&signature_path, signature)?;
    rewrite_tagmanifest_digest(&bag, "signatures/seal.ed25519")?;
    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("tampered signature passed")?;
    assert_eq!(error.code, "invalid_signature");
    Ok(())
}

#[test]
fn rejects_resigned_forged_inventory_count() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let inventory_path = bag.join("data/dataset-inventory.json");
    let mut inventory: Value = serde_json::from_slice(&fs::read(&inventory_path)?)?;
    inventory["datasets"][0]["recordCount"] = json!(2);
    fs::write(inventory_path, serde_jcs::to_vec(&inventory)?)?;
    resign_semantically_invalid_bag(&bag)?;

    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("resigned forged count passed semantic verification")?;
    assert_eq!(error.code, "inventory_record_count");
    Ok(())
}

#[test]
fn rejects_resigned_dangling_attachment_asset() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let messages_path = bag.join("data/normalized/messages.ndjson");
    let mut records = fs::read_to_string(&messages_path)?
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    let message = records.get_mut(2).ok_or("fixture lacks media message")?;
    message["data"]["attachmentAssetIds"] = json!(["ast_deadbeefdeadbeef"]);
    message["contentSha256"] = json!(hex::encode(Sha256::digest(serde_jcs::to_vec(
        &message["data"],
    )?)));
    let mut ndjson = Vec::new();
    for record in records {
        ndjson.extend(serde_jcs::to_vec(&record)?);
        ndjson.push(b'\n');
    }
    fs::write(messages_path, ndjson)?;
    resign_semantically_invalid_bag(&bag)?;

    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("resigned dangling attachment passed semantic verification")?;
    assert_eq!(error.code, "dangling_attachment_asset");
    Ok(())
}

#[test]
fn rejects_resigned_broken_log_hash_chain() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let log_path = bag.join("data/logs/acquisition.ndjson");
    let text = fs::read_to_string(&log_path)?;
    fs::write(
        log_path,
        text.replacen("\"supported\":19", "\"supported\":18", 1),
    )?;
    resign_semantically_invalid_bag(&bag)?;

    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("resigned broken log chain passed semantic verification")?;
    assert_eq!(error.code, "log_event_hash");
    Ok(())
}

#[test]
fn rejects_resigned_wrong_normalized_reference_type() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let messages_path = bag.join("data/normalized/messages.ndjson");
    rewrite_ndjson(&messages_path, |records| {
        let message = records.get_mut(1).ok_or("fixture lacks text message")?;
        message["data"]["senderRecordId"] = json!("cht_c4dc679aac2f4df0");
        refresh_normalized_content_hash(message)
    })?;
    resign_semantically_invalid_bag(&bag)?;

    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("resigned wrong reference type passed semantic verification")?;
    assert_eq!(error.code, "reference_type");
    Ok(())
}

#[test]
fn rejects_resigned_nonreciprocal_media_source() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let media_path = bag.join("data/indexes/media.ndjson");
    rewrite_ndjson(&media_path, |records| {
        let media = records.first_mut().ok_or("fixture lacks media index")?;
        media["sourceRecordIds"] = json!(["msg_7f2e8c70c5a9429a"]);
        Ok(())
    })?;
    resign_semantically_invalid_bag(&bag)?;

    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("resigned nonreciprocal media source passed semantic verification")?;
    assert_eq!(error.code, "media_reference_mismatch");
    Ok(())
}

#[test]
fn rejects_resigned_capability_inventory_causality_mismatch()
-> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let capabilities_path = bag.join("data/diagnostics/capabilities.json");
    let mut capabilities: Value = serde_json::from_slice(&fs::read(&capabilities_path)?)?;
    capabilities["capabilities"][0]["result"] = json!("unsupported");
    capabilities["capabilities"][0]["adapter"] = Value::Null;
    capabilities["capabilities"][0]["reasonCodes"] = json!(["synthetic_cross_mismatch"]);
    fs::write(capabilities_path, serde_jcs::to_vec(&capabilities)?)?;
    resign_semantically_invalid_bag(&bag)?;

    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("resigned capability/inventory mismatch passed semantic verification")?;
    assert_eq!(error.code, "capability_inventory_mismatch");
    Ok(())
}

#[test]
fn rejects_resigned_chat_final_count_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let chats_path = bag.join("data/completeness/chats.ndjson");
    rewrite_ndjson(&chats_path, |records| {
        let chat = records
            .first_mut()
            .ok_or("fixture lacks chat completeness")?;
        chat["finalMessageCount"] = json!(4);
        Ok(())
    })?;
    resign_semantically_invalid_bag(&bag)?;

    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("resigned chat count mismatch passed semantic verification")?;
    assert_eq!(error.code, "chat_completeness_count");
    Ok(())
}

#[test]
fn rejects_unsafe_manifest_path_before_opening_it() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let manifest_path = bag.join("manifest-sha256.txt");
    let text = fs::read_to_string(&manifest_path)?;
    let first_newline = text.find('\n').ok_or("fixture manifest has no line")?;
    let first = &text[..first_newline];
    let digest = first.get(..64).ok_or("fixture digest is short")?;
    let changed = format!("{digest}  ../outside\n{}", &text[first_newline + 1..]);
    fs::write(manifest_path, changed)?;
    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("unsafe manifest passed")?;
    assert_eq!(error.code, "unsafe_path");
    Ok(())
}

#[test]
fn rejects_duplicate_manifest_path() -> Result<(), Box<dyn std::error::Error>> {
    let (_temporary, bag) = copied_fixture()?;
    let manifest_path = bag.join("manifest-sha256.txt");
    let text = fs::read_to_string(&manifest_path)?;
    let first_newline = text.find('\n').ok_or("fixture manifest has no line")?;
    let first = &text[..=first_newline];
    fs::write(manifest_path, format!("{first}{first}{text}"))?;
    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("duplicate manifest path passed")?;
    assert_eq!(error.code, "duplicate_manifest_path");
    Ok(())
}

#[cfg(unix)]
#[test]
fn rejects_symlink_anywhere_in_tree() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::symlink;

    let (_temporary, bag) = copied_fixture()?;
    symlink("acquisition.json", bag.join("data/link"))?;
    let error = verify_directory(&bag, &[]).err().ok_or("symlink passed")?;
    assert_eq!(error.code, "symlink");
    Ok(())
}

#[cfg(windows)]
#[test]
fn rejects_reparse_point_when_windows_allows_test_symlink_creation()
-> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::fs::symlink_file;

    let (_temporary, bag) = copied_fixture()?;
    let link = bag.join("data/link");
    if symlink_file("acquisition.json", &link).is_err() {
        return Ok(());
    }
    let error = verify_directory(&bag, &[])
        .err()
        .ok_or("reparse point passed")?;
    assert_eq!(error.code, "reparse_point");
    Ok(())
}
