//! Native WhatsApp-style viewer for exported JSON/CSV data and original files.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{DateTime, Utc};
use eframe::egui::{self, Color32, ColorImage, RichText, TextureHandle};
use serde_json::{Map, Value};

const ACCENT: Color32 = Color32::from_rgb(0, 168, 132);
const NAV_SURFACE: Color32 = Color32::from_rgb(24, 34, 40);
const LIST_SURFACE: Color32 = Color32::from_rgb(17, 27, 33);
const CHAT_SURFACE: Color32 = Color32::from_rgb(11, 20, 26);
const HEADER_SURFACE: Color32 = Color32::from_rgb(32, 44, 51);
const SELECTED_SURFACE: Color32 = Color32::from_rgb(42, 57, 66);
const INCOMING_BUBBLE: Color32 = Color32::from_rgb(32, 44, 51);
const OUTGOING_BUBBLE: Color32 = Color32::from_rgb(0, 92, 75);
const TEXT_PRIMARY: Color32 = Color32::from_rgb(233, 237, 239);
const TEXT_SECONDARY: Color32 = Color32::from_rgb(134, 150, 160);
const DIVIDER: Color32 = Color32::from_rgb(42, 57, 66);
const ERROR: Color32 = Color32::from_rgb(239, 107, 115);

#[derive(Clone)]
struct ChatSummary {
    directory: PathBuf,
    id: String,
    title: String,
    phone: Option<String>,
    unread_count: u64,
    last_activity: Option<String>,
}

#[derive(Default)]
struct ChatData {
    chat: Value,
    messages: Vec<Value>,
    message_days: Vec<Option<String>>,
    participants: Vec<Value>,
    message_events: Vec<Value>,
    reactions: Vec<Value>,
    receipts: Vec<Value>,
    poll_votes: Vec<Value>,
    group_events: Vec<Value>,
    media: Vec<Value>,
    history: Value,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ViewerSection {
    #[default]
    Chats,
    Statuses,
    Channels,
    Calls,
    More,
}

impl ViewerSection {
    const ALL: [Self; 5] = [
        Self::Chats,
        Self::Statuses,
        Self::Channels,
        Self::Calls,
        Self::More,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Chats => "聊天",
            Self::Statuses => "动态",
            Self::Channels => "频道",
            Self::Calls => "通话",
            Self::More => "更多数据",
        }
    }

    fn short_label(self) -> &'static str {
        match self {
            Self::Chats => "聊",
            Self::Statuses => "动",
            Self::Channels => "频",
            Self::Calls => "话",
            Self::More => "更多",
        }
    }
}

#[derive(Clone, Debug)]
enum DetailView {
    Message(usize),
    ChatInfo,
    Members,
    History,
    MediaList,
    StatusItem { publisher: usize, item: usize },
    ChannelInfo(usize),
    ChannelEvent(usize),
    ChannelMedia(usize),
    Call(usize),
    MoreRecord(usize),
}

#[derive(Clone)]
struct MoreDataset {
    path: PathBuf,
    title: String,
}

/// Stateful parsed-data viewer. Raw JSON remains on disk and is intentionally
/// not rendered in the application.
#[derive(Default)]
pub struct ViewerState {
    path_input: String,
    session_path: Option<PathBuf>,
    manifest: Option<Value>,
    section: ViewerSection,
    filter: String,

    chats: Vec<ChatSummary>,
    selected_chat: Option<usize>,
    chat_data: Option<ChatData>,

    statuses: Vec<Value>,
    selected_status: Option<usize>,
    channels: Vec<Value>,
    selected_channel: Option<usize>,
    channel_events: Vec<Value>,
    channel_media: Vec<Value>,
    calls: Vec<Value>,
    selected_call: Option<usize>,

    more_datasets: Vec<MoreDataset>,
    selected_more: Option<usize>,
    more_records: Vec<Value>,

    names: HashMap<String, String>,
    avatars: HashMap<String, PathBuf>,
    textures: HashMap<PathBuf, TextureHandle>,
    detail: Option<DetailView>,
    error: Option<String>,
}

impl ViewerState {
    /// Set and load an extraction directory.
    pub fn load(&mut self, path: &Path) -> anyhow::Result<()> {
        let manifest = read_json(&path.join("manifest.json"))?;
        let names = load_contact_names(path)?;
        let avatars = load_avatar_paths(path);
        let chats = load_chat_summaries(path)?;
        let statuses = normalize_statuses(read_optional_array(&path.join("global/statuses.json")));
        let channels = read_optional_array(&path.join("global/channels.json"))
            .into_iter()
            .filter(|channel| channel["isJoined"].as_bool() != Some(false))
            .collect();
        let channel_events = read_optional_array(&path.join("global/channel-events.json"));
        let channel_media = read_optional_array(&path.join("global/channel-media/index.json"));
        let calls = read_optional_array(&path.join("global/calls.json"));
        let more_datasets = discover_more_datasets(path)?;

        self.path_input = path.to_string_lossy().into_owned();
        self.session_path = Some(path.to_owned());
        self.manifest = Some(manifest);
        self.names = names;
        self.avatars = avatars;
        self.chats = chats;
        self.statuses = statuses;
        self.channels = channels;
        self.channel_events = channel_events;
        self.channel_media = channel_media;
        self.calls = calls;
        self.more_datasets = more_datasets;
        self.section = ViewerSection::Chats;
        self.filter.clear();
        self.selected_chat = None;
        self.chat_data = None;
        self.selected_status = (!self.statuses.is_empty()).then_some(0);
        self.selected_channel = (!self.channels.is_empty()).then_some(0);
        self.selected_call = (!self.calls.is_empty()).then_some(0);
        self.selected_more = (!self.more_datasets.is_empty()).then_some(0);
        self.more_records.clear();
        self.detail = None;
        self.textures.clear();
        self.error = None;

        if !self.chats.is_empty() {
            self.load_chat(0)?;
        }
        if !self.more_datasets.is_empty() {
            self.load_more_dataset(0)?;
        }
        Ok(())
    }

    /// Draw the complete viewer page.
    pub fn ui(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        self.toolbar(ui);

        if let Some(error) = &self.error {
            egui::Frame::new()
                .fill(Color32::from_rgb(70, 35, 39))
                .inner_margin(egui::Margin::symmetric(12, 7))
                .show(ui, |ui| {
                    ui.colored_label(ERROR, error);
                });
        }

        if self.session_path.is_none() {
            empty_state(
                ui,
                "尚未加载提取结果",
                "选择包含 manifest.json 的结果目录后，即可按聊天、动态、频道和通话查看。",
            );
            return;
        }

        let available = ui.available_size();
        let compact_detail = detail_replaces_content(available.x, self.detail.is_some());
        let sidebar_width = if available.x < 1080.0 { 272.0 } else { 320.0 };

        ui.allocate_ui_with_layout(
            available,
            egui::Layout::left_to_right(egui::Align::Min),
            |ui| {
                ui.allocate_ui_with_layout(
                    egui::vec2(62.0, ui.available_height()),
                    egui::Layout::top_down(egui::Align::Center),
                    |ui| self.navigation(ui),
                );
                divider(ui);
                ui.allocate_ui_with_layout(
                    egui::vec2(sidebar_width, ui.available_height()),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| self.sidebar(ui, context),
                );
                divider(ui);

                if compact_detail {
                    ui.allocate_ui_with_layout(
                        ui.available_size(),
                        egui::Layout::top_down(egui::Align::Min),
                        |ui| self.detail_panel(ui, context, true),
                    );
                } else {
                    let detail_width = if self.detail.is_some() { 370.0 } else { 0.0 };
                    let center_width = (ui.available_width() - detail_width).max(360.0);
                    ui.allocate_ui_with_layout(
                        egui::vec2(center_width, ui.available_height()),
                        egui::Layout::top_down(egui::Align::Min),
                        |ui| self.content(ui, context),
                    );
                    if self.detail.is_some() {
                        divider(ui);
                        ui.allocate_ui_with_layout(
                            egui::vec2(ui.available_width(), ui.available_height()),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| self.detail_panel(ui, context, false),
                        );
                    }
                }
            },
        );
    }

