//! Native, portable workflow for nontechnical Field Collector operators.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use browser_cdp::{BrowserProduct, CdpEndpoint, CdpTarget};
use browser_profile::{
    BrowserProfileObservation, ExistingProfileLaunch, discover_existing_profiles,
    open_existing_profile, open_extension_manager,
};
use chrono::Utc;
use collector_core::{
    AccountConfirmationChallenge, AcquisitionRequest, CollectorError, ExistingProfileContext,
    available_space_bytes, collect_t0, preflight,
};
use eframe::egui::{self, Color32, FontData, FontDefinitions, FontFamily, RichText};
use extension_transport::{ActiveGateway, GatewayConfig, PROTOCOL, PairingGateway};
use portable_config::PortableBundle;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use zeroize::{Zeroize, Zeroizing};

use super::{
    acquisition_request_from_bundle, load_portable_bundle, resolve_verifier, run_external_verifier,
    write_handoff_summary,
};

const WINDOW_TITLE: &str = "WhatsApp Field Collector v0.1";
const POLL_INTERVAL: Duration = Duration::from_millis(80);
const PRIMARY: Color32 = Color32::from_rgb(67, 56, 202);
const SUCCESS: Color32 = Color32::from_rgb(21, 128, 61);
const DANGER: Color32 = Color32::from_rgb(185, 28, 28);
const MUTED: Color32 = Color32::from_rgb(71, 85, 105);
const EXTENSION_VERSION: &str = "0.1.0";
const ADAPTER_ID: &str = "wa-private-collections-v1";
const ADAPTER_VERSION: &str = "1.0.0";
const ADAPTER_BYTES: &[u8] = include_bytes!("../../../injector/dist/collector.iife.js");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Screen {
    Assignment,
    Browser,
    Preflight,
    Acquisition,
    Complete,
}

impl Screen {
    const ALL: [Self; 5] = [
        Self::Assignment,
        Self::Browser,
        Self::Preflight,
        Self::Acquisition,
        Self::Complete,
    ];

    const fn label(self) -> &'static str {
        match self {
            Self::Assignment => "1 任务确认",
            Self::Browser => "2 Profile 与扩展",
            Self::Preflight => "3 现场预检",
            Self::Acquisition => "4 只读采集",
            Self::Complete => "5 校验交接",
        }
    }
}

#[derive(Clone, Debug)]
struct AssignmentView {
    id: String,
    authorization_reference: String,
    target_description: String,
    valid_until_utc: String,
}

#[derive(Clone, Debug)]
struct BrowserPageChoice {
    product: BrowserProduct,
    endpoint: CdpEndpoint,
    target: CdpTarget,
}

enum GuiEvent {
    Status(String),
    Profiles(Vec<BrowserProfileObservation>),
    ProfileOpened(ExistingProfileLaunch),
    PairingCode(String),
    ExtensionReady {
        gateway: Box<ActiveGateway>,
        page: BrowserPageChoice,
        paired_at_utc: String,
    },
    Preflight(Value),
    Confirmation {
        challenge: AccountConfirmationChallenge,
        response: oneshot::Sender<Option<String>>,
    },
    Complete(Value),
    Failed(String),
}

struct CollectorGui {
    bundle: Option<Arc<PortableBundle>>,
    bundle_error: Option<String>,
    assignments: Vec<AssignmentView>,
    selected_assignment: usize,
    screen: Screen,
    passphrase: Zeroizing<String>,
    passive_t0_consent: bool,
    profiles: Vec<BrowserProfileObservation>,
    profile_error: Option<String>,
    selected_profile: Option<usize>,
    profile_launch: Option<ExistingProfileLaunch>,
    extension_dir: Option<PathBuf>,
    extension_error: Option<String>,
    pairing_code: Option<String>,
    extension_paired_at_utc: Option<String>,
    gateway: Option<ActiveGateway>,
    targets: Vec<BrowserPageChoice>,
    selected_target: Option<usize>,
    preflight_report: Option<Value>,
    completion: Option<Value>,
    worker: Option<mpsc::Receiver<GuiEvent>>,
    running: bool,
    status: String,
    error: Option<String>,
    challenge: Option<AccountConfirmationChallenge>,
    challenge_response: Option<oneshot::Sender<Option<String>>>,
    confirmation_input: Zeroizing<String>,
    available_space: Option<u64>,
}

