//! Native acquisition controller and viewer shell.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

use eframe::egui::{self, Color32, RichText};

use crate::acquisition::run_acquisition;
use crate::portable::{LaunchConfiguration, PortableTask};
use crate::protocol::{AcquisitionEvent, AcquisitionPolicy};
use crate::transport::{GatewayEvent, GatewayHandle, start_gateway};
use crate::viewer::ViewerState;

const PRIMARY: Color32 = Color32::from_rgb(0, 168, 132);
const DANGER: Color32 = Color32::from_rgb(185, 28, 28);
const SUCCESS: Color32 = Color32::from_rgb(21, 128, 61);
const PAIRING_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const BUNDLED_CJK_FONT: &[u8] = include_bytes!("../assets/fonts/NotoSansCJKsc-Regular.otf");

#[derive(Clone, Copy, Eq, PartialEq)]
enum Page {
    Collect,
    View,
}

/// Complete egui application state.
pub struct CollectorApp {
    page: Page,
    evidence_name: String,
    output_root: String,
    extension_directory: PathBuf,
    portable_mode: bool,
    portable_task: Option<PortableTask>,
    startup_error: Option<String>,
    pairing_code: String,
    gateway: Option<GatewayHandle>,
    gateway_events: Option<mpsc::Receiver<GatewayEvent>>,
    paired: bool,
    browser_label: String,
    worker_events: Option<mpsc::Receiver<AcquisitionEvent>>,
    cancellation: Arc<AtomicBool>,
    running: bool,
    status: String,
    error: Option<String>,
    latest_path: Option<PathBuf>,
    viewer: ViewerState,
    policy: AcquisitionPolicy,
    max_media_mib: u64,
}

impl CollectorApp {
    pub fn new(context: &egui::Context, launch: LaunchConfiguration) -> Self {
        install_cjk_font(context);
        install_dark_theme(context);
        let output_root = launch.output_root.to_string_lossy().into_owned();
        let extension_directory = launch.extension_directory;
        let startup_error = launch.startup_error;
        let pairing_code = generate_pairing_code();
        let mut app = Self {
            page: Page::Collect,
            evidence_name: String::new(),
            output_root,
            extension_directory,
            portable_mode: launch.portable_mode,
            portable_task: launch.task,
            startup_error: startup_error.clone(),
            pairing_code,
            gateway: None,
            gateway_events: None,
            paired: false,
            browser_label: "未连接".to_owned(),
            worker_events: None,
            cancellation: Arc::new(AtomicBool::new(false)),
            running: false,
            status: "正在启动本机扩展连接".to_owned(),
            error: startup_error,
            latest_path: None,
            viewer: ViewerState::default(),
            policy: AcquisitionPolicy::default(),
            max_media_mib: 0,
        };
        if app.startup_error.is_none() {
            app.restart_gateway();
        } else {
            "便携任务配置无效，采集已禁用".clone_into(&mut app.status);
        }
        app
    }

    fn restart_gateway(&mut self) {
        if let Some(message) = &self.startup_error {
            self.error = Some(message.clone());
            "便携任务配置无效，采集已禁用".clone_into(&mut self.status);
            return;
        }
        if let Some(gateway) = &self.gateway {
            gateway.shutdown();
        }
        self.pairing_code = generate_pairing_code();
        self.paired = false;
        "未连接".clone_into(&mut self.browser_label);
        self.error = None;
        match start_gateway(self.pairing_code.clone()) {
            Ok((gateway, events)) => {
                self.gateway = Some(gateway);
                self.gateway_events = Some(events);
                "等待扩展输入配对码".clone_into(&mut self.status);
            }
            Err(error) => {
                self.gateway = None;
                self.gateway_events = None;
                self.error = Some(error.to_string());
            }
        }
    }

