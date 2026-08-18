//! JSON-first session directory writer.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::protocol::ExtractorFrame;

const CHAT_DATASETS: [&str; 9] = [
    "participants",
    "messages",
    "message_events",
    "reactions",
    "receipts",
    "poll_votes",
    "group_events",
    "media_albums",
    "pins",
];
const GLOBAL_DATASETS: [&str; 10] = [
    "statuses",
    "calls",
    "channels",
    "channel_events",
    "communities",
    "community_relations",
    "presence_snapshots",
    "labels",
    "label_relations",
    "pins",
];

struct ChatWriter {
    chat_id: String,
    directory: PathBuf,
    chat: Value,
    datasets: BTreeMap<String, Vec<Value>>,
    media_index: Vec<Value>,
    history: Option<Value>,
}

struct ActiveMedia {
    file: BufWriter<File>,
    partial_path: PathBuf,
    final_path: PathBuf,
    meta: Map<String, Value>,
    hasher: Sha256,
    byte_length: u64,
}

/// Writes one extraction without any database or archive layer.
pub struct SessionWriter {
    staging_dir: PathBuf,
    final_dir: PathBuf,
    started_at: String,
    capabilities: Option<Value>,
    root_datasets: BTreeMap<String, Vec<Value>>,
    current_chat: Option<ChatWriter>,
    avatar_index: Vec<Value>,
    active_media: Option<ActiveMedia>,
    log: Vec<Value>,
    chat_count: u64,
}

impl SessionWriter {
    /// Create a new `.partial` session below the selected export root.
    pub fn new(output_root: &Path) -> Result<Self> {
        fs::create_dir_all(output_root)
            .with_context(|| format!("cannot create output root {}", output_root.display()))?;
        let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ");
        let id = Uuid::new_v4().simple().to_string();
        let short = id.get(..8).unwrap_or(id.as_str());
        let base_name = format!("{timestamp}_{short}");
        let staging_dir = output_root.join(format!("{base_name}.partial"));
        let final_dir = output_root.join(base_name);
        fs::create_dir_all(staging_dir.join("chats"))?;
        fs::create_dir_all(staging_dir.join("global"))?;
        fs::create_dir_all(staging_dir.join("avatars"))?;
        fs::create_dir_all(staging_dir.join("logs"))?;
        let started_at = Utc::now().to_rfc3339();
        let mut writer = Self {
            staging_dir,
            final_dir,
            started_at,
            capabilities: None,
            root_datasets: BTreeMap::new(),
            current_chat: None,
            avatar_index: Vec::new(),
            active_media: None,
            log: Vec::new(),
            chat_count: 0,
        };
        writer.log("session_started", &json!({}))?;
        Ok(writer)
    }

    /// Consume one validated extractor frame after it is durably handled.
    pub fn handle_frame(&mut self, frame: &ExtractorFrame) -> Result<Option<String>> {
        match frame.kind.as_str() {
            "capabilities" => {
                self.capabilities = Some(frame.payload.clone());
                write_json(&self.staging_dir.join("capabilities.json"), &frame.payload)?;
            }
            "dataset_batch" => self.dataset_batch(&frame.payload)?,
            "chat_begin" => self.chat_begin(&frame.payload)?,
            "chat_end" => self.chat_end(&frame.payload)?,
            "media_start" => self.media_start(&frame.payload)?,
            "media_chunk" => self.media_chunk(&frame.payload)?,
            "media_end" => self.media_end(&frame.payload)?,
            "media_failure" => self.media_failure(&frame.payload)?,
            "progress" => self.log("progress", &frame.payload)?,
            "error" => self.log("extractor_error", &frame.payload)?,
            "complete" => {
                let status = frame.payload["status"]
                    .as_str()
                    .unwrap_or("failed")
                    .to_owned();
                self.log("extractor_complete", &frame.payload)?;
                return Ok(Some(status));
            }
            _ => bail!("unsupported frame kind"),
        }
        Ok(None)
    }