impl CollectorGui {
    fn new() -> Self {
        let (profiles, profile_error) = match discover_existing_profiles() {
            Ok(profiles) => (profiles, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        let (extension_dir, extension_error) = match resolve_extension_directory() {
            Ok(path) => (Some(path), None),
            Err(error) => (None, Some(error.to_string())),
        };
        match load_portable_bundle() {
            Ok(bundle) => {
                let now = Utc::now();
                let assignments = bundle
                    .valid_assignments_at(now)
                    .map(|assignment| AssignmentView {
                        id: assignment.payload.assignment_id.clone(),
                        authorization_reference: assignment.payload.authorization_reference.clone(),
                        target_description: assignment.payload.target_description.clone(),
                        valid_until_utc: assignment.payload.valid_until_utc.clone(),
                    })
                    .collect::<Vec<_>>();
                let available_space = available_space_bytes(&bundle.paths().evidence_sealed);
                Self {
                    bundle: Some(Arc::new(bundle)),
                    bundle_error: None,
                    assignments,
                    selected_assignment: 0,
                    screen: Screen::Assignment,
                    passphrase: Zeroizing::new(String::new()),
                    passive_t0_consent: false,
                    profiles,
                    profile_error,
                    selected_profile: None,
                    profile_launch: None,
                    extension_dir,
                    extension_error,
                    pairing_code: None,
                    extension_paired_at_utc: None,
                    gateway: None,
                    targets: Vec::new(),
                    selected_target: None,
                    preflight_report: None,
                    completion: None,
                    worker: None,
                    running: false,
                    status: "U 盘配置已通过签名和完整性初检".to_owned(),
                    error: None,
                    challenge: None,
                    challenge_response: None,
                    confirmation_input: Zeroizing::new(String::new()),
                    available_space,
                }
            }
            Err(error) => Self {
                bundle: None,
                bundle_error: Some(format!("{error:#}")),
                assignments: Vec::new(),
                selected_assignment: 0,
                screen: Screen::Assignment,
                passphrase: Zeroizing::new(String::new()),
                passive_t0_consent: false,
                profiles,
                profile_error,
                selected_profile: None,
                profile_launch: None,
                extension_dir,
                extension_error,
                pairing_code: None,
                extension_paired_at_utc: None,
                gateway: None,
                targets: Vec::new(),
                selected_target: None,
                preflight_report: None,
                completion: None,
                worker: None,
                running: false,
                status: "U 盘配置不可用，正式采集已禁止".to_owned(),
                error: None,
                challenge: None,
                challenge_response: None,
                confirmation_input: Zeroizing::new(String::new()),
                available_space: None,
            },
        }
    }

    fn selected_assignment(&self) -> Result<&AssignmentView> {
        self.assignments
            .get(self.selected_assignment)
            .ok_or_else(|| anyhow!("没有当前有效的勘察任务"))
    }

    fn selected_page(&self) -> Result<&BrowserPageChoice> {
        self.selected_target
            .and_then(|index| self.targets.get(index))
            .ok_or_else(|| anyhow!("请选择 WhatsApp 页面"))
    }

    fn selected_profile(&self) -> Result<&BrowserProfileObservation> {
        self.selected_profile
            .and_then(|index| self.profiles.get(index))
            .ok_or_else(|| anyhow!("请选择要勘察的浏览器 Profile"))
    }

    fn acquisition_request(&self) -> Result<AcquisitionRequest> {
        let bundle = self
            .bundle
            .as_ref()
            .ok_or_else(|| anyhow!("U 盘配置未通过校验"))?;
        let assignment_view = self.selected_assignment()?;
        let assignment = bundle.assignment_at(&assignment_view.id, Utc::now())?;
        let page = self.selected_page()?;
        let profile = self.selected_profile()?;
        let launch = self
            .profile_launch
            .as_ref()
            .ok_or_else(|| anyhow!("请先用所选 Profile 打开 WhatsApp Web"))?;
        let gateway = self
            .gateway
            .as_ref()
            .ok_or_else(|| anyhow!("请先在 WhatsApp 页面中连接取证扩展"))?;
        let paired_at_utc = self
            .extension_paired_at_utc
            .as_ref()
            .ok_or_else(|| anyhow!("取证扩展配对时间不可用"))?;
        if profile.product != page.product
            || profile.product != launch.product
            || profile.product != gateway.ready().identity.browser_family
            || profile.profile_reference_sha256 != launch.profile_reference_sha256
        {
            bail!("所选 Profile 与当前扩展页面不一致，请重新连接");
        }
        let adapter_sha256 = gateway
            .ready()
            .identity
            .adapter_sha256
            .strip_prefix("sha256:")
            .ok_or_else(|| anyhow!("Adapter 摘要格式无效"))?
            .to_owned();
        let mut request = acquisition_request_from_bundle(
            bundle,
            assignment,
            page.endpoint.clone(),
            None,
            page.target.id.clone(),
            self.passive_t0_consent,
        );
        request.existing_profile = Some(ExistingProfileContext {
            profile_reference_sha256: profile.profile_reference_sha256.clone(),
            browser_family: browser_product_label(profile.product).to_owned(),
            browser_product_was_running: launch.browser_was_running,
            browser_opened_at_utc: launch.opened_at_utc.clone(),
            extension_paired_at_utc: paired_at_utc.clone(),
            extension_version: gateway.ready().identity.extension_version.clone(),
            transport_protocol: PROTOCOL.to_owned(),
            adapter_id: gateway.ready().identity.adapter_id.clone(),
            adapter_version: ADAPTER_VERSION.to_owned(),
            adapter_sha256,
        });
        Ok(request)
    }
}

/// Start the native operator application. No state is persisted in `AppData`.
pub(crate) fn run() -> Result<ExitCode> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1_020.0, 760.0])
            .with_min_inner_size([820.0, 620.0]),
        ..Default::default()
    };
    eframe::run_native(
        WINDOW_TITLE,
        options,
        Box::new(|creation| {
            install_windows_cjk_font(&creation.egui_ctx);
            configure_visuals(&creation.egui_ctx);
            Ok(Box::new(CollectorGui::new()))
        }),
    )
    .map_err(|error| anyhow!(error.to_string()))?;
    Ok(ExitCode::SUCCESS)
}

impl eframe::App for CollectorGui {
    fn update(&mut self, context: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_worker();
        egui::TopBottomPanel::top("wafc_header").show(context, |ui| {
            ui.add_space(10.0);
            ui.horizontal_wrapped(|ui| {
                ui.heading(RichText::new("WhatsApp Web 现场快速采集").color(PRIMARY));
                ui.separator();
                ui.label(RichText::new("只读 T0 · U 盘自动保存 · 独立校验").color(MUTED));
            });
            ui.add_space(8.0);
            ui.horizontal_wrapped(|ui| {
                for step in Screen::ALL {
                    let text = if step == self.screen {
                        RichText::new(step.label()).strong().color(PRIMARY)
                    } else {
                        RichText::new(step.label()).color(MUTED)
                    };
                    ui.label(text);
                    if step != Screen::Complete {
                        ui.label(RichText::new("→").color(Color32::GRAY));
                    }
                }
            });
            ui.add_space(10.0);
        });

        egui::TopBottomPanel::bottom("wafc_status").show(context, |ui| {
            ui.add_space(5.0);
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
            ui.add_space(5.0);
        });

        egui::CentralPanel::default().show(context, |ui| match self.screen {
            Screen::Assignment => self.assignment_ui(ui),
            Screen::Browser => self.browser_ui(ui),
            Screen::Preflight => self.preflight_ui(ui),
            Screen::Acquisition => self.acquisition_ui(ui),
            Screen::Complete => self.complete_ui(ui),
        });

        if self.running {
            context.request_repaint_after(POLL_INTERVAL);
        }
    }
}

impl Drop for CollectorGui {
    fn drop(&mut self) {
        if let Some(response) = self.challenge_response.take() {
            let _ = response.send(None);
        }
        self.passphrase.zeroize();
        self.confirmation_input.zeroize();
    }
}

impl CollectorGui {
    #[allow(clippy::too_many_lines)]
    fn assignment_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("确认勘察员与下发任务");
        ui.label("身份、密钥、授权任务和保存位置均由 Analysis Workstation 下发，现场不可修改。");
        ui.add_space(12.0);