    fn toolbar(&mut self, ui: &mut egui::Ui) {
        egui::Frame::new()
            .fill(HEADER_SURFACE)
            .inner_margin(egui::Margin::symmetric(12, 8))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("结果目录").color(TEXT_SECONDARY));
                    let buttons_width = 170.0;
                    let input_width = (ui.available_width() - buttons_width).max(180.0);
                    ui.add(
                        egui::TextEdit::singleline(&mut self.path_input)
                            .desired_width(input_width)
                            .hint_text("选择提取结果目录"),
                    );
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
            });
    }

    fn navigation(&mut self, ui: &mut egui::Ui) {
        ui.set_min_height(ui.available_height());
        egui::Frame::new()
            .fill(NAV_SURFACE)
            .inner_margin(egui::Margin::symmetric(6, 10))
            .show(ui, |ui| {
                ui.set_min_width(50.0);
                ui.vertical_centered(|ui| {
                    for section in ViewerSection::ALL {
                        let selected = self.section == section;
                        let button = egui::Button::new(
                            RichText::new(section.short_label())
                                .size(if section == ViewerSection::More {
                                    12.0
                                } else {
                                    18.0
                                })
                                .color(if selected { ACCENT } else { TEXT_SECONDARY }),
                        )
                        .fill(if selected {
                            SELECTED_SURFACE
                        } else {
                            NAV_SURFACE
                        })
                        .corner_radius(12.0)
                        .min_size(egui::vec2(46.0, 46.0));
                        if ui.add(button).on_hover_text(section.label()).clicked() {
                            self.section = section;
                            self.filter.clear();
                            self.detail = None;
                        }
                        ui.add_space(5.0);
                    }
                });
            });
    }

    fn sidebar(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let width = ui.available_width();
        ui.set_min_width(width);
        egui::Frame::new()
            .fill(LIST_SURFACE)
            .inner_margin(egui::Margin::symmetric(10, 10))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.heading(RichText::new(self.section.label()).color(TEXT_PRIMARY));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            RichText::new(self.section_count().to_string()).color(TEXT_SECONDARY),
                        );
                    });
                });
                ui.add_space(4.0);
                ui.add(
                    egui::TextEdit::singleline(&mut self.filter)
                        .desired_width(f32::INFINITY)
                        .hint_text("搜索"),
                );
                ui.add_space(6.0);
                match self.section {
                    ViewerSection::Chats => self.chat_sidebar(ui, context),
                    ViewerSection::Statuses => self.status_sidebar(ui, context),
                    ViewerSection::Channels => self.channel_sidebar(ui, context),
                    ViewerSection::Calls => self.call_sidebar(ui, context),
                    ViewerSection::More => self.more_sidebar(ui),
                }
            });
    }

    fn section_count(&self) -> usize {
        match self.section {
            ViewerSection::Chats => self.chats.len(),
            ViewerSection::Statuses => self.statuses.len(),
            ViewerSection::Channels => self.channels.len(),
            ViewerSection::Calls => self.calls.len(),
            ViewerSection::More => self.more_datasets.len(),
        }
    }

    fn chat_sidebar(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let filter = self.filter.to_lowercase();
        let rows = self
            .chats
            .iter()
            .enumerate()
            .filter(|(_, chat)| {
                filter.is_empty()
                    || chat.title.to_lowercase().contains(&filter)
                    || chat.id.to_lowercase().contains(&filter)
            })
            .map(|(index, chat)| (index, chat.clone()))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            sidebar_empty(ui, "没有匹配的聊天");
            return;
        }
        egui::ScrollArea::vertical()
            .id_salt("viewer_chat_sidebar_scroll")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for (index, chat) in rows {
                    let subtitle = chat.phone.clone().unwrap_or_else(|| chat.id.clone());
                    let meta = chat
                        .last_activity
                        .as_deref()
                        .map_or_else(|| "时间未知".to_owned(), short_time);
                    if self.sidebar_row(
                        ui,
                        context,
                        &chat.id,
                        &chat.title,
                        &subtitle,
                        &meta,
                        chat.unread_count,
                        self.selected_chat == Some(index),
                    ) && let Err(error) = self.load_chat(index)
                    {
                        self.error = Some(error.to_string());
                    }
                }
            });
    }

    fn status_sidebar(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let filter = self.filter.to_lowercase();
        let rows = self
            .statuses
            .iter()
            .enumerate()
            .filter_map(|(index, status)| {
                let id = status["publisherId"]
                    .as_str()
                    .or_else(|| status["id"].as_str())
                    .unwrap_or("unknown");
                let title = self.display_name(id);
                (filter.is_empty()
                    || title.to_lowercase().contains(&filter)
                    || id.to_lowercase().contains(&filter))
                .then(|| (index, status.clone(), id.to_owned(), title))
            })
            .collect::<Vec<_>>();
        if rows.is_empty() {
            sidebar_empty(ui, "没有可查看的动态");
            return;
        }
        egui::ScrollArea::vertical()
            .id_salt("viewer_status_sidebar_scroll")
            .show(ui, |ui| {
                for (index, status, id, title) in rows {
                    let count = status["items"].as_array().map_or(0, Vec::len);
                    let meta = status["expiresAt"]
                        .as_str()
                        .map_or_else(|| format!("{count} 条动态"), short_time);
                    if self.sidebar_row(
                        ui,
                        context,
                        &id,
                        &title,
                        &format!("{count} 条动态"),
                        &meta,
                        status["unreadCount"].as_u64().unwrap_or(0),
                        self.selected_status == Some(index),
                    ) {
                        self.selected_status = Some(index);
                        self.detail = None;
                    }
                }
            });
    }

    fn channel_sidebar(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let filter = self.filter.to_lowercase();
        let rows = self
            .channels
            .iter()
            .enumerate()
            .filter_map(|(index, channel)| {
                if channel["isJoined"].as_bool() == Some(false) {
                    return None;
                }
                let id = channel["id"].as_str().unwrap_or("unknown");
                let title = channel["title"].as_str().unwrap_or(id);
                (filter.is_empty()
                    || title.to_lowercase().contains(&filter)
                    || id.to_lowercase().contains(&filter))
                .then(|| (index, channel.clone(), id.to_owned(), title.to_owned()))
            })
            .collect::<Vec<_>>();
        if rows.is_empty() {
            sidebar_empty(ui, "没有已加入的频道");
            return;
        }
        egui::ScrollArea::vertical()
            .id_salt("viewer_channel_sidebar_scroll")
            .show(ui, |ui| {
                for (index, channel, id, title) in rows {
                    let joined = channel["isJoined"].as_bool().unwrap_or(false);
                    let subtitle = if joined { "已加入" } else { "未加入" };
                    if self.sidebar_row(
                        ui,
                        context,
                        &id,
                        &title,
                        subtitle,
                        channel["membershipType"].as_str().unwrap_or("频道"),
                        channel["unreadCount"].as_u64().unwrap_or(0),
                        self.selected_channel == Some(index),
                    ) {
                        self.selected_channel = Some(index);
                        self.detail = None;
                    }
                }
            });
    }

    fn call_sidebar(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let filter = self.filter.to_lowercase();
        let rows = self
            .calls
            .iter()
            .enumerate()
            .filter_map(|(index, call)| {
                let id = call["peerId"]
                    .as_str()
                    .or_else(|| call["contactId"].as_str())
                    .unwrap_or("unknown");
                let title = self.display_name(id);
                (filter.is_empty()
                    || title.to_lowercase().contains(&filter)
                    || id.to_lowercase().contains(&filter))
                .then(|| (index, call.clone(), id.to_owned(), title))
            })
            .collect::<Vec<_>>();
        if rows.is_empty() {
            sidebar_empty(ui, "没有可查看的通话记录");
            return;
        }
        egui::ScrollArea::vertical()
            .id_salt("viewer_call_sidebar_scroll")
            .show(ui, |ui| {
                for (index, call, id, title) in rows {
                    let subtitle = format!(
                        "{} · {}",
                        call_direction_label(&call),
                        call_type_label(&call)
                    );
                    let meta = call["timestamp"]
                        .as_str()
                        .map_or_else(|| "时间未知".to_owned(), short_time);
                    if self.sidebar_row(
                        ui,
                        context,
                        &id,
                        &title,
                        &subtitle,
                        &meta,
                        0,
                        self.selected_call == Some(index),
                    ) {
                        self.selected_call = Some(index);
                        self.detail = None;
                    }
                }
            });
    }

    fn more_sidebar(&mut self, ui: &mut egui::Ui) {
        let filter = self.filter.to_lowercase();
        let rows = self
            .more_datasets
            .iter()
            .enumerate()
            .filter(|(_, dataset)| {
                filter.is_empty() || dataset.title.to_lowercase().contains(&filter)
            })
            .map(|(index, dataset)| (index, dataset.clone()))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            sidebar_empty(ui, "没有其他数据集");
            return;
        }
        egui::ScrollArea::vertical()
            .id_salt("viewer_more_sidebar_scroll")
            .show(ui, |ui| {
                for (index, dataset) in rows {
                    let selected = self.selected_more == Some(index);
                    let response = egui::Frame::new()
                        .fill(if selected {
                            SELECTED_SURFACE
                        } else {
                            LIST_SURFACE
                        })
                        .corner_radius(8.0)
                        .inner_margin(egui::Margin::symmetric(10, 10))
                        .show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.label(RichText::new(&dataset.title).color(TEXT_PRIMARY).strong());
                            ui.label(
                                RichText::new(relative_display(
                                    self.session_path.as_deref(),
                                    &dataset.path,
                                ))
                                .small()
                                .color(TEXT_SECONDARY),
                            );
                        })
                        .response
                        .interact(egui::Sense::click());
                    if response.clicked() {
                        if let Err(error) = self.load_more_dataset(index) {
                            self.error = Some(error.to_string());
                        }
                        self.detail = None;
                    }
                    ui.add_space(3.0);
                }
            });
    }

    #[allow(clippy::too_many_arguments)]
    fn sidebar_row(
        &mut self,
        ui: &mut egui::Ui,
        context: &egui::Context,
        avatar_id: &str,
        title: &str,
        subtitle: &str,
        meta: &str,
        unread: u64,
        selected: bool,
    ) -> bool {
        let response = egui::Frame::new()
            .fill(if selected {
                SELECTED_SURFACE
            } else {
                LIST_SURFACE
            })
            .corner_radius(8.0)
            .inner_margin(egui::Margin::symmetric(8, 8))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    self.avatar(ui, context, avatar_id, title, 42.0);
                    ui.vertical(|ui| {
                        ui.set_width((ui.available_width() - 4.0).max(80.0));
                        ui.horizontal(|ui| {
                            ui.add(
                                egui::Label::new(RichText::new(title).color(TEXT_PRIMARY).strong())
                                    .truncate(),
                            );
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.label(RichText::new(meta).small().color(TEXT_SECONDARY));
                                },
                            );
                        });
                        ui.horizontal(|ui| {
                            ui.add(
                                egui::Label::new(
                                    RichText::new(subtitle).small().color(TEXT_SECONDARY),
                                )
                                .truncate(),
                            );
                            if unread > 0 {
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        ui.label(
                                            RichText::new(unread.to_string())
                                                .small()
                                                .color(Color32::WHITE)
                                                .background_color(ACCENT),
                                        );
                                    },
                                );
                            }
                        });
                    });
                });
            })
            .response
            .interact(egui::Sense::click());
        ui.add_space(3.0);
        response.clicked()
    }

    fn load_chat(&mut self, index: usize) -> anyhow::Result<()> {
        let chat = self
            .chats
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("会话索引无效"))?;
        let chat_record = read_json(&chat.directory.join("chat.json"))?;
        let messages = read_dataset_array(&chat.directory, "messages")?;
        let message_days = message_day_markers(&messages);
        let participants = read_dataset_array(&chat.directory, "participants")?;
        let message_events = read_dataset_array(&chat.directory, "message-events")?;
        let reactions = read_dataset_array(&chat.directory, "reactions")?;
        let receipts = read_dataset_array(&chat.directory, "receipts")?;
        let poll_votes = read_dataset_array(&chat.directory, "poll-votes")?;
        let group_events = read_dataset_array(&chat.directory, "group-events")?;
        let media = read_dataset_array(&chat.directory.join("media"), "index")?;
        let history = read_json(&chat.directory.join("history.json")).unwrap_or(Value::Null);
        self.selected_chat = Some(index);
        self.chat_data = Some(ChatData {
            chat: chat_record,
            messages,
            message_days,
            participants,
            message_events,
            reactions,
            receipts,
            poll_votes,
            group_events,
            media,
            history,
        });
        self.detail = None;
        Ok(())
    }

    fn load_more_dataset(&mut self, index: usize) -> anyhow::Result<()> {
        let dataset = self
            .more_datasets
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("数据集索引无效"))?;
        self.more_records = normalize_records(read_data_file(&dataset.path)?);
        self.selected_more = Some(index);
        Ok(())
    }

    fn display_name(&self, id: &str) -> String {
        self.names
            .get(id)
            .cloned()
            .unwrap_or_else(|| compact_id(id))
    }

    fn avatar(
        &mut self,
        ui: &mut egui::Ui,
        context: &egui::Context,
        id: &str,
        title: &str,
        size: f32,
    ) {
        let path = self.avatars.get(id).cloned();
        if let Some(path) = path
            && let Some(texture) = self.load_texture(context, &path)
        {
            ui.add(
                egui::Image::new((texture.id(), egui::vec2(size, size))).corner_radius(size / 2.0),
            );
            return;
        }
        let (rect, _) = ui.allocate_exact_size(egui::vec2(size, size), egui::Sense::hover());
        ui.painter()
            .circle_filled(rect.center(), size / 2.0, SELECTED_SURFACE);
        let initial = title
            .chars()
            .find(|character| !character.is_whitespace())
            .unwrap_or('?');
        ui.painter().text(
            rect.center(),
            egui::Align2::CENTER_CENTER,
            initial,
            egui::FontId::proportional(size * 0.42),
            TEXT_PRIMARY,
        );
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

impl ViewerState {
    fn content(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        match self.section {
            ViewerSection::Chats => self.chat_content(ui, context),
            ViewerSection::Statuses => self.status_content(ui, context),
            ViewerSection::Channels => self.channel_content(ui, context),
            ViewerSection::Calls => self.call_content(ui, context),
            ViewerSection::More => self.more_content(ui),
        }
    }

    #[allow(clippy::too_many_lines)]
    fn chat_content(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let (chat_record, messages, message_days, participant_count, media_count, reactions) =
            if let Some(chat_data) = self.chat_data.as_ref() {
                (
                    chat_data.chat.clone(),
                    chat_data.messages.clone(),
                    chat_data.message_days.clone(),
                    chat_data.participants.len(),
                    chat_data.media.len(),
                    chat_data.reactions.clone(),
                )
            } else {
                empty_state(ui, "选择一个聊天", "左侧列出了此次提取中保存的会话。");
                return;
            };
        let chat_id = chat_record["id"].as_str().unwrap_or("unknown").to_owned();
        let title = chat_record["title"].as_str().unwrap_or(&chat_id).to_owned();

        section_header(ui, |ui| {
            self.avatar(ui, context, &chat_id, &title, 42.0);
            ui.vertical(|ui| {
                ui.label(
                    RichText::new(&title)
                        .color(TEXT_PRIMARY)
                        .strong()
                        .size(17.0),
                );
                ui.label(
                    RichText::new(format!(
                        "{} 名成员 · {} 条消息 · {} 个媒体记录",
                        participant_count,
                        messages.len(),
                        media_count
                    ))
                    .small()
                    .color(TEXT_SECONDARY),
                );
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("媒体").clicked() {
                    self.detail = Some(DetailView::MediaList);
                }
                if ui.button("成员").clicked() {
                    self.detail = Some(DetailView::Members);
                }
                if ui.button("会话信息").clicked() {
                    self.detail = Some(DetailView::ChatInfo);
                }
                if ui.button("历史完整性").clicked() {
                    self.detail = Some(DetailView::History);
                }
            });
        });

        if messages.is_empty() {
            empty_state(ui, "此会话没有消息", "会话信息仍可从顶部入口查看。");
            return;
        }

        egui::Frame::new()
            .fill(CHAT_SURFACE)
            .inner_margin(egui::Margin::symmetric(14, 10))
            .show(ui, |ui| {
                let height = ui.available_height();
                let row_height = 112.0;
                egui::ScrollArea::vertical()
                    .id_salt(format!("viewer_chat_timeline_{chat_id}"))
                    .auto_shrink([false, false])
                    .stick_to_bottom(true)
                    .max_height(height)
                    .show_rows(ui, row_height, messages.len(), |ui, range| {
                        for index in range {
                            let day = message_days.get(index).and_then(Clone::clone);
                            let day_height = if day.is_some() { 27.0 } else { 0.0 };
                            if let Some(day) = day {
                                ui.vertical_centered(|ui| {
                                    egui::Frame::new()
                                        .fill(HEADER_SURFACE)
                                        .corner_radius(10.0)
                                        .inner_margin(egui::Margin::symmetric(9, 4))
                                        .show(ui, |ui| {
                                            ui.label(
                                                RichText::new(day).small().color(TEXT_SECONDARY),
                                            );
                                        });
                                });
                            }
                            if let Some(message) = messages.get(index) {
                                let from_me = message["fromMe"].as_bool().unwrap_or(false);
                                let message_id = message["id"].as_str().unwrap_or_default();
                                let reaction_count = related_count(&reactions, message_id);
                                let sender = if from_me {
                                    "我".to_owned()
                                } else {
                                    message["senderId"].as_str().map_or_else(
                                        || "对方".to_owned(),
                                        |id| self.display_name(id),
                                    )
                                };
                                let timestamp = message["timestamp"]
                                    .as_str()
                                    .map_or_else(|| "时间未知".to_owned(), short_time);
                                let preview = message_bubble_preview(message);
                                let quoted = message["quotedMessageId"].as_str().is_some();
                                let maximum_bubble_width =
                                    (ui.available_width() * 0.72).clamp(240.0, 680.0);
                                let preview_characters =
                                    u8::try_from(preview.chars().count().min(72)).unwrap_or(72);
                                let estimated_bubble_width =
                                    f32::from(preview_characters) * 8.0 + 112.0;
                                let bubble_width =
                                    estimated_bubble_width.clamp(220.0, maximum_bubble_width);

                                let desired_bubble_height: f32 =
                                    if quoted || preview.chars().count() > 48 {
                                        82.0
                                    } else {
                                        66.0
                                    };
                                let bubble_height =
                                    desired_bubble_height.min(row_height - day_height - 8.0);
                                let row_width = ui.available_width();
                                let (row_rect, _) = ui.allocate_exact_size(
                                    egui::vec2(row_width, bubble_height),
                                    egui::Sense::hover(),
                                );
                                let bubble_width = bubble_width.min(row_rect.width());
                                let bubble_left = if from_me {
                                    row_rect.right() - bubble_width
                                } else {
                                    row_rect.left()
                                };
                                let bubble_rect = egui::Rect::from_min_size(
                                    egui::pos2(bubble_left, row_rect.top()),
                                    egui::vec2(bubble_width, bubble_height),
                                );
                                let mut bubble_ui = ui.new_child(
                                    egui::UiBuilder::new()
                                        .id_salt((chat_id.as_str(), index, "message_bubble"))
                                        .max_rect(bubble_rect)
                                        .layout(egui::Layout::top_down(egui::Align::Min)),
                                );
                                let response = egui::Frame::new()
                                    .fill(if from_me {
                                        OUTGOING_BUBBLE
                                    } else {
                                        INCOMING_BUBBLE
                                    })
                                    .corner_radius(9.0)
                                    .inner_margin(egui::Margin::symmetric(11, 8))
                                    .show(&mut bubble_ui, |ui| {
                                        ui.set_width(bubble_width - 22.0);
                                        ui.set_max_height(bubble_height - 16.0);
                                        if !from_me {
                                            ui.label(
                                                RichText::new(&sender)
                                                    .small()
                                                    .strong()
                                                    .color(ACCENT),
                                            );
                                        }
                                        if quoted {
                                            ui.label(
                                                RichText::new("引用了一条消息")
                                                    .small()
                                                    .italics()
                                                    .color(TEXT_SECONDARY),
                                            );
                                        }
                                        ui.add(
                                            egui::Label::new(
                                                RichText::new(preview).color(TEXT_PRIMARY),
                                            )
                                            .wrap(),
                                        );
                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                ui.label(
                                                    RichText::new(timestamp)
                                                        .small()
                                                        .color(TEXT_SECONDARY),
                                                );
                                                if reaction_count > 0 {
                                                    ui.label(
                                                        RichText::new(format!(
                                                            "反应 {reaction_count}"
                                                        ))
                                                        .small()
                                                        .color(TEXT_SECONDARY),
                                                    );
                                                }
                                            },
                                        );
                                    })
                                    .response
                                    .interact(egui::Sense::click());
                                if response.clicked() {
                                    self.detail = Some(DetailView::Message(index));
                                }
                                ui.add_space((row_height - day_height - bubble_height).max(0.0));
                            } else {
                                ui.add_space(row_height - day_height);
                            }
                        }
                    });
            });
    }

    fn status_content(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let Some(index) = self.selected_status else {
            empty_state(ui, "没有动态", "当前导出结果没有可观察到的动态记录。");
            return;
        };
        let Some(status) = self.statuses.get(index).cloned() else {
            empty_state(ui, "动态不可用", "所选动态记录不存在。");
            return;
        };
        let publisher = status["publisherId"]
            .as_str()
            .or_else(|| status["id"].as_str())
            .unwrap_or("unknown")
            .to_owned();
        let title = self.display_name(&publisher);
        let items = status["items"].as_array().cloned().unwrap_or_default();

        section_header(ui, |ui| {
            self.avatar(ui, context, &publisher, &title, 42.0);
            ui.vertical(|ui| {
                ui.label(
                    RichText::new(&title)
                        .color(TEXT_PRIMARY)
                        .strong()
                        .size(17.0),
                );
                ui.label(
                    RichText::new(format!("{} 条动态", items.len()))
                        .small()
                        .color(TEXT_SECONDARY),
                );
            });
        });

        if items.is_empty() {
            empty_state(ui, "此发布者没有动态项目", "仅保留了发布者级别的动态信息。");
            return;
        }
        scroll_surface(ui, "viewer_status_content_scroll", |ui| {
            for (item_index, item) in items.iter().enumerate() {
                let timestamp =
                    record_timestamp(item).map_or_else(|| "时间未知".to_owned(), short_time);
                let expires = item["expiresAt"]
                    .as_str()
                    .or_else(|| status["expiresAt"].as_str())
                    .map_or_else(|| "未知".to_owned(), short_time);
                let preview = message_preview(item);
                parsed_card(ui, |ui| {
                    ui.label(RichText::new(preview).color(TEXT_PRIMARY).size(16.0));
                    ui.add_space(4.0);
                    ui.label(
                        RichText::new(format!("发布：{timestamp} · 过期：{expires}"))
                            .small()
                            .color(TEXT_SECONDARY),
                    );
                    if item["hasMedia"].as_bool().unwrap_or(false) || item["media"].is_object() {
                        ui.label(
                            RichText::new(format!(
                                "媒体：{}",
                                item["type"].as_str().unwrap_or("未知类型")
                            ))
                            .color(ACCENT),
                        );
                    }
                    if ui.button("查看解析详情").clicked() {
                        self.detail = Some(DetailView::StatusItem {
                            publisher: index,
                            item: item_index,
                        });
                    }
                });
                ui.add_space(8.0);
            }
        });
    }

    fn channel_content(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let Some(index) = self.selected_channel else {
            empty_state(ui, "没有频道", "当前导出结果没有已加入的频道。");
            return;
        };
        let Some(channel) = self.channels.get(index).cloned() else {
            empty_state(ui, "频道不可用", "所选频道记录不存在。");
            return;
        };
        let channel_id = channel["id"].as_str().unwrap_or("unknown").to_owned();
        let title = channel["title"].as_str().unwrap_or(&channel_id).to_owned();
        let events = channel_events_for(&self.channel_events, &channel_id);
        let media = channel_media_for(&self.channel_media, &channel_id);

        section_header(ui, |ui| {
            self.avatar(ui, context, &channel_id, &title, 42.0);
            ui.vertical(|ui| {
                ui.label(
                    RichText::new(&title)
                        .color(TEXT_PRIMARY)
                        .strong()
                        .size(17.0),
                );
                ui.label(
                    RichText::new(format!(
                        "{} 条频道记录 · {} 个媒体记录",
                        events.len(),
                        media.len()
                    ))
                    .small()
                    .color(TEXT_SECONDARY),
                );
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("频道信息").clicked() {
                    self.detail = Some(DetailView::ChannelInfo(index));
                }
                if ui.button(format!("媒体 {}", media.len())).clicked() {
                    self.detail = Some(DetailView::ChannelMedia(index));
                }
            });
        });

        scroll_surface(ui, "viewer_channel_content_scroll", |ui| {
            let description = channel["description"]
                .as_str()
                .unwrap_or("此频道没有说明。");
            egui::Frame::new()
                .fill(HEADER_SURFACE)
                .corner_radius(9.0)
                .inner_margin(egui::Margin::same(12))
                .show(ui, |ui| {
                    ui.label(RichText::new("频道说明").strong().color(ACCENT));
                    ui.add(egui::Label::new(description).wrap());
                });
            ui.add_space(10.0);

            if events.is_empty() {
                empty_state(
                    ui,
                    "没有频道消息",
                    "频道信息已保存，但没有发现频道事件记录。",
                );
            }
            for (event_index, event) in &events {
                let preview = message_preview(event);
                let timestamp =
                    record_timestamp(event).map_or_else(|| "时间未知".to_owned(), short_time);
                let response = egui::Frame::new()
                    .fill(INCOMING_BUBBLE)
                    .corner_radius(9.0)
                    .inner_margin(egui::Margin::symmetric(12, 9))
                    .show(ui, |ui| {
                        ui.set_max_width((ui.available_width() * 0.76).max(300.0));
                        ui.label(RichText::new(preview).color(TEXT_PRIMARY));
                        ui.label(RichText::new(timestamp).small().color(TEXT_SECONDARY));
                    })
                    .response
                    .interact(egui::Sense::click());
                if response.clicked() {
                    self.detail = Some(DetailView::ChannelEvent(*event_index));
                }
                ui.add_space(7.0);
            }
        });
    }

    fn call_content(&mut self, ui: &mut egui::Ui, context: &egui::Context) {
        let Some(index) = self.selected_call else {
            empty_state(ui, "没有通话记录", "当前导出结果没有可观察到的通话。");
            return;
        };
        let Some(call) = self.calls.get(index).cloned() else {
            empty_state(ui, "通话不可用", "所选通话记录不存在。");
            return;
        };
        let peer_id = call["peerId"]
            .as_str()
            .or_else(|| call["contactId"].as_str())
            .unwrap_or("unknown")
            .to_owned();
        let title = self.display_name(&peer_id);

        section_header(ui, |ui| {
            self.avatar(ui, context, &peer_id, &title, 42.0);
            ui.vertical(|ui| {
                ui.label(
                    RichText::new(&title)
                        .color(TEXT_PRIMARY)
                        .strong()
                        .size(17.0),
                );
                ui.label(
                    RichText::new(format!(
                        "{} · {}",
                        call_direction_label(&call),
                        call_type_label(&call)
                    ))
                    .small()
                    .color(TEXT_SECONDARY),
                );
            });
        });

        egui::Frame::new()
            .fill(CHAT_SURFACE)
            .inner_margin(egui::Margin::same(24))
            .show(ui, |ui| {
                ui.vertical_centered(|ui| {
                    self.avatar(ui, context, &peer_id, &title, 82.0);
                    ui.add_space(10.0);
                    ui.heading(RichText::new(&title).color(TEXT_PRIMARY));
                    ui.label(RichText::new(&peer_id).small().color(TEXT_SECONDARY));
                    ui.add_space(16.0);
                    egui::Frame::new()
                        .fill(HEADER_SURFACE)
                        .corner_radius(10.0)
                        .inner_margin(egui::Margin::same(16))
                        .show(ui, |ui| {
                            semantic_row(
                                ui,
                                "时间",
                                call["timestamp"].as_str().unwrap_or("时间未知"),
                            );
                            semantic_row(ui, "方向", call_direction_label(&call));
                            semantic_row(ui, "类型", call_type_label(&call));
                            semantic_row(
                                ui,
                                "时长",
                                format_duration(call["durationSeconds"].as_u64()),
                            );
                            semantic_row(
                                ui,
                                "参与者",
                                call["participantIds"]
                                    .as_array()
                                    .map_or(0, Vec::len)
                                    .to_string(),
                            );
                            semantic_row(ui, "结果", call_result_label(&call));
                        });
                    ui.add_space(14.0);
                    if ui.button("查看完整解析详情").clicked() {
                        self.detail = Some(DetailView::Call(index));
                    }
                });
            });
    }

    fn more_content(&mut self, ui: &mut egui::Ui) {
        let Some(dataset_index) = self.selected_more else {
            empty_state(ui, "没有更多数据", "能力状态、社群和标签等会显示在这里。");
            return;
        };
        let Some(dataset) = self.more_datasets.get(dataset_index).cloned() else {
            empty_state(ui, "数据集不可用", "所选数据集不存在。");
            return;
        };
        let records = self.more_records.clone();
        section_header(ui, |ui| {
            ui.vertical(|ui| {
                ui.label(
                    RichText::new(&dataset.title)
                        .color(TEXT_PRIMARY)
                        .strong()
                        .size(17.0),
                );
                ui.label(
                    RichText::new(format!("{} 条解析记录", records.len()))
                        .small()
                        .color(TEXT_SECONDARY),
                );
            });
        });

        if records.is_empty() {
            empty_state(ui, "数据集为空", "该数据集文件存在，但没有可显示的记录。");
            return;
        }
        scroll_surface(ui, "viewer_more_content_scroll", |ui| {
            for (index, record) in records.iter().enumerate() {
                let title = record_title(record, index);
                let summary = record_summary(record);
                let response = egui::Frame::new()
                    .fill(INCOMING_BUBBLE)
                    .corner_radius(8.0)
                    .inner_margin(egui::Margin::same(11))
                    .show(ui, |ui| {
                        ui.label(RichText::new(title).color(TEXT_PRIMARY).strong());
                        ui.label(RichText::new(summary).small().color(TEXT_SECONDARY));
                    })
                    .response
                    .interact(egui::Sense::click());
                if response.clicked() {
                    self.detail = Some(DetailView::MoreRecord(index));
                }
                ui.add_space(6.0);
            }
        });
    }
}

