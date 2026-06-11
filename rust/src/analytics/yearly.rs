//! 年度报告生成

use std::collections::HashMap;

use chrono::{Datelike, Timelike};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Serialize;

use crate::db::models::{Message, SessionStat, WordStat};
use super::stats;

/// 年度报告
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct YearlyReport {
    pub year: i32,
    pub total_messages: i64,
    pub total_words: i64,
    pub top_sessions_json: String,
    pub top_words_json: String,
    pub active_hours_json: String,
    pub active_weekdays_json: String,
    pub monthly_distribution_json: String,
    pub highlights_json: String,
}

/// 月度统计
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct MonthStat {
    pub month: i32,
    pub message_count: i64,
    pub word_count: i64,
}

/// 年度亮点
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct Highlight {
    pub title: String,
    pub description: String,
    pub value: Option<String>,
}

/// 生成年度报告
pub fn generate_report(messages: &[Message], year: i32) -> YearlyReport {
    // 筛选指定年份的消息
    let year_messages: Vec<&Message> = messages
        .iter()
        .filter(|m| {
            chrono::DateTime::from_timestamp(m.create_time, 0)
                .map(|dt| dt.year() == year)
                .unwrap_or(false)
        })
        .collect();

    if year_messages.is_empty() {
        return YearlyReport {
            year,
            total_messages: 0,
            total_words: 0,
            top_sessions_json: "[]".to_string(),
            top_words_json: "[]".to_string(),
            active_hours_json: serde_json::to_string(&vec![0i64; 24]).unwrap_or_default(),
            active_weekdays_json: serde_json::to_string(&vec![0i64; 7]).unwrap_or_default(),
            monthly_distribution_json: "[]".to_string(),
            highlights_json: "[]".to_string(),
        };
    }

    // 基础统计
    let stats = stats::calculate_stats(&year_messages.iter().map(|m| (*m).clone()).collect::<Vec<_>>());

    // 词频统计
    let top_words = stats::calculate_word_freq(&year_messages.iter().map(|m| (*m).clone()).collect::<Vec<_>>(), 50);
    let top_words_json = serde_json::to_string(&top_words).unwrap_or_default();

    // 活跃时间分布
    let active_hours = stats::calculate_hourly_distribution(&year_messages.iter().map(|m| (*m).clone()).collect::<Vec<_>>());
    let active_hours_json = serde_json::to_string(&active_hours).unwrap_or_default();

    let active_weekdays = stats::calculate_weekly_distribution(&year_messages.iter().map(|m| (*m).clone()).collect::<Vec<_>>());
    let active_weekdays_json = serde_json::to_string(&active_weekdays).unwrap_or_default();

    // 月度统计
    let monthly_distribution = calculate_monthly_stats(&year_messages, year);
    let monthly_distribution_json = serde_json::to_string(&monthly_distribution).unwrap_or_default();

    // 生成亮点
    let highlights = generate_highlights(&year_messages, year, &stats);
    let highlights_json = serde_json::to_string(&highlights).unwrap_or_default();

    YearlyReport {
        year,
        total_messages: stats.total_messages,
        total_words: stats.total_chars,
        top_sessions_json: "[]".to_string(), // 年度报告通常不需要 top sessions
        top_words_json,
        active_hours_json,
        active_weekdays_json,
        monthly_distribution_json,
        highlights_json,
    }
}

/// 计算月度统计
fn calculate_monthly_stats(messages: &[&Message], year: i32) -> Vec<MonthStat> {
    let mut monthly: HashMap<i32, (i64, i64)> = HashMap::new();

    for msg in messages {
        let month = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .map(|dt| dt.month() as i32)
            .unwrap_or(0);

        if month >= 1 && month <= 12 {
            let entry = monthly.entry(month).or_insert((0, 0));
            entry.0 += 1; // 消息数
            if let Some(ref content) = msg.content {
                entry.1 += content.chars().count() as i64; // 字符数
            }
        }
    }

    let mut result: Vec<MonthStat> = monthly
        .into_iter()
        .map(|(month, (count, words))| MonthStat {
            month,
            message_count: count,
            word_count: words,
        })
        .collect();

    result.sort_by_key(|m| m.month);
    result
}

/// 生成年度亮点
fn generate_highlights(messages: &[&Message], year: i32, stats: &stats::MessageStatsResult) -> Vec<Highlight> {
    let mut highlights = vec![];

    // 总消息数
    highlights.push(Highlight {
        title: "💬 聊天足迹".to_string(),
        description: format!("这一年你发送了 {} 条消息", stats.total_messages),
        value: Some(format!("{} 条", stats.total_messages)),
    });

    // 字数统计
    if stats.total_chars > 0 {
        let word_desc = if stats.total_chars > 10000 {
            format!("你写了相当于 {} 万字的聊天记录", stats.total_chars / 10000)
        } else {
            format!("你写了 {} 字的聊天记录", stats.total_chars)
        };
        highlights.push(Highlight {
            title: "📝 文字记录".to_string(),
            description: word_desc,
            value: Some(format!("{} 字", stats.total_chars)),
        });
    }

    // 最活跃的一天
    if let Some((date, count)) = find_most_active_day(messages) {
        highlights.push(Highlight {
            title: "🔥 最活跃的一天".to_string(),
            description: format!("{} 你发送了 {} 条消息", date, count),
            value: Some(format!("{} 条", count)),
        });
    }

    // 深夜聊天
    let night_messages = messages.iter()
        .filter(|m| {
            chrono::DateTime::from_timestamp(m.create_time, 0)
                .map(|dt| {
                    let hour = dt.hour();
                    hour >= 0 && hour < 6
                })
                .unwrap_or(false)
        })
        .count() as i64;

    if night_messages > 0 {
        highlights.push(Highlight {
            title: "🌙 夜猫子指数".to_string(),
            description: format!("你在深夜 (0:00-6:00) 发送了 {} 条消息", night_messages),
            value: Some(format!("{} 条", night_messages)),
        });
    }

    // 表情使用
    let emoji_count = stats.message_type_distribution
        .get("emoji")
        .copied()
        .unwrap_or(0);
    if emoji_count > 0 {
        highlights.push(Highlight {
            title: "😊 表情包达人".to_string(),
            description: format!("你发送了 {} 个表情", emoji_count),
            value: Some(format!("{} 个", emoji_count)),
        });
    }

    // 图片分享
    if stats.image_count > 0 {
        highlights.push(Highlight {
            title: "📷 分享瞬间".to_string(),
            description: format!("你分享了 {} 张图片", stats.image_count),
            value: Some(format!("{} 张", stats.image_count)),
        });
    }

    highlights
}

/// 找到最活跃的一天
fn find_most_active_day(messages: &[&Message]) -> Option<(String, i64)> {
    let mut daily_counts: HashMap<String, i64> = HashMap::new();

    for msg in messages {
        let date = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .map(|dt| dt.format("%Y年%m月%d日").to_string())
            .unwrap_or_default();

        *daily_counts.entry(date).or_insert(0) += 1;
    }

    daily_counts
        .into_iter()
        .max_by_key(|&(_, count)| count)
}