    /// Finalize valid JSON files. Completed sessions lose the `.partial` suffix.
    pub fn finish(mut self, status: &str, summary: &Value) -> Result<PathBuf> {
        if self.active_media.is_some() {
            self.media_end(&json!({"status": "transport_interrupted"}))?;
        }
        if self.current_chat.is_some() {
            self.flush_current_chat()?;
        }
        self.write_root_datasets()?;
        write_json(
            &self.staging_dir.join("avatars/index.json"),
            &self.avatar_index,
        )?;
        write_json(&self.staging_dir.join("logs/extraction.json"), &self.log)?;
        let manifest = json!({
            "schemaVersion": "field-collector-session/1",
            "status": status,
            "startedAt": self.started_at,
            "finishedAt": Utc::now().to_rfc3339(),
            "chatCount": self.chat_count,
            "capabilitiesPath": "capabilities.json",
            "summary": summary.clone(),
            "storage": {
                "format": "UTF-8 JSON and original files",
                "database": false,
                "archive": false
            }
        });
        write_json(&self.staging_dir.join("manifest.json"), &manifest)?;
        if status == "complete" {
            fs::rename(&self.staging_dir, &self.final_dir).with_context(|| {
                format!(
                    "cannot promote {} to {}",
                    self.staging_dir.display(),
                    self.final_dir.display()
                )
            })?;
            Ok(self.final_dir)
        } else {
            Ok(self.staging_dir)
        }
    }

    fn dataset_batch(&mut self, payload: &Value) -> Result<()> {
        let dataset = payload["dataset"]
            .as_str()
            .ok_or_else(|| anyhow!("dataset frame missing dataset"))?;
        let records = payload["records"]
            .as_array()
            .ok_or_else(|| anyhow!("dataset frame records were not an array"))?;
        if payload["chatId"].is_string() {
            let (path, checkpoint) = {
                let chat = self
                    .current_chat
                    .as_mut()
                    .ok_or_else(|| anyhow!("chat dataset arrived outside chat"))?;
                let incoming_chat = payload["chatId"].as_str().unwrap_or_default();
                anyhow::ensure!(incoming_chat == chat.chat_id, "chat dataset id mismatch");
                let target = chat.datasets.entry(dataset.to_owned()).or_default();
                target.extend(records.iter().cloned());
                (
                    chat.directory
                        .join(format!("{}.json", dataset.replace('_', "-"))),
                    target.clone(),
                )
            };
            write_partial_json(&path, &checkpoint)?;
        } else {
            self.root_datasets
                .entry(dataset.to_owned())
                .or_default()
                .extend(records.iter().cloned());
            let checkpoint = self.root_datasets.get(dataset).cloned().unwrap_or_default();
            if let Some(path) = self.root_dataset_path(dataset) {
                if dataset == "accounts" {
                    write_partial_json(&path, &checkpoint.first().cloned().unwrap_or(Value::Null))?;
                } else {
                    write_partial_json(&path, &checkpoint)?;
                }
            }
        }
        Ok(())
    }

    fn chat_begin(&mut self, payload: &Value) -> Result<()> {
        anyhow::ensure!(self.current_chat.is_none(), "nested chat frame");
        let chat_id = payload["chatId"]
            .as_str()
            .ok_or_else(|| anyhow!("chat begin missing id"))?
            .to_owned();
        let index = payload["index"].as_u64().unwrap_or(self.chat_count + 1);
        let directory_name = format!("{index:04}_{}", sanitize_component(&chat_id));
        let directory = self.staging_dir.join("chats").join(directory_name);
        fs::create_dir_all(directory.join("media/original"))?;
        fs::create_dir_all(directory.join("media/preview"))?;
        write_partial_json(
            &directory.join("chat.json"),
            &payload.get("chat").cloned().unwrap_or(Value::Null),
        )?;
        self.current_chat = Some(ChatWriter {
            chat_id,
            directory,
            chat: payload.get("chat").cloned().unwrap_or(Value::Null),
            datasets: BTreeMap::new(),
            media_index: Vec::new(),
            history: None,
        });
        self.chat_count += 1;
        Ok(())
    }

