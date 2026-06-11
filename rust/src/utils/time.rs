//! 时间工具

use chrono::{Datelike, DateTime, Local, NaiveDateTime, TimeZone, Timelike, Utc};

/// 时间戳转本地时间
pub fn timestamp_to_local(timestamp: i64) -> DateTime<Local> {
    DateTime::from_timestamp(timestamp, 0)
        .map(|dt| dt.with_timezone(&Local))
        .unwrap_or_else(|| Local::now())
}

/// 时间戳格式化
pub fn format_timestamp(timestamp: i64, format: &str) -> String {
    timestamp_to_local(timestamp).format(format).to_string()
}

/// 常用格式
pub mod formats {
    pub const DATE: &str = "%Y-%m-%d";
    pub const DATETIME: &str = "%Y-%m-%d %H:%M:%S";
    pub const TIME: &str = "%H:%M:%S";
    pub const FILENAME: &str = "%Y%m%d_%H%M%S";
}

/// 获取年份
pub fn get_year(timestamp: i64) -> i32 {
    timestamp_to_local(timestamp).year()
}

/// 获取月份 (1-12)
pub fn get_month(timestamp: i64) -> u32 {
    timestamp_to_local(timestamp).month()
}

/// 获取日期 (1-31)
pub fn get_day(timestamp: i64) -> u32 {
    timestamp_to_local(timestamp).day()
}

/// 获取星期几 (0=周一, 6=周日)
pub fn get_weekday(timestamp: i64) -> u32 {
    timestamp_to_local(timestamp).weekday().num_days_from_monday()
}

/// 获取小时 (0-23)
pub fn get_hour(timestamp: i64) -> u32 {
    timestamp_to_local(timestamp).hour()
}

/// 计算两个时间戳之间的天数差
pub fn days_between(timestamp1: i64, timestamp2: i64) -> i64 {
    let dt1 = DateTime::from_timestamp(timestamp1, 0).unwrap_or_else(|| Utc::now());
    let dt2 = DateTime::from_timestamp(timestamp2, 0).unwrap_or_else(|| Utc::now());
    (dt2 - dt1).num_days()
}

/// 判断是否是同一天
pub fn is_same_day(timestamp1: i64, timestamp2: i64) -> bool {
    format_timestamp(timestamp1, "%Y-%m-%d") == format_timestamp(timestamp2, "%Y-%m-%d")
}

/// 获取当天开始时间戳
pub fn start_of_day(timestamp: i64) -> i64 {
    let dt = timestamp_to_local(timestamp);
    dt.date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|t| Local.from_local_datetime(&t).single())
        .map(|t| t.timestamp())
        .unwrap_or(timestamp)
}

/// 获取当天结束时间戳
pub fn end_of_day(timestamp: i64) -> i64 {
    let dt = timestamp_to_local(timestamp);
    dt.date_naive()
        .and_hms_opt(23, 59, 59)
        .and_then(|t| Local.from_local_datetime(&t).single())
        .map(|t| t.timestamp())
        .unwrap_or(timestamp)
}
