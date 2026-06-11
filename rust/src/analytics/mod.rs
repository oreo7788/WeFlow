//! 数据分析模块 - 聊天记录统计与分析
//!
//! 功能：
//! - 消息统计
//! - 词频分析
//! - 活跃时间分析
//! - 年度报告
//! - 双人报告

pub mod stats;
pub mod yearly;
pub mod insight;

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tracing::{debug, info, warn};

use crate::db::models::{Message, SessionStat, WordStat};

/// 分析服务
#[napi]
pub struct AnalyticsService {
    // 缓存分析结果
    cache: dashmap::DashMap<String, serde_json::Value>,
}

#[napi]
impl AnalyticsService {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            cache: dashmap::DashMap::new(),
        }
    }

    /// 计算消息统计
    #[napi]
    pub fn calculate_message_stats(&self, messages_json: String) -> napi::Result<stats::MessageStatsResult> {
        let messages: Vec<Message> = serde_json::from_str(&messages_json)
            .map_err(|e| napi::Error::from_reason(format!("解析消息失败: {}", e)))?;
        Ok(stats::calculate_stats(&messages))
    }

    /// 计算词频
    #[napi]
    pub fn calculate_word_frequency(&self, messages_json: String, top_n: i32) -> napi::Result<String> {
        let messages: Vec<Message> = serde_json::from_str(&messages_json)
            .map_err(|e| napi::Error::from_reason(format!("解析消息失败: {}", e)))?;
        let result = stats::calculate_word_freq(&messages, top_n as usize);
        serde_json::to_string(&result)
            .map_err(|e| napi::Error::from_reason(format!("序列化失败: {}", e)))
    }

    /// 计算活跃时间段
    #[napi]
    pub fn calculate_active_hours(&self, messages_json: String) -> napi::Result<String> {
        let messages: Vec<Message> = serde_json::from_str(&messages_json)
            .map_err(|e| napi::Error::from_reason(format!("解析消息失败: {}", e)))?;
        let result = stats::calculate_hourly_distribution(&messages);
        serde_json::to_string(&result)
            .map_err(|e| napi::Error::from_reason(format!("序列化失败: {}", e)))
    }

    /// 生成年度报告
    #[napi]
    pub fn generate_yearly_report(&self, messages_json: String, year: i32) -> napi::Result<yearly::YearlyReport> {
        let messages: Vec<Message> = serde_json::from_str(&messages_json)
            .map_err(|e| napi::Error::from_reason(format!("解析消息失败: {}", e)))?;
        Ok(yearly::generate_report(&messages, year))
    }

    /// 生成双人报告
    #[napi]
    pub fn generate_dual_report(&self, messages_json: String, session_name: String) -> napi::Result<insight::DualReport> {
        let messages: Vec<Message> = serde_json::from_str(&messages_json)
            .map_err(|e| napi::Error::from_reason(format!("解析消息失败: {}", e)))?;
        Ok(insight::generate_dual_report(&messages, &session_name))
    }

    /// 清空缓存
    #[napi]
    pub fn clear_cache(&self) -> napi::Result<i32> {
        let count = self.cache.len() as i32;
        self.cache.clear();
        Ok(count)
    }
}

/// 统计辅助函数
pub mod utils {
    use super::*;

    /// 解析表情符号
    pub fn extract_emojis(text: &str) -> Vec<&str> {
        // 简单的表情提取（实际实现可以使用 emoji 库）
        text.matches(|c: char| is_emoji(c))
            .collect()
    }

    /// 判断字符是否是表情
    fn is_emoji(c: char) -> bool {
        // 基本表情范围
        matches!(c, 
            '\u{1F600}'..='\u{1F64F}' | // 表情符号
            '\u{1F300}'..='\u{1F5FF}' | // 其他符号
            '\u{1F680}'..='\u{1F6FF}' | // 交通工具
            '\u{1F900}'..='\u{1F9FF}' | // 补充符号
            '\u{2600}'..='\u{26FF}' |   // 杂项符号
            '\u{2700}'..='\u{27BF}'     // 装饰符号
        )
    }

    /// 分词（中文）
    pub fn tokenize_chinese(text: &str) -> Vec<String> {
        // 实际实现可以使用 jieba-rs
        // 这里使用简单的字符分割
        text.chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect::<String>()
            .split_whitespace()
            .map(|s| s.to_string())
            .collect()
    }

    /// 过滤停用词
    pub fn filter_stop_words(words: Vec<String>) -> Vec<String> {
        let stop_words: std::collections::HashSet<&str> = [
            "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
            "the", "a", "an", "is", "are", "was", "were", "be", "been",
        ].iter().cloned().collect();

        words.into_iter()
            .filter(|w| !stop_words.contains(w.as_str()))
            .collect()
    }
}