    fn poll_events(&mut self) {
        if let Some(events) = &self.gateway_events {
            while let Ok(event) = events.try_recv() {
                match event {
                    GatewayEvent::Listening => {
                        "本机连接已就绪，请在扩展中输入配对码".clone_into(&mut self.status);
                    }
                    GatewayEvent::Paired {
                        browser_family,
                        browser_version,
                        extension_version,
                    } => {
                        self.paired = true;
                        self.browser_label = format!(
                            "{browser_family} {browser_version} · 扩展 {extension_version}"
                        );
                        "WhatsApp 页面已连接，可以开始提取".clone_into(&mut self.status);
                    }
                    GatewayEvent::Disconnected(message) => {
                        self.paired = false;
                        if !self.running {
                            self.status = message;
                        }
                    }
                    GatewayEvent::Failed(message) => self.error = Some(message),
                }
            }
        }
        if let Some(events) = &self.worker_events {
            while let Ok(event) = events.try_recv() {
                match event {
                    AcquisitionEvent::Status(message) => self.status = message,
                    AcquisitionEvent::Progress(progress) => {
                        if let Some(message) = progress_status(&progress) {
                            self.status = message;
                        }
                    }
                    AcquisitionEvent::Complete(path) => {
                        self.running = false;
                        self.latest_path = Some(path.clone());
                        "提取已结束，结果可以直接查看".clone_into(&mut self.status);
                        if let Err(error) = self.viewer.load(&path) {
                            self.error = Some(error.to_string());
                        }
                    }
                    AcquisitionEvent::Failed(message) => {
                        self.running = false;
                        self.error = Some(message);
                        "提取失败，已接收的部分文件仍会保留".clone_into(&mut self.status);
                    }
                }
            }
        }
    }

    fn start_acquisition(&mut self) {
        if let Some(message) = &self.startup_error {
            self.error = Some(message.clone());
            return;
        }
        let evidence_name = self.evidence_name.trim().to_owned();
        if evidence_name.is_empty() {
            self.error = Some("请先填写检材名称".to_owned());
            return;
        }
        let Some(gateway) = self.gateway.clone() else {
            self.error = Some("扩展连接尚未启动".to_owned());
            return;
        };
        let output_root = PathBuf::from(self.output_root.trim());
        self.cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = Arc::clone(&self.cancellation);
        self.policy.max_media_bytes = self.max_media_mib.saturating_mul(1024 * 1024);
        let policy = self.policy.clone();
        let portable_task = self.portable_task.clone();
        let (events_tx, events_rx) = mpsc::channel();
        self.worker_events = Some(events_rx);
        self.running = true;
        self.error = None;
        "正在建立页面提取会话".clone_into(&mut self.status);
        let spawn_result = std::thread::Builder::new()
            .name("field-collector-acquisition".to_owned())
            .spawn(move || {
                match run_acquisition(
                    &gateway,
                    &output_root,
                    &cancellation,
                    &events_tx,
                    &policy,
                    &evidence_name,
                    portable_task.as_ref(),
                ) {
                    Ok(path) => {
                        let _ = events_tx.send(AcquisitionEvent::Complete(path));
                    }
                    Err(error) => {
                        let _ = events_tx.send(AcquisitionEvent::Failed(error.to_string()));
                    }
                }
            });
        if let Err(error) = spawn_result {
            self.running = false;
            self.worker_events = None;
            self.error = Some(format!("无法启动提取线程：{error}"));
        }
    }

