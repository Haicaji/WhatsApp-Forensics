//! Pull/ACK acquisition loop connecting the fixed page controller to the JSON writer.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};

use crate::protocol::{AcquisitionEvent, ExtractorFrame, cdp_value};
use crate::storage::SessionWriter;
use crate::transport::GatewayHandle;

const DISPATCH_FUNCTION: &str = "function(command){ return this.dispatch(command); }";
const NEXT_FUNCTION: &str = "function(){ return JSON.stringify(this.next()); }";
const ACK_FUNCTION: &str = "function(sequence){ return this.ack(sequence); }";
const CANCEL_FUNCTION: &str = "function(){ return this.cancel(); }";
const ADAPTER_SOURCE: &str = include_str!("../extractor/dist/collector.iife.js");

#[derive(Default)]
struct UiFrameState {
    media_name: Option<String>,
    media_bytes: u64,
    last_media_report: u64,
}

impl UiFrameState {
    fn handle(&mut self, frame: &ExtractorFrame, events: &mpsc::Sender<AcquisitionEvent>) {
        match frame.kind.as_str() {
            "progress" => {
                let _ = events.send(AcquisitionEvent::Progress(frame.payload.clone()));
                let status = match frame.payload["phase"].as_str() {
                    Some("avatar_request") => Some(format!(
                        "正在请求头像 {}/{}：{}",
                        frame.payload["avatarIndex"].as_u64().unwrap_or(0),
                        frame.payload["avatarTotal"].as_u64().unwrap_or(0),
                        frame.payload["contactId"].as_str().unwrap_or("未知联系人")
                    )),
                    Some("media_request") => Some(format!(
                        "正在请求媒体 {}",
                        frame.payload["originalFileName"]
                            .as_str()
                            .unwrap_or("未命名文件")
                    )),
                    Some("media_chat_reactivate") => Some(format!(
                        "媒体地址已过期，正在重新激活会话 {}",
                        frame.payload["chatId"].as_str().unwrap_or("未知会话")
                    )),
                    _ => None,
                };
                if let Some(status) = status {
                    let _ = events.send(AcquisitionEvent::Status(status));
                }
            }
            "chat_begin" => {
                let _ = events.send(AcquisitionEvent::Status(format!(
                    "正在写入会话 {}",
                    frame.payload["chat"]["title"]
                        .as_str()
                        .unwrap_or_else(|| frame.payload["chatId"].as_str().unwrap_or("未知会话"))
                )));
            }
            "media_start" => {
                let name = frame.payload["originalFileName"]
                    .as_str()
                    .unwrap_or("未命名文件")
                    .to_owned();
                self.media_name = Some(name.clone());
                self.media_bytes = 0;
                self.last_media_report = 0;
                let _ = events.send(AcquisitionEvent::Status(format!(
                    "媒体响应已建立，等待数据：{name}"
                )));
            }
            "media_chunk" => {
                let chunk_bytes = frame.payload["dataBase64"]
                    .as_str()
                    .map_or(0, base64_decoded_length);
                self.media_bytes = self.media_bytes.saturating_add(chunk_bytes);
                if self.last_media_report == 0
                    || self.media_bytes.saturating_sub(self.last_media_report) >= 1024 * 1024
                {
                    self.last_media_report = self.media_bytes;
                    let _ = events.send(AcquisitionEvent::Status(format!(
                        "正在保存媒体 {} · 已接收 {}",
                        self.media_name.as_deref().unwrap_or("未命名文件"),
                        format_bytes(self.media_bytes)
                    )));
                }
            }
            "media_end" => {
                let name = self
                    .media_name
                    .take()
                    .unwrap_or_else(|| "未命名文件".to_owned());
                let status = frame.payload["status"].as_str().unwrap_or("unknown");
                let _ = events.send(AcquisitionEvent::Status(format!(
                    "媒体 {status}：{name} · {}",
                    format_bytes(self.media_bytes)
                )));
                self.media_bytes = 0;
                self.last_media_report = 0;
            }
            "media_failure" => {
                let reason = frame.payload["reason"].as_str().unwrap_or("原因未知");
                let _ = events.send(AcquisitionEvent::Status(format!(
                    "已跳过不可用媒体：{} · {reason}",
                    frame.payload["contactId"]
                        .as_str()
                        .or_else(|| frame.payload["originalFileName"].as_str())
                        .unwrap_or("未知媒体")
                )));
            }
            _ => {}
        }
    }
}

