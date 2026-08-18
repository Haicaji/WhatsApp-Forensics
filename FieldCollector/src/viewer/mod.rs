//! Native viewer that reads only the exported JSON directory.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use eframe::egui::{self, ColorImage, RichText, TextureHandle};
use serde_json::Value;

#[derive(Clone)]
struct ChatSummary {
    directory: PathBuf,
    id: String,
    title: String,
}

#[derive(Default)]
struct ChatData {
    chat: Value,
    messages: Vec<Value>,
    participants: Vec<Value>,
    message_events: Vec<Value>,
    reactions: Vec<Value>,
    receipts: Vec<Value>,
    poll_votes: Vec<Value>,
    group_events: Vec<Value>,
    media: Vec<Value>,
    history: Value,
}

/// Stateful JSON and media directory browser.
#[derive(Default)]
pub struct ViewerState {
    path_input: String,
    session_path: Option<PathBuf>,
    manifest: Option<Value>,
    chats: Vec<ChatSummary>,
    selected_chat: Option<usize>,
    chat_data: Option<ChatData>,
    chat_filter: String,
    selected_json: String,
    dataset_files: Vec<PathBuf>,
    selected_dataset: Option<usize>,
    textures: HashMap<PathBuf, TextureHandle>,
    error: Option<String>,
}

