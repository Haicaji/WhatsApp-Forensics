//! JSON/CSV session directory writer with original media files.

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

use crate::portable::PortableTask;

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

struct CsvColumn {
    header: &'static str,
    path: &'static [&'static str],
}

const CONTACT_COLUMNS: &[CsvColumn] = &[
    CsvColumn {
        header: "id",
        path: &["id"],
    },
    CsvColumn {
        header: "lidId",
        path: &["lidId"],
    },
    CsvColumn {
        header: "phoneId",
        path: &["phoneId"],
    },
    CsvColumn {
        header: "phoneNumber",
        path: &["phoneNumber"],
    },
    CsvColumn {
        header: "formattedPhoneNumber",
        path: &["formattedPhoneNumber"],
    },
    CsvColumn {
        header: "deviceId",
        path: &["deviceId"],
    },
    CsvColumn {
        header: "devicePhoneId",
        path: &["devicePhoneId"],
    },
    CsvColumn {
        header: "phoneResolution",
        path: &["phoneResolution"],
    },
    CsvColumn {
        header: "phoneSource",
        path: &["phoneSource"],
    },
    CsvColumn {
        header: "name",
        path: &["name"],
    },
    CsvColumn {
        header: "displayName",
        path: &["displayName"],
    },
    CsvColumn {
        header: "savedName",
        path: &["savedName"],
    },
    CsvColumn {
        header: "pushName",
        path: &["pushName"],
    },
    CsvColumn {
        header: "shortName",
        path: &["shortName"],
    },
    CsvColumn {
        header: "verifiedName",
        path: &["verifiedName"],
    },
    CsvColumn {
        header: "about",
        path: &["about"],
    },
    CsvColumn {
        header: "isMe",
        path: &["isMe"],
    },
    CsvColumn {
        header: "isMyContact",
        path: &["isMyContact"],
    },
    CsvColumn {
        header: "isBusiness",
        path: &["isBusiness"],
    },
    CsvColumn {
        header: "isVerified",
        path: &["isVerified"],
    },
    CsvColumn {
        header: "isBlocked",
        path: &["isBlocked"],
    },
    CsvColumn {
        header: "isWAContact",
        path: &["isWAContact"],
    },
    CsvColumn {
        header: "canReceiveMessage",
        path: &["canReceiveMessage"],
    },
    CsvColumn {
        header: "contactType",
        path: &["contactType"],
    },
    CsvColumn {
        header: "businessCategory",
        path: &["businessCategory"],
    },
    CsvColumn {
        header: "businessDescription",
        path: &["businessDescription"],
    },
    CsvColumn {
        header: "businessEmail",
        path: &["businessEmail"],
    },
    CsvColumn {
        header: "businessWebsite",
        path: &["businessWebsite"],
    },
];

const PARTICIPANT_COLUMNS: &[CsvColumn] = &[
    CsvColumn {
        header: "id",
        path: &["id"],
    },
    CsvColumn {
        header: "chatId",
        path: &["chatId"],
    },
    CsvColumn {
        header: "role",
        path: &["role"],
    },
    CsvColumn {
        header: "name",
        path: &["name"],
    },
    CsvColumn {
        header: "lidId",
        path: &["lidId"],
    },
    CsvColumn {
        header: "phoneId",
        path: &["phoneId"],
    },
    CsvColumn {
        header: "phoneNumber",
        path: &["phoneNumber"],
    },
    CsvColumn {
        header: "formattedPhoneNumber",
        path: &["formattedPhoneNumber"],
    },
];

const MESSAGE_COLUMNS: &[CsvColumn] = &[
    CsvColumn {
        header: "id",
        path: &["id"],
    },
    CsvColumn {
        header: "chatId",
        path: &["chatId"],
    },
    CsvColumn {
        header: "senderId",
        path: &["senderId"],
    },
    CsvColumn {
        header: "recipientId",
        path: &["recipientId"],
    },
    CsvColumn {
        header: "fromMe",
        path: &["fromMe"],
    },
    CsvColumn {
        header: "timestamp",
        path: &["timestamp"],
    },
    CsvColumn {
        header: "type",
        path: &["type"],
    },
    CsvColumn {
        header: "text",
        path: &["text"],
    },
    CsvColumn {
        header: "caption",
        path: &["caption"],
    },
    CsvColumn {
        header: "quotedMessageId",
        path: &["quotedMessageId"],
    },
    CsvColumn {
        header: "isForwarded",
        path: &["isForwarded"],
    },
    CsvColumn {
        header: "isStarred",
        path: &["isStarred"],
    },
    CsvColumn {
        header: "isRevoked",
        path: &["isRevoked"],
    },
    CsvColumn {
        header: "acknowledgement",
        path: &["acknowledgement"],
    },
    CsvColumn {
        header: "hasMedia",
        path: &["hasMedia"],
    },
    CsvColumn {
        header: "mediaMimeType",
        path: &["media", "mimeType"],
    },
    CsvColumn {
        header: "mediaFileName",
        path: &["media", "fileName"],
    },
    CsvColumn {
        header: "mediaSize",
        path: &["media", "size"],
    },
    CsvColumn {
        header: "mediaDurationSeconds",
        path: &["media", "durationSeconds"],
    },
];