impl ViewerState {
    #[allow(clippy::too_many_lines)]
    fn detail_panel(&mut self, ui: &mut egui::Ui, context: &egui::Context, compact: bool) {
        let Some(detail) = self.detail.clone() else {
            return;
        };
        egui::Frame::new()
            .fill(LIST_SURFACE)
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    if compact && ui.button("返回").clicked() {
                        self.detail = None;
                    }
                    ui.heading(
                        RichText::new(detail_title(&detail))
                            .color(TEXT_PRIMARY)
                            .size(18.0),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("关闭").clicked() {
                            self.detail = None;
                        }
                    });
                });
                ui.separator();
                egui::ScrollArea::vertical()
                    .id_salt("viewer_detail_drawer_scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| match detail {
                        DetailView::Message(index) => self.message_detail(ui, context, index),
                        DetailView::ChatInfo => {
                            if let Some(value) =
                                self.chat_data.as_ref().map(|chat| chat.chat.clone())
                            {
                                show_semantic_value(ui, &value, 0);
                            }
                        }
                        DetailView::Members => {
                            let records = self
                                .chat_data
                                .as_ref()
                                .map(|chat| chat.participants.clone())
                                .unwrap_or_default();
                            show_record_list(ui, &records, "没有成员记录");
                        }
                        DetailView::History => {
                            if let Some(value) =
                                self.chat_data.as_ref().map(|chat| chat.history.clone())
                            {
                                show_semantic_value(ui, &value, 0);
                            }
                        }
                        DetailView::MediaList => {
                            let media = self
                                .chat_data
                                .as_ref()
                                .map(|chat| chat.media.clone())
                                .unwrap_or_default();
                            if media.is_empty() {
                                empty_state(ui, "没有媒体记录", "此会话没有附件索引记录。");
                            }
                            for item in &media {
                                self.media_item(ui, context, item);
                                ui.add_space(8.0);
                            }
                        }
                        DetailView::StatusItem { publisher, item } => {
                            let value = self
                                .statuses
                                .get(publisher)
                                .and_then(|status| status["items"].as_array())
                                .and_then(|items| items.get(item))
                                .cloned();
                            if let Some(value) = value {
                                show_semantic_value(ui, &value, 0);
                            }
                        }
                        DetailView::ChannelInfo(index) => {
                            if let Some(value) = self.channels.get(index).cloned() {
                                show_semantic_value(ui, &value, 0);
                            }
                        }
                        DetailView::ChannelEvent(index) => {
                            if let Some(value) = self.channel_events.get(index).cloned() {
                                let message_id = value["id"].as_str().unwrap_or_default();
                                let media = self
                                    .channel_media
                                    .iter()
                                    .filter(|item| item["messageId"].as_str() == Some(message_id))
                                    .cloned()
                                    .collect::<Vec<_>>();
                                show_semantic_value(ui, &value, 0);
                                if !media.is_empty() {
                                    ui.add_space(12.0);
                                    detail_subheading(ui, "频道附件");
                                    for item in &media {
                                        self.media_item(ui, context, item);
                                        ui.add_space(8.0);
                                    }
                                }
                            }
                        }
                        DetailView::ChannelMedia(index) => {
                            if let Some(channel_id) = self
                                .channels
                                .get(index)
                                .and_then(|channel| channel["id"].as_str())
                                .map(ToOwned::to_owned)
                            {
                                let media = channel_media_for(&self.channel_media, &channel_id);
                                if media.is_empty() {
                                    empty_state(
                                        ui,
                                        "没有频道媒体",
                                        "该时间范围内没有媒体索引记录。",
                                    );
                                }
                                for item in &media {
                                    self.media_item(ui, context, item);
                                    ui.add_space(8.0);
                                }
                            }
                        }
                        DetailView::Call(index) => {
                            if let Some(value) = self.calls.get(index).cloned() {
                                show_semantic_value(ui, &value, 0);
                            }
                        }
                        DetailView::MoreRecord(index) => {
                            if let Some(value) = self.more_records.get(index).cloned() {
                                show_semantic_value(ui, &value, 0);
                            }
                        }
                    });
            });
    }

    fn message_detail(&mut self, ui: &mut egui::Ui, context: &egui::Context, index: usize) {
        let Some(chat) = self.chat_data.as_ref() else {
            return;
        };
        let Some(message) = chat.messages.get(index).cloned() else {
            empty_state(ui, "消息不存在", "所选消息已不在当前会话中。");
            return;
        };
        let message_id = message["id"].as_str().unwrap_or_default().to_owned();
        let quoted = message["quotedMessageId"]
            .as_str()
            .and_then(|quoted_id| {
                chat.messages
                    .iter()
                    .find(|candidate| candidate["id"].as_str() == Some(quoted_id))
            })
            .cloned();
        let events = related_records(&chat.message_events, &message_id);
        let reactions = related_records(&chat.reactions, &message_id);
        let receipts = related_records(&chat.receipts, &message_id);
        let poll_votes = related_records(&chat.poll_votes, &message_id);
        let group_events = related_records(&chat.group_events, &message_id);
        let media = chat
            .media
            .iter()
            .filter(|record| record["messageId"].as_str() == Some(&message_id))
            .cloned()
            .collect::<Vec<_>>();

        ui.label(
            RichText::new(message_preview(&message))
                .size(16.0)
                .color(TEXT_PRIMARY),
        );
        ui.add_space(8.0);
        show_semantic_value(ui, &message, 0);

        if let Some(quoted) = quoted {
            ui.add_space(12.0);
            detail_subheading(ui, "引用消息");
            parsed_card(ui, |ui| show_semantic_value(ui, &quoted, 0));
        }
        for (title, records) in [
            ("消息事件", events),
            ("反应", reactions),
            ("回执", receipts),
            ("投票", poll_votes),
            ("群事件", group_events),
        ] {
            if !records.is_empty() {
                ui.add_space(12.0);
                detail_subheading(ui, &format!("{title} ({})", records.len()));
                show_record_list(ui, &records, "");
            }
        }
        if !media.is_empty() {
            ui.add_space(12.0);
            detail_subheading(ui, &format!("附件状态 ({})", media.len()));
            for item in &media {
                self.media_item(ui, context, item);
                ui.add_space(8.0);
            }
        }
    }

    fn media_item(&mut self, ui: &mut egui::Ui, context: &egui::Context, item: &Value) {
        let role = item["role"].as_str().unwrap_or("unknown");
        let status = item["status"].as_str().unwrap_or("unknown");
        let available = matches!(status, "available" | "complete");
        parsed_card(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.colored_label(
                    if available { ACCENT } else { ERROR },
                    RichText::new(format!("{} · {}", role_label(role), status_label(status)))
                        .strong(),
                );
                ui.label(
                    RichText::new(
                        item["originalFileName"]
                            .as_str()
                            .or_else(|| item["fileName"].as_str())
                            .unwrap_or("未命名文件"),
                    )
                    .color(TEXT_PRIMARY),
                );
            });
            let path = item["relativePath"]
                .as_str()
                .and_then(|relative| self.session_path.as_ref().map(|root| root.join(relative)))
                .filter(|candidate| candidate.is_file());
            if let Some(path) = path {
                let mime = item["mimeType"].as_str().unwrap_or("");
                if mime.starts_with("image/")
                    && let Some(texture) = self.load_texture(context, &path)
                {
                    let source = texture.size_vec2();
                    let scale = (290.0 / source.x.max(1.0))
                        .min(190.0 / source.y.max(1.0))
                        .min(1.0);
                    ui.add(egui::Image::new((texture.id(), source * scale)).corner_radius(6.0));
                }
                ui.label(
                    RichText::new(format!(
                        "{} · {} bytes",
                        if mime.is_empty() {
                            "未知类型"
                        } else {
                            mime
                        },
                        item["byteLength"].as_u64().unwrap_or(0)
                    ))
                    .small()
                    .color(TEXT_SECONDARY),
                );
                if ui.button("打开文件").clicked() {
                    open_file(&path);
                }
            } else {
                let reason = item["failureReason"]
                    .as_str()
                    .or_else(|| item["reason"].as_str())
                    .unwrap_or("文件不可用");
                ui.add(egui::Label::new(RichText::new(reason).color(ERROR).small()).wrap());
            }
        });
    }
}

