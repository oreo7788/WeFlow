//! 导出模块 - 消息导出功能
//!
//! 支持格式：
//! - HTML（带图片和样式）
//! - JSON
//! - CSV
//! - Excel
//! - TXT
//! - ChatLab 格式

pub mod html;
pub mod json;
pub mod csv;
pub mod excel;
pub mod txt;

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::RwLock;
use tokio::sync::mpsc;
use tracing::error;

use crate::db::models::{ExportProgress, Message, Session};

/// 导出格式
#[napi]
#[derive(Debug)]
pub enum ExportFormat {
    Html,
    Json,
    Csv,
    Excel,
    Txt,
    ChatLab,
}

impl ExportFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Json => "json",
            Self::Csv => "csv",
            Self::Excel => "xlsx",
            Self::Txt => "txt",
            Self::ChatLab => "json",
        }
    }
}

/// 导出配置
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ExportConfig {
    pub format: ExportFormat,
    pub output_path: String,
    pub include_media: bool,
    pub include_avatar: bool,
    pub date_range_start: Option<i64>,
    pub date_range_end: Option<i64>,
    pub max_file_size_mb: Option<i32>,
    pub naming_mode: String,  // 'datetime', 'sequential', 'original'
}

impl Default for ExportConfig {
    fn default() -> Self {
        Self {
            format: ExportFormat::Html,
            output_path: String::new(),
            include_media: true,
            include_avatar: false,
            date_range_start: None,
            date_range_end: None,
            max_file_size_mb: None,
            naming_mode: "datetime".to_string(),
        }
    }
}

/// 导出任务控制
#[napi]
pub struct ExportTask {
    id: String,
    config: ExportConfig,
    progress: Arc<RwLock<ExportProgress>>,
    cancel_tx: Arc<std::sync::Mutex<Option<mpsc::Sender<()>>>>,
}

impl Clone for ExportTask {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            config: self.config.clone(),
            progress: Arc::clone(&self.progress),
            cancel_tx: Arc::clone(&self.cancel_tx),
        }
    }
}

#[napi]
impl ExportTask {
    #[napi(constructor)]
    pub fn new(id: String, config: ExportConfig) -> Self {
        Self {
            id,
            config,
            progress: Arc::new(RwLock::new(ExportProgress::new(0))),
            cancel_tx: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// 获取当前进度
    #[napi]
    pub fn get_progress(&self) -> ExportProgress {
        self.progress.read().clone()
    }

    /// 执行导出
    #[napi]
    pub async fn execute(&self, messages: Vec<Message>, session: Session) -> napi::Result<bool> {
        let (cancel_tx, mut cancel_rx) = mpsc::channel(1);
        *self.cancel_tx.lock().unwrap() = Some(cancel_tx);

        let total = messages.len() as i64;
        self.progress.write().total = total;
        self.progress.write().set_stage("exporting");

        let result = match self.config.format {
            ExportFormat::Html => {
                html::export_html(&self.config, messages, session, &self.progress, &mut cancel_rx).await
            }
            ExportFormat::Json => {
                json::export_json(&self.config, messages, session, &self.progress, &mut cancel_rx).await
            }
            ExportFormat::Csv => {
                csv::export_csv(&self.config, messages, session, &self.progress, &mut cancel_rx).await
            }
            ExportFormat::Excel => {
                excel::export_excel(&self.config, messages, session, &self.progress, &mut cancel_rx).await
            }
            ExportFormat::Txt => {
                txt::export_txt(&self.config, messages, session, &self.progress, &mut cancel_rx).await
            }
            ExportFormat::ChatLab => {
                json::export_chatlab(&self.config, messages, session, &self.progress, &mut cancel_rx).await
            }
        };

        match result {
            Ok(_) => {
                self.progress.write().set_stage("completed");
                self.progress.write().update(total, None);
                Ok(true)
            }
            Err(e) => {
                error!("导出失败: {}", e);
                self.progress.write().set_error(e.to_string());
                Ok(false)
            }
        }
    }

    /// 取消导出
    #[napi]
    pub fn cancel(&self) -> napi::Result<()> {
        if let Some(ref tx) = *self.cancel_tx.lock().unwrap() {
            let _ = tx.try_send(());
        }
        Ok(())
    }

    /// 暂停导出
    #[napi]
    pub fn pause(&self) -> napi::Result<()> {
        // 实现暂停逻辑
        Ok(())
    }

    /// 恢复导出
    #[napi]
    pub fn resume(&self) -> napi::Result<()> {
        // 实现恢复逻辑
        Ok(())
    }
}

/// 批量导出服务
#[napi]
pub struct ExportService {
    tasks: Arc<RwLock<std::collections::HashMap<String, ExportTask>>>,
}

#[napi]
impl ExportService {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(RwLock::new(std::collections::HashMap::new())),
        }
    }