    fn chat_end(&mut self, payload: &Value) -> Result<()> {
        let chat = self
            .current_chat
            .as_mut()
            .ok_or_else(|| anyhow!("chat end arrived outside chat"))?;
        anyhow::ensure!(
            payload["chatId"].as_str() == Some(chat.chat_id.as_str()),
            "chat end id mismatch"
        );
        chat.history = payload.get("history").cloned();
        self.flush_current_chat()
    }

    fn flush_current_chat(&mut self) -> Result<()> {
        let Some(chat) = self.current_chat.take() else {
            return Ok(());
        };
        write_json(&chat.directory.join("chat.json"), &chat.chat)?;
        for dataset in CHAT_DATASETS {
            let records = chat.datasets.get(dataset).cloned().unwrap_or_default();
            write_json(
                &chat
                    .directory
                    .join(format!("{}.json", dataset.replace('_', "-"))),
                &records,
            )?;
        }
        write_json(&chat.directory.join("media/index.json"), &chat.media_index)?;
        write_json(
            &chat.directory.join("history.json"),
            &chat
                .history
                .unwrap_or_else(|| json!({"complete": false, "reason": "missing_chat_end"})),
        )?;
        Ok(())
    }

    fn media_start(&mut self, payload: &Value) -> Result<()> {
        anyhow::ensure!(self.active_media.is_none(), "nested media stream");
        let meta = payload
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("media metadata was not an object"))?;
        let role = payload["role"].as_str().unwrap_or("original");
        let scope = payload["scope"].as_str().unwrap_or("chat");
        let original_name = payload["originalFileName"].as_str().unwrap_or("file.bin");
        let file_name = sanitize_component(original_name);
        let directory = if scope == "avatar" {
            self.staging_dir.join("avatars")
        } else {
            let chat = self
                .current_chat
                .as_ref()
                .ok_or_else(|| anyhow!("chat media arrived outside chat"))?;
            chat.directory.join("media").join(if role == "preview" {
                "preview"
            } else {
                "original"
            })
        };
        fs::create_dir_all(&directory)?;
        let final_path = unique_media_path(&directory, &file_name);
        let partial_path = media_partial_path(&final_path);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial_path)?;
        self.active_media = Some(ActiveMedia {
            file: BufWriter::new(file),
            partial_path,
            final_path,
            meta,
            hasher: Sha256::new(),
            byte_length: 0,
        });
        Ok(())
    }

    fn media_chunk(&mut self, payload: &Value) -> Result<()> {
        let encoded = payload["dataBase64"]
            .as_str()
            .ok_or_else(|| anyhow!("media chunk missing base64"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .context("media chunk base64 was invalid")?;
        anyhow::ensure!(bytes.len() <= 128 * 1024, "media chunk exceeded limit");
        let active = self
            .active_media
            .as_mut()
            .ok_or_else(|| anyhow!("media chunk arrived without start"))?;
        active.file.write_all(&bytes)?;
        active.file.flush()?;
        active.file.get_ref().sync_data()?;
        active.hasher.update(&bytes);
        active.byte_length = active
            .byte_length
            .checked_add(u64::try_from(bytes.len())?)
            .ok_or_else(|| anyhow!("media byte count overflow"))?;
        Ok(())
    }

    fn media_end(&mut self, payload: &Value) -> Result<()> {
        let mut active = self
            .active_media
            .take()
            .ok_or_else(|| anyhow!("media end arrived without start"))?;
        active.file.flush()?;
        active.file.get_ref().sync_data()?;
        drop(active.file);
        let status = payload["status"].as_str().unwrap_or("available");
        let relative_path = if active.byte_length == 0 {
            fs::remove_file(&active.partial_path)?;
            None
        } else if status == "available" {
            fs::rename(&active.partial_path, &active.final_path)?;
            Some(package_path(&self.staging_dir, &active.final_path)?)
        } else {
            Some(package_path(&self.staging_dir, &active.partial_path)?)
        };
        active
            .meta
            .insert("relativePath".to_owned(), json!(relative_path));
        active
            .meta
            .insert("byteLength".to_owned(), json!(active.byte_length));
        let sha256 = (active.byte_length > 0).then(|| hex::encode(active.hasher.finalize()));
        active.meta.insert("sha256".to_owned(), json!(sha256));
        let recorded_status = if active.byte_length == 0 && status != "cancelled" {
            "unavailable"
        } else {
            status
        };
        active
            .meta
            .insert("status".to_owned(), json!(recorded_status));
        if let Some(reason) = payload["reason"].as_str() {
            active
                .meta
                .insert("failureReason".to_owned(), json!(reason));
        } else if active.byte_length == 0 && status != "cancelled" {
            active
                .meta
                .insert("failureReason".to_owned(), json!("empty_media"));
        }
        let record = Value::Object(active.meta);
        if record["scope"] == "avatar" {
            self.avatar_index.push(record);
            write_partial_json(
                &self.staging_dir.join("avatars/index.json"),
                &self.avatar_index,
            )?;
        } else {
            let chat = self
                .current_chat
                .as_mut()
                .ok_or_else(|| anyhow!("chat media ended outside chat"))?;
            chat.media_index.push(record);
            write_partial_json(&chat.directory.join("media/index.json"), &chat.media_index)?;
        }
        Ok(())
    }

    fn media_failure(&mut self, payload: &Value) -> Result<()> {
        let mut record = payload.clone();
        if let Some(object) = record.as_object_mut() {
            object.insert("status".to_owned(), json!("unavailable"));
            object.insert("relativePath".to_owned(), Value::Null);
        }
        if payload["scope"] == "avatar" {
            self.avatar_index.push(record);
            write_partial_json(
                &self.staging_dir.join("avatars/index.json"),
                &self.avatar_index,
            )?;
        } else if let Some(chat) = self.current_chat.as_mut() {
            chat.media_index.push(record);
            write_partial_json(&chat.directory.join("media/index.json"), &chat.media_index)?;
        } else {
            self.log("media_failure", &record)?;
        }
        Ok(())
    }

    fn write_root_datasets(&self) -> Result<()> {
        let accounts = self
            .root_datasets
            .get("accounts")
            .cloned()
            .unwrap_or_default();
        write_json(
            &self.staging_dir.join("account.json"),
            &accounts.first().cloned().unwrap_or(Value::Null),
        )?;
        write_json(
            &self.staging_dir.join("contacts.json"),
            &self
                .root_datasets
                .get("contacts")
                .cloned()
                .unwrap_or_default(),
        )?;
        write_json(
            &self.staging_dir.join("chat-lists.json"),
            &self
                .root_datasets
                .get("chat_lists")
                .cloned()
                .unwrap_or_default(),
        )?;
        for dataset in GLOBAL_DATASETS {
            write_json(
                &self
                    .staging_dir
                    .join("global")
                    .join(format!("{}.json", dataset.replace('_', "-"))),
                &self.root_datasets.get(dataset).cloned().unwrap_or_default(),
            )?;
        }
        Ok(())
    }

    fn log(&mut self, event: &str, detail: &Value) -> Result<()> {
        self.log.push(json!({
            "at": Utc::now().to_rfc3339(),
            "event": event,
            "detail": detail.clone()
        }));
        write_partial_json(&self.staging_dir.join("logs/extraction.json"), &self.log)
    }

    fn root_dataset_path(&self, dataset: &str) -> Option<PathBuf> {
        match dataset {
            "accounts" => Some(self.staging_dir.join("account.json")),
            "contacts" => Some(self.staging_dir.join("contacts.json")),
            "chat_lists" => Some(self.staging_dir.join("chat-lists.json")),
            dataset if GLOBAL_DATASETS.contains(&dataset) => Some(
                self.staging_dir
                    .join("global")
                    .join(format!("{}.json", dataset.replace('_', "-"))),
            ),
            _ => None,
        }
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("JSON path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map_or_else(|| "partial".to_owned(), |value| format!("{value}.partial"));
    let temp = path.with_extension(temporary_extension);
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    fs::rename(&temp, path)?;
    Ok(())
}

fn write_partial_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("JSON path has no parent"))?;
    fs::create_dir_all(parent)?;
    let partial_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map_or_else(|| "partial".to_owned(), |value| format!("{value}.partial"));
    let partial = path.with_extension(partial_extension);
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&partial)?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    writer.get_ref().sync_data()?;
    Ok(())
}

