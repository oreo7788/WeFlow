//! 数据模型 - 微信数据结构定义

use napi_derive::napi;
use serde::{Deserialize, Serialize};

/// 会话/聊天对象
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,           // 会话ID (username)
    pub nickname: Option<String>,
    pub remark: Option<String>,
    #[napi(js_name = "type")]
    pub r#type: i32,          // 会话类型：1=私聊, 2=群聊, 3=公众号等
    pub message_count: i32,
}

/// 聊天消息
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,              // 消息ID
    pub local_id: i64,        // 本地ID
    pub server_id: Option<String>, // 服务器ID
    pub create_time: i64,     // 创建时间 (秒)
    pub r#type: i32,         // 消息类型
    pub sub_type: i32,       // 子类型
    pub is_sender: bool,      // 是否发送者
    pub talker: String,       // 发送者ID
    pub content: Option<String>, // 文本内容
    pub image_path: Option<String>, // 图片路径
    pub voice_path: Option<String>, // 语音路径
    pub video_path: Option<String>, // 视频路径
    pub file_path: Option<String>, // 文件路径
    pub status: i32,          // 消息状态
    pub msg_seq: i64,         // 消息序列号
    // 导出增强字段
    pub display_name: Option<String>, // 发送者显示名称
    pub group_nickname: Option<String>, // 群昵称
    pub avatar_url: Option<String>, // 头像URL
    pub reply_to_id: Option<i64>, // 引用消息ID
    pub reply_to_content: Option<String>, // 引用消息内容
}

/// 联系人
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    pub username: String,     // 用户ID
    pub alias: Option<String>,
    pub nickname: Option<String>,
    pub remark: Option<String>,
    pub avatar: Option<String>,
    pub r#type: i32,        // 联系人类型
    pub verify_flag: i32,
    pub reserved1: Option<String>,
    pub reserved2: Option<String>,
}

/// 群聊信息
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRoom {
    pub room_id: String,
    pub room_owner: Option<String>,
    pub member_list: Vec<String>,
    pub display_name: Option<String>,
    pub member_count: i32,
}

/// 群成员
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMember {
    pub username: String,
    pub nickname: Option<String>,
    pub display_name: Option<String>,
}

/// 朋友圈消息
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnsPost {
    pub id: i64,
    pub create_time: i64,
    pub content: Option<String>,
    pub images: Vec<String>,
    pub likes: Vec<SnsLike>,
    pub comments: Vec<SnsComment>,
}

/// 朋友圈点赞
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnsLike {
    pub username: String,
    pub nickname: Option<String>,
    pub create_time: i64,
}

/// 朋友圈评论
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnsComment {
    pub id: i64,
    pub username: String,
    pub nickname: Option<String>,
    pub content: String,
    pub reply_to: Option<String>,
    pub create_time: i64,
}

/// 消息统计
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageStats {
    pub total_messages: i64,
    pub total_chars: i64,
    pub image_count: i64,
    pub voice_count: i64,
    pub video_count: i64,
    pub file_count: i64,
    pub first_message_time: Option<i64>,
    pub last_message_time: Option<i64>,
}

/// 年度统计
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YearlyStats {
    pub year: i32,
    pub message_count: i64,
    pub word_count: i64,
    pub top_sessions: Vec<SessionStat>,
    pub top_words: Vec<WordStat>,
    pub active_hours: Vec<i64>,  // 24小时的活跃分布
    pub active_days: Vec<i64>,   // 一周七天的活跃分布
}

/// 会话统计
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStat {
    pub session_id: String,
    pub session_name: String,
    pub message_count: i64,
    pub word_count: i64,
}

/// 词频统计
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordStat {
    pub word: String,
    pub count: i64,
}

/// 数据库表信息
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub row_count: i64,
    pub columns: Vec<ColumnInfo>,
}

/// 列信息
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub r#type: String,
    pub not_null: bool,
    pub default_value: Option<String>,
}

/// 导出进度
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportProgress {
    pub total: i64,
    pub current: i64,
    pub percentage: f64,
    pub current_item: Option<String>,
    pub stage: String,  // 'preparing', 'exporting', 'finalizing', 'completed', 'error'
    pub error: Option<String>,
}

impl ExportProgress {
    pub fn new(total: i64) -> Self {
        Self {
            total,
            current: 0,
            percentage: 0.0,
            current_item: None,
            stage: "preparing".to_string(),
            error: None,
        }
    }

    pub fn update(&mut self, current: i64, item: Option<String>) {
        self.current = current;
        self.percentage = if self.total > 0 {
            (current as f64 / self.total as f64) * 100.0
        } else {
            0.0
        };
        self.current_item = item;
    }

    pub fn set_stage(&mut self, stage: &str) {
        self.stage = stage.to_string();
    }

    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
        self.stage = "error".to_string();
    }
}