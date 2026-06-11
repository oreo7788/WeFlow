//! 洞察分析模块 - 深度聊天分析

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Serialize;

use crate::db::models::Message;

/// 双人报告
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct DualReport {
    pub with_whom: String,
    pub first_chat_date: Option<String>,
    pub total_days: i32,
    pub total_messages: i64,
    pub my_message_count: i64,
    pub other_message_count: i64,
    pub my_word_count: i64,
    pub other_word_count: i64,
    pub my_top_words: Vec<String>,
    pub other_top_words: Vec<String>,
    pub common_topics: Vec<String>,
    pub special_dates: Vec<SpecialDate>,
    pub chat_patterns: ChatPatterns,
}

/// 特殊日期
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct SpecialDate {
    pub date: String,
    pub description: String,
    pub message_count: i64,
}

/// 聊天模式
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct ChatPatterns {
    pub who_starts_more: String,  // "me" or "other"
    pub avg_reply_time_seconds: i64,
    pub longest_conversation_messages: i64,
    pub longest_gap_days: i64,
}

/// 生成双人报告
pub fn generate_dual_report(messages: &[Message], session_name: &str) -> DualReport {
    if messages.is_empty() {
        return DualReport {
            with_whom: session_name.to_string(),
            first_chat_date: None,
            total_days: 0,
            total_messages: 0,
            my_message_count: 0,
            other_message_count: 0,
            my_word_count: 0,
            other_word_count: 0,
            my_top_words: vec![],
            other_top_words: vec![],
            common_topics: vec![],
            special_dates: vec![],
            chat_patterns: ChatPatterns {
                who_starts_more: "unknown".to_string(),
                avg_reply_time_seconds: 0,
                longest_conversation_messages: 0,
                longest_gap_days: 0,
            },
        };
    }

    // 时间范围
    let first_date = messages.first().map(|m| m.create_time);
    let last_date = messages.last().map(|m| m.create_time);
    let total_days = first_date.and_then(|first| {
        last_date.map(|last| {
            ((last - first) / 86400 + 1) as i32
        })
    }).unwrap_or(0);

    // 消息统计
    let mut my_count = 0i64;
    let mut other_count = 0i64;
    let mut my_words = 0i64;
    let mut other_words = 0i64;

    let mut my_word_freq: HashMap<String, i64> = HashMap::new();
    let mut other_word_freq: HashMap<String, i64> = HashMap::new();

    for msg in messages {
        let word_count = msg.content.as_ref()
            .map(|c| c.chars().count() as i64)
            .unwrap_or(0);

        if msg.is_sender {
            my_count += 1;
            my_words += word_count;
            extract_words(msg, &mut my_word_freq);
        } else {
            other_count += 1;
            other_words += word_count;
            extract_words(msg, &mut other_word_freq);
        }
    }

    // 找出每个人的高频词
    let my_top_words = get_top_words(&my_word_freq, 20);
    let other_top_words = get_top_words(&other_word_freq, 20);

    // 共同话题（两人都提到的高频词）
    let common_topics = find_common_topics(&my_word_freq, &other_word_freq);

    // 特殊日期
    let special_dates = find_special_dates(messages);

    // 聊天模式分析
    let chat_patterns = analyze_chat_patterns(messages, my_count, other_count);

    DualReport {
        with_whom: session_name.to_string(),
        first_chat_date: first_date.and_then(|t| {
            chrono::DateTime::from_timestamp(t, 0)
                .map(|dt| dt.format("%Y年%m月%d日").to_string())
        }),
        total_days,
        total_messages: messages.len() as i64,
        my_message_count: my_count,
        other_message_count: other_count,
        my_word_count: my_words,
        other_word_count: other_words,
        my_top_words,
        other_top_words,
        common_topics,
        special_dates,
        chat_patterns,
    }
}

/// 提取单词到频率表
fn extract_words(msg: &Message, freq: &mut HashMap<String, i64>) {
    if let Some(ref content) = msg.content {
        let words: Vec<&str> = content
            .split(|c: char| c.is_whitespace() || c.is_ascii_punctuation())
            .filter(|w| w.len() >= 2 && !is_common_word(w))
            .collect();

        for word in words {
            *freq.entry(word.to_lowercase()).or_insert(0) += 1;
        }
    }
}