        if let Some(error) = &self.bundle_error {
            warning_card(
                ui,
                "U 盘配置校验失败",
                "请停止本次操作，并回到 Analysis Workstation 重新制作或修复取证 U 盘。程序不会回退到未签名配置。",
                error,
            );
            return;
        }
        let Some(bundle) = self.bundle.as_ref() else {
            return;
        };
        let profile = bundle.profile();
        readonly_grid(
            ui,
            [
                ("勘察员", profile.display_name.as_str()),
                ("勘察员编号", profile.operator_id.as_str()),
                ("机构", profile.organization.as_str()),
                ("密钥", profile.key_id.as_str()),
                (
                    "公钥指纹",
                    short_fingerprint(&profile.evidence_signing_key_fingerprint_sha256).as_str(),
                ),
            ],
        );

        ui.add_space(12.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("勘察任务").strong());
            let selected = self
                .assignments
                .get(self.selected_assignment)
                .map_or("无有效任务", |assignment| assignment.id.as_str());
            egui::ComboBox::from_id_salt("assignment")
                .selected_text(selected)
                .show_ui(ui, |ui| {
                    for (index, assignment) in self.assignments.iter().enumerate() {
                        ui.selectable_value(&mut self.selected_assignment, index, &assignment.id);
                    }
                });
        });
        if let Some(assignment) = self.assignments.get(self.selected_assignment) {
            readonly_grid(
                ui,
                [
                    ("授权/案件引用", assignment.authorization_reference.as_str()),
                    ("目标说明", assignment.target_description.as_str()),
                    ("有效期至", assignment.valid_until_utc.as_str()),
                    ("采集模式", "passive_t0（只读基线）"),
                ],
            );
        }

        ui.add_space(12.0);
        egui::Frame::group(ui.style()).show(ui, |ui| {
            ui.label(RichText::new("自动保存").strong());
            ui.label("证据保存位置：U盘\\evidence\\sealed");
            ui.label(format!(
                "剩余空间：{}",
                self.available_space.map_or_else(
                    || "暂时无法读取，将在预检时再次检查".to_owned(),
                    format_bytes
                )
            ));
            ui.label(RichText::new("程序不会扫描其他磁盘，也不接受自定义输出目录。").color(MUTED));
        });

        ui.add_space(12.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("密钥口令").strong());
            ui.add(
                egui::TextEdit::singleline(&mut *self.passphrase)
                    .password(true)
                    .desired_width(340.0),
            );
        });
        ui.checkbox(
            &mut self.passive_t0_consent,
            "我确认当前任务已获得授权，并同意执行只读 T0 基线采集",
        );
        ui.label(
            RichText::new("不会加载历史、下载媒体、点击聊天、发送消息或修改页面。").color(MUTED),
        );

        ui.add_space(14.0);
        if ui
            .add_enabled(
                !self.running && self.bundle.is_some(),
                egui::Button::new("开始现场预检"),
            )
            .clicked()
        {
            match self.validate_assignment_step() {
                Ok(()) => {
                    self.error = None;
                    self.screen = Screen::Browser;
                    "请查找并选择已授权的 WhatsApp 页面".clone_into(&mut self.status);
                }
                Err(error) => self.set_error(error),
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    fn browser_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("选择原浏览器 Profile 并连接取证扩展");
        ui.label(
            "程序只读取 Chrome/Edge 的 Profile 名单；不会读取密码、Cookie、历史记录或聊天数据。",
        );
        ui.label(
            RichText::new(
                "打开原 Profile、加载扩展和 WhatsApp 自动同步都可能改变浏览器缓存或 Profile 状态，本系统不会宣称绝对无痕。",
            )
            .color(DANGER),
        );
        ui.add_space(10.0);

        ui.horizontal(|ui| {
            ui.label(RichText::new("第 1 步：选择 Profile").strong());
            if ui
                .add_enabled(!self.running, egui::Button::new("重新检测"))
                .clicked()
            {
                self.start_profile_discovery();
            }
        });
        if let Some(error) = &self.profile_error {
            ui.colored_label(DANGER, format!("浏览器 Profile 检测失败：{error}"));
        }
        if self.profiles.is_empty() {
            ui.label("未发现可用的 Chrome/Edge Profile。");
        }

        let mut newly_selected = None;
        egui::ScrollArea::vertical()
            .max_height(145.0)
            .show(ui, |ui| {
                for (index, profile) in self.profiles.iter().enumerate() {
                    let running = if profile.browser_was_running {
                        "浏览器当前已运行"
                    } else {
                        "浏览器当前未运行"
                    };
                    let label = format!(
                        "{} · {}（{}） · {running}",
                        browser_product_label(profile.product),
                        profile.display_name,
                        profile.directory_name,
                    );
                    if ui
                        .selectable_label(self.selected_profile == Some(index), label)
                        .clicked()
                        && !self.running
                    {
                        newly_selected = Some(index);
                    }
                }
            });
        if let Some(index) = newly_selected {
            self.select_profile(index);
        }

        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new("第 2 步：打开所选 Profile").strong());
            if ui
                .add_enabled(
                    !self.running && self.selected_profile.is_some(),
                    egui::Button::new("打开 WhatsApp Web"),
                )
                .clicked()
            {
                self.start_profile_launch();
            }
            if self.profile_launch.is_some() {
                ui.colored_label(SUCCESS, "已发出正常打开请求，请确认页面自动登录");
            }
        });

        if self.profile_launch.is_some() {
            ui.add_space(8.0);
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.label(RichText::new("第 3 步：加载 U 盘只读取证扩展").strong());
                ui.label("① 打开扩展管理页并开启“开发者模式”；② 点击“加载已解压的扩展程序”；③ 选择下方扩展文件夹。");
                if let Some(path) = &self.extension_dir {
                    ui.monospace(path.display().to_string());
                }
                if let Some(error) = &self.extension_error {
                    ui.colored_label(DANGER, format!("扩展包不可用：{error}"));
                }
                ui.horizontal_wrapped(|ui| {
                    if ui
                        .add_enabled(
                            !self.running && self.selected_profile.is_some(),
                            egui::Button::new("打开扩展管理页"),
                        )
                        .clicked()
                    {
                        self.open_selected_extension_manager();
                    }
                    if ui
                        .add_enabled(
                            !self.running && self.extension_dir.is_some(),
                            egui::Button::new("打开扩展文件夹"),
                        )
                        .clicked()
                    {
                        self.open_extension_folder();
                    }
                });
            });

            ui.add_space(8.0);
            ui.label(RichText::new("第 4 步：在当前 WhatsApp 页面连接扩展").strong());
            if self.gateway.is_some() {
                ui.colored_label(SUCCESS, "扩展已连接到当前 WhatsApp 页面");
            } else if let Some(code) = &self.pairing_code {
                ui.label("请在当前 WhatsApp 页面点击“WAFC 取证连接器”，输入下面的一次性配对码：");
                ui.label(RichText::new(code).strong().size(28.0).color(PRIMARY));
                ui.label(
                    RichText::new("配对码只用于本次本机连接，不会写入日志或证据包。").color(MUTED),
                );
            } else if ui
                .add_enabled(
                    !self.running && self.extension_dir.is_some(),
                    egui::Button::new("开始等待扩展连接"),
                )
                .clicked()
            {
                self.start_extension_pairing();
            }
        }

        ui.add_space(12.0);
        ui.horizontal(|ui| {
            if ui
                .add_enabled(!self.running, egui::Button::new("返回任务"))
                .clicked()
            {
                self.clear_browser_session();
                self.screen = Screen::Assignment;
            }
            if ui
                .add_enabled(
                    !self.running && self.gateway.is_some() && self.selected_target.is_some(),
                    egui::Button::new("下一步：现场预检"),
                )
                .clicked()
            {
                self.screen = Screen::Preflight;
                self.start_preflight();
            }
        });
        ui.label(
            RichText::new(
                "开始采集前会再次检查 WhatsApp 版本与只读能力；未知版本会停止并留下非内容诊断。",
            )
            .color(MUTED),
        );
    }

    fn preflight_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("现场预检");
        ui.label("正在检查 U 盘配置、固定保存目录、密钥文件和扩展连接；不会读取聊天或解锁私钥。");
        ui.add_space(12.0);
        if self.running {
            ui.spinner();
            ui.label(&self.status);
        }
        if let Some(report) = &self.preflight_report {
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.colored_label(SUCCESS, RichText::new("预检通过").strong());
                ui.label("配置签名与任务有效，固定目录可写，签名密钥文件存在。");
                if let Some(bytes) = report.get("availableSpaceBytes").and_then(Value::as_u64) {
                    ui.label(format!("当前剩余空间：{}", format_bytes(bytes)));
                }
            });
        }
        ui.add_space(14.0);
        ui.horizontal(|ui| {
            if ui
                .add_enabled(!self.running, egui::Button::new("返回页面选择"))
                .clicked()
            {
                self.screen = Screen::Browser;
            }
            if ui
                .add_enabled(
                    !self.running && self.preflight_report.is_some(),
                    egui::Button::new("确认页面并开始只读采集"),
                )
                .clicked()
            {
                self.start_acquisition();
            }
        });
    }

    fn acquisition_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("只读 T0 采集");
        ui.label("在页面确认前不会解锁签名密钥、创建 staging 或开始采集。");
        ui.add_space(12.0);
        if let Some(challenge) = self.challenge.clone() {
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.heading("请目视确认当前 WhatsApp Web 页面");
                ui.label("此确认只绑定当前浏览器页面，不证明账号所有权或账号级绝对完整性。");
                ui.label(format!("WhatsApp build：{}", challenge.whatsapp_build));
                ui.label(
                    RichText::new(format!("一次性确认码：{}", challenge.confirmation_code))
                        .strong()
                        .size(22.0)
                        .color(PRIMARY),
                );
                ui.horizontal(|ui| {
                    ui.label("重新输入确认码");
                    ui.add(
                        egui::TextEdit::singleline(&mut *self.confirmation_input)
                            .password(true)
                            .desired_width(230.0),
                    );
                });
                ui.horizontal(|ui| {
                    if ui.button("确认并开始只读采集").clicked() {
                        if *self.confirmation_input == challenge.confirmation_code {
                            self.answer_challenge(Some(self.confirmation_input.to_string()));
                            "正在执行只读 T0 采集".clone_into(&mut self.status);
                        } else {
                            self.error = Some("确认码不一致，采集尚未开始".to_owned());
                        }
                    }
                    if ui.button("取消").clicked() {
                        self.answer_challenge(None);
                        "已取消，正在安全释放浏览器连接".clone_into(&mut self.status);
                    }
                });
            });
        } else if self.running {
            ui.spinner();
            ui.label(&self.status);
        } else if self.error.is_some() {
            ui.label("本次采集未完成；失败内容不会晋升为正式 Evidence Bag。");
            if ui.button("返回并重新连接扩展").clicked() {
                self.clear_paired_extension();
                self.screen = Screen::Browser;
            }
        }
    }

    fn complete_ui(&mut self, ui: &mut egui::Ui) {
        let handoff_failed = self
            .completion
            .as_ref()
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            == Some("complete_but_handoff_summary_failed");
        ui.heading(if handoff_failed {
            "证据已封存，但交接摘要写入失败"
        } else {
            "采集、校验与封存完成"
        });
        ui.colored_label(
            if handoff_failed { DANGER } else { SUCCESS },
            if handoff_failed {
                "Evidence Bag 已独立验证并保存；请联系技术支持补做非内容交接摘要。"
            } else {
                "Evidence Bag 已通过独立校验并保存到 U盘\\evidence\\sealed。"
            },
        );
        ui.label("交接摘要位于 U盘\\handoff，不包含聊天正文或账号标识。");
        if let Some(completion) = &self.completion {
            ui.add_space(10.0);
            egui::CollapsingHeader::new("技术校验详情")
                .default_open(false)
                .show(ui, |ui| {
                    ui.monospace(pretty_json(completion));
                });
        }
        ui.add_space(14.0);
        if ui.button("开始下一次采集").clicked() {
            self.reset_for_next_acquisition();
        }
    }

    fn validate_assignment_step(&self) -> Result<()> {
        let _ = self.selected_assignment()?;
        if self.passphrase.len() < 12 {
            bail!("请输入至少 12 个 UTF-8 字节的勘察员密钥口令");
        }
        if !self.passive_t0_consent {
            bail!("必须确认当前任务已获授权并同意只读 T0");
        }
        Ok(())
    }

    fn select_profile(&mut self, index: usize) {
        if self.selected_profile == Some(index) {
            return;
        }
        self.clear_browser_session();
        self.selected_profile = Some(index);
        self.profile_launch = None;
        self.error = None;
        "已选择 Profile，请正常打开 WhatsApp Web".clone_into(&mut self.status);
    }

    fn clear_paired_extension(&mut self) {
        self.gateway = None;
        self.pairing_code = None;
        self.extension_paired_at_utc = None;
        self.targets.clear();
        self.selected_target = None;
        self.preflight_report = None;
    }

    fn clear_browser_session(&mut self) {
        self.clear_paired_extension();
        self.profile_launch = None;
        self.selected_profile = None;
    }

    fn open_selected_extension_manager(&mut self) {
        let profile = match self.selected_profile() {
            Ok(profile) => profile,
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        match open_extension_manager(profile) {
            Ok(_) => {
                self.error = None;
                "已打开所选 Profile 的扩展管理页".clone_into(&mut self.status);
            }
            Err(error) => self.set_error(error),
        }
    }

    fn open_extension_folder(&mut self) {
        let Some(path) = self.extension_dir.as_ref() else {
            self.set_error("U 盘扩展文件夹不可用");
            return;
        };
        match show_folder(path) {
            Ok(()) => {
                self.error = None;
                "已打开 U 盘扩展文件夹".clone_into(&mut self.status);
            }
            Err(error) => self.set_error(error),
        }
    }

    fn start_profile_discovery(&mut self) {
        self.spawn_worker("正在只读检测 Chrome/Edge Profile", move |sender| {
            let profiles = discover_existing_profiles()?;
            sender
                .send(GuiEvent::Profiles(profiles))
                .map_err(|_| anyhow!("GUI 已关闭"))?;
            Ok(())
        });
    }

    fn start_profile_launch(&mut self) {
        let profile = match self.selected_profile() {
            Ok(profile) => profile.clone(),
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        self.clear_paired_extension();
        self.spawn_worker(
            "正在用所选 Profile 正常打开 WhatsApp Web",
            move |sender| {
                let launch = open_existing_profile(&profile)?;
                sender
                    .send(GuiEvent::ProfileOpened(launch))
                    .map_err(|_| anyhow!("GUI 已关闭"))?;
                Ok(())
            },
        );
    }

    fn start_extension_pairing(&mut self) {
        if self.profile_launch.is_none() {
            self.set_error("请先用所选 Profile 打开 WhatsApp Web");
            return;
        }
        let expected_product = match self.selected_profile() {
            Ok(profile) => profile.product,
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        let adapter_sha256 = format!("sha256:{}", waeb_writer::sha256_hex(ADAPTER_BYTES));
        self.pairing_code = None;
        self.clear_paired_extension();
        self.spawn_async_worker("正在建立一次性本机扩展通道", move |sender| async move {
            let gateway = PairingGateway::start(GatewayConfig::production(
                EXTENSION_VERSION,
                ADAPTER_ID,
                adapter_sha256,
            ))
            .await?;
            sender
                .send(GuiEvent::PairingCode(gateway.pairing_code().to_owned()))
                .map_err(|_| anyhow!("GUI 已关闭"))?;
            let gateway = gateway.wait_until_ready().await?;
            let ready = gateway.ready().clone();
            if ready.identity.browser_family != expected_product {
                gateway.shutdown().await?;
                bail!("扩展连接的浏览器与所选 Profile 不一致");
            }
            let page = BrowserPageChoice {
                product: ready.identity.browser_family,
                endpoint: ready.endpoint,
                target: CdpTarget {
                    id: ready.target_id,
                    target_type: "page".to_owned(),
                    url: ready.identity.tab_url,
                    title: "WhatsApp Web（勘察员当前选择）".to_owned(),
                    web_socket_debugger_url: String::new(),
                },
            };
            sender
                .send(GuiEvent::ExtensionReady {
                    gateway: Box::new(gateway),
                    page,
                    paired_at_utc: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                })
                .map_err(|_| anyhow!("GUI 已关闭"))?;
            Ok(())
        });
    }

    fn start_preflight(&mut self) {
        let request = match self.acquisition_request() {
            Ok(request) => request,
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        self.spawn_worker("正在检查 U 盘、任务与签名密钥", move |sender| {
            let report = preflight(&request)?;
            sender
                .send(GuiEvent::Preflight(serde_json::to_value(report)?))
                .map_err(|_| anyhow!("GUI 已关闭"))?;
            Ok(())
        });
    }

    fn start_acquisition(&mut self) {
        if let Err(error) = self.validate_assignment_step() {
            self.set_error(error);
            return;
        }
        let request = match self.acquisition_request() {
            Ok(request) => request,
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        let Some(bundle) = self.bundle.as_ref() else {
            self.set_error("U 盘配置未通过校验");
            return;
        };
        let trusted_fingerprint = bundle
            .profile()
            .evidence_signing_key_fingerprint_sha256
            .clone();
        let handoff_dir = bundle.paths().handoff.clone();
        let diagnostics_dir = bundle.paths().diagnostics.clone();
        let verifier = match resolve_verifier(None) {
            Ok(verifier) => verifier,
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        let passphrase = Zeroizing::new(std::mem::take(&mut *self.passphrase));
        let Some(gateway) = self.gateway.take() else {
            self.set_error("取证扩展尚未连接，请返回页面选择重新连接");
            return;
        };
        self.screen = Screen::Acquisition;
        self.spawn_async_worker("正在锁定目标并等待目视确认", move |sender| async move {
            let confirmation_sender = sender.clone();
            let collection = collect_t0(&request, passphrase.as_str(), move |challenge| {
                let confirmation_sender = confirmation_sender.clone();
                async move {
                    let (response, receiver) = oneshot::channel();
                    if confirmation_sender
                        .send(GuiEvent::Confirmation {
                            challenge,
                            response,
                        })
                        .is_err()
                    {
                        return None;
                    }
                    receiver.await.ok().flatten()
                }
            })
            .await;
            let relay_shutdown = gateway.shutdown().await;
            if let Err(error) = &collection {
                let _ = write_collection_diagnostic(&diagnostics_dir, &request, error);
            }
            let mut result = collection?;
            relay_shutdown.context("扩展通道未能确认安全关闭")?;
            sender
                .send(GuiEvent::Status(
                    "证据包已签名，正在执行独立校验".to_owned(),
                ))
                .map_err(|_| anyhow!("GUI 已关闭"))?;
            let verification = run_external_verifier(
                &verifier,
                &result.evidence_bag_path,
                Some(&trusted_fingerprint),
                &result,
            )?;
            result.promote_verified()?;
            let completion =
                match write_handoff_summary(&result, &request, &verification, &handoff_dir) {
                    Ok(handoff_summary) => json!({
                        "status": "complete",
                        "acquisition": result,
                        "externalVerification": verification,
                        "handoffSummary": handoff_summary,
                    }),
                    Err(error) => json!({
                        "status": "complete_but_handoff_summary_failed",
                        "acquisition": result,
                        "externalVerification": verification,
                        "handoffSummary": {"status": "failed", "error": error.to_string()},
                    }),
                };
            sender
                .send(GuiEvent::Complete(completion))
                .map_err(|_| anyhow!("GUI 已关闭"))?;
            Ok(())
        });
    }

    fn spawn_worker<F>(&mut self, status: &str, work: F)
    where
        F: FnOnce(mpsc::Sender<GuiEvent>) -> Result<()> + Send + 'static,
    {
        if self.running {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        self.worker = Some(receiver);
        self.running = true;
        self.error = None;
        status.clone_into(&mut self.status);
        thread::spawn(move || {
            if let Err(error) = work(sender.clone()) {
                let _ = sender.send(GuiEvent::Failed(format!("{error:#}")));
            }
        });
    }

    fn spawn_async_worker<F, Fut>(&mut self, status: &str, work: F)
    where
        F: FnOnce(mpsc::Sender<GuiEvent>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<()>> + Send + 'static,
    {
        self.spawn_worker(status, move |sender| {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .context("无法创建 GUI 后台运行时")?;
            runtime.block_on(work(sender))
        });
    }

    fn poll_worker(&mut self) {
        let events = self
            .worker
            .as_ref()
            .map_or_else(Vec::new, |receiver| receiver.try_iter().collect::<Vec<_>>());
        for event in events {
            match event {
                GuiEvent::Status(status) => self.status = status,
                GuiEvent::Profiles(profiles) => {
                    self.clear_browser_session();
                    self.profiles = profiles;
                    self.profile_error = None;
                    self.finish_worker(if self.profiles.is_empty() {
                        "未发现可用的 Chrome/Edge Profile"
                    } else {
                        "已更新浏览器 Profile 名单"
                    });
                }
                GuiEvent::ProfileOpened(launch) => {
                    self.profile_launch = Some(launch);
                    self.finish_worker("已打开所选 Profile，请确认 WhatsApp 自动登录并加载扩展");
                }
                GuiEvent::PairingCode(code) => {
                    self.pairing_code = Some(code);
                    "等待勘察员在当前 WhatsApp 页面中输入配对码".clone_into(&mut self.status);
                }
                GuiEvent::ExtensionReady {
                    gateway,
                    page,
                    paired_at_utc,
                } => {
                    self.targets = vec![page];
                    self.selected_target = Some(0);
                    self.extension_paired_at_utc = Some(paired_at_utc);
                    self.gateway = Some(*gateway);
                    self.pairing_code = None;
                    self.preflight_report = None;
                    self.finish_worker("扩展已连接到当前 WhatsApp 页面");
                }
                GuiEvent::Preflight(report) => {
                    self.available_space = report
                        .get("availableSpaceBytes")
                        .and_then(Value::as_u64)
                        .or(self.available_space);
                    self.preflight_report = Some(report);
                    self.finish_worker("现场预检通过，尚未读取聊天或解锁私钥");
                }
                GuiEvent::Confirmation {
                    challenge,
                    response,
                } => {
                    self.challenge = Some(challenge);
                    self.challenge_response = Some(response);
                    self.confirmation_input.zeroize();
                    "等待目视确认当前 WhatsApp 页面".clone_into(&mut self.status);
                }
                GuiEvent::Complete(completion) => {
                    let handoff_failed = completion.get("status").and_then(Value::as_str)
                        == Some("complete_but_handoff_summary_failed");
                    self.completion = Some(completion);
                    self.challenge = None;
                    self.challenge_response = None;
                    self.confirmation_input.zeroize();
                    self.screen = Screen::Complete;
                    self.finish_worker(if handoff_failed {
                        "证据已校验封存，但交接摘要写入失败"
                    } else {
                        "独立校验通过，正式证据包和交接摘要已完成"
                    });
                }
                GuiEvent::Failed(error) => {
                    self.challenge = None;
                    self.challenge_response = None;
                    self.confirmation_input.zeroize();
                    self.running = false;
                    self.worker = None;
                    self.pairing_code = None;
                    "操作失败关闭".clone_into(&mut self.status);
                    self.error = Some(operator_friendly_error(&error));
                }
            }
        }
    }

    fn finish_worker(&mut self, status: &str) {
        self.running = false;
        self.worker = None;
        self.error = None;
        status.clone_into(&mut self.status);
    }

    fn answer_challenge(&mut self, answer: Option<String>) {
        if let Some(response) = self.challenge_response.take() {
            let _ = response.send(answer);
        }
        self.challenge = None;
        self.confirmation_input.zeroize();
        self.error = None;
    }

    fn set_error(&mut self, error: impl std::fmt::Display) {
        self.error = Some(error.to_string());
        "请按提示检查后重试".clone_into(&mut self.status);
    }

    fn reset_for_next_acquisition(&mut self) {
        self.passphrase.zeroize();
        self.confirmation_input.zeroize();
        self.passive_t0_consent = false;
        self.clear_browser_session();
        self.preflight_report = None;
        self.completion = None;
        self.challenge = None;
        self.challenge_response = None;
        self.error = None;
        self.screen = Screen::Assignment;
        "已清除上次口令和结果，请确认下一次任务".clone_into(&mut self.status);
    }
}

const EXTENSION_ROOT_FILES: [&str; 6] = [
    "adapter",
    "manifest.json",
    "popup.html",
    "popup.js",
    "service-worker.js",
    "styles.css",
];
const EXTENSION_ADAPTER_FILES: [&str; 2] = ["adapter-manifest.json", "collector.iife.js"];

const fn browser_product_label(product: BrowserProduct) -> &'static str {
    match product {
        BrowserProduct::Chrome => "Chrome",
        BrowserProduct::Edge => "Edge",
    }
}

fn resolve_extension_directory() -> Result<PathBuf> {
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    let portable = executable
        .parent()
        .ok_or_else(|| anyhow!("无法确定程序所在目录"))?
        .join("extension");
    if portable.exists() {
        return validate_extension_directory(&portable);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extension/dist");
        validate_extension_directory(&development)
    }
    #[cfg(not(debug_assertions))]
    bail!("U 盘发行包缺少 extension 文件夹")
}

fn validate_extension_directory(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path).context("无法读取扩展文件夹")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
        bail!("扩展文件夹不是安全的真实目录");
    }
    let canonical = fs::canonicalize(path)?;
    let root_files = safe_directory_names(&canonical)?;
    if root_files
        != EXTENSION_ROOT_FILES
            .into_iter()
            .map(str::to_owned)
            .collect()
    {
        bail!("扩展文件清单与本版 Field Collector 不一致");
    }
    let adapter_dir = canonical.join("adapter");
    let adapter_metadata = fs::symlink_metadata(&adapter_dir)?;
    if !adapter_metadata.is_dir()
        || adapter_metadata.file_type().is_symlink()
        || metadata_is_reparse(&adapter_metadata)
    {
        bail!("Adapter 目录不安全");
    }
    let adapter_files = safe_directory_names(&adapter_dir)?;
    if adapter_files
        != EXTENSION_ADAPTER_FILES
            .into_iter()
            .map(str::to_owned)
            .collect()
    {
        bail!("Adapter 文件清单与本版 Field Collector 不一致");
    }
    for relative in [
        "manifest.json",
        "popup.html",
        "popup.js",
        "service-worker.js",
        "styles.css",
        "adapter/adapter-manifest.json",
        "adapter/collector.iife.js",
    ] {
        let file = canonical.join(relative);
        let file_metadata = fs::symlink_metadata(&file)?;
        if !file_metadata.is_file()
            || file_metadata.file_type().is_symlink()
            || metadata_is_reparse(&file_metadata)
            || file_metadata.len() == 0
            || file_metadata.len() > 8 * 1024 * 1024
        {
            bail!("扩展文件不安全或大小异常");
        }
    }
    let adapter = fs::read(canonical.join("adapter/collector.iife.js"))?;
    if adapter.as_slice() != ADAPTER_BYTES {
        bail!("Adapter 字节与 Field Collector 内嵌版本不一致");
    }
    let manifest_bytes = fs::read(canonical.join("adapter/adapter-manifest.json"))?;
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).context("Adapter 版本清单不是有效 JSON")?;
    let expected_sha = format!("sha256:{}", waeb_writer::sha256_hex(ADAPTER_BYTES));
    if manifest.get("schemaVersion").and_then(Value::as_str) != Some("wafc-adapter-manifest/1")
        || manifest.get("adapterId").and_then(Value::as_str) != Some(ADAPTER_ID)
        || manifest.get("version").and_then(Value::as_str) != Some(ADAPTER_VERSION)
        || manifest.get("sha256").and_then(Value::as_str) != Some(expected_sha.as_str())
        || manifest.as_object().map(serde_json::Map::len) != Some(4)
    {
        bail!("Adapter 版本清单与本版 Field Collector 不一致");
    }
    Ok(canonical)
}

fn safe_directory_names(path: &Path) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow!("扩展目录包含非 UTF-8 文件名"))?;
        if !names.insert(name) {
            bail!("扩展目录包含重复文件名");
        }
    }
    Ok(names)
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
const fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn show_folder(path: &Path) -> Result<()> {
    let safe_path = validate_extension_directory(path)?;
    let child = Command::new("explorer.exe")
        .arg(safe_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("无法打开扩展文件夹")?;
    drop(child);
    Ok(())
}

#[cfg(not(windows))]
fn show_folder(_path: &Path) -> Result<()> {
    bail!("当前版本仅支持 Windows")
}

fn write_collection_diagnostic(
    directory: &Path,
    request: &AcquisitionRequest,
    error: &CollectorError,
) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(directory).context("诊断目录不可用")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
        bail!("诊断目录不安全");
    }
    let directory = fs::canonicalize(directory)?;
    let (reason_code, whatsapp_build, reason_codes) = match error {
        CollectorError::UnsupportedWhatsAppVersion {
            build,
            reason_codes,
        } => (
            "unsupported_whatsapp_version_or_capability",
            Some(build.as_str()),
            reason_codes.clone(),
        ),
        CollectorError::TargetInvalidated(_) | CollectorError::TargetNotFound => {
            ("selected_page_changed", None, Vec::new())
        }
        CollectorError::Browser(_) | CollectorError::Bridge(_) | CollectorError::Protocol(_) => {
            ("read_only_transport_or_adapter_failed", None, Vec::new())
        }
        CollectorError::AccountConfirmationRejected
        | CollectorError::AccountConfirmationTimedOut => {
            ("operator_confirmation_not_completed", None, Vec::new())
        }
        _ => ("local_acquisition_failed", None, Vec::new()),
    };
    let context = request
        .existing_profile
        .as_ref()
        .ok_or_else(|| anyhow!("原 Profile 采集上下文不可用"))?;
    let payload = json!({
        "schemaVersion": "wafc-field-diagnostic/1",
        "createdAtUtc": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "status": "failed_closed",
        "reasonCode": reason_code,
        "reasonCodes": reason_codes,
        "whatsappBuild": whatsapp_build,
        "assignmentId": request.portable_configuration.assignment_id,
        "browserFamily": context.browser_family,
        "profileReferenceSha256": context.profile_reference_sha256,
        "browserProductWasRunning": context.browser_product_was_running,
        "browserOpenedAtUtc": context.browser_opened_at_utc,
        "extensionVersion": context.extension_version,
        "adapterId": context.adapter_id,
        "adapterVersion": context.adapter_version,
        "adapterSha256": context.adapter_sha256,
        "possibleProfileImpacts": [
            "original_profile_opened",
            "unpacked_extension_loaded_or_reloaded",
            "whatsapp_network_sync_possible",
            "browser_cache_or_profile_metadata_change_possible"
        ],
        "diagnosticFileContainsEvidenceContent": false,
        "formalEvidenceBagCreated": false,
        "partialStagingMayExist": !matches!(
            error,
            CollectorError::UnsupportedWhatsAppVersion { .. }
                | CollectorError::AccountConfirmationRejected
                | CollectorError::AccountConfirmationTimedOut
        ),
        "guidance": "update_adapter_and_run_authorized_message_matrix_before_retry"
    });
    let encoded = serde_json::to_vec_pretty(&payload)?;
    for attempt in 0_u8..10 {
        let filename = format!(
            "wafc-diagnostic-{}-{}-{attempt}.json",
            Utc::now().timestamp_micros(),
            std::process::id(),
        );
        let path = directory.join(filename);
        let mut file = match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        };
        file.write_all(&encoded)?;
        file.sync_all()?;
        return Ok(path);
    }
    bail!("无法创建唯一诊断文件")
}

