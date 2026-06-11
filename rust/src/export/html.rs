//! HTML 导出 - 增强版
//!
//! 完整功能：
//! - 文本、图片、语音、视频、文件消息
//! - 引用消息渲染
//! - 合并转发聊天记录
//! - 日期分割线
//! - 群组昵称显示
//! - 头像显示
//! - 动画和响应式布局

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Receiver;

use crate::db::models::{ExportProgress, Message, Session};
use super::{utils, ExportConfig};
use tracing::info;

/// HTML 模板 - 完整样式
const HTML_TEMPLATE: &str = r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{TITLE}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
            background: #f5f5f5;
            padding: 0;
            line-height: 1.6;
            color: #333;
        }
        .container { max-width: 800px; margin: 0 auto; background: #f5f5f5; min-height: 100vh; }
        .header {
            background: linear-gradient(135deg, #07c160 0%, #05a050 100%);
            color: white;
            padding: 30px 20px;
            text-align: center;
            position: sticky;
            top: 0;
            z-index: 100;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header h1 { font-size: 22px; margin-bottom: 8px; font-weight: 500; }
        .header .meta { font-size: 13px; opacity: 0.9; }
        .messages { padding: 16px; }
        .message {
            display: flex;
            margin-bottom: 20px;
            animation: fadeIn 0.3s ease;
            align-items: flex-start;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: none; }
        }
        .message.sent { flex-direction: row-reverse; }
        .avatar {
            width: 40px;
            height: 40px;
            border-radius: 4px;
            background: #07c160;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 14px;
            margin: 0 12px;
            flex-shrink: 0;
            overflow: hidden;
            font-weight: 500;
        }
        .avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .content { max-width: 70%; }
        .bubble {
            padding: 10px 14px;
            border-radius: 4px;
            word-wrap: break-word;
            font-size: 15px;
            line-height: 1.5;
        }
        .message.received .bubble {
            background: white;
            border: 1px solid #e8e8e8;
            border-radius: 2px 8px 8px 8px;
        }
        .message.sent .bubble {
            background: #95ec69;
            border-radius: 8px 2px 8px 8px;
        }
        .sender-name {
            font-size: 12px;
            color: #999;
            margin-bottom: 4px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .sender-name .group-nick {
            color: #bbb;
            font-size: 11px;
        }
        .timestamp {
            font-size: 11px;
            color: #bbb;
            margin-top: 4px;
            text-align: right;
        }
        .message.sent .timestamp { text-align: left; }
        /* 消息类型样式 */
        .text-msg { white-space: pre-wrap; word-break: break-word; }
        .image-msg { max-width: 100%; }
        .image-msg img {
            max-width: 100%;
            max-height: 300px;
            border-radius: 4px;
            cursor: pointer;
            transition: transform 0.2s;
        }
        .image-msg img:hover { transform: scale(1.02); }
        .voice-msg {
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(0,0,0,0.05);
            padding: 8px 12px;
            border-radius: 4px;
            min-width: 80px;
        }
        .voice-icon {
            width: 20px;
            height: 20px;
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23666"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>') no-repeat center;
            background-size: contain;
            opacity: 0.6;
        }
        .video-msg {
            position: relative;
            display: inline-block;
        }
        .video-msg img {
            max-width: 200px;
            border-radius: 4px;
        }
        .video-msg .play-btn {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 50px;
            height: 50px;
            background: rgba(0,0,0,0.6);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .video-msg .play-btn::after {
            content: '';
            width: 0;
            height: 0;
            border-left: 16px solid white;
            border-top: 10px solid transparent;
            border-bottom: 10px solid transparent;
            margin-left: 4px;
        }
        .file-msg {
            display: flex;
            align-items: center;
            gap: 10px;
            background: #f8f8f8;
            padding: 12px;
            border-radius: 4px;
            min-width: 200px;
        }
        .file-icon {
            width: 48px;
            height: 48px;
            background: #07c160;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 12px;
            font-weight: 500;
        }
        .file-info { flex: 1; }
        .file-name { font-size: 14px; color: #333; margin-bottom: 4px; }
        .file-size { font-size: 12px; color: #999; }
        .quote-msg {
            background: rgba(0,0,0,0.04);
            padding: 8px 10px;
            border-radius: 4px;
            margin-bottom: 6px;
            font-size: 13px;
            color: #666;
            border-left: 3px solid #07c160;
        }
        .quote-msg .quote-title { font-weight: 500; margin-bottom: 2px; }
        .chat-record-msg {
            background: white;
            border: 1px solid #e8e8e8;
            border-radius: 8px;
            padding: 12px;
            min-width: 200px;
        }
        .chat-record-msg .record-title {
            font-weight: 500;
            color: #07c160;
            margin-bottom: 8px;
            font-size: 14px;
        }
        .chat-record-msg .record-item {
            font-size: 13px;
            color: #666;
            margin: 4px 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .system-msg {
            text-align: center;
            margin: 16px 0;
            color: #999;
            font-size: 12px;
        }
        .date-divider {
            text-align: center;
            margin: 24px 0;
            position: relative;
        }
        .date-divider::before {
            content: "";
            position: absolute;
            top: 50%;
            left: 20%;
            right: 20%;
            border-top: 1px solid #e0e0e0;
        }
        .date-divider span {
            background: #f5f5f5;
            padding: 0 16px;
            color: #999;
            font-size: 12px;
            position: relative;
        }
        .revoked-msg {
            color: #999;
            font-style: italic;
            font-size: 13px;
        }
        .emoji {
            width: 20px;
            height: 20px;
            vertical-align: middle;
            display: inline-block;
        }
        /* 响应式 */
        @media (max-width: 600px) {
            .container { max-width: 100%; }
            .content { max-width: 80%; }
            .header { padding: 20px 15px; }
        }
        /* 打印样式 */
        @media print {
            body { background: white; }
            .header { background: #07c160 !important; -webkit-print-color-adjust: exact; }
            .bubble { -webkit-print-color-adjust: exact; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{SESSION_NAME}</h1>
            <div class="meta">{MESSAGE_COUNT} 条消息 · {TIME_RANGE}</div>
        </div>
        <div class="messages">
            {MESSAGES}
        </div>
    </div>
    <script>
        // 图片点击放大
        document.querySelectorAll('.image-msg img').forEach(img => {
            img.addEventListener('click', function() {
                window.open(this.src, '_blank');
            });
        });
    </script>
</body>
</html>"##;

/// 导出为 HTML
pub async fn export_html(
    config: &ExportConfig,
    messages: Vec<Message>,
    session: Session,
    progress: &std::sync::Arc<parking_lot::RwLock<ExportProgress>>,
    cancel_rx: &mut Receiver<()>,
) -> Result<()> {
    let output_path = Path::new(&config.output_path);
    utils::ensure_dir(output_path.parent().unwrap_or(output_path))?;

    let total = messages.len();
    let mut html_parts: Vec<String> = Vec::with_capacity(total + total / 20); // 预留日期分割线空间

    // 记录上一条消息的日期，用于添加分割线
    let mut last_date: Option<chrono::NaiveDate> = None;

    for (i, msg) in messages.iter().enumerate() {
        // 检查取消
        if cancel_rx.try_recv().is_ok() {
            bail!("导出已取消");
        }

        // 更新进度
        if i % 100 == 0 || i == total - 1 {
            progress.write().update(i as i64, Some(format!("处理消息 {}/{}", i + 1, total)));
        }

        // 检查是否需要添加日期分割线
        if let Some(date) = chrono::DateTime::from_timestamp(msg.create_time, 0)
            .map(|d| d.date_naive()) {
            if last_date.map_or(true, |d| d != date) {
                let date_str = date.format("%Y年%m月%d日").to_string();
                html_parts.push(format!(
                    r#"<div class="date-divider"><span>{}</span></div>"#,
                    date_str
                ));
                last_date = Some(date);
            }
        }

        // 渲染消息
        let html_msg = render_message_enhanced(msg, &session);
        html_parts.push(html_msg);
    }

    // 构建完整 HTML
    let session_name = session.nickname.as_ref()
        .or(session.remark.as_ref())
        .map(|s| s.as_str())
        .unwrap_or(&session.id);

    let time_range = if let (Some(first), Some(last)) = (
        messages.first().and_then(|m| chrono::DateTime::from_timestamp(m.create_time, 0)),
        messages.last().and_then(|m| chrono::DateTime::from_timestamp(m.create_time, 0)),
    ) {
        format!("{} 至 {}",
            first.format("%Y-%m-%d %H:%M"),
            last.format("%Y-%m-%d %H:%M")
        )
    } else {
        "未知时间".to_string()
    };

    let html = HTML_TEMPLATE
        .replace("{TITLE}", &format!("聊天记录 - {}", session_name))
        .replace("{SESSION_NAME}", session_name)
        .replace("{MESSAGE_COUNT}", &messages.len().to_string())
        .replace("{TIME_RANGE}", &time_range)
        .replace("{MESSAGES}", &html_parts.join("\n"));

    // 写入文件
    std::fs::write(output_path, html)
        .with_context(|| format!("写入 HTML 文件失败: {}", output_path.display()))?;

    info!("HTML 导出完成: {}", output_path.display());
    Ok(())
}

/// 渲染单条消息（增强版）
fn render_message_enhanced(msg: &Message, session: &Session) -> String {
    // 系统消息类型
    match msg.r#type {
        10000 => return render_system_message(msg), // 系统提示
        10002 => return render_system_message(msg), // 撤回消息
        _ => {}
    }

    let is_sent = msg.is_sender;
    let message_class = if is_sent { "sent" } else { "received" };

    // 获取发送者显示名称
    let sender_name = msg.display_name.as_ref()
        .map(|s| s.as_str())
        .unwrap_or_else(|| {
            if is_sent { "我" } else { "对方" }
        });

    // 群组昵称
    let group_nick = msg.group_nickname.as_ref()
        .map(|n| format!(r#"<span class="group-nick">({})</span>"#, html_escape(n)))
        .unwrap_or_default();

    // 头像
    let avatar_content = if let Some(url) = msg.avatar_url.as_ref() {
        format!(r#"<img src="{}" alt="">"#, html_escape(url))
    } else {
        sender_name.chars().next().unwrap_or('?').to_string()
    };

    // 时间
    let time_str = chrono::DateTime::from_timestamp(msg.create_time, 0)
        .map(|d| d.format("%H:%M").to_string())
        .unwrap_or_else(|| msg.create_time.to_string());

    // 引用消息
    let quote_html = if let Some(ref content) = msg.reply_to_content {
        let title = msg.display_name.as_ref()
            .map(|n| format!("{} 引用", n))
            .unwrap_or_else(|| "引用".to_string());
        format!(
            r#"<div class="quote-msg">
                <div class="quote-title">{}</div>
                <div>{}</div>
            </div>"#,
            html_escape(&title),
            html_escape(content)
        )
    } else {
        String::new()
    };

    // 根据消息类型渲染内容
    let content = match msg.r#type {
        1 => render_text_message_enhanced(msg),
        3 => render_image_message_enhanced(msg),
        34 => render_voice_message_enhanced(msg),
        43 | 62 => render_video_message_enhanced(msg),
        47 => render_emoji_message(msg),
        48 => render_location_message(msg),
        49 => render_app_message_enhanced(msg),
        50 => render_emoji_message(msg),
        42 | 62 => render_video_message_enhanced(msg),
        _ => render_unknown_message(msg),
    };

    format!(
        r##"<div class="message {class}">
            <div class="avatar">{avatar}</div>
            <div class="content">
                <div class="sender-name">{sender}{group_nick}</div>
                <div class="bubble">
                    {quote}
                    {content}
                </div>
                <div class="timestamp">{time}</div>
            </div>
        </div>"##,
        class = message_class,
        avatar = avatar_content,
        sender = html_escape(sender_name),
        group_nick = group_nick,
        quote = quote_html,
        content = content,
        time = time_str,
    )
}

/// 渲染文本消息（增强版）
fn render_text_message_enhanced(msg: &Message) -> String {
    let content = msg.content.as_ref()
        .map(|c| {
            let escaped = html_escape(c);
            // 转换 URL 为链接
            let with_links = url_to_links(&escaped);
            // 处理换行
            with_links.replace('\n', "<br>")
        })
        .unwrap_or_else(|| "[空消息]".to_string());

    format!(r#"<div class="text-msg">{}</div>"#, content)
}

/// 渲染图片消息（增强版）
fn render_image_message_enhanced(msg: &Message) -> String {
    let path = msg.image_path.as_ref()
        .filter(|p| !p.is_empty())
        .map(|p| {
            // 使用本地路径（已复制到 media 目录）
            format!(r#"<img src="{}" alt="图片" loading="lazy" onclick="window.open(this.src)" />"#, html_escape(p))
        })
        .unwrap_or_else(|| {
            // 备用显示
            r#"<div class="image-msg" style="color:#999;">[图片]</div>"#.to_string()
        });

    format!(r#"<div class="image-msg">{}</div>"#, path)
}

/// 渲染语音消息（增强版）
fn render_voice_message_enhanced(msg: &Message) -> String {
    let duration = msg.content.as_ref()
        .and_then(|c| c.parse::<i32>().ok())
        .map(|d| format!("{}\"", d))
        .unwrap_or_default();

    format!(
        r#"<div class="voice-msg">
            <div class="voice-icon"></div>
            <span>{}</span>
        </div>"#,
        if duration.is_empty() { "语音消息".to_string() } else { duration }
    )
}

/// 渲染视频消息（增强版）
fn render_video_message_enhanced(msg: &Message) -> String {
    if let Some(thumb) = msg.content.as_ref().or(msg.image_path.as_ref()) {
        format!(
            r#"<div class="video-msg">
                <img src="{}" alt="视频封面">
                <div class="play-btn"></div>
            </div>"#,
            html_escape(thumb)
        )
    } else {
        r#"<div class="video-msg">[视频]</div>"#.to_string()
    }
}

/// 渲染表情消息
fn render_emoji_message(_msg: &Message) -> String {
    r#"<div class="emoji-msg">[表情]</div>"#.to_string()
}

/// 渲染位置消息
fn render_location_message(msg: &Message) -> String {
    let content = msg.content.as_ref()
        .map(|c| html_escape(c))
        .unwrap_or_else(|| "[位置]".to_string());

    format!(
        r#"<div class="location-msg">
            <div style="font-weight:500;margin-bottom:4px;">📍 位置</div>
            <div>{}</div>
        </div>"#,
        content
    )
}

/// 渲染应用消息（增强版）
fn render_app_message_enhanced(msg: &Message) -> String {
    match msg.sub_type {
        19 | 57 => render_chat_record_message(msg), // 合并转发
        6 => render_file_message(msg), // 文件
        3 => render_music_message(msg), // 音乐
        4 => render_program_message(msg), // 小程序
        5 => render_link_message(msg), // 链接
        _ => render_generic_app_message(msg),
    }
}

/// 渲染合并转发聊天记录
fn render_chat_record_message(msg: &Message) -> String {
    // 尝试解析合并转发的标题和内容
    let (title, items) = if let Some(content) = msg.content.as_ref() {
        parse_chat_record_content(content)
    } else {
        ("聊天记录".to_string(), vec![])
    };

    let items_html: Vec<String> = items.iter()
        .take(4) // 最多显示4条
        .map(|item| format!(
            r#"<div class="record-item">{}: {}</div>"#,
            html_escape(&item.0),
            html_escape(&item.1)
        ))
        .collect();

    format!(
        r#"<div class="chat-record-msg">
            <div class="record-title">📋 {}</div>
            {}
        </div>"#,
        html_escape(&title),
        items_html.join("")
    )
}

/// 渲染文件消息
fn render_file_message(msg: &Message) -> String {
    // 尝试从内容解析文件名
    let (file_name, file_size) = if let Some(content) = msg.content.as_ref() {
        parse_file_info(content)
    } else {
        (msg.file_path.clone().unwrap_or_default(), "未知大小".to_string())
    };

    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("FILE")
        .to_uppercase();

    format!(
        r#"<div class="file-msg">
            <div class="file-icon">{}</div>
            <div class="file-info">
                <div class="file-name">{}</div>
                <div class="file-size">{}</div>
            </div>
        </div>"#,
        ext,
        html_escape(&file_name),
        file_size
    )
}

/// 渲染音乐消息
fn render_music_message(_msg: &Message) -> String {
    r#"<div class="music-msg">🎵 [音乐]</div>"#.to_string()
}

/// 渲染小程序
fn render_program_message(msg: &Message) -> String {
    let title = msg.content.as_ref()
        .map(|c| html_escape(c))
        .unwrap_or_else(|| "[小程序]".to_string());

    format!(
        r#"<div class="program-msg">
            <div style="font-size:12px;color:#999;margin-bottom:4px;">小程序</div>
            <div>{}</div>
        </div>"#,
        title
    )
}

/// 渲染链接消息
fn render_link_message(msg: &Message) -> String {
    let title = msg.content.as_ref()
        .map(|c| html_escape(c))
        .unwrap_or_else(|| "[链接]".to_string());

    format!(
        r#"<div class="link-msg">
            <div style="font-size:12px;color:#999;margin-bottom:4px;">🔗 链接</div>
            <div style="color:#07c160;text-decoration:underline;">{}</div>
        </div>"#,
        title
    )
}

/// 渲染通用应用消息
fn render_generic_app_message(_msg: &Message) -> String {
    r#"<div class="app-msg">[应用消息]</div>"#.to_string()
}

/// 渲染系统消息
fn render_system_message(msg: &Message) -> String {
    let content = msg.content.as_ref()
        .map(|c| html_escape(c))
        .unwrap_or_else(|| "[系统消息]".to_string());

    format!(
        r#"<div class="system-msg">{}</div>"#,
        content
    )
}

/// 渲染未知消息
fn render_unknown_message(msg: &Message) -> String {
    format!(
        r#"<div class="unknown-msg">[未知消息类型: type={}, sub_type={}]</div>"#,
        msg.r#type,
        msg.sub_type
    )
}

/// HTML 转义
fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

/// 将 URL 转换为链接
fn url_to_links(text: &str) -> String {
    use regex::Regex;

    let url_regex = Regex::new(
        r#"(?i)((?:https?://|www\.)[^一-龥\s<]+)"#
    ).unwrap_or_else(|_| Regex::new(r"https?://[^\s<]+").unwrap());

    url_regex.replace_all(text, |caps: &regex::Captures| {
        let url = &caps[0];
        let href = if url.starts_with("http") {
            url.to_string()
        } else {
            format!("https://{}", url)
        };
        format!(r#"<a href="{}" target="_blank" style="color:#07c160;">{}</a>"#, href, url)
    }).to_string()
}

/// 解析合并转发聊天记录内容
fn parse_chat_record_content(content: &str) -> (String, Vec<(String, String)>) {
    // 尝试解析 JSON 格式的聊天记录
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(content) {
        let title = json.get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "聊天记录".to_string());

        let items: Vec<(String, String)> = json.get("recordList")
            .or_else(|| json.get("chatRecordList"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let name = item.get("sourcename")
                            .or_else(|| item.get("sender"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("未知");
                        let text = item.get("datadesc")
                            .or_else(|| item.get("content"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("...");
                        Some((name.to_string(), text.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();

        return (title, items);
    }

    // 解析失败返回默认值
    ("聊天记录".to_string(), vec![])
}

/// 解析文件信息
fn parse_file_info(content: &str) -> (String, String) {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(content) {
        let name = json.get("title")
            .or_else(|| json.get("fileName"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        let size = json.get("fileSize")
            .and_then(|v| v.as_i64())
            .map(|s| format_file_size(s))
            .unwrap_or_else(|| "未知大小".to_string());

        return (name, size);
    }

    ("未知文件".to_string(), "未知大小".to_string())
}

/// 格式化文件大小
fn format_file_size(size: i64) -> String {
    if size < 1024 {
        format!("{} B", size)
    } else if size < 1024 * 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
    } else if size < 1024 * 1024 * 1024 {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", size as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}
