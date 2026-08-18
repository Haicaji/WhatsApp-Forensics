//! Native acquisition controller and viewer shell.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

use eframe::egui::{self, Color32, RichText};

use crate::acquisition::run_acquisition;
use crate::protocol::AcquisitionEvent;
use crate::transport::{GatewayEvent, GatewayHandle, start_gateway};
use crate::viewer::ViewerState;

const PRIMARY: Color32 = Color32::from_rgb(67, 56, 202);
const DANGER: Color32 = Color32::from_rgb(185, 28, 28);
const SUCCESS: Color32 = Color32::from_rgb(21, 128, 61);
const PAIRING_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

#[derive(Clone, Copy, Eq, PartialEq)]
enum Page {
    Collect,
    View,
}

/// Complete egui application state.
pub struct CollectorApp {
    page: Page,
    output_root: String,
    extension_directory: PathBuf,
    pairing_code: String,
    gateway: Option<GatewayHandle>,
    gateway_events: Option<mpsc::Receiver<GatewayEvent>>,
    paired: bool,
    browser_label: String,
    worker_events: Option<mpsc::Receiver<AcquisitionEvent>>,
    cancellation: Arc<AtomicBool>,
    running: bool,
    status: String,
    progress: Option<serde_json::Value>,
    error: Option<String>,
    latest_path: Option<PathBuf>,
    viewer: ViewerState,
}

impl CollectorApp {
    pub fn new(context: &egui::Context) -> Self {
        install_cjk_font(context);
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let output_root = manifest_dir.join("exports").to_string_lossy().into_owned();
        let extension_directory = manifest_dir.join("extension/dist");
        let pairing_code = generate_pairing_code();
        let mut app = Self {
            page: Page::Collect,
            output_root,
            extension_directory,
            pairing_code,
            gateway: None,
            gateway_events: None,
            paired: false,
            browser_label: "未连接".to_owned(),
            worker_events: None,
            cancellation: Arc::new(AtomicBool::new(false)),
            running: false,
            status: "正在启动本机扩展连接".to_owned(),
            progress: None,
            error: None,
            latest_path: None,
            viewer: ViewerState::default(),
        };
        app.restart_gateway();
        app
    }

    fn restart_gateway(&mut self) {
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
                    AcquisitionEvent::Progress(progress) => self.progress = Some(progress),
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
        let Some(gateway) = self.gateway.clone() else {
            self.error = Some("扩展连接尚未启动".to_owned());
            return;
        };
        let output_root = PathBuf::from(self.output_root.trim());
        self.cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = Arc::clone(&self.cancellation);
        let (events_tx, events_rx) = mpsc::channel();
        self.worker_events = Some(events_rx);
        self.running = true;
        self.error = None;
        self.progress = None;
        "正在建立页面提取会话".clone_into(&mut self.status);
        let spawn_result = std::thread::Builder::new()
            .name("field-collector-acquisition".to_owned())
            .spawn(move || {
                match run_acquisition(&gateway, &output_root, &cancellation, &events_tx) {
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

    fn collect_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("WhatsApp Web 全量提取原型");
        ui.label("输出标准 JSON 和原始媒体文件，不生成数据库、SQL、ZIP 或 Evidence Bag。");
        ui.add_space(12.0);
        ui.group(|ui| {
            ui.heading("1. 加载浏览器扩展");
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
            ui.heading("2. 连接已登录的 WhatsApp Web");
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
            ui.heading("3. 提取并保存");
            ui.horizontal(|ui| {
                ui.label("输出根目录");
                ui.add_enabled(
                    !self.running,
                    egui::TextEdit::singleline(&mut self.output_root).desired_width(620.0),
                );
                if ui.button("打开").clicked() {
                    open_folder(Path::new(&self.output_root));
                }
            });
            ui.colored_label(
                Color32::from_rgb(180, 83, 9),
                "全历史模式会打开/滚动会话并下载媒体，可能产生已读、缓存和网络请求。",
            );
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(
                        self.paired && !self.running,
                        egui::Button::new("开始提取全部可访问内容"),
                    )
                    .clicked()
                {
                    self.start_acquisition();
                }
                if ui
                    .add_enabled(self.running, egui::Button::new("在当前文件边界取消"))
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
            if let Some(progress) = &self.progress {
                ui.monospace(serde_json::to_string(progress).unwrap_or_default());
            }
        });
    }
}

impl eframe::App for CollectorApp {
    fn update(&mut self, context: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_events();
        egui::TopBottomPanel::top("header").show(context, |ui| {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.heading(RichText::new("FieldCollector").color(PRIMARY));
                ui.separator();
                ui.selectable_value(&mut self.page, Page::Collect, "提取");
                ui.selectable_value(&mut self.page, Page::View, "查看 JSON 与源文件");
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

fn open_folder(path: &Path) {
    let _ = fs::create_dir_all(path);
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer.exe").arg(path).spawn();
}

fn install_cjk_font(context: &egui::Context) {
    #[cfg(windows)]
    if let Ok(bytes) = fs::read(r"C:\Windows\Fonts\msyh.ttc") {
        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert(
            "microsoft_yahei".to_owned(),
            egui::FontData::from_owned(bytes).into(),
        );
        for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            fonts
                .families
                .entry(family)
                .or_default()
                .insert(0, "microsoft_yahei".to_owned());
        }
        context.set_fonts(fonts);
    }
}