const RECEIPT_COLUMNS: &[CsvColumn] = &[
    CsvColumn {
        header: "id",
        path: &["id"],
    },
    CsvColumn {
        header: "chatId",
        path: &["chatId"],
    },
    CsvColumn {
        header: "messageId",
        path: &["messageId"],
    },
    CsvColumn {
        header: "state",
        path: &["state"],
    },
];

const EXTRACTION_LOG_COLUMNS: &[CsvColumn] = &[
    CsvColumn {
        header: "at",
        path: &["at"],
    },
    CsvColumn {
        header: "event",
        path: &["event"],
    },
    CsvColumn {
        header: "phase",
        path: &["phase"],
    },
    CsvColumn {
        header: "dataset",
        path: &["dataset"],
    },
    CsvColumn {
        header: "chatIndex",
        path: &["chatIndex"],
    },
    CsvColumn {
        header: "chatTotal",
        path: &["chatTotal"],
    },
    CsvColumn {
        header: "chatId",
        path: &["chatId"],
    },
    CsvColumn {
        header: "channelId",
        path: &["channelId"],
    },
    CsvColumn {
        header: "messageId",
        path: &["messageId"],
    },
    CsvColumn {
        header: "avatarIndex",
        path: &["avatarIndex"],
    },
    CsvColumn {
        header: "avatarTotal",
        path: &["avatarTotal"],
    },
    CsvColumn {
        header: "contactId",
        path: &["contactId"],
    },
    CsvColumn {
        header: "originalFileName",
        path: &["originalFileName"],
    },
    CsvColumn {
        header: "status",
        path: &["status"],
    },
    CsvColumn {
        header: "reason",
        path: &["reason"],
    },
    CsvColumn {
        header: "message",
        path: &["message"],
    },
    CsvColumn {
        header: "detail",
        path: &["detail"],
    },
];

const EXTRACTION_LOG_FLAT_FIELDS: &[&str] = &[
    "phase",
    "dataset",
    "chatIndex",
    "chatTotal",
    "chatId",
    "channelId",
    "messageId",
    "avatarIndex",
    "avatarTotal",
    "contactId",
    "originalFileName",
    "status",
    "reason",
    "message",
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
    meta: Map<String, Value>,
    hasher: Sha256,
    byte_length: u64,
}

/// Writes one extraction without any database or archive layer.
pub struct SessionWriter {
    staging_dir: PathBuf,
    final_dir: PathBuf,
    started_at: String,
    evidence_name: String,
    session_id: String,
    portable_task: Option<PortableTask>,
    capabilities: Option<Value>,
    root_datasets: BTreeMap<String, Vec<Value>>,
    current_chat: Option<ChatWriter>,
    avatar_index: Vec<Value>,
    channel_media_index: Vec<Value>,
    media_objects: BTreeMap<String, Value>,
    active_media: Option<ActiveMedia>,
    log: Vec<Value>,
    chat_count: u64,
}

impl SessionWriter {
    /// Create a session associated with the operator-entered evidence item name.
    #[cfg(test)]
    pub fn new_with_evidence_item(output_root: &Path, evidence_name: &str) -> Result<Self> {
        Self::new_with_context(output_root, evidence_name, None)
    }