    /// 创建导出任务
    #[napi]
    pub fn create_task(&self, id: String, config: ExportConfig) -> napi::Result<ExportTask> {
        let task = ExportTask::new(id.clone(), config);
        self.tasks.write().insert(id, task.clone());
        Ok(task)
    }

    /// 执行任务导出
    #[napi]
    pub async fn run_task(&self, task_id: String, messages: Vec<Message>, session: Session) -> napi::Result<bool> {
        let task = {
            let tasks = self.tasks.read();
            tasks.get(&task_id).cloned().ok_or_else(|| napi::Error::from_reason("任务不存在"))?
        };
        task.execute(messages, session).await
    }

    /// 获取任务进度
    #[napi]
    pub fn get_task_progress(&self, task_id: String) -> napi::Result<Option<ExportProgress>> {
        let tasks = self.tasks.read();
        if let Some(task) = tasks.get(&task_id) {
            Ok(Some(task.get_progress()))
        } else {
            Ok(None)
        }
    }

    /// 取消任务
    #[napi]
    pub fn cancel_task(&self, task_id: String) -> napi::Result<()> {
        let tasks = self.tasks.read();
        if let Some(task) = tasks.get(&task_id) {
            task.cancel()?;
        }
        Ok(())
    }

    /// 清理已完成任务
    #[napi]
    pub fn cleanup_tasks(&self) -> napi::Result<i32> {
        let mut tasks = self.tasks.write();
        let initial_count = tasks.len() as i32;
        
        tasks.retain(|_, task| {
            let progress = task.get_progress();
            progress.stage != "completed" && progress.stage != "error"
        });
        
        Ok(initial_count - tasks.len() as i32)
    }
}

/// 导出辅助函数
pub mod utils {
    use super::*;
    use std::path::Path;

    /// 确保目录存在
    pub fn ensure_dir(path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// 格式化文件大小
    pub fn format_file_size(bytes: u64) -> String {
        const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
        let mut size = bytes as f64;
        let mut unit_idx = 0;

        while size >= 1024.0 && unit_idx < UNITS.len() - 1 {
            size /= 1024.0;
            unit_idx += 1;
        }

        format!("{:.2} {}", size, UNITS[unit_idx])
    }

    /// 安全文件名
    pub fn sanitize_filename(name: &str) -> String {
        name.replace(|c: char| c.is_ascii_control() || ['/', '\\', ':', '*', '?', '"', '<', '>', '|'].contains(&c), "_")
            .trim()
            .to_string()
    }

    /// 构建导出文件名
    pub fn build_export_filename(
        session_name: &str,
        start_time: Option<i64>,
        end_time: Option<i64>,
        format: ExportFormat,
    ) -> String {
        let name = sanitize_filename(session_name);
        let date_part = if let (Some(start), Some(end)) = (start_time, end_time) {
            format!(
                "_{}_to_{}",
                chrono::DateTime::from_timestamp(start, 0)
                    .map(|d| d.format("%Y%m%d").to_string())
                    .unwrap_or_default(),
                chrono::DateTime::from_timestamp(end, 0)
                    .map(|d| d.format("%Y%m%d").to_string())
                    .unwrap_or_default()
            )
        } else {
            String::new()
        };

        format!("{}{}.{}", name, date_part, format.extension())
    }
}