fn configure_visuals(context: &egui::Context) {
    let mut visuals = egui::Visuals::light();
    visuals.hyperlink_color = PRIMARY;
    visuals.selection.bg_fill = Color32::from_rgb(224, 231, 255);
    visuals.selection.stroke.color = PRIMARY;
    context.set_visuals(visuals);
}

fn readonly_grid<'a>(ui: &mut egui::Ui, rows: impl IntoIterator<Item = (&'a str, &'a str)>) {
    egui::Grid::new(ui.next_auto_id())
        .num_columns(2)
        .spacing([18.0, 8.0])
        .striped(true)
        .show(ui, |ui| {
            for (label, value) in rows {
                ui.label(RichText::new(label).strong());
                ui.label(value);
                ui.end_row();
            }
        });
}

fn warning_card(ui: &mut egui::Ui, title: &str, guidance: &str, detail: &str) {
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.colored_label(DANGER, RichText::new(title).strong().size(18.0));
        ui.label(guidance);
        egui::CollapsingHeader::new("技术详情")
            .default_open(false)
            .show(ui, |ui| {
                ui.monospace(detail);
            });
    });
}

fn short_fingerprint(value: &str) -> String {
    if value.len() <= 24 {
        return value.to_owned();
    }
    format!("{}…{}", &value[..15], &value[value.len() - 8..])
}