impl ViewerState {
    /// Set and load an extraction directory.
    pub fn load(&mut self, path: &Path) -> anyhow::Result<()> {
        let manifest = read_json(&path.join("manifest.json"))?;
        let mut chats = Vec::new();
        let chats_root = path.join("chats");
        if chats_root.is_dir() {
            let mut directories = fs::read_dir(&chats_root)?
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            directories.sort();
            for directory in directories {
                let chat = read_json(&directory.join("chat.json")).unwrap_or(Value::Null);
                chats.push(ChatSummary {
                    id: chat["id"].as_str().unwrap_or("unknown_chat").to_owned(),
                    title: chat["title"]
                        .as_str()
                        .unwrap_or_else(|| chat["id"].as_str().unwrap_or("未命名会话"))
                        .to_owned(),
                    directory,
                });
            }
        }
        let mut dataset_files = [
            "account.json",
            "contacts.json",
            "chat-lists.json",
            "capabilities.json",
            "avatars/index.json",
            "logs/extraction.json",
        ]
        .into_iter()
        .map(|relative| path.join(relative))
        .filter(|candidate| candidate.is_file())
        .collect::<Vec<_>>();
        let global = path.join("global");
        if global.is_dir() {
            dataset_files.extend(
                fs::read_dir(global)?
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|candidate| candidate.extension().is_some_and(|value| value == "json")),
            );
        }
        dataset_files.sort();
        self.path_input = path.to_string_lossy().into_owned();
        self.session_path = Some(path.to_owned());
        self.manifest = Some(manifest.clone());
        self.chats = chats;
        self.dataset_files = dataset_files;
        self.selected_chat = None;
        self.chat_data = None;
        self.selected_dataset = None;
        self.selected_json = pretty(&manifest);
        self.textures.clear();
        self.error = None;
        Ok(())
    }

    /// Draw the complete viewer page.
    pub fn ui(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        ui.heading("提取结果查看器");
        ui.label("直接读取 JSON 和原始文件；不建立或读取任何数据库。");
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label("结果目录");
            ui.add(egui::TextEdit::singleline(&mut self.path_input).desired_width(520.0));
            if ui.button("加载").clicked() {
                let path = PathBuf::from(self.path_input.trim());
                if let Err(error) = self.load(&path) {
                    self.error = Some(error.to_string());
                }
            }
            if ui.button("打开目录").clicked()
                && let Some(path) = &self.session_path
            {
                open_folder(path);
            }
        });
        if let Some(error) = &self.error {
            ui.colored_label(egui::Color32::from_rgb(185, 28, 28), error);
        }
        if let Some(manifest) = &self.manifest {
            ui.horizontal_wrapped(|ui| {
                ui.label(
                    RichText::new(format!(
                        "状态：{}",
                        manifest["status"].as_str().unwrap_or("unknown")
                    ))
                    .strong(),
                );
                ui.separator();
                ui.label(format!("会话：{}", self.chats.len()));
                ui.separator();
                ui.label(format!(
                    "完成时间：{}",
                    manifest["finishedAt"].as_str().unwrap_or("-")
                ));
            });
        }
        ui.separator();
        self.dataset_selector(ui);
        ui.separator();
        let has_media = self
            .chat_data
            .as_ref()
            .is_some_and(|chat| !chat.media.is_empty());
        let available_height = ui.available_height();
        let media_height = if has_media {
            (available_height * 0.28).clamp(190.0, 290.0)
        } else {
            0.0
        };
        let main_height = (available_height - media_height - 8.0).max(220.0);
        ui.allocate_ui_with_layout(
            egui::vec2(ui.available_width(), main_height),
            egui::Layout::left_to_right(egui::Align::TOP),
            |ui| {
                ui.vertical(|ui| self.chat_list(ui, main_height));
                ui.separator();
                ui.vertical(|ui| self.message_list(ui, main_height));
                ui.separator();
                ui.vertical(|ui| self.raw_json(ui, main_height));
            },
        );
        if has_media {
            ui.separator();
            self.media_gallery(ui, context, media_height);
        }
    }

    fn dataset_selector(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label("全局数据");
            let selected_text = self
                .selected_dataset
                .and_then(|index| self.dataset_files.get(index))
                .map_or_else(
                    || "选择 JSON 文件".to_owned(),
                    |path| relative_display(self.session_path.as_deref(), path),
                );
            egui::ComboBox::from_id_salt("viewer_dataset")
                .selected_text(selected_text)
                .show_ui(ui, |ui| {
                    for (index, path) in self.dataset_files.iter().enumerate() {
                        let relative = self
                            .session_path
                            .as_ref()
                            .and_then(|root| path.strip_prefix(root).ok())
                            .unwrap_or(path)
                            .to_string_lossy();
                        ui.selectable_value(&mut self.selected_dataset, Some(index), relative);
                    }
                });
            if ui.button("查看数据集").clicked()
                && let Some(path) = self
                    .selected_dataset
                    .and_then(|index| self.dataset_files.get(index))
            {
                match read_json(path) {
                    Ok(value) => self.selected_json = pretty(&value),
                    Err(error) => self.error = Some(error.to_string()),
                }
            }
            if ui.button("查看 manifest").clicked()
                && let Some(manifest) = &self.manifest
            {
                self.selected_json = pretty(manifest);
            }
        });
    }

    fn chat_list(&mut self, ui: &mut egui::Ui, height: f32) {
        ui.set_min_width(230.0);
        ui.heading("会话");
        ui.add(egui::TextEdit::singleline(&mut self.chat_filter).hint_text("搜索标题或 ID"));
        let filter = self.chat_filter.to_lowercase();
        let visible = self
            .chats
            .iter()
            .enumerate()
            .filter(|(_, chat)| {
                filter.is_empty()
                    || chat.title.to_lowercase().contains(&filter)
                    || chat.id.to_lowercase().contains(&filter)
            })
            .map(|(index, chat)| (index, chat.title.clone(), chat.id.clone()))
            .collect::<Vec<_>>();
        egui::ScrollArea::vertical()
            .id_salt("viewer_chat_list_scroll")
            .max_height((height - 58.0).max(120.0))
            .show(ui, |ui| {
                for (index, title, id) in visible {
                    if ui
                        .selectable_label(self.selected_chat == Some(index), title)
                        .on_hover_text(id)
                        .clicked()
                        && let Err(error) = self.load_chat(index)
                    {
                        self.error = Some(error.to_string());
                    }
                }
            });
    }

    fn load_chat(&mut self, index: usize) -> anyhow::Result<()> {
        let chat = self
            .chats
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("会话索引无效"))?;
        let chat_record = read_json(&chat.directory.join("chat.json"))?;
        let messages = read_array(&chat.directory.join("messages.json"))?;
        let participants = read_array(&chat.directory.join("participants.json"))?;
        let message_events = read_array(&chat.directory.join("message-events.json"))?;
        let reactions = read_array(&chat.directory.join("reactions.json"))?;
        let receipts = read_array(&chat.directory.join("receipts.json"))?;
        let poll_votes = read_array(&chat.directory.join("poll-votes.json"))?;
        let group_events = read_array(&chat.directory.join("group-events.json"))?;
        let media = read_array(&chat.directory.join("media/index.json"))?;
        let history = read_json(&chat.directory.join("history.json")).unwrap_or(Value::Null);
        self.selected_chat = Some(index);
        self.chat_data = Some(ChatData {
            chat: chat_record,
            messages,
            participants,
            message_events,
            reactions,
            receipts,
            poll_votes,
            group_events,
            media,
            history: history.clone(),
        });
        self.selected_json = pretty(&history);
        Ok(())
    }

    fn message_list(&mut self, ui: &mut egui::Ui, height: f32) {
        ui.set_min_width(420.0);
        let Some(chat) = self.chat_data.as_ref() else {
            ui.heading("消息");
            ui.label("选择会话后查看消息、成员和媒体。");
            return;
        };
        ui.horizontal(|ui| {
            ui.heading(format!("消息 ({})", chat.messages.len()));
            if ui.button("会话信息").clicked() {
                self.selected_json = pretty(&chat.chat);
            }
            if ui
                .button(format!("成员 {}", chat.participants.len()))
                .clicked()
            {
                self.selected_json = pretty(&chat.participants);
            }
            if ui.button("历史完整性").clicked() {
                self.selected_json = pretty(&chat.history);
            }
        });
        ui.horizontal_wrapped(|ui| {
            for (label, records) in [
                ("事件", &chat.message_events),
                ("反应", &chat.reactions),
                ("回执", &chat.receipts),
                ("投票", &chat.poll_votes),
                ("群事件", &chat.group_events),
            ] {
                if ui.button(format!("{label} {}", records.len())).clicked() {
                    self.selected_json = pretty(records);
                }
            }
        });
        let messages = chat.messages.clone();
        let message_events = chat.message_events.clone();
        let reactions = chat.reactions.clone();
        let receipts = chat.receipts.clone();
        let poll_votes = chat.poll_votes.clone();
        egui::ScrollArea::vertical()
            .id_salt("viewer_message_list_scroll")
            .max_height((height - 86.0).max(120.0))
            .show(ui, |ui| {
                for message in &messages {
                    let from_me = message["fromMe"].as_bool().unwrap_or(false);
                    let sender = if from_me {
                        "我"
                    } else {
                        message["senderId"].as_str().unwrap_or("对方")
                    };
                    let timestamp = message["timestamp"].as_str().unwrap_or("时间未知");
                    let text = message_preview(message);
                    let label = format!("{sender} · {timestamp}\n{text}");
                    if ui
                        .add_sized([400.0, 48.0], egui::Button::new(label).wrap())
                        .clicked()
                    {
                        let message_id = message["id"].as_str().unwrap_or_default();
                        let quoted = message["quotedMessageId"].as_str().and_then(|quoted_id| {
                            messages
                                .iter()
                                .find(|candidate| candidate["id"].as_str() == Some(quoted_id))
                        });
                        let related = |records: &[Value]| {
                            records
                                .iter()
                                .filter(|record| record["messageId"].as_str() == Some(message_id))
                                .cloned()
                                .collect::<Vec<_>>()
                        };
                        self.selected_json = pretty(&serde_json::json!({
                            "message": message,
                            "quotedMessage": quoted,
                            "events": related(&message_events),
                            "reactions": related(&reactions),
                            "receipts": related(&receipts),
                            "pollVotes": related(&poll_votes)
                        }));
                    }
                    ui.add_space(3.0);
                }
            });
    }

    fn raw_json(&mut self, ui: &mut egui::Ui, height: f32) {
        ui.set_min_width(360.0);
        ui.heading("原始 JSON");
        egui::ScrollArea::both()
            .id_salt("viewer_raw_json_scroll")
            .max_height((height - 36.0).max(120.0))
            .show(ui, |ui| {
                ui.add(
                    egui::TextEdit::multiline(&mut self.selected_json)
                        .font(egui::TextStyle::Monospace)
                        .desired_width(520.0)
                        .desired_rows(28)
                        .interactive(false),
                );
            });
    }

    fn media_gallery(&mut self, ui: &mut egui::Ui, context: &egui::Context, height: f32) {
        let Some(chat) = self.chat_data.as_ref() else {
            return;
        };
        ui.heading(format!("媒体文件 ({})", chat.media.len()));
        let media = chat.media.clone();
        egui::ScrollArea::horizontal()
            .id_salt("viewer_media_gallery_scroll")
            .max_height((height - 32.0).max(140.0))
            .show(ui, |ui| {
                ui.horizontal_top(|ui| {
                    for item in media {
                        ui.group(|ui| {
                            ui.set_min_width(250.0);
                            ui.set_max_width(250.0);
                            ui.vertical(|ui| {
                                ui.set_width(250.0);
                                let role = item["role"].as_str().unwrap_or("unknown");
                                let status = item["status"].as_str().unwrap_or("unknown");
                                let status_color = if matches!(status, "available" | "complete") {
                                    egui::Color32::from_rgb(22, 163, 74)
                                } else {
                                    egui::Color32::from_rgb(220, 38, 38)
                                };
                                ui.colored_label(
                                    status_color,
                                    RichText::new(format!("{role} · {status}")).strong(),
                                );
                                ui.add(
                                    egui::Label::new(
                                        item["originalFileName"].as_str().unwrap_or("未命名文件"),
                                    )
                                    .wrap(),
                                );

                                let path = item["relativePath"]
                                    .as_str()
                                    .and_then(|relative| {
                                        self.session_path.as_ref().map(|root| root.join(relative))
                                    })
                                    .filter(|path| path.is_file());
                                if let Some(path) = path {
                                    let mime = item["mimeType"].as_str().unwrap_or("");
                                    if mime.starts_with("image/")
                                        && let Some(texture) = self.load_texture(context, &path)
                                    {
                                        let size = texture.size_vec2();
                                        let scale = (220.0 / size.x.max(1.0))
                                            .min(130.0 / size.y.max(1.0))
                                            .min(1.0);
                                        ui.image((texture.id(), size * scale));
                                    }
                                    ui.label(format!(
                                        "{} bytes",
                                        item["byteLength"].as_u64().unwrap_or(0)
                                    ));
                                    if ui.button("打开原文件").clicked() {
                                        open_file(&path);
                                    }
                                } else {
                                    let reason = item["failureReason"]
                                        .as_str()
                                        .or_else(|| item["reason"].as_str())
                                        .unwrap_or("文件不可用");
                                    ui.add(
                                        egui::Label::new(
                                            RichText::new(reason)
                                                .color(egui::Color32::from_rgb(220, 38, 38)),
                                        )
                                        .wrap(),
                                    );
                                }
                                if ui.button("查看媒体 JSON").clicked() {
                                    self.selected_json = pretty(&item);
                                }
                            });
                        });
                    }
                });
            });
    }

    fn load_texture(&mut self, context: &egui::Context, path: &Path) -> Option<&TextureHandle> {
        if !self.textures.contains_key(path) {
            let bytes = fs::read(path).ok()?;
            let decoded = image::load_from_memory(&bytes).ok()?.to_rgba8();
            let size = [
                usize::try_from(decoded.width()).ok()?,
                usize::try_from(decoded.height()).ok()?,
            ];
            let color = ColorImage::from_rgba_unmultiplied(size, decoded.as_raw());
            let texture =
                context.load_texture(path.to_string_lossy(), color, egui::TextureOptions::LINEAR);
            self.textures.insert(path.to_owned(), texture);
        }
        self.textures.get(path)
    }
}