fn divider(ui: &mut egui::Ui) {
    let (rect, _) =
        ui.allocate_exact_size(egui::vec2(1.0, ui.available_height()), egui::Sense::hover());
    ui.painter().rect_filled(rect, 0.0, DIVIDER);
}

fn detail_replaces_content(width: f32, detail_open: bool) -> bool {
    detail_open && width < 1200.0
}

fn section_header(ui: &mut egui::Ui, content: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::new()
        .fill(HEADER_SURFACE)
        .inner_margin(egui::Margin::symmetric(14, 9))
        .show(ui, |ui| {
            ui.horizontal(content);
        });
}

fn scroll_surface(
    ui: &mut egui::Ui,
    id: impl std::hash::Hash,
    content: impl FnOnce(&mut egui::Ui),
) {
    egui::Frame::new()
        .fill(CHAT_SURFACE)
        .inner_margin(egui::Margin::symmetric(16, 14))
        .show(ui, |ui| {
            egui::ScrollArea::vertical()
                .id_salt(id)
                .auto_shrink([false, false])
                .show(ui, content);
        });
}

fn parsed_card(ui: &mut egui::Ui, content: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::new()
        .fill(INCOMING_BUBBLE)
        .corner_radius(8.0)
        .inner_margin(egui::Margin::same(11))
        .show(ui, content);
}

