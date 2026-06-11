//! 数据库连接管理

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use tracing::{debug, error, info, warn};

/// 数据库连接池（简化版）
pub struct ConnectionPool {
    connections: Arc<Mutex<Vec<Connection>>>,
    db_path: String,
    key: Option<String>,
}

impl ConnectionPool {
    /// 创建新的连接池
    pub fn new(db_path: &str, key: Option<String>) -> Result<Self> {
        let pool = Self {
            connections: Arc::new(Mutex::new(Vec::new())),
            db_path: db_path.to_string(),
            key,
        };

        // 初始化一个连接
        let conn = pool.create_connection()?;
        pool.connections.lock().unwrap().push(conn);

        Ok(pool)
    }

    /// 获取一个连接
    pub fn get(&self) -> Result<PooledConnection> {
        let mut connections = self.connections.lock().unwrap();
        
        if let Some(conn) = connections.pop() {
            Ok(PooledConnection {
                conn: Some(conn),
                pool: Arc::clone(&self.connections),
            })
        } else {
            // 如果没有可用连接，创建新的
            let conn = self.create_connection()?;
            Ok(PooledConnection {
                conn: Some(conn),
                pool: Arc::clone(&self.connections),
            })
        }
    }

    /// 创建新连接
    fn create_connection(&self) -> Result<Connection> {
        let path = Path::new(&self.db_path);
        
        if !path.exists() {
            bail!("数据库文件不存在: {}", self.db_path);
        }

        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
        let conn = Connection::open_with_flags(path, flags)
            .with_context(|| format!("打开数据库失败: {}", self.db_path))?;

        // 如果有密钥，设置加密
        if let Some(ref key) = self.key {
            conn.execute_batch(&format!("PRAGMA key = '{}';", key))
                .with_context(|| "设置数据库密钥失败")?;
        }

        // 优化设置
        conn.execute_batch(
            r#"
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA cache_size = -64000; -- 64MB cache
                PRAGMA temp_store = MEMORY;
            "#
        )?;

        Ok(conn)
    }
}

/// 池化连接，自动归还
pub struct PooledConnection {
    conn: Option<Connection>,
    pool: Arc<Mutex<Vec<Connection>>>,
}

impl std::ops::Deref for PooledConnection {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.conn.as_ref().unwrap()
    }
}

impl std::ops::DerefMut for PooledConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.conn.as_mut().unwrap()
    }
}

impl Drop for PooledConnection {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = self.pool.lock().unwrap().push(conn);
        }
    }
}

/// 数据库事务
pub struct Transaction<'conn> {
    tx: rusqlite::Transaction<'conn>,
}

impl<'conn> Transaction<'conn> {
    pub fn new(conn: &'conn mut Connection) -> Result<Self> {
        let tx = conn.transaction()?;
        Ok(Self { tx })
    }

    pub fn commit(self) -> Result<()> {
        self.tx.commit().map_err(|e| e.into())
    }

    pub fn rollback(self) -> Result<()> {
        self.tx.rollback().map_err(|e| e.into())
    }
}

impl<'conn> std::ops::Deref for Transaction<'conn> {
    type Target = rusqlite::Transaction<'conn>;

    fn deref(&self) -> &Self::Target {
        &self.tx
    }
}

impl<'conn> std::ops::DerefMut for Transaction<'conn> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.tx
    }
}