fn sanitize_component(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    let limited = cleaned.chars().take(140).collect::<String>();
    if limited.is_empty() {
        "unnamed".to_owned()
    } else {
        limited
    }
}

fn media_partial_path(path: &Path) -> PathBuf {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map_or_else(|| "partial".to_owned(), |value| format!("{value}.partial"));
    path.with_extension(extension)
}

fn unique_media_path(directory: &Path, file_name: &str) -> PathBuf {
    for suffix in 1_u64..10_000 {
        let candidate = if suffix == 1 {
            directory.join(file_name)
        } else {
            let path = Path::new(file_name);
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("file");
            let extension = path.extension().and_then(|value| value.to_str());
            let name = extension.map_or_else(
                || format!("{stem}_{suffix}"),
                |extension| format!("{stem}_{suffix}.{extension}"),
            );
            directory.join(name)
        };
        if !candidate.exists() && !media_partial_path(&candidate).exists() {
            return candidate;
        }
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    directory.join(format!("{}_{}", stem, Uuid::new_v4().simple()))
}

fn package_path(root: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(root)
        .context("media path escaped session root")?
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use uuid::Uuid;

    use super::{SessionWriter, sanitize_component};
    use crate::protocol::{EXTRACTOR_PROTOCOL, ExtractorFrame};

    fn frame(sequence: u64, kind: &str, payload: serde_json::Value) -> ExtractorFrame {
        ExtractorFrame {
            protocol: EXTRACTOR_PROTOCOL.to_owned(),
            sequence: sequence.to_string(),
            kind: kind.to_owned(),
            payload,
        }
    }

    #[test]
    fn sanitizes_windows_path_characters() {
        assert_eq!(sanitize_component("a:b/c?.txt"), "a_b_c_.txt");
    }

    #[test]
    fn writes_valid_json_session_without_database() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("field-collector-test-{}", Uuid::new_v4()));
        let mut writer = SessionWriter::new(&root)?;
        writer.handle_frame(&frame(0, "capabilities", json!({"datasets": {}})))?;
        writer.handle_frame(&frame(
            1,
            "dataset_batch",
            json!({
                "dataset": "accounts", "chatId": null, "records": [{"id": "me"}], "final": true
            }),
        ))?;
        writer.handle_frame(&frame(
            2,
            "chat_begin",
            json!({
                "index": 1, "chatId": "a:b@g.us", "chat": {"id": "a:b@g.us", "title": "Test"}
            }),
        ))?;
        writer.handle_frame(&frame(3, "dataset_batch", json!({
            "dataset": "messages", "chatId": "a:b@g.us", "records": [{"id": "m1", "text": "hello"}], "final": true
        })))?;
        writer.handle_frame(&frame(
            4,
            "media_start",
            json!({
                "scope": "chat", "chatId": "a:b@g.us", "messageId": "m1",
                "role": "original", "isOriginal": true, "mimeType": "image/jpeg",
                "originalFileName": "../same:name.jpg"
            }),
        ))?;
        writer.handle_frame(&frame(5, "media_chunk", json!({"dataBase64": "aGVsbG8="})))?;
        writer.handle_frame(&frame(6, "media_end", json!({"status": "available"})))?;
        writer.handle_frame(&frame(
            7,
            "media_start",
            json!({
                "scope": "chat", "chatId": "a:b@g.us", "messageId": "m2",
                "role": "original", "isOriginal": true, "mimeType": "image/jpeg",
                "originalFileName": "../same:name.jpg"
            }),
        ))?;
        writer.handle_frame(&frame(8, "media_chunk", json!({"dataBase64": "d29ybGQ="})))?;
        writer.handle_frame(&frame(9, "media_end", json!({"status": "available"})))?;
        writer.handle_frame(&frame(
            10,
            "chat_end",
            json!({
            "chatId": "a:b@g.us", "history": {"complete": true}
            }),
        ))?;
        let path = writer.finish("complete", &json!({"chats": 1}))?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("manifest.json"))?)?;
        assert_eq!(manifest["storage"]["database"], false);
        let messages = fs::read_to_string(path.join("chats/0001_a_b@g.us/messages.json"))?;
        assert!(serde_json::from_str::<serde_json::Value>(&messages).is_ok());
        let media: serde_json::Value = serde_json::from_slice(&fs::read(
            path.join("chats/0001_a_b@g.us/media/index.json"),
        )?)?;
        let media = media
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("media index must be an array"))?;
        assert_eq!(media.len(), 2);
        assert_ne!(media[0]["relativePath"], media[1]["relativePath"]);
        assert_eq!(
            media[0]["sha256"],
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        for item in media {
            let relative = item["relativePath"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("media path missing"))?;
            assert!(!relative.split('/').any(|component| component == ".."));
            assert!(path.join(relative).is_file());
        }
        crate::viewer::ViewerState::default().load(&path)?;
        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[test]
    fn cancelled_session_keeps_valid_partial_results() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("field-collector-cancel-test-{}", Uuid::new_v4()));
        let mut writer = SessionWriter::new(&root)?;
        writer.handle_frame(&frame(
            0,
            "capabilities",
            json!({"datasets": {"messages": {"status": "supported"}}}),
        ))?;
        writer.handle_frame(&frame(
            1,
            "media_start",
            json!({
                "scope": "avatar", "contactId": "timeout@c.us", "role": "avatar",
                "isOriginal": true, "mimeType": "image/jpeg",
                "originalFileName": "avatar_timeout@c.us.jpg"
            }),
        ))?;
        writer.handle_frame(&frame(
            2,
            "media_end",
            json!({"status": "failed", "reason": "media_idle_timeout"}),
        ))?;
        let path = writer.finish("cancelled", &json!({"status": "cancelled"}))?;
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("partial")
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("manifest.json"))?)?;
        assert_eq!(manifest["status"], "cancelled");
        assert!(path.join("contacts.json").is_file());
        let avatars: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("avatars/index.json"))?)?;
        assert_eq!(avatars[0]["status"], "unavailable");
        assert_eq!(avatars[0]["relativePath"], serde_json::Value::Null);
        assert!(
            !path
                .join("avatars/avatar_timeout@c.us.jpg.partial")
                .exists()
        );
        crate::viewer::ViewerState::default().load(&path)?;
        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[test]
    fn protocol_fixture_generates_a_viewable_session() -> anyhow::Result<()> {
        let root =
            std::env::temp_dir().join(format!("field-collector-fixture-test-{}", Uuid::new_v4()));
        let frames: Vec<ExtractorFrame> =
            serde_json::from_str(include_str!("../../tests/fixtures/protocol-frames.json"))?;
        let mut writer = SessionWriter::new(&root)?;
        let mut terminal = None;
        for (index, frame) in frames.iter().enumerate() {
            frame.validate(u64::try_from(index)?)?;
            if let Some(status) = writer.handle_frame(frame)? {
                terminal = Some((status, frame.payload.clone()));
            }
            if frame.kind == "dataset_batch" {
                let checkpoint = writer
                    .staging_dir
                    .join("chats/0001_alice@c.us/messages.json.partial");
                let value: serde_json::Value = serde_json::from_slice(&fs::read(checkpoint)?)?;
                assert_eq!(value.as_array().map(Vec::len), Some(1));
            }
        }
        let (status, summary) =
            terminal.ok_or_else(|| anyhow::anyhow!("fixture had no terminal frame"))?;
        let path = writer.finish(&status, &summary)?;
        crate::viewer::ViewerState::default().load(&path)?;
        let messages: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("chats/0001_alice@c.us/messages.json"))?)?;
        assert_eq!(messages.as_array().map(Vec::len), Some(1));
        fs::remove_dir_all(&root)?;
        Ok(())
    }
}
