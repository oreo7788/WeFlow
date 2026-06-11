//! 数据库模块 - SQLite/WCDB 操作
//!
//! 包含：
//! - 微信数据库连接和查询
//! - 会话管理
//! - 消息读写

pub mod connection;
pub mod models;
pub mod queries;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::RwLock;
use rusqlite::{Connection, OpenFlags};
use tracing::{debug, error, info, warn};

/// 数据库配置
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DbConfig {
    pub db_path: String,
    pub key: Option<String>,
    pub read_only: bool,
}

impl Default for DbConfig {
    fn default() -> Self {
        Self {
            db_path: String::new(),
            key: None,
            read_only: true,
        }
    }
}

/// WCDB 数据库服务
#[napi]
pub struct WcdbService {
    connections: Arc<RwLock<dashmap::DashMap<String, Connection>>>,
    config: Arc<RwLock<DbConfig>>,
}

#[napi]
impl WcdbService {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(dashmap::DashMap::new())),
            config: Arc::new(RwLock::new(DbConfig::default())),
        }
    }

    /// 初始化数据库连接
    #[napi]
    pub fn initialize(&self, config: DbConfig) -> napi::Result<()> {
        *self.config.write() = config.clone();
        info!("初始化数据库: {}", config.db_path);
        Ok(())
    }

    /// 打开账户数据库
    #[napi]
    pub fn open_account(&self, wxid: String, account_path: String) -> napi::Result<bool> {
        let path = PathBuf::from(&account_path);

        if !path.exists() {
            warn!("数据库路径不存在: {}", account_path);
            return Ok(false);
        }

        // 打开连接
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
        match Connection::open_with_flags(&path, flags) {
            Ok(conn) => {
                // 如果有密钥，设置加密
                if let Some(ref key) = self.config.read().key {
                    if let Err(e) = conn.execute_batch(&format!("PRAGMA key = '{}';", key)) {
                        error!("设置数据库密钥失败: {}", e);
                        return Ok(false);
                    }
                }

                self.connections.write().insert(wxid.clone(), conn);
                info!("成功打开数据库: {} -> {}", wxid, account_path);
                Ok(true)
            }
            Err(e) => {
                error!("打开数据库失败: {} - {}", account_path, e);
                Ok(false)
            }
        }
    }

    /// 关闭账户连接
    #[napi]
    pub fn close_account(&self, wxid: String) -> napi::Result<bool> {
        let removed = self.connections.write().remove(&wxid).is_some();
        if removed {
            info!("关闭数据库连接: {}", wxid);
        }
        Ok(removed)
    }

    /// 执行查询
    #[napi]
    pub fn query(&self, wxid: String, sql: String) -> napi::Result<Vec<String>> {
        let connections = self.connections.read();
        let conn = connections
            .get(&wxid)
            .ok_or_else(|| napi::Error::from_reason(format!("未找到连接: {}", wxid)))?;

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| napi::Error::from_reason(format!("准备查询失败: {}", e)))?;

        let column_count = stmt.column_count();
        let rows = stmt
            .query_map([], |row| {
                let mut values = Vec::with_capacity(column_count);
                for i in 0..column_count {
                    let value: rusqlite::types::Value = row.get(i)?;
                    values.push(format!("{:?}", value));
                }
                Ok(values)
            })
            .map_err(|e| napi::Error::from_reason(format!("执行查询失败: {}", e)))?;

        let mut results = Vec::new();
        for row in rows {
            if let Ok(values) = row {
                results.push(values.join(", "));
            }
        }

        Ok(results)
    }

    /// 获取会话列表
    #[napi]
    pub fn get_sessions(&self, wxid: String) -> napi::Result<String> {
        let connections = self.connections.read();
        let conn = connections
            .get(&wxid)
            .ok_or_else(|| napi::Error::from_reason(format!("未找到连接: {}", wxid)))?;

        let mut stmt = conn
            .prepare(
                "SELECT 
                    username as id,
                    nickname,
                    remark,
                    type,
                    msg_count as message_count
                FROM Session 
                ORDER BY type ASC, username ASC"
            )
            .map_err(|e| napi::Error::from_reason(format!("准备查询失败: {}", e)))?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(models::Session {
                    id: row.get(0)?,
                    nickname: row.get(1)?,
                    remark: row.get(2)?,
                    r#type: row.get(3)?,
                    message_count: row.get(4)?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("查询失败: {}", e)))?;

        let sessions_vec: Vec<_> = sessions
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("读取结果失败: {}", e)))?;

        serde_json::to_string(&sessions_vec)
            .map_err(|e| napi::Error::from_reason(format!("序列化失败: {}", e)))
    }

    /// 获取消息数量
    #[napi]
    pub fn get_message_count(&self, wxid: String, session_id: String) -> napi::Result<i64> {
        let connections = self.connections.read();
        let conn = connections
            .get(&wxid)
            .ok_or_else(|| napi::Error::from_reason(format!("未找到连接: {}", wxid)))?;

        // 构建表名
        let table_name = format!("MSG_{}", session_id.replace("-", "_"));

        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {}", table_name),
                [],
                |row| row.get(0),
            )
            .map_err(|e| {
                // 表可能不存在
                if e.to_string().contains("no such table") {
                    return napi::Error::from_reason(format!("会话表不存在: {}", session_id));
                }
                napi::Error::from_reason(format!("查询失败: {}", e))
            })?;

        Ok(count)
    }
}

/// 数据库实用函数
#[napi]
pub fn sanitize_table_name(name: String) -> String {
    // 替换非法字符
    name.replace("-", "_")
        .replace(".", "_")
        .replace(" ", "_")
        .replace(|c: char| !c.is_alphanumeric() && c != '_', "")
}