    #[allow(clippy::too_many_lines)]
    fn collect_ui(&mut self, ui: &mut egui::Ui) {
        if self.portable_mode {
            ui.group(|ui| {
                ui.heading("便携任务");
                if let Some(task) = &self.portable_task {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(RichText::new("案件").strong());
                        ui.label(&task.case_name);
                        ui.separator();
                        ui.label(RichText::new("任务").strong());
                        ui.label(&task.task_name);
                    });
                    ui.weak(format!("任务编号：{}", task.task_id));
                    ui.label("结果将固定写入任务 U 盘的 results 目录。");
                } else {
                    ui.colored_label(DANGER, "task.json 无效，当前不能开始采集。");
                }
            });
            ui.add_space(8.0);
        }
        ui.group(|ui| {
            ui.heading("1. 检材信息");
            ui.label("填写当前提取检材的信息。当前仅要求填写检材名称。");
            ui.horizontal(|ui| {
                ui.label("检材名称");
                ui.add_enabled(
                    !self.running,
                    egui::TextEdit::singleline(&mut self.evidence_name)
                        .hint_text("必填")
                        .desired_width(420.0),
                );
                if self.evidence_name.trim().is_empty() {
                    ui.colored_label(DANGER, "必填");
                }
            });
        });
        ui.add_space(8.0);
        ui.group(|ui| {
            ui.heading("2. 加载浏览器扩展");
            ui.label("在 Chrome 扩展管理页启用开发者模式，加载下面的未打包扩展目录。");
            ui.horizontal(|ui| {
                ui.monospace(self.extension_directory.to_string_lossy());
                if ui.button("打开扩展目录").clicked() {
                    open_folder(&self.extension_directory);
                }
            });
        });
        ui.add_space(8.0);
        ui.group(|ui| {
            ui.heading("3. 连接已登录的 WhatsApp Web");
            ui.label("打开并选中 WhatsApp Web 标签页，点击扩展并输入一次性配对码：");
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(&self.pairing_code)
                        .monospace()
                        .size(30.0)
                        .strong()
                        .color(PRIMARY),
                );
                if ui.button("复制连接码").clicked() {
                    ui.ctx().copy_text(self.pairing_code.clone());
                    "连接码已复制到剪贴板".clone_into(&mut self.status);
                }
            });
            ui.horizontal(|ui| {
                ui.label(format!("浏览器：{}", self.browser_label));
                if self.paired {
                    ui.colored_label(SUCCESS, "已连接");
                }
                if !self.running && ui.button("重新生成连接").clicked() {
                    self.restart_gateway();
                }
            });
        });
        ui.add_space(8.0);
        ui.group(|ui| {
            ui.heading("4. 设置采集策略");
            ui.horizontal_wrapped(|ui| {
                ui.add_enabled(
                    !self.running,
                    egui::Checkbox::new(&mut self.policy.include_statuses, "动态"),
                );
                ui.add_enabled(
                    !self.running,
                    egui::Checkbox::new(&mut self.policy.include_calls, "通话记录"),
                );
                ui.add_enabled(
                    !self.running,
                    egui::Checkbox::new(&mut self.policy.include_channels, "频道"),
                );
                ui.add_enabled(
                    !self.running,
                    egui::Checkbox::new(&mut self.policy.include_chat_media, "聊天附件"),
                );
                ui.add_enabled(
                    !self.running && self.policy.include_channels,
                    egui::Checkbox::new(&mut self.policy.include_channel_media, "频道附件"),
                );
                ui.add_enabled(
                    !self.running,
                    egui::Checkbox::new(&mut self.policy.include_avatars, "头像/频道图片"),
                );
            });
            ui.horizontal(|ui| {
                ui.label("频道时间范围");
                ui.add_enabled(
                    !self.running && self.policy.include_channels,
                    egui::DragValue::new(&mut self.policy.channel_days)
                        .range(1..=3650)
                        .suffix(" 天"),
                );
                ui.separator();
                ui.label("单个附件上限");
                ui.add_enabled(
                    !self.running,
                    egui::DragValue::new(&mut self.max_media_mib)
                        .range(0..=1024 * 1024)
                        .suffix(" MiB"),
                );
                ui.weak("0 表示不限制；未知大小的流会在达到上限时中止并删除临时内容");
            });
        });
        ui.add_space(8.0);
        ui.group(|ui| {
            ui.heading("5. 提取并保存");
            ui.horizontal(|ui| {
                ui.label("输出根目录");
                ui.add_enabled(
                    !self.running && !self.portable_mode,
                    egui::TextEdit::singleline(&mut self.output_root).desired_width(620.0),
                );
                if ui.button("打开").clicked() {
                    open_folder(Path::new(&self.output_root));
                }
            });
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(
                        self.paired && !self.running && !self.evidence_name.trim().is_empty(),
                        egui::Button::new("开始提取"),
                    )
                    .clicked()
                {
                    self.start_acquisition();
                }
                if ui
                    .add_enabled(self.running, egui::Button::new("取消任务"))
                    .clicked()
                {
                    self.cancellation.store(true, Ordering::SeqCst);
                }
                if let Some(path) = &self.latest_path
                    && ui.button("查看本次结果").clicked()
                {
                    let _ = self.viewer.load(path);
                    self.page = Page::View;
                }
            });
        });
    }
}

