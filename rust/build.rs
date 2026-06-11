use std::env;
use std::process::Command;

fn main() {
    // NAPI-RS 构建配置 - 必须在其他操作之前
    napi_build::setup();
    
    // 打印构建信息
    println!("cargo:rerun-if-changed=src");
    
    // 获取 rustc 版本
    let rustc_version = match Command::new("rustc")
        .args(["--version"])
        .output() 
    {
        Ok(output) => String::from_utf8(output.stdout)
            .unwrap_or_default()
            .trim()
            .to_string(),
        Err(_) => "unknown".to_string(),
    };
    
    // 获取目标平台
    let target = env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    
    // 设置环境变量供代码使用
    println!("cargo:rustc-env=RUSTC_VERSION={}", rustc_version);
    println!("cargo:rustc-env=TARGET={}", target);
}
