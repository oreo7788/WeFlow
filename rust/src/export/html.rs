//! HTML 导出

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc::Receiver;

use crate::db::models::{ExportProgress, Message, Session};
use super::{utils, ExportConfig};
use tracing::info;

/// HTML 样式
const HTML_TEMPLATE: &str = r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{TITLE}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5; 
            padding: 20px;
            line-height: 1.6;
        }
        .container { max-width: 800px; margin: 0 auto; }
        .header { 
            background: #07c160; 
            color: white; 
            padding: 20px; 
            border-radius: 8px 8px 0 0;
            text-align: center;
        }
        .header h1 { font-size: 20px; margin-bottom: 8px; }
        .header .meta { font-size: 12px; opacity: 0.9; }
        .messages { background: white; padding: 16px; border-radius: 0 0 8px 8px; }
        .message { 
            display: flex; 
            margin-bottom: 16px; 
            animation: fadeIn 0.3s ease;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
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
        }
        .content { max-width: 70%; }
        .bubble { 
            padding: 10px 14px; 
            border-radius: 4px; 
            word-wrap: break-word;
        }
        .message.received .bubble { background: white; border: 1px solid #e0e0e0; }
        .message.sent .bubble { background: #95ec69; }
        .sender-name { font-size: 12px; color: #888; margin-bottom: 4px; }
        .timestamp { font-size: 11px; color: #aaa; margin-top: 4px; text-align: right; }
        .message.sent .timestamp { text-align: left; }
        .image-msg img { max-width: 100%; border-radius: 4px; }
        .voice-msg { 
            display: flex; 
            align-items: center; 
            background: rgba(0,0,0,0.05); 
            padding: 8px 12px; 
            border-radius: 4px;
        }
        .voice-msg::before { 
            content: "🔊"; 
            margin-right: 8px; 
        }
        .file-msg { 
            display: flex; 
            align-items: center; 
            background: #f0f0f0; 
            padding: 10px; 
            border-radius: 4px;
        }
        .file-msg::before { 
            content: "📎"; 
            margin-right: 8px; 
            font-size: 20px;
        }
        .divider { 
            text-align: center; 
            margin: 20px 0; 
            position: relative;
        }
        .divider::before {
            content: "";
            position: absolute;
            top: 50%;
            left: 0;
            right: 0;
            border-top: 1px solid #e0e0e0;
        }
        .divider span { 
            background: white; 
            padding: 0 16px; 
            color: #888; 
            font-size: 12px;
            position: relative;
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
    utils::ensure_dir(output_path)?;

    let mut html_messages = Vec::with_capacity(messages.len());
    let total = messages.len();

    for (i, msg) in messages.iter().enumerate() {
        // 检查取消
        if cancel_rx.try_recv().is_ok() {
            bail!("导出已取消");
        }

        // 更新进度
        if i % 100 == 0 {
            progress.write().update(i as i64, Some(format!("处理消息 {}/{}", i, total)));
        }

        let html_msg = render_message(msg, &session);
        html_messages.push(html_msg);
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
            first.format("%Y-%m-%d"),
            last.format("%Y-%m-%d")
        )
    } else {
        "未知时间".to_string()
    };

    let html = HTML_TEMPLATE
        .replace("{TITLE}", &format!("聊天记录 - {}", session_name))
        .replace("{SESSION_NAME}", session_name)
        .replace("{MESSAGE_COUNT}", &messages.len().to_string())
        .replace("{TIME_RANGE}", &time_range)
        .replace("{MESSAGES}", &html_messages.join("\n"));

    // 写入文件
    std::fs::write(output_path, html)
        .with_context(|| format!("写入 HTML 文件失败: {}", output_path.display()))?;

    info!("HTML 导出完成: {}", output_path.display());
    Ok(())
}

/// 渲染单条消息为 HTML
fn render_message(msg: &Message, session: &Session) -> String {
    let is_sent = msg.is_sender;
    let message_class = if is_sent { "sent" } else { "received" };
    
    let sender_name = if is_sent {
        "我".to_string()
    } else {
        session.nickname.clone().unwrap_or_else(|| "对方".to_string())
    };

    let time_str = chrono::DateTime::from_timestamp(msg.create_time, 0)
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| msg.create_time.to_string());

    // 根据消息类型渲染不同内容
    let content = match msg.r#type {
        1 => render_text_message(msg),
        3 => render_image_message(msg),
        34 => render_voice_message(msg),
        43 | 62 => render_video_message(msg),
        49 => render_app_message(msg),
        _ => render_unknown_message(msg),
    };

    format!(
        r##"<div class="message {class}">
            <div class="avatar">{initial}</div>
            <div class="content">
                <div class="sender-name">{sender}</div>
                <div class="bubble">
                    {content}
                </div>
                <div class="timestamp">{time}</div>
            </div>
        </div>"##,
        class = message_class,
        initial = sender_name.chars().next().unwrap_or('?'),
        sender = sender_name,
        content = content,
        time = time_str,
    )
}

fn render_text_message(msg: &Message) -> String {
    let content = msg.content.as_ref()
        .map(|c| html_escape(c))
        .unwrap_or_else(|| "[空消息]".to_string());
    format!("<div class=\"text-msg\">{}</div>", content)
}

fn render_image_message(msg: &Message) -> String {
    let path = msg.image_path.as_ref()
        .map(|p| format!("<img src=\"{}\" alt=\"图片\" loading=\"lazy\" />", p))
        .unwrap_or_else(|| "[图片]".to_string());
    format!("<div class=\"image-msg\">{}</div>", path)
}

fn render_voice_message(msg: &Message) -> String {
    let duration = msg.content.as_ref()
        .and_then(|c| c.parse::<i32>().ok())
        .map(|d| format!("{}\"", d))
        .unwrap_or_default();
    format!(
        "<div class=\"voice-msg\">语音消息 {}</div>",
        duration
    )
}

fn render_video_message(msg: &Message) -> String {
    format!("<div class=\"video-msg\">[视频]</div>")
}

fn render_app_message(msg: &Message) -> String {
    format!("<div class=\"app-msg\">[应用消息]</div>")
}

fn render_unknown_message(msg: &Message) -> String {
    format!("<div class=\"unknown-msg\">[未知消息类型: {}]</div>", msg.r#type)
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}