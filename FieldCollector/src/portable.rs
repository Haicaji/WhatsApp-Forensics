//! Portable task discovery and validation.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, ensure};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PORTABLE_TASK_SCHEMA: &str = "wafc-portable-task/1";

/// Language-neutral task contract written by Analysis Workstation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableTask {
    pub schema_version: String,
    pub task_id: String,
    pub case_id: String,
    pub case_name: String,
    pub task_name: String,
    pub created_at_utc: String,
    pub result_directory: String,
}

impl PortableTask {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == PORTABLE_TASK_SCHEMA,
            "不支持的任务版本：{}",
            self.schema_version
        );
        Uuid::parse_str(&self.task_id).context("taskId 不是有效 UUID")?;
        Uuid::parse_str(&self.case_id).context("caseId 不是有效 UUID")?;
        ensure!(!self.case_name.trim().is_empty(), "caseName 不能为空");
        ensure!(!self.task_name.trim().is_empty(), "taskName 不能为空");
        DateTime::parse_from_rfc3339(&self.created_at_utc)
            .context("createdAtUtc 不是有效 ISO-8601 时间")?;
        ensure!(
            self.result_directory == "results",
            "resultDirectory 必须为 results"
        );
        Ok(())
    }
}

/// Paths and optional task selected before the UI starts.
#[derive(Clone, Debug)]
pub struct LaunchConfiguration {
    pub extension_directory: PathBuf,
    pub output_root: PathBuf,
    pub portable_mode: bool,
    pub task: Option<PortableTask>,
    pub startup_error: Option<String>,
}

impl LaunchConfiguration {
    /// Resolve the current process location. A broken adjacent task is surfaced
    /// as a blocking configuration error instead of falling back to standalone.
    pub fn for_current_process() -> Self {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let executable = match std::env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                return Self {
                    extension_directory: manifest_dir.join("extension/dist"),
                    output_root: manifest_dir.join("exports"),
                    portable_mode: false,
                    task: None,
                    startup_error: Some(format!("无法确定程序位置：{error}")),
                };
            }
        };
        match resolve_launch_configuration(&executable, &manifest_dir) {
            Ok(configuration) => configuration,
            Err(error) => {
                let root = executable
                    .parent()
                    .map_or_else(|| manifest_dir.clone(), Path::to_path_buf);
                Self {
                    extension_directory: root.join("extension"),
                    output_root: root.join("results"),
                    portable_mode: true,
                    task: None,
                    startup_error: Some(format!("便携任务无效：{error:#}")),
                }
            }
        }
    }
}

/// Pure path-based resolver used by startup and tests.
pub fn resolve_launch_configuration(
    executable: &Path,
    manifest_dir: &Path,
) -> Result<LaunchConfiguration> {
    let executable_root = executable
        .parent()
        .ok_or_else(|| anyhow!("可执行文件没有父目录"))?;
    let task_path = executable_root.join("task.json");
    if !task_path.exists() {
        return Ok(LaunchConfiguration {
            extension_directory: manifest_dir.join("extension/dist"),
            output_root: manifest_dir.join("exports"),
            portable_mode: false,
            task: None,
            startup_error: None,
        });
    }

    let metadata = fs::symlink_metadata(&task_path)
        .with_context(|| format!("无法读取 {}", task_path.display()))?;
    ensure!(metadata.file_type().is_file(), "task.json 必须是普通文件");
    ensure!(!metadata.file_type().is_symlink(), "task.json 不能是链接");
    let bytes =
        fs::read(&task_path).with_context(|| format!("无法读取 {}", task_path.display()))?;
    let task: PortableTask = serde_json::from_slice(&bytes).context("task.json 不是有效 JSON")?;
    task.validate()?;

    Ok(LaunchConfiguration {
        extension_directory: executable_root.join("extension"),
        output_root: executable_root.join(&task.result_directory),
        portable_mode: true,
        task: Some(task),
        startup_error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{PORTABLE_TASK_SCHEMA, resolve_launch_configuration};
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn standalone_mode_keeps_manifest_relative_paths() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("field-collector-mode-{}", Uuid::new_v4()));
        let executable_root = root.join("portable");
        let manifest_root = root.join("source");
        fs::create_dir_all(&executable_root)?;
        let configuration = resolve_launch_configuration(
            &executable_root.join("Field Collector.exe"),
            &manifest_root,
        )?;
        assert!(!configuration.portable_mode);
        assert_eq!(configuration.output_root, manifest_root.join("exports"));
        assert_eq!(
            configuration.extension_directory,
            manifest_root.join("extension/dist")
        );
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn valid_task_locks_paths_next_to_the_executable() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("field-collector-task-{}", Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        fs::write(
            root.join("task.json"),
            serde_json::to_vec_pretty(&json!({
                "schemaVersion": PORTABLE_TASK_SCHEMA,
                "taskId": Uuid::new_v4().to_string(),
                "caseId": Uuid::new_v4().to_string(),
                "caseName": "测试案件",
                "taskName": "现场提取",
                "createdAtUtc": "2026-08-20T01:02:03Z",
                "resultDirectory": "results"
            }))?,
        )?;
        let configuration =
            resolve_launch_configuration(&root.join("Field Collector.exe"), &root.join("source"))?;
        assert!(configuration.portable_mode);
        assert!(configuration.task.is_some());
        assert_eq!(configuration.output_root, root.join("results"));
        assert_eq!(configuration.extension_directory, root.join("extension"));
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn broken_adjacent_task_does_not_fall_back_to_standalone() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("field-collector-broken-{}", Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        fs::write(root.join("task.json"), b"{not-json")?;
        let Err(error) =
            resolve_launch_configuration(&root.join("Field Collector.exe"), &root.join("source"))
        else {
            anyhow::bail!("broken task unexpectedly passed validation");
        };
        assert!(error.to_string().contains("JSON"));
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