fn format_bytes(bytes: u64) -> String {
    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;
    if bytes >= GIB {
        format_unit(bytes, GIB, "GB")
    } else {
        format_unit(bytes, MIB, "MB")
    }
}

fn format_unit(bytes: u64, unit: u64, suffix: &str) -> String {
    let whole = bytes / unit;
    let tenth = bytes % unit * 10 / unit;
    format!("{whole}.{tenth} {suffix}")
}

fn operator_friendly_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("current whatsapp web version") || lower.contains("unsupported_whatsapp") {
        "当前 WhatsApp Web 版本未通过只读能力检查，采集已停止。非内容诊断已尝试写入 U盘\\diagnostics，请更新 Adapter 后再试。".to_owned()
    } else if lower.contains("connection")
        || lower.contains("endpoint")
        || lower.contains("cdp")
        || lower.contains("extension relay")
        || lower.contains("websocket")
    {
        "取证扩展连接已停止。请保持 WhatsApp 页面打开，然后返回上一步重新连接扩展。".to_owned()
    } else if lower.contains("passphrase") || lower.contains("unlock") || lower.contains("keystore")
    {
        "密钥口令不正确，或勘察员密钥与当前任务不匹配。".to_owned()
    } else if lower.contains("assignment") || lower.contains("portable") {
        "U 盘任务或配置已失效。请回到 Analysis Workstation 重新下发。".to_owned()
    } else {
        error.chars().take(360).collect()
    }
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "<invalid JSON>".to_owned())
}