impl eframe::App for CollectorApp {
    fn update(&mut self, context: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_events();
        egui::TopBottomPanel::top("header").show(context, |ui| {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.page, Page::Collect, "提取");
                ui.selectable_value(&mut self.page, Page::View, "查看数据与源文件");
            });
            ui.add_space(8.0);
        });
        egui::TopBottomPanel::bottom("status").show(context, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new("状态").strong());
                ui.label(&self.status);
                if self.running {
                    ui.spinner();
                }
            });
            if let Some(error) = &self.error {
                ui.colored_label(DANGER, error);
            }
        });
        egui::CentralPanel::default().show(context, |ui| match self.page {
            Page::Collect => {
                egui::ScrollArea::vertical()
                    .id_salt("app_collect_content_scroll")
                    .show(ui, |ui| self.collect_ui(ui));
            }
            Page::View => {
                self.viewer.ui(ui, context);
            }
        });
        if self.running {
            context.request_repaint_after(std::time::Duration::from_millis(80));
        }
    }
}

impl Drop for CollectorApp {
    fn drop(&mut self) {
        self.cancellation.store(true, Ordering::SeqCst);
        if let Some(gateway) = &self.gateway {
            gateway.shutdown();
        }
    }
}

fn generate_pairing_code() -> String {
    let mut random = [0_u8; 10];
    if getrandom::fill(&mut random).is_err() {
        return "23456789AB".to_owned();
    }
    random
        .into_iter()
        .map(|byte| char::from(PAIRING_ALPHABET[usize::from(byte) % PAIRING_ALPHABET.len()]))
        .collect()
}

fn progress_status(progress: &serde_json::Value) -> Option<String> {
    let phase = progress["phase"].as_str()?;
    Some(match phase {
        "global_datasets" => match progress["dataset"].as_str().unwrap_or_default() {
            "statuses" => "正在提取动态".to_owned(),
            "calls" => "正在提取通话记录".to_owned(),
            "channels" => "正在提取频道".to_owned(),
            dataset => format!("正在提取数据：{dataset}"),
        },
        "identity_resolution" => "正在解析账号与联系人信息".to_owned(),
        "history" => format!(
            "正在加载会话 {}/{}",
            progress["chatIndex"].as_u64().unwrap_or(0),
            progress["chatTotal"].as_u64().unwrap_or(0)
        ),
        "media_request" => "正在请求聊天附件".to_owned(),
        "channel_media_request" => "正在请求频道附件".to_owned(),
        "media_chat_reactivate" => "正在刷新附件下载地址".to_owned(),
        "avatar_request" => format!(
            "正在提取头像 {}/{}",
            progress["avatarIndex"].as_u64().unwrap_or(0),
            progress["avatarTotal"].as_u64().unwrap_or(0)
        ),
        _ => return None,
    })
}

fn open_folder(path: &Path) {
    let _ = fs::create_dir_all(path);
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer.exe").arg(path).spawn();
}

fn install_cjk_font(context: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "noto_sans_cjk_sc".to_owned(),
        egui::FontData::from_static(BUNDLED_CJK_FONT).into(),
    );
    for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .insert(0, "noto_sans_cjk_sc".to_owned());
    }
    context.set_fonts(fonts);
}

fn install_dark_theme(context: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = Color32::from_rgb(17, 27, 33);
    visuals.window_fill = Color32::from_rgb(17, 27, 33);
    visuals.extreme_bg_color = Color32::from_rgb(11, 20, 26);
    visuals.faint_bg_color = Color32::from_rgb(32, 44, 51);
    visuals.selection.bg_fill = Color32::from_rgb(0, 120, 102);
    visuals.selection.stroke.color = Color32::from_rgb(233, 237, 239);
    visuals.widgets.inactive.bg_fill = Color32::from_rgb(42, 57, 66);
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(55, 70, 79);
    visuals.widgets.active.bg_fill = Color32::from_rgb(0, 120, 102);
    context.set_visuals(visuals);
}
