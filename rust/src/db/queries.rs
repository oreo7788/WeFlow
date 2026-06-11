//! 查询构建器 - 微信数据库查询

use std::fmt::Write;

/// 消息查询构建器
pub struct MessageQuery {
    table_name: String,
    limit: Option<usize>,
    offset: Option<usize>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    order_desc: bool,
}

impl MessageQuery {
    pub fn new(table_name: String) -> Self {
        Self {
            table_name,
            limit: None,
            offset: None,
            start_time: None,
            end_time: None,
            order_desc: true,
        }
    }

    pub fn limit(mut self, n: usize) -> Self {
        self.limit = Some(n);
        self
    }

    pub fn offset(mut self, n: usize) -> Self {
        self.offset = Some(n);
        self
    }

    pub fn time_range(mut self, start: i64, end: i64) -> Self {
        self.start_time = Some(start);
        self.end_time = Some(end);
        self
    }

    pub fn asc(mut self) -> Self {
        self.order_desc = false;
        self
    }

    pub fn desc(mut self) -> Self {
        self.order_desc = true;
        self
    }

    /// 构建 SQL
    pub fn build(self) -> String {
        let mut sql = format!(
            r#"SELECT 
                MsgId as id,
                localId as local_id,
                MsgSvrID as server_id,
                CreateTime as create_time,
                Type as type,
                SubType as sub_type,
                IsSender as is_sender,
                StrTalker as talker,
                StrContent as content,
                CompressContent as compress_content,
                DisplayContent as display_content,
                Status as status,
                MsgSeq as msg_seq,
                ImgPath as image_path,
                Reserved1 as reserved1,
                Reserved2 as reserved2
            FROM {}"#,
            self.table_name
        );

        // WHERE 条件
        let mut conditions = Vec::new();
        
        if let Some(start) = self.start_time {
            conditions.push(format!("CreateTime >= {}", start));
        }
        if let Some(end) = self.end_time {
            conditions.push(format!("CreateTime <= {}", end));
        }

        if !conditions.is_empty() {
            sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
        }

        // ORDER BY
        sql.push_str(if self.order_desc {
            " ORDER BY CreateTime DESC, MsgId DESC"
        } else {
            " ORDER BY CreateTime ASC, MsgId ASC"
        });

        // LIMIT OFFSET
        if let Some(limit) = self.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        }
        if let Some(offset) = self.offset {
            sql.push_str(&format!(" OFFSET {}", offset));
        }

        sql
    }
}

/// 会话统计查询
pub struct SessionStatsQuery {
    session_ids: Vec<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    group_by: GroupBy,
}

#[derive(Clone, Copy)]
pub enum GroupBy {
    Day,
    Week,
    Month,
    Year,
}

impl SessionStatsQuery {
    pub fn new(session_ids: Vec<String>) -> Self {
        Self {
            session_ids,
            start_time: None,
            end_time: None,
            group_by: GroupBy::Day,
        }
    }

    pub fn time_range(mut self, start: i64, end: i64) -> Self {
        self.start_time = Some(start);
        self.end_time = Some(end);
        self
    }

    pub fn group_by(mut self, by: GroupBy) -> Self {
        self.group_by = by;
        self
    }
}

/// 联系人查询构建器
pub struct ContactQuery {
    r#type: Option<i32>,
    keyword: Option<String>,
    limit: Option<usize>,
}

impl ContactQuery {
    pub fn new() -> Self {
        Self {
            r#type: None,
            keyword: None,
            limit: None,
        }
    }

    pub fn with_type(mut self, t: i32) -> Self {
        self.r#type = Some(t);
        self
    }

    pub fn search(mut self, keyword: String) -> Self {
        self.keyword = Some(keyword);
        self
    }

    pub fn limit(mut self, n: usize) -> Self {
        self.limit = Some(n);
        self
    }

    pub fn build(self) -> String {
        let mut sql = String::from(
            r#"SELECT 
                UserName as username,
                Alias as alias,
                NickName as nickname,
                Remark as remark,
                Reserved1 as avatar,
                Type as type,
                VerifyFlag as verify_flag,
                Reserved2 as reserved2,
                Reserved3 as reserved3
            FROM Contact"#
        );

        let mut conditions = Vec::new();

        if let Some(t) = self.r#type {
            conditions.push(format!("Type = {}", t));
        }

        if let Some(keyword) = self.keyword {
            let escaped = keyword.replace("'", "''");
            conditions.push(format!(
                "(NickName LIKE '%{}%' OR Remark LIKE '%{}%' OR Alias LIKE '%{}%')",
                escaped, escaped, escaped
            ));
        }

        if !conditions.is_empty() {
            sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
        }

        sql.push_str(" ORDER BY Type ASC, NickName ASC");

        if let Some(limit) = self.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        }

        sql
    }
}

/// 常用 SQL 查询模板
pub mod templates {
    /// 获取所有消息表名
    pub const LIST_MESSAGE_TABLES: &str = r#"
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name LIKE 'MSG_%'
        ORDER BY name
    "#;

    /// 获取数据库统计信息
    pub const DB_STATS: &str = r#"
        SELECT 
            (SELECT COUNT(*) FROM Contact) as contact_count,
            (SELECT COUNT(*) FROM Session) as session_count,
            (SELECT SUM(msg_count) FROM Session) as total_messages
    "#;

    /// 获取特定类型消息数量
    pub fn count_messages_by_type(table: &str, msg_type: i32) -> String {
        format!(
            "SELECT COUNT(*) FROM {} WHERE Type = {}",
            table, msg_type
        )
    }

    /// 搜索消息内容
    pub fn search_messages(table: &str, keyword: &str) -> String {
        let escaped = keyword.replace("'", "''");
        format!(
            r#"SELECT * FROM {} 
            WHERE StrContent LIKE '%{}%' 
            ORDER BY CreateTime DESC"#,
            table, escaped
        )
    }

    /// 获取每日消息统计
    pub const DAILY_STATS: &str = r#"
        SELECT 
            date(CreateTime, 'unixepoch', 'localtime') as date,
            COUNT(*) as count
        FROM {}
        GROUP BY date
        ORDER BY date
    "#;

    /// 获取消息类型分布
    pub const MESSAGE_TYPE_DISTRIBUTION: &str = r#"
        SELECT 
            Type,
            COUNT(*) as count
        FROM {}
        GROUP BY Type
        ORDER BY count DESC
    "#;
}