fn install_windows_cjk_font(context: &egui::Context) {
    let Some(path) = windows_ui_font_path() else {
        return;
    };
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32 * 1024 * 1024
    {
        return;
    }
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    let mut fonts = FontDefinitions::default();
    let name = "windows-cjk".to_owned();
    fonts
        .font_data
        .insert(name.clone(), Arc::new(FontData::from_owned(bytes)));
    for family in [FontFamily::Proportional, FontFamily::Monospace] {
        fonts.families.entry(family).or_default().push(name.clone());
    }
    context.set_fonts(fonts);
}

#[cfg(windows)]
fn windows_ui_font_path() -> Option<PathBuf> {
    let windows = std::env::var_os("WINDIR")?;
    ["msyh.ttc", "msyh.ttf", "simhei.ttf", "segoeui.ttf"]
        .into_iter()
        .map(|name| Path::new(&windows).join("Fonts").join(name))
        .find(|path| path.is_file())
}

#[cfg(not(windows))]
fn windows_ui_font_path() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gui_screen_sequence_is_fixed_to_five_plain_language_steps() {
        assert_eq!(Screen::ALL.len(), 5);
        assert_eq!(Screen::ALL[0], Screen::Assignment);
        assert_eq!(Screen::ALL[4], Screen::Complete);
    }

    #[test]
    fn fingerprint_display_keeps_algorithm_and_both_ends() {
        let value = format!("sha256:{}", "a".repeat(64));
        let shortened = short_fingerprint(&value);
        assert!(shortened.starts_with("sha256:"));
        assert!(shortened.ends_with("aaaaaaaa"));
        assert!(shortened.contains('…'));
    }

    #[test]
    fn friendly_errors_hide_low_level_browser_terms() {
        let message = operator_friendly_error("CDP endpoint connection refused: ws://secret");
        assert!(!message.contains("ws://"));
        assert!(message.contains("取证扩展连接"));
    }

    #[test]
    fn normal_gui_flow_has_no_operator_supplied_endpoint_or_technical_field() {
        let gui = CollectorGui::new();
        assert!(gui.targets.is_empty());
        assert!(gui.gateway.is_none());
    }

    #[test]
    fn formatting_uses_operator_friendly_units() {
        assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2.0 GB");
        assert_eq!(format_bytes(512 * 1024 * 1024), "512.0 MB");
    }
}
