//! 基础统计模块

use std::collections::HashMap;

use chrono::{Datelike, Timelike};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::db::models::{Message, MessageStats, SessionStat, WordStat};

/// 消息统计结果
#[napi(object)]
#[derive(Debug, Clone)]
pub struct MessageStatsResult {
    pub total_messages: i64,
    pub total_chars: i64,
    pub image_count: i64,
    pub voice_count: i64,
    pub video_count: i64,
    pub file_count: i64,
    pub first_message_time: Option<i64>,
    pub last_message_time: Option<i64>,
    pub message_type_distribution: HashMap<String, i64>,
}

/// 计算基础统计
pub fn calculate_stats(messages: &[Message]) -> MessageStatsResult {
    let total = messages.len() as i64;
    
    let mut chars = 0i64;
    let mut images = 0i64;
    let mut voices = 0i64;
    let mut videos = 0i64;
    let mut files = 0i64;
    let mut type_distribution: HashMap<String, i64> = HashMap::new();

    let first_time = messages.first().map(|m| m.create_time);
    let last_time = messages.last().map(|m| m.create_time);

    for msg in messages {
        // 字符统计
        if let Some(ref content) = msg.content {
            chars += content.chars().count() as i64;
        }

        // 类型统计
        let type_name = message_type_name(msg.r#type);
        *type_distribution.entry(type_name).or_insert(0) += 1;

        // 特定类型计数
        match msg.r#type {
            3 => images += 1,
            34 => voices += 1,
            43 | 62 => videos += 1,
            49 if is_file_message(msg) => files += 1,
            _ => {}
        }
    }

    MessageStatsResult {
        total_messages: total,
        total_chars: chars,
        image_count: images,
        voice_count: voices,
        video_count: videos,
        file_count: files,
        first_message_time: first_time,
        last_message_time: last_time,
        message_type_distribution: type_distribution,
    }
}

/// 计算词频
pub fn calculate_word_freq(messages: &[Message], top_n: usize) -> Vec<WordStat> {
    let mut word_counts: HashMap<String, i64> = HashMap::new();

    for msg in messages {
        if let Some(ref content) = msg.content {
            // 简单分词：按空格和标点分割
            let words: Vec<&str> = content
                .split(|c: char| c.is_whitespace() || c.is_ascii_punctuation())
                .filter(|w| w.len() >= 2 && !is_stop_word(w))
                .collect();

            for word in words {
                let word = word.to_lowercase();
                *word_counts.entry(word).or_insert(0) += 1;
            }
        }
    }

    // 转换为 Vec 并排序
    let mut stats: Vec<WordStat> = word_counts
        .into_iter()
        .map(|(word, count)| WordStat { word, count })
        .collect();

    stats.sort_by(|a, b| b.count.cmp(&a.count));
    stats.truncate(top_n);

    stats
}

/// 计算每小时消息分布
pub fn calculate_hourly_distribution(messages: &[Message]) -> Vec<i64> {
    let mut hours = vec![0i64; 24];

    for msg in messages {
        let hour = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .map(|dt| dt.hour() as usize)
            .unwrap_or(0);

        if hour < 24 {
            hours[hour] += 1;
        }
    }

    hours
}

/// 计算每周消息分布
pub fn calculate_weekly_distribution(messages: &[Message]) -> Vec<i64> {
    let mut days = vec![0i64; 7]; // 周一到周日

    for msg in messages {
        let weekday = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .map(|dt| dt.weekday().num_days_from_monday() as usize)
            .unwrap_or(0);

        if weekday < 7 {
            days[weekday] += 1;
        }
    }

    days
}

/// 计算每日消息数量
pub fn calculate_daily_counts(messages: &[Message]) -> HashMap<String, i64> {
    let mut counts: HashMap<String, i64> = HashMap::new();

    for msg in messages {
        let date = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .map(|dt| dt.format("%Y-%m-%d").to_string())
            .unwrap_or_default();

        *counts.entry(date).or_insert(0) += 1;
    }

    counts
}

/// 消息类型名称
fn message_type_name(msg_type: i32) -> String {
    match msg_type {
        1 => "text".to_string(),
        3 => "image".to_string(),
        34 => "voice".to_string(),
        43 => "video".to_string(),
        47 => "emoji".to_string(),
        49 => "app".to_string(),
        50 => "video_call".to_string(),
        62 => "short_video".to_string(),
        _ => format!("other_{}", msg_type),
    }
}

/// 判断是否文件消息
fn is_file_message(msg: &Message) -> bool {
    // 根据 sub_type 或内容判断
    msg.file_path.is_some()
}

/// 停用词判断
fn is_stop_word(word: &str) -> bool {
    const STOP_WORDS: &[&str] = &[
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
        "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
        "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
        "你", "会", "着", "没有", "看", "好", "自己", "这", "那", "个",
    ];

    word.len() < 2 || STOP_WORDS.contains(&word.to_lowercase().as_str())
}

/// 计算对话者统计
pub fn calculate_speaker_stats(messages: &[Message], session_name: &str) -> Vec<SessionStat> {
    let mut speaker_counts: HashMap<String, (i64, i64)> = HashMap::new();

    for msg in messages {
        let speaker = if msg.is_sender {
            "我".to_string()
        } else {
            session_name.to_string()
        };

        let entry = speaker_counts.entry(speaker).or_insert((0, 0));
        entry.0 += 1; // 消息数
        
        if let Some(ref content) = msg.content {
            entry.1 += content.chars().count() as i64; // 字符数
        }
    }

    speaker_counts
        .into_iter()
        .map(|(session_id, (msg_count, word_count))| SessionStat {
            session_id: session_id.clone(),
            session_name: session_id,
            message_count: msg_count,
            word_count,
        })
        .collect()
}