fn read_json(path: &Path) -> anyhow::Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn read_array(path: &Path) -> anyhow::Result<Vec<Value>> {
    Ok(read_json(path)?.as_array().cloned().unwrap_or_default())
}

fn pretty(value: &impl serde::Serialize) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|error| format!("JSON 显示失败：{error}"))
}

fn relative_display(root: Option<&Path>, path: &Path) -> String {
    root.and_then(|root| path.strip_prefix(root).ok())
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

fn message_preview(message: &Value) -> String {
    let kind = message["type"].as_str().unwrap_or("非文本消息");
    let text = message["text"]
        .as_str()
        .or_else(|| message["caption"].as_str());
    let Some(text) = text else {
        return format!("[{kind}]");
    };
    if kind != "chat" && looks_like_base64_payload(text) {
        return format!("[{kind} 媒体内容]");
    }
    let mut preview = text.chars().take(160).collect::<String>();
    if text.chars().count() > 160 {
        preview.push('…');
    }
    preview
}

fn looks_like_base64_payload(value: &str) -> bool {
    value.len() > 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'+' | b'/' | b'=' | b' ' | b'\r' | b'\n' | b'\t')
        })
}

fn open_folder(path: &Path) {
    #[cfg(windows)]
    let _ = Command::new("explorer.exe").arg(path).spawn();
}

fn open_file(path: &Path) {
    #[cfg(windows)]
    let _ = Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(path)
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::{looks_like_base64_payload, message_preview, relative_display};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn media_payload_is_collapsed_in_message_preview() {
        let payload = format!("/9j/{}", "A".repeat(512));
        let message = json!({"type": "image", "text": payload});
        assert_eq!(message_preview(&message), "[image 媒体内容]");
        assert!(looks_like_base64_payload(&payload));
    }

    #[test]
    fn ordinary_message_preview_is_preserved_and_bounded() {
        let message = json!({"type": "chat", "text": "你好"});
        assert_eq!(message_preview(&message), "你好");
        let long_message = json!({"type": "chat", "text": "字".repeat(200)});
        assert_eq!(message_preview(&long_message).chars().count(), 161);
    }

    #[test]
    fn dataset_label_is_relative_to_session() {
        let root = Path::new("exports/session");
        let path = root.join("chats/chat/media/index.json");
        assert_eq!(
            relative_display(Some(root), &path),
            Path::new("chats/chat/media/index.json")
                .to_string_lossy()
                .into_owned()
        );
    }
}