fn empty_state(ui: &mut egui::Ui, title: &str, body: &str) {
    let available = ui.available_size();
    ui.allocate_ui_with_layout(
        available,
        egui::Layout::top_down_justified(egui::Align::Center),
        |ui| {
            ui.add_space((available.y * 0.28).clamp(28.0, 190.0));
            ui.heading(RichText::new(title).color(TEXT_PRIMARY));
            ui.label(RichText::new(body).color(TEXT_SECONDARY));
        },
    );
}

fn sidebar_empty(ui: &mut egui::Ui, text: &str) {
    ui.add_space(18.0);
    ui.vertical_centered(|ui| {
        ui.label(RichText::new(text).color(TEXT_SECONDARY));
    });
}

fn detail_subheading(ui: &mut egui::Ui, title: &str) {
    ui.label(RichText::new(title).color(ACCENT).strong().size(15.0));
    ui.add_space(4.0);
}

fn detail_title(detail: &DetailView) -> &'static str {
    match detail {
        DetailView::Message(_) => "消息详情",
        DetailView::ChatInfo => "会话信息",
        DetailView::Members => "成员列表",
        DetailView::History => "历史完整性",
        DetailView::MediaList => "媒体文件",
        DetailView::StatusItem { .. } => "动态详情",
        DetailView::ChannelInfo(_) => "频道信息",
        DetailView::ChannelEvent(_) => "频道消息",
        DetailView::ChannelMedia(_) => "频道媒体",
        DetailView::Call(_) => "通话详情",
        DetailView::MoreRecord(_) => "记录详情",
    }
}

fn semantic_row(ui: &mut egui::Ui, label: impl Into<String>, value: impl Into<String>) {
    let label = label.into();
    let value = value.into();
    ui.horizontal_wrapped(|ui| {
        ui.add_sized(
            [92.0, 18.0],
            egui::Label::new(RichText::new(label).small().color(TEXT_SECONDARY)),
        );
        ui.add(egui::Label::new(RichText::new(value).color(TEXT_PRIMARY)).wrap());
    });
    ui.add_space(3.0);
}