/// Run one full extraction on a worker thread.
pub fn run_acquisition(
    gateway: &GatewayHandle,
    output_root: &Path,
    cancellation: &Arc<AtomicBool>,
    events: &mpsc::Sender<AcquisitionEvent>,
) -> Result<PathBuf> {
    let _ = events.send(AcquisitionEvent::Status("正在等待扩展连接".to_owned()));
    gateway.wait_paired(Duration::from_secs(5))?;
    let _ = events.send(AcquisitionEvent::Status(
        "正在启用固定页面提取器".to_owned(),
    ));
    gateway.request("Runtime.enable", json!({}), Duration::from_secs(15))?;
    let evaluated = gateway.request(
        "Runtime.evaluate",
        json!({
            "expression": ADAPTER_SOURCE,
            "awaitPromise": false,
            "returnByValue": false,
            "userGesture": false
        }),
        Duration::from_secs(20),
    )?;
    if let Some(description) = evaluated
        .pointer("/exceptionDetails/exception/description")
        .and_then(Value::as_str)
    {
        anyhow::bail!("页面提取器注入失败：{description}");
    }
    let object_id = evaluated
        .pointer("/result/objectId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("页面提取器没有返回控制器对象"))?
        .to_owned();

    let result = run_controller(gateway, output_root, cancellation, events, &object_id);
    let _ = gateway.request(
        "Runtime.releaseObject",
        json!({"objectId": object_id}),
        Duration::from_secs(10),
    );
    result
}

fn run_controller(
    gateway: &GatewayHandle,
    output_root: &Path,
    cancellation: &Arc<AtomicBool>,
    events: &mpsc::Sender<AcquisitionEvent>,
    object_id: &str,
) -> Result<PathBuf> {
    let probe = call_controller(
        gateway,
        object_id,
        DISPATCH_FUNCTION,
        &[json!({"value": {"command": "probe"}})],
    )?;
    let unavailable = probe["datasets"].as_object().map_or(0, |datasets| {
        datasets
            .values()
            .filter(|item| item["status"] != "supported")
            .count()
    });
    let _ = events.send(AcquisitionEvent::Status(format!(
        "能力探测完成，{unavailable} 个类别当前不可用；结果会明确记录"
    )));

    let mut writer = SessionWriter::new(output_root)?;
    let start = call_controller(
        gateway,
        object_id,
        DISPATCH_FUNCTION,
        &[json!({"value": {"command": "start_full"}})],
    )?;
    anyhow::ensure!(start["accepted"] == true, "页面提取器拒绝开始命令");
    let _ = events.send(AcquisitionEvent::Status(
        "正在提取全部可访问历史和原始媒体".to_owned(),
    ));

    let mut expected_sequence = 0_u64;
    let mut cancel_sent = false;
    let mut completion: Option<(String, Value)> = None;
    let mut ui_frame_state = UiFrameState::default();
    let loop_result: Result<()> = (|| {
        loop {
            if cancellation.load(Ordering::SeqCst) && !cancel_sent {
                let _ = call_controller(gateway, object_id, CANCEL_FUNCTION, &[]);
                cancel_sent = true;
                let _ = events.send(AcquisitionEvent::Status(
                    "已请求取消，正在完成当前文件边界".to_owned(),
                ));
            }
            let next = call_controller(gateway, object_id, NEXT_FUNCTION, &[])?;
            if next["kind"] == "idle" {
                std::thread::sleep(Duration::from_millis(80));
                continue;
            }
            let frame: ExtractorFrame =
                serde_json::from_value(next).context("页面提取器返回了无效帧")?;
            frame.validate(expected_sequence)?;
            let terminal_status = writer.handle_frame(&frame)?;
            ui_frame_state.handle(&frame, events);
            let acknowledged = call_controller(
                gateway,
                object_id,
                ACK_FUNCTION,
                &[json!({"value": frame.sequence})],
            )?;
            anyhow::ensure!(acknowledged["accepted"] == true, "页面提取器拒绝 ACK");
            expected_sequence = expected_sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("frame sequence overflow"))?;
            if let Some(status) = terminal_status {
                completion = Some((status, frame.payload));
                break;
            }
        }
        Ok(())
    })();

    match loop_result {
        Ok(()) => {
            let (status, summary) =
                completion.ok_or_else(|| anyhow!("extractor ended without completion frame"))?;
            let path = writer.finish(&status, &summary)?;
            if status == "complete" || status == "cancelled" {
                Ok(path)
            } else {
                Err(anyhow!("提取器报告失败，部分结果保留在 {}", path.display()))
            }
        }
        Err(error) => {
            let detail = error.to_string();
            let path = writer.finish("failed", &json!({"error": detail}))?;
            Err(anyhow!("{detail}；部分结果保留在 {}", path.display()))
        }
    }
}

fn base64_decoded_length(encoded: &str) -> u64 {
    let padding = encoded
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);
    let decoded = encoded
        .len()
        .saturating_div(4)
        .saturating_mul(3)
        .saturating_sub(padding);
    u64::try_from(decoded).unwrap_or(u64::MAX)
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        let tenths = u128::from(bytes) * 10 / (1024 * 1024);
        format!("{}.{:01} MiB", tenths / 10, tenths % 10)
    } else if bytes >= 1024 {
        let tenths = u128::from(bytes) * 10 / 1024;
        format!("{}.{:01} KiB", tenths / 10, tenths % 10)
    } else {
        format!("{bytes} B")
    }
}

fn call_controller(
    gateway: &GatewayHandle,
    object_id: &str,
    function_declaration: &str,
    arguments: &[Value],
) -> Result<Value> {
    let response = gateway.request(
        "Runtime.callFunctionOn",
        json!({
            "functionDeclaration": function_declaration,
            "objectId": object_id,
            "arguments": arguments,
            "awaitPromise": true,
            "returnByValue": true,
            "userGesture": false
        }),
        Duration::from_secs(20),
    )?;
    cdp_value(&response)
}
