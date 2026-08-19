#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod acquisition;
mod app;
mod protocol;
mod storage;
mod transport;
mod viewer;

use anyhow::{Result, anyhow};
use app::CollectorApp;

fn main() -> Result<()> {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_inner_size([1_280.0, 820.0])
            .with_min_inner_size([960.0, 640.0]),
        ..Default::default()
    };
    eframe::run_native(
        "WhatsApp 网页现场快采",
        options,
        Box::new(|creation| Ok(Box::new(CollectorApp::new(&creation.egui_ctx)))),
    )
    .map_err(|error| anyhow!(error.to_string()))?;
    Ok(())
}
