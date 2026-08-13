//! Native, portable workflow for nontechnical Field Collector operators.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::{Arc, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use browser_cdp::{BrowserProduct, CdpEndpoint, CdpTarget};
use browser_profile::{
    BrowserProfileObservation, ExistingProfileLaunch, ProfilePagePreparation,
    confirm_existing_profile_page, discover_existing_profiles, open_existing_profile,
    open_extension_manager,
};
use chrono::Utc;
use collector_core::{
    AccountConfirmationChallenge, AcquisitionCancellation, AcquisitionProgress, AcquisitionRequest,
    CollectorError, ExistingProfileContext, RecoveryCandidate, available_space_bytes,
    collect_with_progress_and_cancel, list_recovery_candidates, preflight,
};
use eframe::egui::{self, Color32, FontData, FontDefinitions, FontFamily, RichText};
use extension_transport::{ActiveGateway, GatewayConfig, PROTOCOL, PairingGateway};
use portable_config::{AcquisitionMode, MediaPolicy, MediaPolicyMode, PortableBundle};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use zeroize::{Zeroize, Zeroizing};

use super::{
    acquisition_request_from_bundle, load_portable_bundle, resolve_verifier, run_external_verifier,
    write_handoff_summary,
};

const WINDOW_TITLE: &str = concat!("WhatsApp Field Collector v", env!("CARGO_PKG_VERSION"));
const POLL_INTERVAL: Duration = Duration::from_millis(80);
const PRIMARY: Color32 = Color32::from_rgb(67, 56, 202);
const SUCCESS: Color32 = Color32::from_rgb(21, 128, 61);
const WARNING: Color32 = Color32::from_rgb(180, 83, 9);
const DANGER: Color32 = Color32::from_rgb(185, 28, 28);
const MUTED: Color32 = Color32::from_rgb(71, 85, 105);
const EXTENSION_VERSION: &str = "0.2.5";
const ADAPTER_ID: &str = "wa-private-collections-v2";
const ADAPTER_VERSION: &str = "2.5.3";
const ADAPTER_BRIDGE_PROTOCOL: &str = "wafc-bridge/2";
const MIN_PASSPHRASE_CHARACTERS: usize = 8;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const ADAPTER_BYTES: &[u8] = include_bytes!("../../../injector/dist/collector.iife.js");
const EXTENSION_MANIFEST_BYTES: &[u8] = include_bytes!("../../../extension/dist/manifest.json");
const EXTENSION_POPUP_HTML_BYTES: &[u8] = include_bytes!("../../../extension/dist/popup.html");
const EXTENSION_POPUP_JS_BYTES: &[u8] = include_bytes!("../../../extension/dist/popup.js");
const EXTENSION_SERVICE_WORKER_BYTES: &[u8] =
    include_bytes!("../../../extension/dist/service-worker.js");
const EXTENSION_STYLES_BYTES: &[u8] = include_bytes!("../../../extension/dist/styles.css");
const EXTENSION_ADAPTER_MANIFEST_BYTES: &[u8] =
    include_bytes!("../../../extension/dist/adapter/adapter-manifest.json");
static GUI_ASYNC_RUNTIME: OnceLock<std::result::Result<tokio::runtime::Runtime, String>> =
    OnceLock::new();

fn gui_async_runtime() -> Result<&'static tokio::runtime::Runtime> {
    GUI_ASYNC_RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| anyhow!("无法创建 GUI 后台运行时: {error}"))
}

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
    acquisition_mode: AcquisitionMode,
    media_policy: MediaPolicy,
}

#[derive(Clone, Debug)]
struct BrowserPageChoice {
    product: BrowserProduct,
    endpoint: CdpEndpoint,
    target: CdpTarget,
}

enum GuiEvent {
    Status(String),
    AssignmentKeyValidated {
        assignment_id: String,
        passphrase: Zeroizing<String>,
    },
    Profiles(Vec<BrowserProfileObservation>),
    ProfileOpened(ExistingProfileLaunch),
    PairingCode(String),
    ExtensionReady {
        gateway: Box<ActiveGateway>,
        page: BrowserPageChoice,
        paired_at_utc: String,
    },
    Preflight {
        report: Value,
        recovery_candidates: Vec<RecoveryCandidate>,
    },
    Confirmation {
        challenge: AccountConfirmationChallenge,
        response: oneshot::Sender<Option<String>>,
    },
    Progress(AcquisitionProgress),
    Complete(Value),
    Failed(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoverySelection {
    Resume(usize),
    StartNew,
}

struct CollectorGui {
    bundle: Option<Arc<PortableBundle>>,
    bundle_error: Option<String>,
    assignments: Vec<AssignmentView>,
    selected_assignment: usize,
    screen: Screen,
    passphrase: Zeroizing<String>,
    operator_consent: bool,
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
    recovery_candidates: Vec<RecoveryCandidate>,
    recovery_selection: RecoverySelection,
    completion: Option<Value>,
    progress: Option<AcquisitionProgress>,
    acquisition_started_at: Option<Instant>,
    last_progress_at: Option<Instant>,
    cancellation: Option<AcquisitionCancellation>,
    worker: Option<mpsc::Receiver<GuiEvent>>,
    running: bool,
    status: String,
    error: Option<String>,
    challenge: Option<AccountConfirmationChallenge>,
    challenge_response: Option<oneshot::Sender<Option<String>>>,
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
                        acquisition_mode: assignment.payload.acquisition_mode,
                        media_policy: assignment.payload.media_policy,
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
                    operator_consent: false,
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
                    recovery_candidates: Vec::new(),
                    recovery_selection: RecoverySelection::StartNew,
                    completion: None,
                    progress: None,
                    acquisition_started_at: None,
                    last_progress_at: None,
                    cancellation: None,
                    worker: None,
                    running: false,
                    status: "U 盘配置已通过签名和完整性初检".to_owned(),
                    error: None,
                    challenge: None,
                    challenge_response: None,
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
                operator_consent: false,
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
                recovery_candidates: Vec::new(),
                recovery_selection: RecoverySelection::StartNew,
                completion: None,
                progress: None,
                acquisition_started_at: None,
                last_progress_at: None,
                cancellation: None,
                worker: None,
                running: false,
                status: "U 盘配置不可用，正式采集已禁止".to_owned(),
                error: None,
                challenge: None,
                challenge_response: None,
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
            .ok_or_else(|| anyhow!("请先打开 WhatsApp Web，或确认对应页面已经打开"))?;
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
            self.operator_consent,
        );
        request.existing_profile = Some(ExistingProfileContext {
            profile_reference_sha256: profile.profile_reference_sha256.clone(),
            browser_family: browser_product_contract_value(profile.product).to_owned(),
            browser_product_was_running: launch.browser_was_running,
            browser_opened_at_utc: launch.opened_at_utc.clone(),
            browser_page_ready_at_utc: launch.page_ready_at_utc.clone(),
            browser_page_preparation: launch.preparation.as_str().to_owned(),
            extension_paired_at_utc: paired_at_utc.clone(),
            extension_version: gateway.ready().identity.extension_version.clone(),
            transport_protocol: PROTOCOL.to_owned(),
            adapter_id: gateway.ready().identity.adapter_id.clone(),
            adapter_version: ADAPTER_VERSION.to_owned(),
            adapter_sha256,
        });
        request.resume_evidence_id = match self.recovery_selection {
            RecoverySelection::Resume(index) => self
                .recovery_candidates
                .get(index)
                .map(|candidate| candidate.evidence_id),
            RecoverySelection::StartNew => None,
        };
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
                ui.label(RichText::new("只读取证 · U 盘自动保存 · 独立校验").color(MUTED));
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

        egui::CentralPanel::default().show(context, |ui| {
            egui::ScrollArea::vertical()
                .id_salt(("wafc_screen_scroll", self.screen.label()))
                .scroll_bar_visibility(
                    egui::containers::scroll_area::ScrollBarVisibility::AlwaysVisible,
                )
                .auto_shrink([false, false])
                .show(ui, |ui| match self.screen {
                    Screen::Assignment => self.assignment_ui(ui),
                    Screen::Browser => self.browser_ui(ui),
                    Screen::Preflight => self.preflight_ui(ui),
                    Screen::Acquisition => self.acquisition_ui(ui),
                    Screen::Complete => self.complete_ui(ui),
                });
        });

        if self.running {
            context.request_repaint_after(POLL_INTERVAL);
        }
    }
}

