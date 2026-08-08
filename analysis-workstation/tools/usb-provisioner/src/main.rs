//! Restricted CLI wrapper for the Analysis Workstation USB provisioning backend.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use getopts::{Matches, Options};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
use wafc_usb_provisioner::{
    InitializeRequest, UsbProvisionRequest, initialize_workstation, read_assignment_template,
    read_operator_template,
};
use zeroize::{Zeroize, Zeroizing};

const MAX_RPC_REQUEST_BYTES: u64 = 128 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
enum RpcRequest {
    InitializeWorkstation {
        #[serde(rename = "stateDir")]
        state_dir: PathBuf,
        #[serde(rename = "workstationId")]
        workstation_id: String,
        #[serde(rename = "keyId")]
        key_id: String,
        passphrase: String,
        #[serde(rename = "createdAtUtc")]
        created_at_utc: chrono::DateTime<Utc>,
    },
    ProvisionUsb {
        #[serde(rename = "stateDir")]
        state_dir: PathBuf,
        #[serde(rename = "collectorRoot")]
        collector_root: PathBuf,
        #[serde(rename = "bundleId")]
        bundle_id: Uuid,
        operator: wafc_usb_provisioner::OperatorTemplate,
        assignments: Vec<wafc_usb_provisioner::AssignmentTemplateDocument>,
        #[serde(rename = "workstationPassphrase")]
        workstation_passphrase: String,
        #[serde(rename = "operatorPassphrase")]
        operator_passphrase: String,
        #[serde(rename = "createdAtUtc")]
        created_at_utc: chrono::DateTime<Utc>,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Workstation U 盘配置失败：{error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<ExitCode> {
    let mut arguments = std::env::args().skip(1);
    let Some(command) = arguments.next() else {
        print_help();
        return Ok(ExitCode::from(2));
    };
    let rest = arguments.collect::<Vec<_>>();
    match command.as_str() {
        "init-workstation" => init_workstation(&rest),
        "provision-usb" => provision_usb_command(&rest),
        "rpc" => rpc_command(&rest),
        "help" | "--help" | "-h" => {
            print_help();
            Ok(ExitCode::SUCCESS)
        }
        _ => {
            print_help();
            Ok(ExitCode::from(2))
        }
    }
}

fn rpc_command(arguments: &[String]) -> Result<ExitCode> {
    if !arguments.is_empty() {
        bail!("rpc 不接受命令行参数");
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_RPC_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RPC_REQUEST_BYTES {
        bail!("RPC 请求超过大小上限");
    }
    let parsed_request = serde_json::from_slice(&bytes);
    bytes.zeroize();
    let request: RpcRequest = parsed_request.context("RPC 请求不是严格 JSON")?;
    let result = execute_rpc(request);
    let response = match result {
        Ok(value) => json!({"ok": true, "result": value}),
        Err(error) => json!({
            "ok": false,
            "error": {
                "code": "provisioning_failed",
                "message": error.to_string(),
            }
        }),
    };
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(if response.get("ok") == Some(&Value::Bool(true)) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn execute_rpc(request: RpcRequest) -> Result<Value> {
    match request {
        RpcRequest::InitializeWorkstation {
            state_dir,
            workstation_id,
            key_id,
            mut passphrase,
            created_at_utc,
        } => {
            let profile = initialize_workstation(&InitializeRequest {
                state_dir: &state_dir,
                workstation_id: &workstation_id,
                key_id: &key_id,
                passphrase: &passphrase,
                created_at_utc,
            });
            passphrase.zeroize();
            Ok(serde_json::to_value(profile?)?)
        }
        RpcRequest::ProvisionUsb {
            state_dir,
            collector_root,
            bundle_id,
            operator,
            assignments,
            mut workstation_passphrase,
            mut operator_passphrase,
            created_at_utc,
        } => {
            let receipt = wafc_usb_provisioner::provision_usb(&UsbProvisionRequest {
                state_dir: &state_dir,
                usb_root: &collector_root,
                bundle_id,
                operator,
                assignments,
                workstation_passphrase: &workstation_passphrase,
                operator_passphrase: &operator_passphrase,
                created_at_utc,
            });
            workstation_passphrase.zeroize();
            operator_passphrase.zeroize();
            Ok(serde_json::to_value(receipt?)?)
        }
    }
}

fn init_workstation(arguments: &[String]) -> Result<ExitCode> {
    let mut options = Options::new();
    options.reqopt("", "state", "新的 Workstation 状态目录", "DIR");
    options.reqopt("", "workstation-id", "Workstation 标识", "ID");
    options.reqopt("", "key-id", "配置签名密钥标识", "ID");
    options.optflag("h", "help", "显示帮助");
    let matches = parse_options(&options, arguments)?;
    if matches.opt_present("help") {
        println!(
            "{}",
            options.usage(
                "用法: wafc-usb-provisioner init-workstation --state DIR --workstation-id ID --key-id ID"
            )
        );
        return Ok(ExitCode::SUCCESS);
    }
    let state_dir = PathBuf::from(required(&matches, "state")?);
    let workstation_id = required(&matches, "workstation-id")?;
    let key_id = required(&matches, "key-id")?;
    let passphrase = read_new_passphrase("Workstation 配置签名密钥口令")?;
    let profile = initialize_workstation(&InitializeRequest {
        state_dir: &state_dir,
        workstation_id: &workstation_id,
        key_id: &key_id,
        passphrase: passphrase.as_str(),
        created_at_utc: Utc::now(),
    })?;
    println!("{}", serde_json::to_string_pretty(&profile)?);
    Ok(ExitCode::SUCCESS)
}

fn provision_usb_command(arguments: &[String]) -> Result<ExitCode> {
    let mut options = Options::new();
    options.reqopt("", "state", "Workstation 状态目录", "DIR");
    options.reqopt("", "usb-root", "已放入两个 EXE 的 U 盘根目录", "DIR");
    options.reqopt("", "operator-template", "勘察员模板 JSON", "FILE");
    options.optmulti("", "assignment", "任务模板 JSON，可重复", "FILE");
    options.optopt("", "bundle-id", "可选固定 bundle UUID", "UUID");
    options.optflag("h", "help", "显示帮助");
    let matches = parse_options(&options, arguments)?;
    if matches.opt_present("help") {
        println!(
            "{}",
            options.usage(
                "用法: wafc-usb-provisioner provision-usb --state DIR --usb-root DIR --operator-template FILE --assignment FILE [--assignment FILE]"
            )
        );
        return Ok(ExitCode::SUCCESS);
    }
    let assignment_paths = matches.opt_strs("assignment");
    if assignment_paths.is_empty() {
        bail!("至少需要一个 --assignment");
    }
    let state_dir = PathBuf::from(required(&matches, "state")?);
    let usb_root = PathBuf::from(required(&matches, "usb-root")?);
    let operator =
        read_operator_template(&PathBuf::from(required(&matches, "operator-template")?))?;
    let assignments = assignment_paths
        .into_iter()
        .map(|path| read_assignment_template(&PathBuf::from(path)))
        .collect::<Result<Vec<_>, _>>()?;
    let workstation_passphrase = read_passphrase("Workstation 配置签名密钥口令")?;
    let operator_passphrase = read_new_passphrase("新勘察员证据签名密钥口令")?;
    let bundle_id = matches.opt_str("bundle-id").map_or_else(
        || Ok(Uuid::new_v4()),
        |value| Uuid::parse_str(&value).context("bundle-id 不是 UUID"),
    )?;
    let receipt = wafc_usb_provisioner::provision_usb(&UsbProvisionRequest {
        state_dir: &state_dir,
        usb_root: &usb_root,
        bundle_id,
        operator,
        assignments,
        workstation_passphrase: workstation_passphrase.as_str(),
        operator_passphrase: operator_passphrase.as_str(),
        created_at_utc: Utc::now(),
    })?;
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(ExitCode::SUCCESS)
}

fn read_passphrase(label: &str) -> Result<Zeroizing<String>> {
    let value = rpassword::prompt_password(format!("{label}: "))?;
    if value.len() < 12 {
        bail!("{label}至少需要 12 个 UTF-8 字节");
    }
    Ok(Zeroizing::new(value))
}

fn read_new_passphrase(label: &str) -> Result<Zeroizing<String>> {
    let first = read_passphrase(label)?;
    let mut second = Zeroizing::new(rpassword::prompt_password("再次输入口令: ")?);
    if first.as_str() != second.as_str() {
        second.zeroize();
        bail!("两次口令不一致");
    }
    Ok(first)
}

fn required(matches: &Matches, name: &str) -> Result<String> {
    let value = matches
        .opt_str(name)
        .ok_or_else(|| anyhow!("缺少 --{name}"))?;
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        bail!("--{name} 不能为空或包含控制字符");
    }
    Ok(value)
}

fn parse_options(options: &Options, arguments: &[String]) -> Result<Matches> {
    options.parse(arguments).map_err(|error| anyhow!(error))
}

fn print_help() {
    println!(
        "WAFC Analysis Workstation USB Provisioner\n\n命令:\n  init-workstation  初始化实验室 Workstation 配置签名密钥\n  provision-usb     创建签名勘察员配置与任务并登记公钥\n  rpc               仅供 Electron 主进程通过有界 stdin JSON 调用\n\n口令只从隐藏输入或 RPC stdin 读取，不接受 argv、环境变量或模板字段。"
    );
}