    /// Create a session, optionally linked to an Analysis Workstation task.
    pub fn new_with_context(
        output_root: &Path,
        evidence_name: &str,
        portable_task: Option<&PortableTask>,
    ) -> Result<Self> {
        let evidence_name = evidence_name.trim();
        anyhow::ensure!(
            !evidence_name.is_empty(),
            "evidence item name cannot be empty"
        );
        fs::create_dir_all(output_root)
            .with_context(|| format!("cannot create output root {}", output_root.display()))?;
        let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ");
        let session_id = Uuid::new_v4().to_string();
        let short = session_id.get(..8).unwrap_or(session_id.as_str());
        let base_name = format!("{timestamp}_{short}");
        let staging_dir = output_root.join(format!("{base_name}.partial"));
        let final_dir = output_root.join(base_name);
        fs::create_dir_all(staging_dir.join("chats"))?;
        fs::create_dir_all(staging_dir.join("global"))?;
        fs::create_dir_all(staging_dir.join("media/incoming"))?;
        fs::create_dir_all(staging_dir.join("media/objects"))?;
        fs::create_dir_all(staging_dir.join("global/channel-media"))?;
        fs::create_dir_all(staging_dir.join("logs"))?;
        let started_at = Utc::now().to_rfc3339();
        let mut writer = Self {
            staging_dir,
            final_dir,
            started_at,
            evidence_name: evidence_name.to_owned(),
            session_id,
            portable_task: portable_task.cloned(),
            capabilities: None,
            root_datasets: BTreeMap::new(),
            current_chat: None,
            avatar_index: Vec::new(),
            channel_media_index: Vec::new(),
            media_objects: BTreeMap::new(),
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

    /// Finalize valid JSON/CSV files. Completed sessions lose the `.partial` suffix.
    pub fn finish(mut self, status: &str, summary: &Value) -> Result<PathBuf> {
        if self.active_media.is_some() {
            self.media_end(&json!({"status": "transport_interrupted"}))?;
        }
        if self.current_chat.is_some() {
            self.flush_current_chat()?;
        }
        self.write_root_datasets()?;
        write_json(
            &self.staging_dir.join("media/avatars.json"),
            &self.avatar_index,
        )?;
        write_json(
            &self.staging_dir.join("global/channel-media/index.json"),
            &self.channel_media_index,
        )?;
        write_json(
            &self.staging_dir.join("media/index.json"),
            &self.media_objects.values().collect::<Vec<_>>(),
        )?;
        write_csv(
            &self.staging_dir.join("logs/extraction.csv"),
            "extraction_logs",
            &self.log,
        )?;
        let mut manifest = json!({
            "schemaVersion": "field-collector-session/5",
            "status": status,
            "startedAt": self.started_at,
            "finishedAt": Utc::now().to_rfc3339(),
            "evidenceItem": {"name": &self.evidence_name},
            "chatCount": self.chat_count,
            "capabilitiesPath": "capabilities.json",
            "summary": summary.clone(),
            "storage": {
                "format": "UTF-8 JSON/CSV and original files",
                "database": false,
                "archive": false,
                "contentAddressedMedia": true,
                "mediaObjectsPath": "media/index.json",
                "avatarIndexPath": "media/avatars.json",
                "logsPath": "logs/extraction.csv",
                "tabularCsv": ["contacts", "participants", "messages", "receipts", "extraction_logs"]
            }
        });
        if let Some(task) = &self.portable_task {
            manifest["schemaVersion"] = json!("field-collector-session/6");
            manifest["sessionId"] = json!(&self.session_id);
            manifest["task"] = json!({
                "schemaVersion": &task.schema_version,
                "taskId": &task.task_id,
                "caseId": &task.case_id,
                "caseName": &task.case_name,
                "taskName": &task.task_name,
                "createdAtUtc": &task.created_at_utc
            });
        }
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
                (dataset_path(&chat.directory, dataset), target.clone())
            };
            write_partial_dataset(&path, dataset, &checkpoint)?;
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
                    write_partial_dataset(&path, dataset, &checkpoint)?;
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
        let directory_name = chat_directory_name(index, &chat_id);
        let directory = self.staging_dir.join("chats").join(directory_name);
        fs::create_dir_all(directory.join("media"))?;
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
            write_dataset(&dataset_path(&chat.directory, dataset), dataset, &records)?;
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
        let scope = payload["scope"].as_str().unwrap_or("chat");
        anyhow::ensure!(
            matches!(scope, "avatar" | "channel") || self.current_chat.is_some(),
            "media arrived outside a chat, channel, or avatar scope"
        );
        let incoming = self.staging_dir.join("media/incoming");
        fs::create_dir_all(&incoming)?;
        let partial_path = incoming.join(format!("{}.partial", Uuid::new_v4().simple()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial_path)?;
        self.active_media = Some(ActiveMedia {
            file: BufWriter::new(file),
            partial_path,
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

    #[allow(clippy::too_many_lines)]
    fn media_end(&mut self, payload: &Value) -> Result<()> {
        let mut active = self
            .active_media
            .take()
            .ok_or_else(|| anyhow!("media end arrived without start"))?;
        active.file.flush()?;
        active.file.get_ref().sync_data()?;
        drop(active.file);
        let status = payload["status"].as_str().unwrap_or("available");
        let complete_hash = (active.byte_length > 0).then(|| hex::encode(active.hasher.finalize()));
        let mut deduplicated = false;
        let relative_path = if active.byte_length == 0 || status == "skipped" {
            if active.partial_path.is_file() {
                fs::remove_file(&active.partial_path)?;
            }
            None
        } else if status == "available" {
            let sha256 = complete_hash
                .as_deref()
                .ok_or_else(|| anyhow!("complete media hash missing"))?;
            let existing_path = self
                .media_objects
                .get(sha256)
                .and_then(|record| record["relativePath"].as_str())
                .map(ToOwned::to_owned);
            if let Some(relative) = existing_path {
                fs::remove_file(&active.partial_path)?;
                deduplicated = true;
                Some(relative)
            } else {
                let extension = safe_media_extension(
                    active.meta["originalFileName"].as_str().unwrap_or_default(),
                    active.meta["mimeType"].as_str(),
                );
                let prefix = sha256.get(..2).unwrap_or("00");
                let directory = self.staging_dir.join("media/objects").join(prefix);
                fs::create_dir_all(&directory)?;
                let object_path = directory.join(format!("{sha256}{extension}"));
                fs::rename(&active.partial_path, &object_path)?;
                Some(package_path(&self.staging_dir, &object_path)?)
            }
        } else {
            Some(package_path(&self.staging_dir, &active.partial_path)?)
        };
        active
            .meta
            .insert("relativePath".to_owned(), json!(relative_path));
        active
            .meta
            .insert("byteLength".to_owned(), json!(active.byte_length));
        let sha256 = (status == "available")
            .then_some(complete_hash.clone())
            .flatten();
        active.meta.insert("sha256".to_owned(), json!(sha256));
        active.meta.insert(
            "partialSha256".to_owned(),
            json!(
                (status != "available")
                    .then_some(complete_hash.clone())
                    .flatten()
            ),
        );
        active
            .meta
            .insert("deduplicated".to_owned(), json!(deduplicated));
        let recorded_status = if status == "skipped" {
            "skipped"
        } else if active.byte_length == 0 && status != "cancelled" {
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
        if status == "available"
            && let Some(hash) = record["sha256"].as_str()
        {
            self.update_media_object(hash, &record)?;
        }
        if record["scope"] == "avatar" {
            self.avatar_index.push(record);
            write_partial_json(
                &self.staging_dir.join("media/avatars.json"),
                &self.avatar_index,
            )?;
        } else if record["scope"] == "channel" {
            self.channel_media_index.push(record);
            write_partial_json(
                &self.staging_dir.join("global/channel-media/index.json"),
                &self.channel_media_index,
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
            object
                .entry("status".to_owned())
                .or_insert_with(|| json!("unavailable"));
            object.insert("relativePath".to_owned(), Value::Null);
        }
        if payload["scope"] == "avatar" {
            self.avatar_index.push(record);
            write_partial_json(
                &self.staging_dir.join("media/avatars.json"),
                &self.avatar_index,
            )?;
        } else if payload["scope"] == "channel" {
            self.channel_media_index.push(record);
            write_partial_json(
                &self.staging_dir.join("global/channel-media/index.json"),
                &self.channel_media_index,
            )?;
        } else if let Some(chat) = self.current_chat.as_mut() {
            chat.media_index.push(record);
            write_partial_json(&chat.directory.join("media/index.json"), &chat.media_index)?;
        } else {
            self.log("media_failure", &record)?;
        }
        Ok(())
    }

    fn update_media_object(&mut self, sha256: &str, reference: &Value) -> Result<()> {
        let relative_path = reference["relativePath"].clone();
        let byte_length = reference["byteLength"].clone();
        let entry = self
            .media_objects
            .entry(sha256.to_owned())
            .or_insert_with(|| {
                json!({
                    "sha256": sha256,
                    "relativePath": relative_path,
                    "byteLength": byte_length,
                    "mimeTypes": [],
                    "originalFileNames": [],
                    "references": []
                })
            });
        let object = entry
            .as_object_mut()
            .ok_or_else(|| anyhow!("media object catalog entry was not an object"))?;
        append_unique_json_string(object, "mimeTypes", reference["mimeType"].as_str());
        append_unique_json_string(
            object,
            "originalFileNames",
            reference["originalFileName"].as_str(),
        );
        let mut reference_count = None;
        if let Some(references) = object.get_mut("references").and_then(Value::as_array_mut) {
            references.push(json!({
                "scope": reference["scope"],
                "chatId": reference["chatId"],
                "channelId": reference["channelId"],
                "contactId": reference["contactId"],
                "messageId": reference["messageId"],
                "role": reference["role"],
                "originalFileName": reference["originalFileName"]
            }));
            reference_count = Some(references.len());
        }
        if let Some(reference_count) = reference_count {
            object.insert("referenceCount".to_owned(), json!(reference_count));
        }
        write_partial_json(
            &self.staging_dir.join("media/index.json"),
            &self.media_objects.values().collect::<Vec<_>>(),
        )
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
        write_csv(
            &self.staging_dir.join("contacts.csv"),
            "contacts",
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
        let mut record = Map::new();
        record.insert("at".to_owned(), json!(Utc::now().to_rfc3339()));
        record.insert("event".to_owned(), json!(event));
        let mut remaining = match detail {
            Value::Object(object) => object.clone(),
            Value::Null => Map::new(),
            value => Map::from_iter([("value".to_owned(), value.clone())]),
        };
        for field in EXTRACTION_LOG_FLAT_FIELDS {
            if let Some(value) = remaining.remove(*field) {
                record.insert((*field).to_owned(), value);
            }
        }
        if !remaining.is_empty() {
            record.insert("detail".to_owned(), Value::Object(remaining));
        }
        self.log.push(Value::Object(record));
        write_partial_csv(
            &self.staging_dir.join("logs/extraction.csv"),
            "extraction_logs",
            &self.log,
        )
    }

    fn root_dataset_path(&self, dataset: &str) -> Option<PathBuf> {
        match dataset {
            "accounts" => Some(self.staging_dir.join("account.json")),
            "contacts" => Some(self.staging_dir.join("contacts.csv")),
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

fn csv_columns(dataset: &str) -> Option<&'static [CsvColumn]> {
    match dataset {
        "contacts" => Some(CONTACT_COLUMNS),
        "participants" => Some(PARTICIPANT_COLUMNS),
        "messages" => Some(MESSAGE_COLUMNS),
        "receipts" => Some(RECEIPT_COLUMNS),
        "extraction_logs" => Some(EXTRACTION_LOG_COLUMNS),
        _ => None,
    }
}

fn dataset_path(directory: &Path, dataset: &str) -> PathBuf {
    let extension = if csv_columns(dataset).is_some() {
        "csv"
    } else {
        "json"
    };
    directory.join(format!("{}.{extension}", dataset.replace('_', "-")))
}

fn chat_directory_name(index: u64, chat_id: &str) -> String {
    format!("{index}_{}", sanitize_component(chat_id))
}

fn write_dataset(path: &Path, dataset: &str, records: &[Value]) -> Result<()> {
    if csv_columns(dataset).is_some() {
        write_csv(path, dataset, records)
    } else {
        write_json(path, &records)
    }
}

fn write_partial_dataset(path: &Path, dataset: &str, records: &[Value]) -> Result<()> {
    if csv_columns(dataset).is_some() {
        write_partial_csv(path, dataset, records)
    } else {
        write_partial_json(path, &records)
    }
}

fn write_csv(path: &Path, dataset: &str, records: &[Value]) -> Result<()> {
    let temporary_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map_or_else(|| "partial".to_owned(), |value| format!("{value}.partial"));
    let temporary = path.with_extension(temporary_extension);
    write_csv_file(&temporary, dataset, records, false)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn write_partial_csv(path: &Path, dataset: &str, records: &[Value]) -> Result<()> {
    let partial_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map_or_else(|| "partial".to_owned(), |value| format!("{value}.partial"));
    write_csv_file(
        &path.with_extension(partial_extension),
        dataset,
        records,
        true,
    )
}

fn write_csv_file(path: &Path, dataset: &str, records: &[Value], sync: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("CSV path has no parent"))?;
    fs::create_dir_all(parent)?;
    let columns =
        csv_columns(dataset).ok_or_else(|| anyhow!("CSV schema missing for {dataset}"))?;
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    let mut writer = BufWriter::new(file);
    write_csv_row(&mut writer, columns.iter().map(|column| column.header))?;
    for record in records {
        let cells = columns
            .iter()
            .map(|column| csv_value(record, column.path))
            .collect::<Result<Vec<_>>>()?;
        write_csv_row(&mut writer, cells.iter().map(String::as_str))?;
    }
    writer.flush()?;
    if sync {
        writer.get_ref().sync_data()?;
    }
    Ok(())
}

fn write_csv_row<'a>(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = &'a str>,
) -> Result<()> {
    let mut first = true;
    for value in values {
        if first {
            first = false;
        } else {
            writer.write_all(b",")?;
        }
        if value.contains([',', '"', '\r', '\n']) {
            writer.write_all(b"\"")?;
            writer.write_all(value.replace('"', "\"\"").as_bytes())?;
            writer.write_all(b"\"")?;
        } else {
            writer.write_all(value.as_bytes())?;
        }
    }
    writer.write_all(b"\r\n")?;
    Ok(())
}

fn csv_value(record: &Value, path: &[&str]) -> Result<String> {
    let value = path
        .iter()
        .try_fold(record, |current, key| current.get(*key))
        .unwrap_or(&Value::Null);
    match value {
        Value::Null => Ok(String::new()),
        Value::String(value) => Ok(value.clone()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::Array(_) | Value::Object(_) => Ok(serde_json::to_string(value)?),
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

fn safe_media_extension(file_name: &str, mime_type: Option<&str>) -> String {
    let from_name = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 10
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .map(|value| format!(".{}", value.to_ascii_lowercase()));
    from_name.unwrap_or_else(|| {
        match mime_type
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
        {
            "image/jpeg" => ".jpg",
            "image/png" => ".png",
            "image/webp" => ".webp",
            "image/gif" => ".gif",
            "video/mp4" => ".mp4",
            "audio/ogg" => ".ogg",
            "audio/mpeg" => ".mp3",
            "application/pdf" => ".pdf",
            "text/vcard" | "text/x-vcard" => ".vcf",
            _ => ".bin",
        }
        .to_owned()
    })
}

fn append_unique_json_string(object: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return;
    };
    let values = object
        .entry(key.to_owned())
        .or_insert_with(|| json!([]))
        .as_array_mut();
    if let Some(values) = values
        && !values.iter().any(|item| item.as_str() == Some(value))
    {
        values.push(json!(value));
    }
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

    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::{SessionWriter, chat_directory_name, sanitize_component, write_csv};
    use crate::portable::{PORTABLE_TASK_SCHEMA, PortableTask};
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
    fn chat_directory_sequence_uses_natural_unbounded_digits() {
        assert_eq!(chat_directory_name(1, "chat@g.us"), "1_chat@g.us");
        assert_eq!(
            chat_directory_name(12_345_678_901, "chat@g.us"),
            "12345678901_chat@g.us"
        );
    }

    #[test]
    fn evidence_item_name_is_required_and_saved_in_the_manifest() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "field-collector-evidence-name-test-{}",
            Uuid::new_v4()
        ));
        assert!(SessionWriter::new_with_evidence_item(&root, "   ").is_err());

        let writer = SessionWriter::new_with_evidence_item(&root, "  张三手机  ")?;
        let path = writer.finish("complete", &json!({}))?;
        let manifest: Value = serde_json::from_slice(&fs::read(path.join("manifest.json"))?)?;
        assert_eq!(manifest["evidenceItem"]["name"], "张三手机");

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn portable_session_uses_v6_and_embeds_task_reference() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "field-collector-portable-manifest-test-{}",
            Uuid::new_v4()
        ));
        let task = PortableTask {
            schema_version: PORTABLE_TASK_SCHEMA.to_owned(),
            task_id: Uuid::new_v4().to_string(),
            case_id: Uuid::new_v4().to_string(),
            case_name: "测试案件".to_owned(),
            task_name: "一号采集任务".to_owned(),
            created_at_utc: "2026-08-20T01:02:03Z".to_owned(),
            result_directory: "results".to_owned(),
        };

        let writer = SessionWriter::new_with_context(&root, "测试检材", Some(&task))?;
        let path = writer.finish("complete", &json!({}))?;
        let manifest: Value = serde_json::from_slice(&fs::read(path.join("manifest.json"))?)?;
        assert_eq!(manifest["schemaVersion"], "field-collector-session/6");
        assert_eq!(manifest["task"]["taskId"], task.task_id);
        assert_eq!(manifest["task"]["caseId"], task.case_id);
        assert!(Uuid::parse_str(manifest["sessionId"].as_str().unwrap_or_default()).is_ok());

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn enriched_contact_and_participant_csv_preserve_phone_identity() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "field-collector-identity-csv-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root)?;
        let contacts = root.join("contacts.csv");
        write_csv(
            &contacts,
            "contacts",
            &[json!({
                "id": "259567069958235@lid",
                "lidId": "259567069958235@lid",
                "phoneId": "8615880921237@c.us",
                "phoneNumber": "8615880921237",
                "formattedPhoneNumber": "+8615880921237",
                "name": "JJ",
                "about": "Available"
            })],
        )?;
        let csv = fs::read_to_string(&contacts)?;
        assert!(csv.starts_with("id,lidId,phoneId,phoneNumber,formattedPhoneNumber,"));
        assert!(
            csv.contains("259567069958235@lid,8615880921237@c.us,8615880921237,+8615880921237")
        );

        let participants = root.join("participants.csv");
        write_csv(
            &participants,
            "participants",
            &[json!({
                "id": "259567069958235@lid",
                "chatId": "group@g.us",
                "role": "member",
                "phoneId": "8615880921237@c.us"
            })],
        )?;
        assert!(fs::read_to_string(participants)?.contains("8615880921237@c.us"));
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn content_addressed_media_deduplicates_across_chats_and_channels() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "field-collector-media-dedup-test-{}",
            Uuid::new_v4()
        ));
        let mut writer = SessionWriter::new_with_evidence_item(&root, "测试检材")?;
        writer.handle_frame(&frame(0, "capabilities", json!({"datasets": {}})))?;
        let payload = "c2FtZS1hdHRhY2htZW50";
        let mut sequence = 1;
        for (index, chat_id, file_name) in [
            (1, "chat-a@c.us", "first-name.jpg"),
            (2, "chat-b@c.us", "second-name.png"),
        ] {
            writer.handle_frame(&frame(
                sequence,
                "chat_begin",
                json!({"index": index, "chatId": chat_id, "chat": {"id": chat_id}}),
            ))?;
            sequence += 1;
            writer.handle_frame(&frame(
                sequence,
                "media_start",
                json!({
                    "scope": "chat", "chatId": chat_id, "messageId": format!("m{index}"),
                    "role": "original", "isOriginal": true, "mimeType": "image/jpeg",
                    "originalFileName": file_name
                }),
            ))?;
            sequence += 1;
            writer.handle_frame(&frame(
                sequence,
                "media_chunk",
                json!({"dataBase64": payload}),
            ))?;
            sequence += 1;
            writer.handle_frame(&frame(
                sequence,
                "media_end",
                json!({"status": "available"}),
            ))?;
            sequence += 1;
            writer.handle_frame(&frame(
                sequence,
                "chat_end",
                json!({"chatId": chat_id, "history": {"complete": true}}),
            ))?;
            sequence += 1;
        }
        writer.handle_frame(&frame(
            sequence,
            "media_start",
            json!({
                "scope": "channel", "chatId": "news@newsletter",
                "channelId": "news@newsletter", "messageId": "post-1",
                "role": "original", "isOriginal": true, "mimeType": "image/jpeg",
                "originalFileName": "channel-name.jpeg"
            }),
        ))?;
        sequence += 1;
        writer.handle_frame(&frame(
            sequence,
            "media_chunk",
            json!({"dataBase64": payload}),
        ))?;
        sequence += 1;
        writer.handle_frame(&frame(
            sequence,
            "media_end",
            json!({"status": "available"}),
        ))?;
        sequence += 1;
        writer.handle_frame(&frame(
            sequence,
            "media_start",
            json!({
                "scope": "avatar", "contactId": "avatar-owner@c.us",
                "role": "avatar", "isOriginal": true, "mimeType": "image/jpeg",
                "originalFileName": "avatar-owner.jpg"
            }),
        ))?;
        sequence += 1;
        writer.handle_frame(&frame(
            sequence,
            "media_chunk",
            json!({"dataBase64": payload}),
        ))?;
        sequence += 1;
        writer.handle_frame(&frame(
            sequence,
            "media_end",
            json!({"status": "available"}),
        ))?;

        let path = writer.finish("complete", &json!({"status": "complete"}))?;
        let first: Value = serde_json::from_slice(&fs::read(
            path.join("chats/1_chat-a@c.us/media/index.json"),
        )?)?;
        let second: Value = serde_json::from_slice(&fs::read(
            path.join("chats/2_chat-b@c.us/media/index.json"),
        )?)?;
        let channel: Value =
            serde_json::from_slice(&fs::read(path.join("global/channel-media/index.json"))?)?;
        let avatars: Value = serde_json::from_slice(&fs::read(path.join("media/avatars.json"))?)?;
        assert_eq!(first[0]["relativePath"], second[0]["relativePath"]);
        assert_eq!(first[0]["relativePath"], channel[0]["relativePath"]);
        assert_eq!(first[0]["relativePath"], avatars[0]["relativePath"]);
        assert_eq!(first[0]["originalFileName"], "first-name.jpg");
        assert_eq!(second[0]["originalFileName"], "second-name.png");
        assert_eq!(second[0]["deduplicated"], true);
        assert_eq!(channel[0]["deduplicated"], true);
        assert_eq!(avatars[0]["deduplicated"], true);
        assert!(!path.join("avatars").exists());

        let objects: Value = serde_json::from_slice(&fs::read(path.join("media/index.json"))?)?;
        assert_eq!(objects.as_array().map(Vec::len), Some(1));
        assert_eq!(objects[0]["referenceCount"], 4);
        assert_eq!(
            objects[0]["originalFileNames"].as_array().map(Vec::len),
            Some(4)
        );
        assert_eq!(
            objects[0]["references"][3]["contactId"],
            "avatar-owner@c.us"
        );
        let object_path = objects[0]["relativePath"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("media object path missing"))?;
        assert!(path.join(object_path).is_file());
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn writes_valid_json_csv_session_without_database() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("field-collector-test-{}", Uuid::new_v4()));
        let mut writer = SessionWriter::new_with_evidence_item(&root, "测试检材")?;
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
        assert_eq!(manifest["schemaVersion"], "field-collector-session/5");
        assert_eq!(manifest["storage"]["database"], false);
        assert_eq!(manifest["storage"]["tabularCsv"][2], "messages");
        assert_eq!(manifest["storage"]["logsPath"], "logs/extraction.csv");
        assert_eq!(manifest["storage"]["avatarIndexPath"], "media/avatars.json");
        let logs = fs::read_to_string(path.join("logs/extraction.csv"))?;
        assert!(logs.starts_with("at,event,phase,dataset,chatIndex,chatTotal,"));
        assert!(logs.contains("session_started"));
        assert!(!path.join("logs/extraction.json").exists());
        let messages = fs::read_to_string(path.join("chats/1_a_b@g.us/messages.csv"))?;
        assert!(messages.starts_with("id,chatId,senderId,recipientId,fromMe,"));
        assert!(messages.contains("m1"));
        assert!(!path.join("chats/1_a_b@g.us/messages.json").exists());
        assert!(path.join("chats/1_a_b@g.us/participants.csv").is_file());
        assert!(path.join("chats/1_a_b@g.us/receipts.csv").is_file());
        assert!(path.join("chats/1_a_b@g.us/reactions.json").is_file());
        let media: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("chats/1_a_b@g.us/media/index.json"))?)?;
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
        let mut writer = SessionWriter::new_with_evidence_item(&root, "测试检材")?;
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
        assert!(path.join("contacts.csv").is_file());
        let avatars: serde_json::Value =
            serde_json::from_slice(&fs::read(path.join("media/avatars.json"))?)?;
        assert_eq!(avatars[0]["status"], "unavailable");
        assert_eq!(avatars[0]["relativePath"], serde_json::Value::Null);
        assert!(!path.join("avatars").exists());
        assert_eq!(fs::read_dir(path.join("media/incoming"))?.count(), 0);
        crate::viewer::ViewerState::default().load(&path)?;
        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[test]
    fn writes_status_call_and_joined_channel_global_files() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "field-collector-global-datasets-test-{}",
            Uuid::new_v4()
        ));
        let mut writer = SessionWriter::new_with_evidence_item(&root, "测试检材")?;
        writer.handle_frame(&frame(
            0,
            "capabilities",
            json!({"datasets": {
                "statuses": {"status": "supported", "recordCount": 1},
                "calls": {"status": "supported", "recordCount": 1},
                "channels": {"status": "supported", "recordCount": 1}
            }}),
        ))?;
        for (sequence, dataset, record) in [
            (1, "statuses", json!({"id": "owner@status", "items": []})),
            (2, "calls", json!({"id": "call-1", "direction": "incoming"})),
            (
                3,
                "channels",
                json!({"id": "joined@newsletter", "isJoined": true}),
            ),
            (
                4,
                "channel_events",
                json!({"id": "post-1", "channelId": "joined@newsletter"}),
            ),
        ] {
            writer.handle_frame(&frame(
                sequence,
                "dataset_batch",
                json!({"dataset": dataset, "chatId": null, "records": [record], "final": true}),
            ))?;
        }
        let path = writer.finish("complete", &json!({"status": "complete"}))?;
        for relative in [
            "global/statuses.json",
            "global/calls.json",
            "global/channels.json",
            "global/channel-events.json",
        ] {
            let value: serde_json::Value = serde_json::from_slice(&fs::read(path.join(relative))?)?;
            assert_eq!(value.as_array().map(Vec::len), Some(1), "{relative}");
        }
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
        let mut writer = SessionWriter::new_with_evidence_item(&root, "测试检材")?;
        let mut terminal = None;
        for (index, frame) in frames.iter().enumerate() {
            frame.validate(u64::try_from(index)?)?;
            if let Some(status) = writer.handle_frame(frame)? {
                terminal = Some((status, frame.payload.clone()));
            }
            if frame.kind == "dataset_batch" {
                let checkpoint = writer
                    .staging_dir
                    .join("chats/1_alice@c.us/messages.csv.partial");
                let value = fs::read_to_string(checkpoint)?;
                assert!(
                    value
                        .lines()
                        .next()
                        .is_some_and(|line| line.starts_with("id,chatId"))
                );
                assert!(value.contains("m1"));
            }
        }
        let (status, summary) =
            terminal.ok_or_else(|| anyhow::anyhow!("fixture had no terminal frame"))?;
        let path = writer.finish(&status, &summary)?;
        crate::viewer::ViewerState::default().load(&path)?;
        let messages = fs::read_to_string(path.join("chats/1_alice@c.us/messages.csv"))?;
        assert_eq!(messages.lines().count(), 2);
        fs::remove_dir_all(&root)?;
        Ok(())
    }
}