impl Drop for CollectorGui {
    fn drop(&mut self) {
        if let Some(cancellation) = &self.cancellation {
            cancellation.cancel();
        }
        if let Some(response) = self.challenge_response.take() {
            let _ = response.send(None);
        }
        self.passphrase.zeroize();
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
        ui.add_enabled_ui(!self.running, |ui| {
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
                            ui.selectable_value(
                                &mut self.selected_assignment,
                                index,
                                &assignment.id,
                            );
                        }
                    });
            });
        });
        if let Some(assignment) = self.assignments.get(self.selected_assignment) {
            readonly_grid(
                ui,
                [
                    ("授权/案件引用", assignment.authorization_reference.as_str()),
                    ("目标说明", assignment.target_description.as_str()),
                    ("有效期至", assignment.valid_until_utc.as_str()),
                    (
                        "采集模式",
                        acquisition_mode_label(assignment.acquisition_mode),
                    ),
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
        let accessibility_value_too_long = ui
            .add_enabled_ui(!self.running, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("密钥口令").strong());
                    accessible_password_edit(ui, &mut self.passphrase)
                })
                .inner
            })
            .inner;
        if accessibility_value_too_long {
            self.set_error(format!(
                "勘察员密钥口令不能超过 {MAX_PASSPHRASE_BYTES} 个 UTF-8 字节"
            ));
        }
        ui.add_enabled(
            !self.running,
            egui::Checkbox::new(
                &mut self.operator_consent,
                "我确认当前任务已获得授权，并同意执行上方只读采集模式",
            ),
        );
        let impact = self
            .assignments
            .get(self.selected_assignment)
            .map_or("任务模式不可用。", |assignment| {
                acquisition_mode_impact(assignment.acquisition_mode)
            });
        ui.label(RichText::new(impact).color(MUTED));
        ui.label(
            RichText::new(
                "口令会先在本机验证；验证通过后才允许打开浏览器和连接扩展。口令不会保存到 U 盘、日志或证据包。",
            )
            .color(MUTED),
        );

        ui.add_space(14.0);
        if ui
            .add_enabled(
                !self.running && self.bundle.is_some(),
                egui::Button::new("验证口令并开始现场预检"),
            )
            .clicked()
        {
            self.start_assignment_validation();
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
                        "该浏览器已有进程；此 Profile 是否已打开待确认"
                    } else {
                        "该浏览器当前未检测到进程"
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
        ui.label(
            RichText::new(
                "运行状态只精确到 Chrome/Edge，不能仅凭浏览器进程判断某个 Profile 是否已打开；当前页面最终由勘察员与扩展连接共同确认。",
            )
            .color(MUTED),
        );
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
            if ui
                .add_enabled(
                    !self.running && self.selected_profile.is_some(),
                    egui::Button::new("页面已打开，直接继续"),
                )
                .clicked()
            {
                self.confirm_profile_already_open();
            }
            if let Some(launch) = &self.profile_launch {
                let message = match launch.preparation {
                    ProfilePagePreparation::CollectorRequestedOpen => {
                        "已发出正常打开请求，请确认页面自动登录"
                    }
                    ProfilePagePreparation::OperatorConfirmedAlreadyOpen => {
                        "已确认使用当前已打开页面，不会重复打开"
                    }
                };
                ui.colored_label(SUCCESS, message);
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
        ui.label(
            "正在检查 U 盘配置、固定保存目录、密钥文件和扩展连接；不会读取聊天。签名私钥只会在正式采集时再次解锁。",
        );
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
        if !self.recovery_candidates.is_empty() {
            ui.add_space(12.0);
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.colored_label(
                    WARNING,
                    RichText::new("发现未完成采集").strong().size(18.0),
                );
                ui.label(
                    "程序找到了经过加密认证、属于当前任务的恢复点。继续前仍会重新核对当前 Profile、WhatsApp 页面、扩展和 Adapter；不一致时会安全停止。",
                );
                let mut selection = self.recovery_selection;
                for (index, candidate) in self.recovery_candidates.iter().enumerate() {
                    let label = format!(
                        "继续上次采集（{}） · 已处理附件 {} / {} · 保存于 {}",
                        short_evidence_id(candidate),
                        candidate.completed_media,
                        candidate.requested_media,
                        candidate.updated_at_utc,
                    );
                    ui.radio_value(&mut selection, RecoverySelection::Resume(index), label);
                }
                ui.radio_value(
                    &mut selection,
                    RecoverySelection::StartNew,
                    "开始新的采集（旧的未完成 staging 保留，不会被覆盖）",
                );
                self.recovery_selection = selection;
                ui.label(
                    RichText::new(
                        "继续采集会沿用原证据包与来源编号；任何同源校验失败都会拒绝续写。",
                    )
                    .color(MUTED),
                );
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
                    !self.running
                        && self.preflight_report.is_some()
                        && recovery_selection_is_valid(
                            self.recovery_selection,
                            self.recovery_candidates.len(),
                        ),
                    egui::Button::new(match self.recovery_selection {
                        RecoverySelection::Resume(_) => "确认页面并继续上次采集",
                        RecoverySelection::StartNew => "确认页面并开始新的只读采集",
                    }),
                )
                .clicked()
            {
                self.start_acquisition();
            }
        });
    }

    fn acquisition_ui(&mut self, ui: &mut egui::Ui) {
        self.acquisition_intro(ui);
        ui.add_space(12.0);
        if let Some(challenge) = self.challenge.clone() {
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.heading("请目视确认当前 WhatsApp Web 页面");
                ui.label("此确认只绑定当前浏览器页面，不证明账号所有权或账号级绝对完整性。");
                ui.label(format!("WhatsApp build：{}", challenge.whatsapp_build));
                ui.label(&challenge.instruction);
                ui.horizontal(|ui| {
                    if ui.button("我已核对当前页面并授权开始").clicked() {
                        self.answer_challenge(Some(challenge.confirmation_code));
                        "正在执行任务指定的只读取证采集".clone_into(&mut self.status);
                    }
                    if ui.button("取消").clicked() {
                        self.answer_challenge(None);
                        "已取消，正在安全释放浏览器连接".clone_into(&mut self.status);
                    }
                });
            });
        } else {
            if let Some(progress) = &self.progress {
                let elapsed_seconds = self
                    .acquisition_started_at
                    .map_or(progress.elapsed_seconds, |started| {
                        started.elapsed().as_secs().max(progress.elapsed_seconds)
                    });
                let last_update_age = self
                    .last_progress_at
                    .map(|updated| updated.elapsed().as_secs());
                acquisition_progress_card(
                    ui,
                    progress,
                    self.running,
                    elapsed_seconds,
                    last_update_age,
                );
            } else if self.running {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label(&self.status);
                });
                ui.colored_label(MUTED, "正在建立只读取证流，第一条进度即将显示。");
            }

            if self.running {
                if let Ok(assignment) = self.selected_assignment() {
                    ui.add_space(12.0);
                    egui::CollapsingHeader::new("本次任务的媒体策略")
                        .default_open(false)
                        .show(ui, |ui| {
                            ui.label(media_policy_summary(assignment.media_policy));
                            ui.label(format!(
                                "单文件上限：{}；媒体总量上限：{}。",
                                format_bytes(assignment.media_policy.max_asset_bytes),
                                format_bytes(assignment.media_policy.max_total_bytes),
                            ));
                            ui.label("这些限制由 Analysis Workstation 签名下发，现场不可修改。");
                        });
                }
                let cancellation_requested = self
                    .cancellation
                    .as_ref()
                    .is_some_and(AcquisitionCancellation::is_cancelled);
                let cancellation_allowed = self.progress.as_ref().is_some_and(|progress| {
                    !matches!(progress.phase.as_str(), "finalizing" | "verifying")
                });
                ui.add_space(14.0);
                if ui
                    .add_enabled(
                        cancellation_allowed && !cancellation_requested,
                        egui::Button::new("安全取消采集"),
                    )
                    .clicked()
                {
                    if let Some(cancellation) = &self.cancellation {
                        cancellation.cancel();
                    }
                    "已收到取消请求，正在完成当前数据块校验并安全停止".clone_into(&mut self.status);
                }
                if cancellation_requested {
                    ui.colored_label(
                        WARNING,
                        "正在安全停止：已接收的数据块会完成校验，失败 staging 会保留且不会成为正式证据包。",
                    );
                } else if cancellation_allowed {
                    ui.label(
                        RichText::new(
                            "取消后不会再请求新附件；WhatsApp 已发起的网络活动可能无法立即停止。",
                        )
                        .color(MUTED),
                    );
                } else {
                    ui.label(
                        RichText::new("正在封存或校验，为避免破坏证据一致性，此阶段不可取消。")
                            .color(MUTED),
                    );
                }
            } else if self.error.is_some() {
                self.failed_acquisition_guidance(ui);
            }
        }
    }

    fn acquisition_intro(&self, ui: &mut egui::Ui) {
        ui.heading("经授权的只读取证采集");
        if self.challenge.is_some() {
            ui.label("页面确认前不会解锁签名密钥、创建 staging 或读取聊天数据。");
        } else if self.running {
            ui.label("程序正在分阶段读取、写入和校验；页面会持续显示当前工作与等待原因。");
        } else if self.error.is_some() {
            ui.label("本次采集已安全停止，未完成内容不会晋升为正式 Evidence Bag。");
        }
    }

    fn failed_acquisition_guidance(&mut self, ui: &mut egui::Ui) {
        ui.add_space(12.0);
        egui::Frame::group(ui.style()).show(ui, |ui| {
            ui.strong("接下来怎么做");
            ui.label("1. 保持当前 WhatsApp 页面和 U 盘连接稳定。");
            ui.label("2. 查看窗口底部的原因提示；必要时重新连接取证扩展。");
            ui.label(
                "3. 返回任务页重新输入口令；预检会判断能否继续上次采集，也可明确选择开始新的采集。",
            );
            ui.colored_label(
                WARNING,
                "如果本次已建立 staging，程序会保留它用于诊断，但不会把它当作正式证据包。",
            );
        });
        ui.add_space(10.0);
        if ui.button("返回任务并重新输入口令").clicked() {
            self.reset_after_failed_acquisition();
        }
    }

    fn complete_ui(&mut self, ui: &mut egui::Ui) {
        let handoff_failed = self
            .completion
            .as_ref()
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            == Some("complete_but_handoff_summary_failed");
        let partial_scope = completion_scope_is_partial(self.completion.as_ref());
        let chat_count = completion_record_count(self.completion.as_ref(), "chats");
        let message_count = completion_record_count(self.completion.as_ref(), "messages");
        let media_requested = completion_media_count(self.completion.as_ref(), "requested");
        let media_available = completion_media_count(self.completion.as_ref(), "available");
        let media_download_timeouts =
            completion_media_count(self.completion.as_ref(), "downloadTimeout");
        let media_no_progress =
            completion_media_count(self.completion.as_ref(), "noProgressTimeout");
        let media_unavailable = completion_media_count(self.completion.as_ref(), "unavailable");
        let media_expired = completion_media_count(self.completion.as_ref(), "expired");
        ui.heading(if handoff_failed {
            "证据已封存，但交接摘要写入失败"
        } else if partial_scope {
            "证据已校验封存；采集范围部分完成"
        } else {
            "采集、校验与封存完成"
        });
        ui.colored_label(
            if handoff_failed {
                DANGER
            } else if partial_scope {
                WARNING
            } else {
                SUCCESS
            },
            if handoff_failed {
                "Evidence Bag 已独立验证并保存；请联系技术支持补做非内容交接摘要。"
            } else if partial_scope {
                "Evidence Bag 的签名和内部一致性已通过独立校验，但部分可观察数据未能完整获取。"
            } else {
                "Evidence Bag 已通过独立校验并保存到 U盘\\evidence\\sealed。"
            },
        );
        ui.label(format!(
            "本包记录：{chat_count} 个聊天、{message_count} 条消息。"
        ));
        if media_requested > 0 {
            ui.label(format!(
                "媒体获取：成功 {media_available} / {media_requested}；源端不可用 {media_unavailable}；无进展超时 {media_no_progress}；总时限超时 {media_download_timeouts}；过期 {media_expired}。"
            ));
            if media_available < media_requested {
                ui.colored_label(
                    WARNING,
                    "未取得的媒体已按具体原因写入完整性记录，不影响 Evidence Bag 的签名与独立校验。",
                );
                if media_no_progress > 0 {
                    ui.label(
                        "“无进展超时”表示 WhatsApp 下载任务在任务规定时间内没有产生任何新字节；程序已按下发策略完成允许的重试。",
                    );
                }
                if media_unavailable > 0 {
                    ui.label(
                        "“源端不可用”表示当前 WhatsApp Web 页面在允许的尝试后仍未提供可读取的媒体字节，常见于不可访问的头像或已不再驻留的附件。",
                    );
                }
            }
        } else {
            ui.label("本次任务未请求媒体字节，或页面未观察到媒体附件。");
        }
        if chat_count > 0 && message_count == 0 {
            ui.colored_label(
                DANGER,
                RichText::new(
                    "检测到聊天但消息数为 0：请勿将本包视为聊天内容已完整获取，应保留本包并使用更新后的 Adapter 复采。",
                )
                .strong(),
            );
        }
        if partial_scope {
            let reasons = completion_scope_reason_texts(self.completion.as_ref());
            if !reasons.is_empty() {
                ui.add_space(8.0);
                ui.strong("为什么标记为部分完成");
                for reason in reasons {
                    ui.label(format!("• {reason}"));
                }
            }
        }
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
        if self.passphrase.chars().count() < MIN_PASSPHRASE_CHARACTERS {
            bail!("请输入至少 {MIN_PASSPHRASE_CHARACTERS} 个字符的勘察员密钥口令");
        }
        if self.passphrase.len() > MAX_PASSPHRASE_BYTES {
            bail!("勘察员密钥口令不能超过 {MAX_PASSPHRASE_BYTES} 个 UTF-8 字节");
        }
        if !self.operator_consent {
            bail!("必须确认当前任务已获授权并同意执行签名任务中的采集模式");
        }
        Ok(())
    }

    fn start_assignment_validation(&mut self) {
        if let Err(error) = self.validate_assignment_step() {
            self.set_error(error);
            return;
        }
        let Some(bundle) = self.bundle.as_ref().map(Arc::clone) else {
            self.set_error("U 盘配置未通过校验");
            return;
        };
        let assignment_id = match self.selected_assignment() {
            Ok(assignment) => assignment.id.clone(),
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        let passphrase = Zeroizing::new(std::mem::take(&mut *self.passphrase));
        self.spawn_worker(
            "正在本机验证任务与密钥口令，不会打开浏览器或读取聊天",
            move |sender| {
                let _ = bundle.assignment_at(&assignment_id, Utc::now())?;
                let unlocked = bundle.unlock_operator_key(passphrase.as_str())?;
                drop(unlocked);
                sender
                    .send(GuiEvent::AssignmentKeyValidated {
                        assignment_id,
                        passphrase,
                    })
                    .map_err(|_| anyhow!("GUI 已关闭"))?;
                Ok(())
            },
        );
    }

    fn select_profile(&mut self, index: usize) {
        if self.selected_profile == Some(index) {
            return;
        }
        self.clear_browser_session();
        self.selected_profile = Some(index);
        self.profile_launch = None;
        self.error = None;
        "已选择 Profile；可打开 WhatsApp Web，或确认对应页面已经打开".clone_into(&mut self.status);
    }

    fn clear_paired_extension(&mut self) {
        self.gateway = None;
        self.pairing_code = None;
        self.extension_paired_at_utc = None;
        self.targets.clear();
        self.selected_target = None;
        self.preflight_report = None;
        self.recovery_candidates.clear();
        self.recovery_selection = RecoverySelection::StartNew;
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

    fn confirm_profile_already_open(&mut self) {
        let profile = match self.selected_profile() {
            Ok(profile) => profile,
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        match confirm_existing_profile_page(profile) {
            Ok(confirmation) => {
                self.clear_paired_extension();
                self.profile_launch = Some(confirmation);
                self.error = None;
                "已确认对应 WhatsApp 页面已经打开；下一步请加载或连接取证扩展"
                    .clone_into(&mut self.status);
            }
            Err(error) => self.set_error(error),
        }
    }

    fn start_extension_pairing(&mut self) {
        if self.profile_launch.is_none() {
            self.set_error("请先打开 WhatsApp Web，或确认对应页面已经打开");
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
        let passphrase = Zeroizing::new(self.passphrase.to_string());
        self.spawn_worker("正在检查 U 盘、任务与签名密钥", move |sender| {
            let report = preflight(&request)?;
            let recovery_candidates = list_recovery_candidates(&request, passphrase.as_str())?;
            sender
                .send(GuiEvent::Preflight {
                    report: serde_json::to_value(report)?,
                    recovery_candidates,
                })
                .map_err(|_| anyhow!("GUI 已关闭"))?;
            Ok(())
        });
    }

    #[allow(clippy::too_many_lines)]
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
        let cancellation = AcquisitionCancellation::new();
        self.screen = Screen::Acquisition;
        self.progress = Some(initial_acquisition_progress());
        self.acquisition_started_at = None;
        self.last_progress_at = Some(Instant::now());
        self.cancellation = Some(cancellation.clone());
        self.spawn_async_worker("正在锁定目标并等待目视确认", move |sender| async move {
            let confirmation_sender = sender.clone();
            let progress_sender = sender.clone();
            let collection = Box::pin(collect_with_progress_and_cancel(
                &request,
                passphrase.as_str(),
                move |challenge| {
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
                },
                cancellation,
                move |progress| {
                    let _ = progress_sender.send(GuiEvent::Progress(progress));
                },
            ))
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
            let runtime = gui_async_runtime()?;
            runtime.block_on(work(sender))
        });
    }

    #[allow(clippy::too_many_lines)]
    fn poll_worker(&mut self) {
        let events = self
            .worker
            .as_ref()
            .map_or_else(Vec::new, |receiver| receiver.try_iter().collect::<Vec<_>>());
        for event in events {
            match event {
                GuiEvent::Status(status) => self.status = status,
                GuiEvent::AssignmentKeyValidated {
                    assignment_id,
                    passphrase,
                } => self.finish_assignment_key_validation(&assignment_id, passphrase),
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
                GuiEvent::Preflight {
                    report,
                    recovery_candidates,
                } => {
                    self.available_space = report
                        .get("availableSpaceBytes")
                        .and_then(Value::as_u64)
                        .or(self.available_space);
                    self.preflight_report = Some(report);
                    self.recovery_candidates = recovery_candidates;
                    self.recovery_selection = if self.recovery_candidates.is_empty() {
                        RecoverySelection::StartNew
                    } else {
                        RecoverySelection::Resume(0)
                    };
                    self.finish_worker(if self.recovery_candidates.is_empty() {
                        "现场预检通过，尚未读取聊天；正式采集时会再次校验并解锁密钥"
                    } else {
                        "现场预检通过，并发现可安全核对后继续的未完成采集"
                    });
                }
                GuiEvent::Confirmation {
                    challenge,
                    response,
                } => {
                    self.challenge = Some(challenge);
                    self.challenge_response = Some(response);
                    "等待目视确认当前 WhatsApp 页面".clone_into(&mut self.status);
                }
                GuiEvent::Progress(progress) => {
                    self.apply_progress(progress);
                }
                GuiEvent::Complete(completion) => {
                    let handoff_failed = completion.get("status").and_then(Value::as_str)
                        == Some("complete_but_handoff_summary_failed");
                    let partial_scope = completion_scope_is_partial(Some(&completion));
                    self.completion = Some(completion);
                    self.progress = None;
                    self.acquisition_started_at = None;
                    self.last_progress_at = None;
                    self.cancellation = None;
                    self.challenge = None;
                    self.challenge_response = None;
                    self.screen = Screen::Complete;
                    self.finish_worker(if handoff_failed {
                        "证据已校验封存，但交接摘要写入失败"
                    } else if partial_scope {
                        "证据包已通过独立校验，但采集范围为部分完成，请查看页面提示"
                    } else {
                        "独立校验通过，正式证据包和交接摘要已完成"
                    });
                }
                GuiEvent::Failed(error) => {
                    self.challenge = None;
                    self.challenge_response = None;
                    self.running = false;
                    self.worker = None;
                    self.pairing_code = None;
                    self.cancellation = None;
                    if self.screen == Screen::Assignment {
                        "口令或任务验证未通过，未打开浏览器、未读取聊天"
                            .clone_into(&mut self.status);
                    } else {
                        "操作失败关闭".clone_into(&mut self.status);
                    }
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

    fn apply_progress(&mut self, progress: AcquisitionProgress) {
        acquisition_progress_text(&progress).clone_into(&mut self.status);
        self.progress = Some(progress);
        self.last_progress_at = Some(Instant::now());
    }

    fn finish_assignment_key_validation(
        &mut self,
        assignment_id: &str,
        passphrase: Zeroizing<String>,
    ) {
        let unchanged = self
            .assignments
            .get(self.selected_assignment)
            .is_some_and(|assignment| assignment.id == assignment_id)
            && self.operator_consent;
        if unchanged {
            self.passphrase = passphrase;
            self.screen = Screen::Browser;
            self.finish_worker("任务与密钥口令已验证，请选择已授权的浏览器 Profile");
        } else {
            drop(passphrase);
            self.running = false;
            self.worker = None;
            self.set_error("验证期间任务或授权确认发生变化，请重新确认");
        }
    }

    fn answer_challenge(&mut self, answer: Option<String>) {
        if answer.is_some() && self.acquisition_started_at.is_none() {
            let now = Instant::now();
            self.acquisition_started_at = Some(now);
            self.last_progress_at = Some(now);
        }
        if let Some(response) = self.challenge_response.take() {
            let _ = response.send(answer);
        }
        self.challenge = None;
        self.error = None;
    }

    fn set_error(&mut self, error: impl std::fmt::Display) {
        self.error = Some(error.to_string());
        "请按提示检查后重试".clone_into(&mut self.status);
    }

    fn reset_for_next_acquisition(&mut self) {
        if let Some(cancellation) = self.cancellation.take() {
            cancellation.cancel();
        }
        self.passphrase.zeroize();
        self.operator_consent = false;
        self.clear_browser_session();
        self.preflight_report = None;
        self.completion = None;
        self.challenge = None;
        self.challenge_response = None;
        self.progress = None;
        self.acquisition_started_at = None;
        self.last_progress_at = None;
        self.error = None;
        self.screen = Screen::Assignment;
        "已清除上次口令和结果，请确认下一次任务".clone_into(&mut self.status);
    }

    fn reset_after_failed_acquisition(&mut self) {
        if let Some(cancellation) = self.cancellation.take() {
            cancellation.cancel();
        }
        self.passphrase.zeroize();
        self.operator_consent = false;
        self.clear_browser_session();
        self.preflight_report = None;
        self.challenge = None;
        self.challenge_response = None;
        self.progress = None;
        self.acquisition_started_at = None;
        self.last_progress_at = None;
        self.screen = Screen::Assignment;
        "采集已失败关闭，请重新输入密钥口令；预检将检查能否安全继续".clone_into(&mut self.status);
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

const fn browser_product_contract_value(product: BrowserProduct) -> &'static str {
    match product {
        BrowserProduct::Chrome => "chrome",
        BrowserProduct::Edge => "edge",
    }
}

const fn acquisition_mode_label(mode: AcquisitionMode) -> &'static str {
    match mode {
        AcquisitionMode::PassiveT0 => "快速被动快照（仅当前驻留数据）",
        AcquisitionMode::ComprehensiveReadonlyV02 => "综合只读采集（历史与媒体）",
    }
}

const fn acquisition_mode_impact(mode: AcquisitionMode) -> &'static str {
    match mode {
        AcquisitionMode::PassiveT0 => {
            "只读取当前已驻留数据；不会加载历史、下载媒体、点击聊天或修改页面。"
        }
        AcquisitionMode::ComprehensiveReadonlyV02 => {
            "会调用 WhatsApp 内部只读加载器补全可观察历史和媒体，可能产生网络同步与缓存变化；不会点击聊天、发送消息或修改群组/社群。"
        }
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
    for (relative, expected) in [
        ("manifest.json", EXTENSION_MANIFEST_BYTES),
        ("popup.html", EXTENSION_POPUP_HTML_BYTES),
        ("popup.js", EXTENSION_POPUP_JS_BYTES),
        ("service-worker.js", EXTENSION_SERVICE_WORKER_BYTES),
        ("styles.css", EXTENSION_STYLES_BYTES),
        (
            "adapter/adapter-manifest.json",
            EXTENSION_ADAPTER_MANIFEST_BYTES,
        ),
        ("adapter/collector.iife.js", ADAPTER_BYTES),
    ] {
        if fs::read(canonical.join(relative))?.as_slice() != expected {
            bail!("扩展文件 {relative} 与本版 Field Collector 内嵌清单不一致");
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
        || manifest.get("bridgeProtocol").and_then(Value::as_str) != Some(ADAPTER_BRIDGE_PROTOCOL)
        || manifest.get("sha256").and_then(Value::as_str) != Some(expected_sha.as_str())
        || manifest.as_object().map(serde_json::Map::len) != Some(5)
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
        "browserPageReadyAtUtc": context.browser_page_ready_at_utc,
        "browserPagePreparation": context.browser_page_preparation,
        "extensionVersion": context.extension_version,
        "adapterId": context.adapter_id,
        "adapterVersion": context.adapter_version,
        "adapterSha256": context.adapter_sha256,
        "possibleProfileImpacts": [
            if context.browser_page_preparation == "collector_requested_open" {
                "original_profile_open_requested_by_collector"
            } else {
                "original_profile_already_open_operator_confirmed"
            },
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

/// Renders a password field and accepts the standard AccessKit `SetValue`
/// action used by Windows UI Automation and assistive input software.
///
/// egui 0.33 exposes `ValuePattern` for password fields but does not consume
/// text `SetValue` actions itself. The replacement remains process-local,
/// overwrites the previous in-memory value, and is bounded before copying.
fn accessible_password_edit(ui: &mut egui::Ui, passphrase: &mut Zeroizing<String>) -> bool {
    let mut response = ui.add(
        egui::TextEdit::singleline(&mut **passphrase)
            .password(true)
            .desired_width(340.0),
    );
    let replacement = ui.input(|input| {
        input
            .accesskit_action_requests(response.id, egui::accesskit::Action::SetValue)
            .filter_map(|request| match &request.data {
                Some(egui::accesskit::ActionData::Value(value)) => {
                    Some(Zeroizing::new(value.to_string()))
                }
                _ => None,
            })
            .last()
    });
    let Some(replacement) = replacement else {
        return false;
    };
    if !replace_bounded_passphrase(passphrase, replacement.as_str()) {
        return true;
    }
    response.mark_changed();
    ui.ctx().request_repaint();
    false
}

fn replace_bounded_passphrase(passphrase: &mut Zeroizing<String>, replacement: &str) -> bool {
    if replacement.len() > MAX_PASSPHRASE_BYTES {
        return false;
    }
    passphrase.zeroize();
    passphrase.push_str(replacement);
    true
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

fn short_evidence_id(candidate: &RecoveryCandidate) -> String {
    candidate.evidence_id.to_string().chars().take(8).collect()
}

const fn recovery_selection_is_valid(selection: RecoverySelection, candidate_count: usize) -> bool {
    match selection {
        RecoverySelection::Resume(index) => index < candidate_count,
        RecoverySelection::StartNew => true,
    }
}

fn initial_acquisition_progress() -> AcquisitionProgress {
    AcquisitionProgress {
        phase: "preparing".to_owned(),
        status_code: "validating_source".to_owned(),
        completed: 0,
        total: 0,
        media_index: None,
        media_total: None,
        attempt: None,
        current_asset_bytes: 0,
        total_media_bytes: 0,
        elapsed_seconds: 0,
        current_dataset: None,
        current_output_path: None,
        current_media_kind: None,
        current_file_name: None,
    }
}

fn acquisition_progress_card(
    ui: &mut egui::Ui,
    progress: &AcquisitionProgress,
    active: bool,
    elapsed_seconds: u64,
    last_update_age: Option<u64>,
) {
    const PHASES: [&str; 6] = ["核对", "历史", "记录", "媒体", "封存", "校验"];
    let current_phase = acquisition_phase_index(progress);
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.horizontal(|ui| {
            if active {
                ui.spinner();
            } else {
                ui.colored_label(WARNING, RichText::new("已停止").strong());
            }
            ui.vertical(|ui| {
                ui.heading(acquisition_phase_title(progress));
                ui.label(acquisition_progress_text(progress));
            });
        });
        ui.add_space(10.0);
        ui.horizontal_wrapped(|ui| {
            for (index, phase) in PHASES.iter().enumerate() {
                let (state, color) = match index.cmp(&current_phase) {
                    std::cmp::Ordering::Less => ("已完成", SUCCESS),
                    std::cmp::Ordering::Equal if active => ("进行中", PRIMARY),
                    std::cmp::Ordering::Equal => ("停在此处", WARNING),
                    std::cmp::Ordering::Greater => ("等待", MUTED),
                };
                ui.label(RichText::new(format!("{phase} · {state}")).color(color));
                if index + 1 < PHASES.len() {
                    ui.label(RichText::new("—").color(Color32::LIGHT_GRAY));
                }
            }
        });
        ui.add_space(10.0);
        if progress.total > 0 {
            let permyriad = progress
                .completed
                .saturating_mul(10_000)
                .checked_div(progress.total)
                .unwrap_or(0)
                .min(10_000);
            let fraction = f32::from(u16::try_from(permyriad).unwrap_or(10_000)) / 10_000.0;
            ui.add(
                egui::ProgressBar::new(fraction)
                    .show_percentage()
                    .text(format!(
                        "{}：{} / {}",
                        acquisition_progress_unit(progress),
                        progress.completed,
                        progress.total
                    )),
            );
        } else {
            ui.colored_label(
                MUTED,
                "当前阶段无法可靠计算百分比，程序会持续显示阶段与耗时。",
            );
        }
        ui.add_space(10.0);
        acquisition_progress_facts(ui, progress, elapsed_seconds, last_update_age);
        ui.add_space(10.0);
        acquisition_activity_label(ui, progress, active, last_update_age);
    });
    ui.add_space(10.0);
    if progress.phase == "media" {
        ui.colored_label(
            WARNING,
            "媒体可能需要等待 WhatsApp 加载。单个附件失败会被准确记录，系统会按任务策略继续处理其他内容。",
        );
    } else if active {
        ui.colored_label(
            MUTED,
            "请保持 WhatsApp 页面、浏览器和 U 盘连接稳定；已取得的数据正在持续写入并校验。",
        );
    }
}

fn acquisition_progress_facts(
    ui: &mut egui::Ui,
    progress: &AcquisitionProgress,
    elapsed_seconds: u64,
    last_update_age: Option<u64>,
) {
    egui::Grid::new("acquisition_progress_facts")
        .num_columns(2)
        .spacing([18.0, 6.0])
        .show(ui, |ui| {
            ui.label("已用时间");
            ui.strong(format_duration(elapsed_seconds));
            ui.end_row();
            ui.label("最近进度更新");
            ui.strong(progress_recency_text(last_update_age));
            ui.end_row();
            if let Some(dataset) = progress.current_dataset.as_deref() {
                ui.label("当前数据类别");
                ui.strong(dataset_display_name(dataset));
                ui.end_row();
            }
            if let Some(kind) = progress.current_media_kind.as_deref() {
                ui.label("当前附件类型");
                ui.strong(media_kind_display_name(kind));
                ui.end_row();
            }
            if let Some(file_name) = progress.current_file_name.as_deref() {
                ui.label("当前原文件名");
                ui.strong(file_name);
                ui.end_row();
            }
            if let Some(path) = progress.current_output_path.as_deref() {
                ui.label("正在写入证据包文件");
                ui.monospace(path);
                ui.end_row();
            }
            if let (Some(index), Some(total)) = (progress.media_index, progress.media_total) {
                ui.label("当前媒体");
                ui.strong(format!("{index} / {total}"));
                ui.end_row();
            }
            if let Some(attempt) = progress.attempt.filter(|value| *value > 0) {
                ui.label("当前尝试");
                ui.strong(format!("第 {attempt} 次"));
                ui.end_row();
            }
            if progress.phase == "media" {
                ui.label("当前媒体已写入");
                ui.strong(format_bytes(progress.current_asset_bytes));
                ui.end_row();
                ui.label("媒体累计写入");
                ui.strong(format_bytes(progress.total_media_bytes));
                ui.end_row();
            }
        });
}

fn acquisition_activity_label(
    ui: &mut egui::Ui,
    progress: &AcquisitionProgress,
    active: bool,
    last_update_age: Option<u64>,
) {
    let (text, color) = acquisition_activity_text(progress, active, last_update_age);
    ui.colored_label(color, RichText::new(text).strong());
}

fn acquisition_progress_unit(progress: &AcquisitionProgress) -> &'static str {
    match progress.phase.as_str() {
        "recovering" => "已完成媒体",
        "history" => "已处理聊天",
        "records" => "已保存记录",
        "media" => "已处理媒体",
        _ => "当前阶段",
    }
}

fn dataset_display_name(dataset: &str) -> &'static str {
    match dataset {
        "accounts" => "账号资料",
        "contacts" => "联系人",
        "chats" => "聊天会话",
        "chat_lists" => "聊天列表",
        "participants" => "群组成员",
        "messages" => "聊天消息",
        "message_events" => "消息事件",
        "reactions" => "表情回应",
        "receipts" => "送达与已读回执",
        "poll_votes" => "投票记录",
        "group_events" => "群组事件",
        "statuses" => "Status 动态",
        "calls" => "通话记录",
        "channels" => "频道",
        "channel_events" => "频道内容",
        "communities" => "社区",
        "community_relations" => "社区关系",
        "presence_snapshots" => "在线状态快照",
        "media" => "附件与头像",
        _ => "结构化记录",
    }
}

fn media_kind_display_name(kind: &str) -> &'static str {
    match kind {
        "image" => "图片",
        "video" => "视频",
        "audio" => "音频",
        "voice" => "语音消息",
        "document" => "文档",
        "sticker" => "贴纸",
        "contact_card" => "联系人名片",
        "avatar" => "头像",
        _ => "其他媒体",
    }
}

fn progress_recency_text(age_seconds: Option<u64>) -> String {
    match age_seconds {
        Some(0..=2) => "刚刚".to_owned(),
        Some(seconds) if seconds < 60 => format!("{seconds} 秒前"),
        Some(seconds) => format!("{} 分钟前", seconds / 60),
        None => "正在建立进度通道".to_owned(),
    }
}

fn acquisition_activity_text(
    progress: &AcquisitionProgress,
    active: bool,
    last_update_age: Option<u64>,
) -> (String, Color32) {
    if !active {
        return (
            "采集已停止；这里保留的是最后一次已确认的进度。".to_owned(),
            WARNING,
        );
    }
    match last_update_age {
        Some(0..=5) => (
            if progress.phase == "media" {
                "程序仍在工作，附件任务与本机连接保持响应。".to_owned()
            } else {
                "程序仍在工作，采集进度正在持续更新。".to_owned()
            },
            SUCCESS,
        ),
        Some(seconds @ 6..=30) => (
            format!("正在等待当前步骤返回结果，已等待 {seconds} 秒；请保持页面打开。"),
            WARNING,
        ),
        Some(seconds) => (
            format!(
                "当前步骤耗时较长，已有 {seconds} 秒未收到新进度；程序会按任务时限自动继续或给出明确结果。"
            ),
            WARNING,
        ),
        None => (
            "正在建立采集进度通道，请保持当前 WhatsApp 页面打开。".to_owned(),
            MUTED,
        ),
    }
}

fn acquisition_phase_index(progress: &AcquisitionProgress) -> usize {
    match progress.phase.as_str() {
        "history" => 1,
        "snapshot" | "records" => 2,
        "media" => 3,
        "finalizing" => 4,
        "verifying" => 5,
        _ => 0,
    }
}

fn acquisition_phase_title(progress: &AcquisitionProgress) -> &'static str {
    match progress.phase.as_str() {
        "preparing" => "正在核对页面与任务",
        "recovering" => "正在核对上次未完成采集",
        "history" => "正在读取可观察聊天历史",
        "snapshot" => "正在整理页面快照",
        "records" => "正在保存结构化记录",
        "media" => "正在处理媒体文件",
        "finalizing" => "正在封存 Evidence Bag",
        "verifying" => "正在执行独立校验",
        _ => "正在执行只读取证采集",
    }
}

fn acquisition_progress_text(progress: &AcquisitionProgress) -> &'static str {
    match progress.status_code.as_str() {
        "validating_source" => "正在复核所选 WhatsApp 页面、浏览器与签名任务。",
        "revalidating_recovery_source" => {
            "正在确认任务、Profile、当前 WhatsApp 页面和媒体清单仍与上次一致；核对通过后才会续写。"
        }
        "history_round_complete" => "已完成一轮历史读取，正在检查是否还有可观察记录。",
        "history_chat_complete" => "当前聊天历史已处理，正在继续下一项。",
        "snapshot_ready" => "页面快照已就绪，准备分块写入 U 盘。",
        "records_streaming" => "结构化记录正在分块写入，已完成内容不会重复保存。",
        "media_start" | "media_checking_cache" => "正在先检查浏览器中已有的附件数据。",
        "media_cache_miss" => "缓存中没有此附件，正在按任务策略准备下一步。",
        "media_requesting_download" => "缓存中未找到，正在按任务授权请求 WhatsApp 加载附件。",
        "media_waiting_download" => "附件仍在加载；通信保持响应，请不要关闭 WhatsApp 页面。",
        "media_retrying" => "本次附件尚未取得，正在按签名策略进行下一次尝试。",
        "media_blob_ready" | "media_streaming" => "附件已取得，正在分块写入并计算哈希。",
        "media_asset_complete" => "当前媒体已保存，正在继续处理下一项。",
        "media_asset_unavailable" => "当前媒体未能取得，原因将写入完整性记录，并继续处理其他内容。",
        "building_evidence_bag" => "正在生成清单、完整性结果和证据包签名。",
        "running_independent_verifier" => "证据包已封存，正在由独立校验器复核。",
        _ => "采集任务仍在运行，程序会持续更新这里的状态。",
    }
}

fn media_policy_summary(policy: MediaPolicy) -> &'static str {
    match policy.mode {
        MediaPolicyMode::CachedOnly => {
            "仅读取浏览器已缓存的媒体；缓存中没有的附件会被记录为未取得。"
        }
        MediaPolicyMode::NetworkBestEffort => {
            "先检查缓存，必要时允许 WhatsApp 加载媒体；单个附件失败不影响其他内容。"
        }
        MediaPolicyMode::MetadataOnly => "只保存附件元数据，不请求或保存附件字节。",
    }
}

fn format_duration(seconds: u64) -> String {
    let hours = seconds / 3_600;
    let minutes = seconds % 3_600 / 60;
    let seconds = seconds % 60;
    if hours > 0 {
        format!("{hours} 小时 {minutes:02} 分 {seconds:02} 秒")
    } else if minutes > 0 {
        format!("{minutes} 分 {seconds:02} 秒")
    } else {
        format!("{seconds} 秒")
    }
}

fn format_bytes(bytes: u64) -> String {
    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;
    const KIB: u64 = 1024;
    if bytes >= GIB {
        format_unit(bytes, GIB, "GB")
    } else if bytes >= MIB {
        format_unit(bytes, MIB, "MB")
    } else if bytes >= KIB {
        format_unit(bytes, KIB, "KB")
    } else {
        format!("{bytes} B")
    }
}

fn format_unit(bytes: u64, unit: u64, suffix: &str) -> String {
    let whole = bytes / unit;
    let tenth = bytes % unit * 10 / unit;
    format!("{whole}.{tenth} {suffix}")
}

fn operator_friendly_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("cancelled by operator") {
        "采集已按勘察员要求安全停止。已接收的数据块完成校验后保留在失败 staging 中，不会晋升为正式证据包；浏览器已发起的网络活动可能无法立即停止。".to_owned()
    } else if lower.contains("extension pairing was rejected") {
        "扩展配对未通过。请确认在当前 WhatsApp 页面输入的是本窗口最新配对码；如果刚更新 Collector，请在扩展管理页移除旧扩展，再加载本 U 盘的 extension 文件夹。".to_owned()
    } else if lower.contains("extension pairing timed out") {
        "等待扩展连接已超时，尚未读取聊天。请保持 WhatsApp 页面打开，返回上一步重新开始连接，并在扩展中输入新显示的配对码。".to_owned()
    } else if lower.contains("extension pairing port is unavailable") {
        "本机取证扩展通道正被另一份 Collector 占用。请只保留一个 Field Collector 窗口，再重新开始扩展连接。".to_owned()
    } else if lower.contains("current whatsapp web version")
        || lower.contains("unsupported_whatsapp")
    {
        "当前 WhatsApp Web 版本未通过只读能力检查，采集已停止。非内容诊断已尝试写入 U盘\\diagnostics，请更新 Adapter 后再试。".to_owned()
    } else if lower.contains("controller command contracts differ") {
        "Collector 发出的固定采集命令未通过页面执行契约，采集已在读取记录前安全停止。U 盘组件可能完全一致；请将 U盘\\diagnostics 与失败 staging 交回 Workstation 诊断，不要反复重装扩展。".to_owned()
    } else if lower.contains("controller protocol versions differ")
        || lower.contains("page bridge version contract did not match")
    {
        "Collector 与取证扩展组件版本不一致，尚未开始读取聊天。请在浏览器扩展管理页重新加载本次 U 盘 Field Collector\\extension 文件夹，再返回上一步重新连接。".to_owned()
    } else if lower.contains("cdp request timed out") {
        "取证扩展与 Collector 的短时通信未响应，采集已安全停止。这不是媒体下载等待时限；失败 staging 已保留，请保持页面打开并重新连接扩展后再试。".to_owned()
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
    } else if lower.contains("checkpoint") || lower.contains("recovery") {
        "无法证明当前页面与上次未完成采集仍是同一来源，因此程序拒绝续写。旧 staging 已保留；请回到预检页选择开始新的采集。".to_owned()
    } else if lower.contains("assignment") || lower.contains("portable") {
        "U 盘任务或配置已失效。请回到 Analysis Workstation 重新下发。".to_owned()
    } else {
        error.chars().take(360).collect()
    }
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "<invalid JSON>".to_owned())
}

fn completion_scope_is_partial(completion: Option<&Value>) -> bool {
    completion
        .and_then(|value| value.pointer("/acquisition/completeness/overall"))
        .and_then(Value::as_str)
        != Some("complete_as_observed")
}

fn completion_record_count(completion: Option<&Value>, dataset: &str) -> u64 {
    completion
        .and_then(|value| value.pointer(&format!("/acquisition/recordCounts/{dataset}")))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn completion_media_count(completion: Option<&Value>, outcome: &str) -> u64 {
    completion
        .and_then(|value| {
            value.pointer(&format!("/acquisition/completeness/mediaCounts/{outcome}"))
        })
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn completion_scope_reason_texts(completion: Option<&Value>) -> Vec<&'static str> {
    let Some(codes) = completion
        .and_then(|value| value.pointer("/acquisition/completeness/reasonCodes"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    codes
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|code| match code {
            "media_partial" => Some("部分媒体未取得，具体数量和原因见上方媒体摘要。"),
            "one_or_more_datasets_degraded" => Some(
                "聊天列表、成员、回执/事件或社区等至少一类只能读取当前页面已经物化的内容。",
            ),
            "history_stable_no_growth" => Some(
                "历史补全在连续多轮无新增后停止；这表示本次客户端观察已稳定，不等于服务端绝对全量。",
            ),
            "store_only_no_ui_fallback" => Some(
                "按只读策略未打开或滚动聊天页面强行补齐，以避免额外改变页面状态。",
            ),
            "account_scope_unverifiable" => {
                Some("WhatsApp Web 无法独立证明账号服务端数据已经绝对全量取得。")
            }
            "media_inline_preview_omitted" => Some(
                "消息中的内嵌缩略预览未冒充原附件保存，附件完整性以上方媒体结果为准。",
            ),
            _ => None,
        })
        .collect()
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

    struct TempExtension(PathBuf);

    impl Drop for TempExtension {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn gui_screen_sequence_is_fixed_to_five_plain_language_steps() {
        assert_eq!(Screen::ALL.len(), 5);
        assert_eq!(Screen::ALL[0], Screen::Assignment);
        assert_eq!(Screen::ALL[4], Screen::Complete);
        assert!(WINDOW_TITLE.ends_with(env!("CARGO_PKG_VERSION")));
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
    fn channel_timeout_is_not_misreported_as_a_media_download_timeout() {
        let message = operator_friendly_error("CDP request timed out");
        assert!(message.contains("短时通信未响应"));
        assert!(message.contains("不是媒体下载等待时限"));
    }

    #[test]
    fn pairing_failures_give_plain_language_recovery_steps() {
        let rejected = operator_friendly_error("extension pairing was rejected");
        assert!(rejected.contains("本窗口最新配对码"));
        assert!(rejected.contains("移除旧扩展"));
        assert!(!rejected.contains("pairing"));

        let timed_out = operator_friendly_error("extension pairing timed out");
        assert!(timed_out.contains("尚未读取聊天"));
        assert!(timed_out.contains("新显示的配对码"));

        let unavailable = operator_friendly_error("extension pairing port is unavailable");
        assert!(unavailable.contains("只保留一个 Field Collector 窗口"));
    }

    #[test]
    fn controller_command_rejection_is_not_misreported_as_a_version_mismatch() {
        let message =
            operator_friendly_error("collector and page controller command contracts differ");
        assert!(message.contains("固定采集命令"));
        assert!(message.contains("组件可能完全一致"));
        assert!(message.contains("不要反复重装扩展"));
        assert!(!message.contains("组件版本不一致"));
        assert!(!message.contains("controller"));
    }

    #[test]
    fn normal_gui_flow_has_no_operator_supplied_endpoint_or_technical_field() {
        let gui = CollectorGui::new();
        assert!(gui.targets.is_empty());
        assert!(gui.gateway.is_none());
    }

    #[test]
    fn existing_profile_uses_canonical_browser_family_contract_values() {
        assert_eq!(
            browser_product_contract_value(BrowserProduct::Chrome),
            "chrome"
        );
        assert_eq!(browser_product_contract_value(BrowserProduct::Edge), "edge");
        assert_eq!(browser_product_label(BrowserProduct::Chrome), "Chrome");
        assert_eq!(browser_product_label(BrowserProduct::Edge), "Edge");
    }

    #[test]
    fn gui_async_runtime_keeps_background_tasks_alive_between_workflow_phases() -> Result<()> {
        let runtime = gui_async_runtime()?;
        let (sender, completion_receiver) = oneshot::channel();
        let task = runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = sender.send(());
        });

        let signal_received = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(1), completion_receiver)
                .await
                .is_ok()
        });
        assert!(
            signal_received,
            "background task stopped between GUI workflow phases"
        );
        assert!(runtime.block_on(task).is_ok());
        Ok(())
    }

    #[test]
    fn failed_acquisition_returns_to_the_only_screen_that_accepts_a_passphrase() {
        let mut gui = CollectorGui::new();
        gui.screen = Screen::Acquisition;
        gui.passphrase = Zeroizing::new("temporary-passphrase".to_owned());
        gui.operator_consent = true;
        gui.preflight_report = Some(json!({"status": "passed"}));

        gui.reset_after_failed_acquisition();

        assert_eq!(gui.screen, Screen::Assignment);
        assert!(gui.passphrase.is_empty());
        assert!(!gui.operator_consent);
        assert!(gui.preflight_report.is_none());
        assert!(gui.status.contains("重新输入密钥口令"));
    }

    #[test]
    fn formatting_uses_operator_friendly_units() {
        assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2.0 GB");
        assert_eq!(format_bytes(512 * 1024 * 1024), "512.0 MB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_duration(65), "1 分 05 秒");
    }

    #[test]
    fn progress_copy_explains_waiting_and_continuation_without_technical_jargon() {
        let progress = AcquisitionProgress {
            phase: "media".to_owned(),
            status_code: "media_waiting_download".to_owned(),
            completed: 2,
            total: 5,
            media_index: Some(3),
            media_total: Some(5),
            attempt: Some(1),
            current_asset_bytes: 0,
            total_media_bytes: 1024,
            elapsed_seconds: 9,
            current_dataset: Some("media".to_owned()),
            current_output_path: Some("data/media/sha256/<hash-pending>".to_owned()),
            current_media_kind: Some("document".to_owned()),
            current_file_name: Some("evidence.pdf".to_owned()),
        };
        assert_eq!(acquisition_phase_title(&progress), "正在处理媒体文件");
        assert!(acquisition_progress_text(&progress).contains("仍在加载"));

        let mut unavailable = progress;
        unavailable.status_code = "media_asset_unavailable".to_owned();
        assert!(acquisition_progress_text(&unavailable).contains("继续处理其他内容"));
    }

    #[test]
    fn detailed_progress_uses_plain_language_dataset_and_media_names() {
        assert_eq!(dataset_display_name("messages"), "聊天消息");
        assert_eq!(dataset_display_name("statuses"), "Status 动态");
        assert_eq!(dataset_display_name("media"), "附件与头像");
        assert_eq!(media_kind_display_name("document"), "文档");
        assert_eq!(media_kind_display_name("voice"), "语音消息");
    }

    #[test]
    fn progress_page_starts_with_a_visible_phase_and_orders_all_six_steps() {
        let initial = initial_acquisition_progress();
        assert_eq!(acquisition_phase_index(&initial), 0);
        assert_eq!(acquisition_phase_title(&initial), "正在核对页面与任务");
        assert_eq!(acquisition_progress_unit(&initial), "当前阶段");

        let verifying = AcquisitionProgress {
            phase: "verifying".to_owned(),
            status_code: "running_independent_verifier".to_owned(),
            ..initial
        };
        assert_eq!(acquisition_phase_index(&verifying), 5);
        assert!(acquisition_progress_text(&verifying).contains("独立校验器"));
    }

    #[test]
    fn recovery_choice_only_accepts_an_existing_candidate_or_explicit_new_collection() {
        assert!(recovery_selection_is_valid(RecoverySelection::Resume(0), 1));
        assert!(!recovery_selection_is_valid(
            RecoverySelection::Resume(1),
            1
        ));
        assert!(recovery_selection_is_valid(RecoverySelection::StartNew, 0));
    }

    #[test]
    fn recovery_progress_explains_source_revalidation_in_plain_language() {
        let recovering = AcquisitionProgress {
            phase: "recovering".to_owned(),
            status_code: "revalidating_recovery_source".to_owned(),
            completed: 1,
            total: 2,
            media_index: Some(2),
            media_total: Some(2),
            attempt: None,
            current_asset_bytes: 0,
            total_media_bytes: 1024,
            elapsed_seconds: 3,
            current_dataset: Some("media".to_owned()),
            current_output_path: Some("data/media/sha256/<resume>".to_owned()),
            current_media_kind: None,
            current_file_name: None,
        };
        let title = acquisition_phase_title(&recovering);
        let copy = acquisition_progress_text(&recovering);
        assert!(title.contains("上次未完成采集"));
        assert!(copy.contains("任务"));
        assert!(copy.contains("Profile"));
        assert!(copy.contains("核对通过后才会续写"));
        for jargon in ["CDP", "WebSocket", "checkpoint"] {
            assert!(!title.contains(jargon));
            assert!(!copy.contains(jargon));
        }
    }

    #[test]
    fn progress_activity_copy_distinguishes_live_waiting_and_stopped_states() {
        let progress = AcquisitionProgress {
            phase: "media".to_owned(),
            status_code: "media_waiting_download".to_owned(),
            completed: 2,
            total: 5,
            media_index: Some(3),
            media_total: Some(5),
            attempt: Some(1),
            current_asset_bytes: 0,
            total_media_bytes: 1024,
            elapsed_seconds: 9,
            current_dataset: Some("media".to_owned()),
            current_output_path: Some("data/media/sha256/<hash-pending>".to_owned()),
            current_media_kind: Some("image".to_owned()),
            current_file_name: None,
        };
        assert_eq!(progress_recency_text(Some(0)), "刚刚");
        assert_eq!(progress_recency_text(Some(12)), "12 秒前");
        assert!(
            acquisition_activity_text(&progress, true, Some(2))
                .0
                .contains("仍在工作")
        );
        assert!(
            acquisition_activity_text(&progress, true, Some(18))
                .0
                .contains("已等待 18 秒")
        );
        assert!(
            acquisition_activity_text(&progress, true, Some(31))
                .0
                .contains("耗时较长")
        );
        assert!(
            acquisition_activity_text(&progress, false, Some(1))
                .0
                .contains("最后一次已确认")
        );
        assert_eq!(acquisition_progress_unit(&progress), "已处理媒体");
    }

    #[test]
    fn completion_page_distinguishes_evidence_validity_from_collection_scope() {
        let partial = json!({
            "acquisition": {
                "completeness": {
                    "overall": "partial",
                    "reasonCodes": ["history_stable_no_growth", "media_partial"]
                },
                "recordCounts": {"chats": 2, "messages": 0}
            }
        });
        assert!(completion_scope_is_partial(Some(&partial)));
        assert_eq!(completion_record_count(Some(&partial), "chats"), 2);
        assert_eq!(completion_record_count(Some(&partial), "messages"), 0);
        let reasons = completion_scope_reason_texts(Some(&partial));
        assert_eq!(reasons.len(), 2);
        assert!(reasons[0].contains("连续多轮无新增"));
        assert!(reasons[1].contains("部分媒体"));
        let media = json!({
            "acquisition": {
                "completeness": {
                    "mediaCounts": {"requested": 48, "available": 43, "expired": 2,
                        "downloadTimeout": 2, "noProgressTimeout": 1}
                }
            }
        });
        assert_eq!(completion_media_count(Some(&media), "requested"), 48);
        assert_eq!(completion_media_count(Some(&media), "available"), 43);
        assert_eq!(
            completion_media_count(Some(&media), "downloadTimeout")
                + completion_media_count(Some(&media), "noProgressTimeout"),
            3
        );

        let complete = json!({
            "acquisition": {
                "completeness": {"overall": "complete_as_observed"},
                "recordCounts": {"chats": 1, "messages": 42}
            }
        });
        assert!(!completion_scope_is_partial(Some(&complete)));
        assert_eq!(completion_record_count(Some(&complete), "messages"), 42);
    }

    #[test]
    fn accessible_passphrase_replacement_is_bounded_and_overwrites_old_value() {
        let mut passphrase = Zeroizing::new("old-sensitive-value".to_owned());
        assert!(replace_bounded_passphrase(
            &mut passphrase,
            "replacement-passphrase"
        ));
        assert_eq!(passphrase.as_str(), "replacement-passphrase");

        let oversized = "x".repeat(MAX_PASSPHRASE_BYTES + 1);
        assert!(!replace_bounded_passphrase(&mut passphrase, &oversized));
        assert_eq!(passphrase.as_str(), "replacement-passphrase");
    }

    #[test]
    fn collector_rejects_a_one_byte_extension_shell_change() -> Result<()> {
        let root = std::env::temp_dir().join(format!(
            "wafc-extension-integrity-{}-{}",
            std::process::id(),
            Utc::now().timestamp_micros()
        ));
        fs::create_dir(&root)?;
        let temporary = TempExtension(root);
        fs::create_dir(temporary.0.join("adapter"))?;
        for (relative, bytes) in [
            ("manifest.json", EXTENSION_MANIFEST_BYTES),
            ("popup.html", EXTENSION_POPUP_HTML_BYTES),
            ("popup.js", EXTENSION_POPUP_JS_BYTES),
            ("service-worker.js", EXTENSION_SERVICE_WORKER_BYTES),
            ("styles.css", EXTENSION_STYLES_BYTES),
            (
                "adapter/adapter-manifest.json",
                EXTENSION_ADAPTER_MANIFEST_BYTES,
            ),
            ("adapter/collector.iife.js", ADAPTER_BYTES),
        ] {
            fs::write(temporary.0.join(relative), bytes)?;
        }
        assert!(validate_extension_directory(&temporary.0).is_ok());
        let mut changed = EXTENSION_SERVICE_WORKER_BYTES.to_vec();
        changed.push(b'\n');
        fs::write(temporary.0.join("service-worker.js"), changed)?;
        assert!(validate_extension_directory(&temporary.0).is_err());
        Ok(())
    }
}