fn show_record_list(ui: &mut egui::Ui, records: &[Value], empty: &str) {
    if records.is_empty() {
        if !empty.is_empty() {
            ui.label(RichText::new(empty).color(TEXT_SECONDARY));
        }
        return;
    }
    for (index, record) in records.iter().enumerate() {
        parsed_card(ui, |ui| {
            ui.label(
                RichText::new(record_title(record, index))
                    .color(TEXT_PRIMARY)
                    .strong(),
            );
            show_semantic_value(ui, record, 0);
        });
        ui.add_space(6.0);
    }
}

fn show_semantic_value(ui: &mut egui::Ui, value: &Value, depth: usize) {
    match value {
        Value::Object(object) => {
            let visible = object
                .iter()
                .filter(|(key, value)| !hidden_field(key) && !value.is_null())
                .collect::<Vec<_>>();
            if visible.is_empty() {
                ui.label(RichText::new("没有可显示的解析字段").color(TEXT_SECONDARY));
                return;
            }
            for (key, child) in visible {
                match child {
                    Value::Object(_) | Value::Array(_) if depth < 3 => {
                        egui::CollapsingHeader::new(field_label(key))
                            .id_salt(format!("semantic_{depth}_{key}"))
                            .default_open(depth == 0 && short_collection(child))
                            .show(ui, |ui| show_semantic_value(ui, child, depth + 1));
                    }
                    Value::Object(_) | Value::Array(_) => {
                        semantic_row(ui, field_label(key), compact_collection(child));
                    }
                    _ => semantic_row(ui, field_label(key), value_label(child)),
                }
            }
        }
        Value::Array(values) => {
            if values.is_empty() {
                ui.label(RichText::new("空列表").color(TEXT_SECONDARY));
                return;
            }
            for (index, child) in values.iter().enumerate().take(100) {
                match child {
                    Value::Object(_) | Value::Array(_) => {
                        egui::CollapsingHeader::new(record_title(child, index))
                            .id_salt(format!("semantic_array_{depth}_{index}"))
                            .show(ui, |ui| show_semantic_value(ui, child, depth + 1));
                    }
                    _ => semantic_row(ui, format!("项目 {}", index + 1), value_label(child)),
                }
            }
            if values.len() > 100 {
                ui.label(
                    RichText::new(format!("其余 {} 项请在导出文件中查看", values.len() - 100))
                        .small()
                        .color(TEXT_SECONDARY),
                );
            }
        }
        _ => {
            ui.label(RichText::new(value_label(value)).color(TEXT_PRIMARY));
        }
    }
}

fn hidden_field(key: &str) -> bool {
    key.eq_ignore_ascii_case("raw") || key.starts_with('_') || key.starts_with("__fieldCollector")
}

fn short_collection(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.len() <= 5,
        Value::Object(values) => values.len() <= 7,
        _ => true,
    }
}

fn compact_collection(value: &Value) -> String {
    match value {
        Value::Array(values) => format!("{} 项", values.len()),
        Value::Object(values) => format!("{} 个字段", values.len()),
        _ => value_label(value),
    }
}

fn field_label(key: &str) -> String {
    match key {
        "id" => "ID",
        "chatId" => "会话 ID",
        "channelId" => "频道 ID",
        "messageId" => "消息 ID",
        "senderId" => "发送者",
        "recipientId" => "接收者",
        "publisherId" => "发布者",
        "peerId" => "联系人",
        "contactId" => "联系人 ID",
        "contactName" => "联系人名称",
        "lidId" => "LID 身份",
        "phoneId" => "电话身份 ID",
        "phoneNumber" => "电话号码",
        "formattedPhoneNumber" => "格式化电话号码",
        "deviceId" => "设备 ID",
        "devicePhoneId" => "设备电话身份",
        "phoneResolution" => "电话号码解析状态",
        "phoneSource" => "电话号码来源",
        "accountSource" => "当前账户来源",
        "title" => "标题",
        "name" => "名称",
        "displayName" => "显示名称",
        "savedName" => "通讯录名称",
        "pushName" => "WhatsApp 名称",
        "shortName" => "短名称",
        "verifiedName" => "认证名称",
        "about" => "个人简介",
        "isMe" => "当前账户",
        "isMyContact" => "已保存联系人",
        "isBusiness" => "商业账户",
        "isVerified" => "已认证",
        "isBlocked" => "已屏蔽",
        "isWAContact" => "WhatsApp 用户",
        "canReceiveMessage" => "可接收消息",
        "contactType" => "联系人类型",
        "businessCategory" => "商业类别",
        "businessDescription" => "商业说明",
        "businessEmail" => "商业邮箱",
        "businessWebsite" => "商业网站",
        "description" => "说明",
        "text" => "正文",
        "caption" => "说明文字",
        "type" => "类型",
        "timestamp" => "时间",
        "createdAt" => "创建时间",
        "updatedAt" => "更新时间",
        "expiresAt" => "过期时间",
        "fromMe" => "由我发送",
        "isForwarded" => "已转发",
        "isStarred" => "已加星标",
        "isRevoked" => "已撤回",
        "hasMedia" => "包含媒体",
        "quotedMessageId" => "引用消息 ID",
        "acknowledgement" => "确认状态",
        "participantIds" => "参与者",
        "durationSeconds" => "时长（秒）",
        "direction" => "方向",
        "isVideo" => "视频通话",
        "isGroup" => "群组通话",
        "state" | "status" => "状态",
        "complete" => "已完整提取",
        "method" => "提取方式",
        "reason" => "原因",
        "failureReason" => "失败原因",
        "relativePath" => "相对路径",
        "originalFileName" => "原文件名",
        "mimeType" => "MIME 类型",
        "byteLength" => "文件大小",
        "sha256" => "SHA-256",
        "unreadCount" => "未读数",
        "membershipType" => "成员关系",
        "isJoined" => "已加入",
        "items" => "项目",
        "datasets" => "数据集",
        "capability" => "能力",
        _ => key,
    }
    .to_owned()
}

fn value_label(value: &Value) -> String {
    match value {
        Value::Null => "未提供".to_owned(),
        Value::Bool(value) => yes_no(*value).to_owned(),
        Value::Number(value) => value.to_string(),
        Value::String(value) if value.is_empty() => "空".to_owned(),
        Value::String(value) => value.clone(),
        Value::Array(values) => format!("{} 项", values.len()),
        Value::Object(values) => format!("{} 个字段", values.len()),
    }
}

fn yes_no(value: bool) -> &'static str {
    if value { "是" } else { "否" }
}

fn direction_label(direction: Option<&str>) -> &'static str {
    match direction.unwrap_or_default().to_ascii_lowercase().as_str() {
        "incoming" | "in" | "received" => "呼入",
        "outgoing" | "out" | "placed" => "呼出",
        "missed" => "未接",
        _ => "方向未知",
    }
}

fn call_direction_label(call: &Value) -> &'static str {
    if call["direction"].as_str().is_some() {
        return direction_label(call["direction"].as_str());
    }
    match call["raw"]["id"]["fromMe"].as_bool() {
        Some(true) => "呼出",
        Some(false) => "呼入",
        None => "方向未知",
    }
}

fn call_type_label(call: &Value) -> &'static str {
    if call["isVideo"]
        .as_bool()
        .or_else(|| call["raw"]["isVideoCall"].as_bool())
        .unwrap_or(false)
    {
        "视频通话"
    } else {
        "语音通话"
    }
}

fn call_result_label(call: &Value) -> String {
    let result = call["state"]
        .as_str()
        .or_else(|| call["reason"].as_str())
        .or_else(|| call["raw"]["finalCallOutcome"].as_str())
        .or_else(|| call["raw"]["callOutcome"].as_str());
    match result.map(str::to_ascii_lowercase).as_deref() {
        Some("completed" | "complete") => "已完成".to_owned(),
        Some("missed") => "未接".to_owned(),
        Some("rejected") => "已拒绝".to_owned(),
        Some("failed") => "失败".to_owned(),
        _ => result.map_or_else(|| "未知".to_owned(), ToOwned::to_owned),
    }
}

fn format_duration(seconds: Option<u64>) -> String {
    let Some(seconds) = seconds else {
        return "未知".to_owned();
    };
    if seconds >= 3600 {
        format!(
            "{} 小时 {} 分 {} 秒",
            seconds / 3600,
            seconds % 3600 / 60,
            seconds % 60
        )
    } else if seconds >= 60 {
        format!("{} 分 {} 秒", seconds / 60, seconds % 60)
    } else {
        format!("{seconds} 秒")
    }
}

fn role_label(role: &str) -> &'static str {
    match role {
        "original" => "原件",
        "preview" => "预览",
        "avatar" => "头像",
        _ => "媒体",
    }
}

fn status_label(status: &str) -> &'static str {
    match status {
        "available" | "complete" => "可用",
        "unavailable" => "不可用",
        "failed" | "error" => "失败",
        "partial" => "部分完成",
        "skipped" => "按策略跳过",
        _ => "状态未知",
    }
}

fn related_count(records: &[Value], message_id: &str) -> usize {
    records
        .iter()
        .filter(|record| record["messageId"].as_str() == Some(message_id))
        .count()
}

fn related_records(records: &[Value], message_id: &str) -> Vec<Value> {
    records
        .iter()
        .filter(|record| record["messageId"].as_str() == Some(message_id))
        .cloned()
        .collect()
}

fn message_day_markers(messages: &[Value]) -> Vec<Option<String>> {
    let mut previous = None;
    messages
        .iter()
        .map(|message| {
            let day = record_timestamp(message).and_then(parse_day);
            if day.is_some() && day != previous {
                previous.clone_from(&day);
                day
            } else {
                None
            }
        })
        .collect()
}

fn record_timestamp(value: &Value) -> Option<&str> {
    value["timestamp"]
        .as_str()
        .or_else(|| value["createdAt"].as_str())
        .or_else(|| value["time"].as_str())
}

fn parse_day(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.format("%Y年%m月%d日").to_string())
        .or_else(|| (value.len() >= 10).then(|| value[..10].to_owned()))
}

fn short_time(value: &str) -> String {
    DateTime::parse_from_rfc3339(value).ok().map_or_else(
        || value.chars().take(16).collect(),
        |timestamp| timestamp.format("%m-%d %H:%M").to_string(),
    )
}