/// 获取高频词
fn get_top_words(freq: &HashMap<String, i64>, n: usize) -> Vec<String> {
    let mut words: Vec<(&String, &i64)> = freq.iter().collect();
    words.sort_by(|a, b| b.1.cmp(a.1));
    words.truncate(n);
    words.into_iter().map(|(w, _)| w.clone()).collect()
}

/// 查找共同话题
fn find_common_topics(
    my_words: &HashMap<String, i64>,
    other_words: &HashMap<String, i64>,
) -> Vec<String> {
    let mut common: Vec<(String, i64, i64)> = vec![];

    for (word, my_count) in my_words {
        if let Some(other_count) = other_words.get(word) {
            if *my_count >= 3 && *other_count >= 3 {
                common.push((word.clone(), *my_count, *other_count));
            }
        }
    }

    // 按总频次排序
    common.sort_by(|a, b| (b.1 + b.2).cmp(&(a.1 + a.2)));
    common.truncate(10);

    common.into_iter().map(|(w, _, _)| w).collect()
}

/// 查找特殊日期
fn find_special_dates(messages: &[Message]) -> Vec<SpecialDate> {
    let mut daily_counts: HashMap<String, Vec<&Message>> = HashMap::new();

    for msg in messages {
        let date = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .map(|dt| dt.format("%Y-%m-%d").to_string())
            .unwrap_or_default();

        daily_counts.entry(date).or_default().push(msg);
    }

    // 找出消息数最多的几天
    let mut dates: Vec<(String, i64)> = daily_counts
        .iter()
        .map(|(date, msgs)| (date.clone(), msgs.len() as i64))
        .collect();

    dates.sort_by(|a, b| b.1.cmp(&a.1));
    dates.truncate(5);

    dates
        .into_iter()
        .map(|(date, count)| SpecialDate {
            date,
            description: "特别的一天".to_string(),
            message_count: count,
        })
        .collect()
}

/// 分析聊天模式
fn analyze_chat_patterns(messages: &[Message], my_count: i64, other_count: i64) -> ChatPatterns {
    let who_starts = if my_count > other_count {
        "me".to_string()
    } else {
        "other".to_string()
    };

    // 计算最长连续对话
    let mut max_conversation = 0i64;
    let mut current_conversation = 0i64;

    for (i, msg) in messages.iter().enumerate() {
        if i == 0 {
            current_conversation = 1;
        } else {
            let prev = &messages[i - 1];
            // 如果时间间隔小于 5 分钟，认为是连续对话
            if msg.create_time - prev.create_time < 300 {
                current_conversation += 1;
            } else {
                max_conversation = max_conversation.max(current_conversation);
                current_conversation = 1;
            }
        }
    }
    max_conversation = max_conversation.max(current_conversation);

    // 计算最长间隔
    let mut max_gap = 0i64;
    for (i, msg) in messages.iter().enumerate() {
        if i > 0 {
            let prev = &messages[i - 1];
            let gap = msg.create_time - prev.create_time;
            if gap > max_gap {
                max_gap = gap;
            }
        }
    }

    ChatPatterns {
        who_starts_more: who_starts,
        avg_reply_time_seconds: 0, // 需要更复杂的分析
        longest_conversation_messages: max_conversation,
        longest_gap_days: max_gap / 86400,
    }
}

/// 常见词过滤
fn is_common_word(word: &str) -> bool {
    const COMMON_WORDS: &[&str] = &[
        "这个", "那个", "然后", "就是", "什么", "怎么", "没有", "可以",
        "现在", "今天", "明天", "昨天", "知道", "觉得", "还是", "这样",
        "一下", "有点", "可能", "应该", "已经", "正在", "但是", "所以",
        "the", "this", "that", "with", "have", "from", "they", "will",
    ];

    word.len() < 2 || COMMON_WORDS.contains(&word.to_lowercase().as_str())
}