fn epoch_to_rfc3339(value: &Value) -> Option<String> {
    let seconds = value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|v| i64::try_from(v).ok()))?;
    DateTime::<Utc>::from_timestamp(seconds, 0).map(|timestamp| timestamp.to_rfc3339())
}

fn compact_id(id: &str) -> String {
    let prefix = id.split('@').next().unwrap_or(id);
    if prefix.chars().count() > 18 {
        format!("{}…", prefix.chars().take(18).collect::<String>())
    } else {
        prefix.to_owned()
    }
}

fn record_title(record: &Value, index: usize) -> String {
    record["title"]
        .as_str()
        .or_else(|| record["name"].as_str())
        .or_else(|| record["displayName"].as_str())
        .or_else(|| record["id"].as_str())
        .or_else(|| record["messageId"].as_str())
        .map_or_else(|| format!("记录 {}", index + 1), ToOwned::to_owned)
}

fn record_summary(record: &Value) -> String {
    let Value::Object(object) = record else {
        return value_label(record);
    };
    let parts = object
        .iter()
        .filter(|(key, value)| {
            !hidden_field(key)
                && !value.is_null()
                && !matches!(key.as_str(), "id" | "title" | "name" | "displayName")
                && !matches!(value, Value::Object(_) | Value::Array(_))
        })
        .take(4)
        .map(|(key, value)| {
            format!(
                "{}：{}",
                field_label(key),
                compact_meta(&value_label(value))
            )
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        "没有额外的解析字段".to_owned()
    } else {
        parts.join(" · ")
    }
}

fn compact_meta(value: &str) -> String {
    let mut result = value.chars().take(48).collect::<String>();
    if value.chars().count() > 48 {
        result.push('…');
    }
    result
}

fn load_chat_summaries(root: &Path) -> anyhow::Result<Vec<ChatSummary>> {
    let chats_root = root.join("chats");
    if !chats_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut directories = fs::read_dir(&chats_root)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    directories.sort();
    let mut chats = Vec::new();
    for directory in directories {
        let chat = read_json(&directory.join("chat.json")).unwrap_or(Value::Null);
        let id = chat["id"].as_str().unwrap_or("unknown_chat").to_owned();
        let title = chat["title"]
            .as_str()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(&id)
            .to_owned();
        let last_activity = chat["lastMessageAt"]
            .as_str()
            .map(ToOwned::to_owned)
            .or_else(|| chat["timestamp"].as_str().map(ToOwned::to_owned))
            .or_else(|| epoch_to_rfc3339(&chat["raw"]["t"]));
        chats.push(ChatSummary {
            directory,
            id,
            title,
            phone: chat["formattedPhoneNumber"]
                .as_str()
                .or_else(|| chat["phoneNumber"].as_str())
                .map(ToOwned::to_owned),
            unread_count: chat["unreadCount"].as_u64().unwrap_or(0),
            last_activity,
        });
    }
    chats.sort_by(|left, right| right.last_activity.cmp(&left.last_activity));
    Ok(chats)
}

fn load_contact_names(root: &Path) -> anyhow::Result<HashMap<String, String>> {
    let contacts_csv = root.join("contacts.csv");
    let contacts_json = root.join("contacts.json");
    let contacts = if contacts_csv.is_file() {
        read_csv(&contacts_csv)?
    } else if contacts_json.is_file() {
        read_optional_array(&contacts_json)
    } else {
        Vec::new()
    };
    let mut names = HashMap::new();
    for contact in contacts {
        let Some(id) = contact["id"].as_str() else {
            continue;
        };
        let name = [
            "displayName",
            "name",
            "pushName",
            "savedName",
            "verifiedName",
        ]
        .into_iter()
        .find_map(|key| {
            contact[key]
                .as_str()
                .filter(|value| !value.trim().is_empty())
        });
        if let Some(name) = name {
            for identity in [
                Some(id),
                contact["lidId"].as_str(),
                contact["phoneId"].as_str(),
                contact["devicePhoneId"].as_str(),
            ]
            .into_iter()
            .flatten()
            {
                names.insert(identity.to_owned(), name.to_owned());
            }
        }
    }
    Ok(names)
}

fn load_avatar_paths(root: &Path) -> HashMap<String, PathBuf> {
    let current = root.join("media/avatars.json");
    let legacy = root.join("avatars/index.json");
    let index = if current.is_file() { current } else { legacy };
    if !index.is_file() {
        return HashMap::new();
    }
    let records = read_optional_array(&index);
    let mut avatars = HashMap::new();
    for record in records {
        let status = record["status"].as_str().unwrap_or_default();
        if !matches!(status, "available" | "complete") {
            continue;
        }
        let Some(contact_id) = record["contactId"]
            .as_str()
            .or_else(|| record["id"].as_str())
        else {
            continue;
        };
        let Some(relative) = record["relativePath"].as_str() else {
            continue;
        };
        let path = root.join(relative);
        if path.is_file() {
            avatars.insert(contact_id.to_owned(), path);
        }
    }
    avatars
}

fn discover_more_datasets(root: &Path) -> anyhow::Result<Vec<MoreDataset>> {
    let mut candidates = [
        "account.json",
        "contacts.csv",
        "contacts.json",
        "chat-lists.json",
        "capabilities.json",
        "media/avatars.json",
        "avatars/index.json",
        "logs/extraction.csv",
        "logs/extraction.json",
    ]
    .into_iter()
    .map(|relative| root.join(relative))
    .filter(|path| path.is_file())
    .collect::<Vec<_>>();

    let global = root.join("global");
    if global.is_dir() {
        candidates.extend(
            fs::read_dir(global)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .is_some_and(|value| value == "json" || value == "csv")
                })
                .filter(|path| {
                    !matches!(
                        path.file_name().and_then(|value| value.to_str()),
                        Some(
                            "statuses.json"
                                | "calls.json"
                                | "channels.json"
                                | "channel-events.json"
                        )
                    )
                }),
        );
    }
    candidates.sort();
    candidates.dedup();
    Ok(candidates
        .into_iter()
        .map(|path| MoreDataset {
            title: dataset_title(&path),
            path,
        })
        .collect())
}

fn dataset_title(path: &Path) -> String {
    match path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "account" => "账号信息",
        "contacts" => "联系人",
        "chat-lists" => "聊天列表",
        "capabilities" => "能力状态",
        "avatars" => "头像索引",
        "index"
            if path
                .parent()
                .and_then(Path::file_name)
                .and_then(|v| v.to_str())
                == Some("avatars") =>
        {
            "头像索引"
        }
        "extraction" => "提取日志",
        "communities" => "社群",
        "community-relations" => "社群关系",
        "presence-snapshots" => "在线状态",
        "labels" => "标签",
        "label-relations" => "标签关系",
        "pinned" => "置顶",
        "media-albums" => "媒体相册",
        "group-events" => "全局群事件",
        stem if !stem.is_empty() => stem,
        _ => "其他数据",
    }
    .to_owned()
}

fn normalize_records(value: Value) -> Vec<Value> {
    match value {
        Value::Array(records) => records,
        Value::Object(mut object) => {
            if let Some(Value::Object(datasets)) = object.remove("datasets") {
                return datasets
                    .into_iter()
                    .map(|(name, value)| match value {
                        Value::Object(mut record) => {
                            record.insert("name".to_owned(), Value::String(name));
                            Value::Object(record)
                        }
                        value => {
                            let mut record = Map::new();
                            record.insert("name".to_owned(), Value::String(name));
                            record.insert("status".to_owned(), value);
                            Value::Object(record)
                        }
                    })
                    .collect();
            }
            vec![Value::Object(object)]
        }
        Value::Null => Vec::new(),
        value => vec![value],
    }
}

fn normalize_statuses(records: Vec<Value>) -> Vec<Value> {
    if records.iter().any(|record| record["items"].is_array()) {
        return records;
    }
    let mut grouped: Vec<Value> = Vec::new();
    for record in records {
        let publisher = record["publisherId"]
            .as_str()
            .or_else(|| record["senderId"].as_str())
            .or_else(|| record["chatId"].as_str())
            .unwrap_or("unknown")
            .to_owned();
        if let Some(group) = grouped
            .iter_mut()
            .find(|group| group["publisherId"].as_str() == Some(&publisher))
        {
            if let Some(items) = group["items"].as_array_mut() {
                items.push(record);
            }
        } else {
            grouped.push(serde_json::json!({
                "publisherId": publisher,
                "items": [record]
            }));
        }
    }
    grouped
}

fn channel_events_for(events: &[Value], channel_id: &str) -> Vec<(usize, Value)> {
    events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event["channelId"].as_str() == Some(channel_id)
                || event["chatId"].as_str() == Some(channel_id)
        })
        .map(|(index, event)| (index, event.clone()))
        .collect()
}

fn channel_media_for(media: &[Value], channel_id: &str) -> Vec<Value> {
    media
        .iter()
        .filter(|record| {
            record["channelId"].as_str() == Some(channel_id)
                || (record["scope"].as_str() == Some("channel")
                    && record["chatId"].as_str() == Some(channel_id))
        })
        .cloned()
        .collect()
}

fn read_json(path: &Path) -> anyhow::Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn read_optional_array(path: &Path) -> Vec<Value> {
    read_json(path)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn read_data_file(path: &Path) -> anyhow::Result<Value> {
    if path.extension().is_some_and(|extension| extension == "csv") {
        return Ok(Value::Array(read_csv(path)?));
    }
    read_json(path)
}

fn read_dataset_array(directory: &Path, stem: &str) -> anyhow::Result<Vec<Value>> {
    let csv = directory.join(format!("{stem}.csv"));
    if csv.is_file() {
        return read_csv(&csv);
    }
    let json = directory.join(format!("{stem}.json"));
    if !json.is_file() {
        return Ok(Vec::new());
    }
    let value = read_json(&json)?;
    Ok(value.as_array().cloned().unwrap_or_default())
}

fn read_csv(path: &Path) -> anyhow::Result<Vec<Value>> {
    let text = String::from_utf8(fs::read(path)?)?;
    parse_csv(text.trim_start_matches('\u{feff}'))
}

fn parse_csv(text: &str) -> anyhow::Result<Vec<Value>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if quoted {
            if character == '"' {
                if characters.peek() == Some(&'"') {
                    characters.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
            continue;
        }
        match character {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(character),
        }
    }
    anyhow::ensure!(!quoted, "CSV quoted field was not closed");
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    let mut rows = rows.into_iter();
    let headers = rows
        .next()
        .ok_or_else(|| anyhow::anyhow!("CSV did not contain a header"))?;
    anyhow::ensure!(
        headers.iter().all(|header| !header.is_empty()),
        "CSV header was empty"
    );
    rows.filter(|row| row.iter().any(|cell| !cell.is_empty()))
        .map(|row| {
            anyhow::ensure!(
                row.len() <= headers.len(),
                "CSV row had more cells than its header"
            );
            let mut object = Map::new();
            for (index, header) in headers.iter().enumerate() {
                let cell = row.get(index).map_or("", String::as_str);
                object.insert(header.clone(), csv_cell_value(header, cell));
            }
            Ok(Value::Object(object))
        })
        .collect()
}

fn csv_cell_value(header: &str, cell: &str) -> Value {
    if cell.is_empty() {
        return Value::Null;
    }
    if matches!(
        header,
        "isMe"
            | "isMyContact"
            | "isBusiness"
            | "isVerified"
            | "fromMe"
            | "isForwarded"
            | "isStarred"
            | "isRevoked"
            | "hasMedia"
            | "isVideo"
            | "isGroup"
            | "isJoined"
    ) && let Ok(value) = cell.parse::<bool>()
    {
        return Value::Bool(value);
    }
    if matches!(
        header,
        "acknowledgement"
            | "state"
            | "mediaSize"
            | "mediaDurationSeconds"
            | "durationSeconds"
            | "unreadCount"
    ) && let Ok(value) = serde_json::from_str::<serde_json::Number>(cell)
    {
        return Value::Number(value);
    }
    Value::String(cell.to_owned())
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
    let mut preview = text.chars().take(180).collect::<String>();
    if text.chars().count() > 180 {
        preview.push('…');
    }
    preview
}

fn message_bubble_preview(message: &Value) -> String {
    let preview = message_preview(message);
    let mut compact = preview.chars().take(88).collect::<String>();
    if preview.chars().count() > 88 {
        compact.push('…');
    }
    compact
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
    use super::{
        ViewerState, call_direction_label, call_result_label, call_type_label, channel_events_for,
        channel_media_for, detail_replaces_content, format_duration, hidden_field,
        load_avatar_paths, looks_like_base64_payload, message_day_markers, message_preview,
        normalize_records, normalize_statuses, parse_csv, read_dataset_array, record_summary,
        relative_display,
    };
    use serde_json::json;
    use std::{fs, path::Path};
    use uuid::Uuid;

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
        let long_message = json!({"type": "chat", "text": "字".repeat(220)});
        assert_eq!(message_preview(&long_message).chars().count(), 181);
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

    #[test]
    fn csv_parser_preserves_commas_quotes_and_multiline_text() -> anyhow::Result<()> {
        let records = parse_csv(
            "id,text,fromMe,acknowledgement\r\nm1,\"第一行,字段\n第二行 \"\"引用\"\"\",true,3\r\n",
        )?;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["id"], "m1");
        assert_eq!(records[0]["text"], "第一行,字段\n第二行 \"引用\"");
        assert_eq!(records[0]["fromMe"], true);
        assert_eq!(records[0]["acknowledgement"], 3);
        Ok(())
    }

    #[test]
    fn legacy_json_dataset_remains_readable() -> anyhow::Result<()> {
        let directory = temporary_directory("legacy-viewer");
        fs::create_dir_all(&directory)?;
        fs::write(
            directory.join("messages.json"),
            br#"[{"id":"legacy-message"}]"#,
        )?;
        let records = read_dataset_array(&directory, "messages")?;
        assert_eq!(records[0]["id"], "legacy-message");
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn csv_message_dataset_is_preferred_and_readable() -> anyhow::Result<()> {
        let directory = temporary_directory("csv-viewer");
        fs::create_dir_all(&directory)?;
        fs::write(
            directory.join("messages.csv"),
            "id,text\r\ncsv-message,hello\r\n",
        )?;
        fs::write(directory.join("messages.json"), br#"[{"id":"legacy"}]"#)?;
        let records = read_dataset_array(&directory, "messages")?;
        assert_eq!(records[0]["id"], "csv-message");
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn message_days_only_mark_the_first_message_of_each_date() {
        let messages = vec![
            json!({"timestamp":"2026-08-17T23:59:00Z"}),
            json!({"timestamp":"2026-08-17T23:59:30Z"}),
            json!({"timestamp":"2026-08-18T00:01:00Z"}),
        ];
        let markers = message_day_markers(&messages);
        assert!(
            markers[0]
                .as_deref()
                .is_some_and(|value| value.contains("08月17日"))
        );
        assert_eq!(markers[1], None);
        assert!(
            markers[2]
                .as_deref()
                .is_some_and(|value| value.contains("08月18日"))
        );
    }

    #[test]
    fn flat_statuses_are_grouped_by_publisher() {
        let groups = normalize_statuses(vec![
            json!({"id":"s1","publisherId":"alice"}),
            json!({"id":"s2","publisherId":"bob"}),
            json!({"id":"s3","publisherId":"alice"}),
        ]);
        assert_eq!(groups.len(), 2);
        let alice_count = groups
            .iter()
            .find(|group| group["publisherId"] == "alice")
            .and_then(|group| group["items"].as_array())
            .map(Vec::len);
        assert_eq!(alice_count, Some(2));
    }

    #[test]
    fn channel_events_are_associated_with_the_selected_channel() {
        let events = vec![
            json!({"id":"a","channelId":"channel-a"}),
            json!({"id":"b","chatId":"channel-b"}),
            json!({"id":"c","channelId":"channel-a"}),
        ];
        let selected = channel_events_for(&events, "channel-a");
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].1["id"], "a");
        assert_eq!(selected[1].1["id"], "c");
    }

    #[test]
    fn channel_media_accepts_explicit_and_legacy_channel_identity() {
        let media = vec![
            json!({"scope":"channel", "channelId":"channel-a", "messageId":"one"}),
            json!({"scope":"channel", "chatId":"channel-a", "messageId":"two"}),
            json!({"scope":"chat", "chatId":"channel-a", "messageId":"not-channel"}),
        ];
        let selected = channel_media_for(&media, "channel-a");
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn call_fields_are_formatted_for_humans() {
        assert_eq!(call_type_label(&json!({"isVideo":true})), "视频通话");
        assert_eq!(call_type_label(&json!({"isVideo":false})), "语音通话");
        let call = json!({
            "direction": null,
            "state": null,
            "raw": {"id":{"fromMe":false},"finalCallOutcome":"Completed"}
        });
        assert_eq!(call_direction_label(&call), "呼入");
        assert_eq!(call_result_label(&call), "已完成");
        assert_eq!(format_duration(Some(65)), "1 分 5 秒");
        assert_eq!(format_duration(None), "未知");
    }

    #[test]
    fn capabilities_object_becomes_a_record_list() {
        let records = normalize_records(json!({
            "datasets": {
                "calls": {"status":"available"},
                "statuses": {"status":"unavailable","reason":"module missing"}
            }
        }));
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|record| record["name"].is_string()));
    }

    #[test]
    fn raw_fields_are_excluded_from_visible_summaries() {
        let record = json!({
            "id":"one",
            "status":"available",
            "raw":{"secret":"must not render"},
            "_private":"hidden"
        });
        let summary = record_summary(&record);
        assert!(!summary.contains("must not render"));
        assert!(!summary.contains("private"));
        assert!(hidden_field("raw"));
        assert!(hidden_field("__fieldCollectorType"));
    }

    #[test]
    fn unified_media_avatar_index_only_maps_available_existing_files() -> anyhow::Result<()> {
        let directory = temporary_directory("avatar-viewer");
        fs::create_dir_all(directory.join("media/objects/aa"))?;
        fs::write(
            directory.join("media/objects/aa/avatar.jpg"),
            b"image-placeholder",
        )?;
        fs::write(
            directory.join("media/avatars.json"),
            serde_json::to_vec(&json!([
                {
                    "contactId":"alice",
                    "status":"available",
                    "relativePath":"media/objects/aa/avatar.jpg"
                },
                {
                    "contactId":"bob",
                    "status":"unavailable",
                    "relativePath":null
                },
                {
                    "contactId":"carol",
                    "status":"available",
                    "relativePath":"media/objects/aa/missing.jpg"
                }
            ]))?,
        )?;
        let avatars = load_avatar_paths(&directory);
        assert!(avatars.contains_key("alice"));
        assert!(!avatars.contains_key("bob"));
        assert!(!avatars.contains_key("carol"));
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn legacy_avatar_directory_remains_readable() -> anyhow::Result<()> {
        let directory = temporary_directory("legacy-avatar-viewer");
        fs::create_dir_all(directory.join("avatars"))?;
        fs::write(directory.join("avatars/alice.jpg"), b"legacy-avatar")?;
        fs::write(
            directory.join("avatars/index.json"),
            serde_json::to_vec(&json!([{
                "contactId":"alice",
                "status":"available",
                "relativePath":"avatars/alice.jpg"
            }]))?,
        )?;
        assert!(load_avatar_paths(&directory).contains_key("alice"));
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn empty_viewer_has_clear_zero_counts() {
        let viewer = ViewerState::default();
        assert_eq!(viewer.chats.len(), 0);
        assert_eq!(viewer.statuses.len(), 0);
        assert_eq!(viewer.channels.len(), 0);
        assert_eq!(viewer.calls.len(), 0);
    }

    #[test]
    fn detail_drawer_replaces_content_below_the_compact_breakpoint() {
        assert!(detail_replaces_content(960.0, true));
        assert!(!detail_replaces_content(1280.0, true));
        assert!(!detail_replaces_content(960.0, false));
    }

    fn temporary_directory(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("field-collector-{label}-test-{}", Uuid::new_v4()))
    }
}
