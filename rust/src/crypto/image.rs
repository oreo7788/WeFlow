//! 图片解密 - 微信 .dat 图片文件解密

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use tracing::{info, warn};

use super::{DecryptConfig, Decryptor};

/// 支持的图片格式
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImageFormat {
    Jpeg,
    Png,
    Gif,
    Webp,
    Bmp,
    Unknown,
}

impl ImageFormat {
    /// 从魔数识别图片格式
    pub fn from_magic_bytes(data: &[u8]) -> Self {
        if data.len() < 8 {
            return Self::Unknown;
        }

        match &data[..8] {
            // JPEG: FF D8 FF
            [0xFF, 0xD8, 0xFF, ..] => Self::Jpeg,
            // PNG: 89 50 4E 47 0D 0A 1A 0A
            [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] => Self::Png,
            // GIF: GIF87a or GIF89a
            [0x47, 0x49, 0x46, 0x38, 0x37, 0x61, ..] |
            [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ..] => Self::Gif,
            // WebP: RIFF....WEBP
            [0x52, 0x49, 0x46, 0x46, _, _, _, _, 0x57, 0x45, 0x42, 0x50] => Self::Webp,
            // BMP: BM
            [0x42, 0x4D, ..] => Self::Bmp,
            _ => Self::Unknown,
        }
    }

    /// 获取文件扩展名
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
            Self::Unknown => "bin",
        }
    }
}

/// 图片解密结果
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ImageDecryptResult {
    pub success: bool,
    pub output_path: Option<String>,
    pub format: String,
    pub error: Option<String>,
    pub is_thumbnail: bool,
}

/// 图片解密服务
#[napi]
pub struct ImageDecryptService {
    config: DecryptConfig,
    cache: dashmap::DashMap<String, String>, // 输入路径 -> 输出路径缓存
}

#[napi]
impl ImageDecryptService {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            config: DecryptConfig::default(),
            cache: dashmap::DashMap::new(),
        }
    }

    /// 设置 XOR 密钥
    #[napi]
    pub fn set_xor_key(&mut self, key: Vec<u8>) {
        self.config.image_xor_key = Some(key);
    }

    /// 设置 AES 密钥
    #[napi]
    pub fn set_aes_key(&mut self, key: String) {
        self.config.image_aes_key = Some(key.into_bytes());
    }

    /// 解密单个 .dat 文件
    #[napi]
    pub async fn decrypt_file(
        &self,
        input_path: String,
        output_dir: String,
    ) -> napi::Result<ImageDecryptResult> {
        let input = PathBuf::from(&input_path);
        
        // 检查缓存
        if let Some(cached) = self.cache.get(&input_path) {
            return Ok(ImageDecryptResult {
                success: true,
                output_path: Some(cached.clone()),
                format: ImageFormat::Jpeg.extension().to_string(),
                error: None,
                is_thumbnail: false,
            });
        }

        // 执行解密
        match self.decrypt_file_internal(&input, Path::new(&output_dir)).await {
            Ok(result) => {
                // 缓存结果
                if let Some(ref path) = result.output_path {
                    self.cache.insert(input_path, path.clone());
                }
                Ok(result)
            }
            Err(e) => Ok(ImageDecryptResult {
                success: false,
                output_path: None,
                format: "unknown".to_string(),
                error: Some(e.to_string()),
                is_thumbnail: false,
            }),
        }
    }

    /// 批量解密
    #[napi]
    pub async fn decrypt_batch(
        &self,
        input_paths: Vec<String>,
        output_dir: String,
        concurrency: u32,
    ) -> napi::Result<Vec<ImageDecryptResult>> {
        let output_dir = PathBuf::from(output_dir);
        
        // 使用 Rayon 进行并行处理
        let results: Vec<ImageDecryptResult> = input_paths
            .into_par_iter()
            .map(|input_path| {
                let input = PathBuf::from(&input_path);
                match tokio::runtime::Handle::current().block_on(
                    self.decrypt_file_internal(&input, &output_dir)
                ) {
                    Ok(r) => r,
                    Err(e) => ImageDecryptResult {
                        success: false,
                        output_path: None,
                        format: "unknown".to_string(),
                        error: Some(e.to_string()),
                        is_thumbnail: false,
                    }
                }
            })
            .collect();

        Ok(results)
    }

    /// 尝试自动识别密钥
    #[napi]
    pub fn try_detect_key(&self, sample_path: String) -> napi::Result<Option<Vec<u8>>> {
        let data = fs::read(&sample_path)
            .map_err(|e| napi::Error::from_reason(format!("读取文件失败: {}", e)))?;

        // 尝试常见的 XOR 密钥
        let common_keys: Vec<Vec<u8>> = vec![
            vec![0xA3, 0xA2, 0xA1, 0xA0],
            vec![0x12, 0x34, 0x56, 0x78],
        ];

        for key in common_keys {
            let decrypted = Decryptor::xor_decrypt(&data[..16.min(data.len())], &key);
            let format = ImageFormat::from_magic_bytes(&decrypted);
            if format != ImageFormat::Unknown {
                return Ok(Some(key));
            }
        }

        Ok(None)
    }

    /// 内部解密实现
    async fn decrypt_file_internal(
        &self,
        input: &Path,
        output_dir: &Path,
    ) -> Result<ImageDecryptResult> {
        // 读取 .dat 文件
        let data = fs::read(input)
            .with_context(|| format!("读取文件失败: {}", input.display()))?;

        if data.is_empty() {
            bail!("文件为空: {}", input.display());
        }

        // 获取密钥
        let key = self.config.image_xor_key.as_ref()
            .or(self.config.image_aes_key.as_ref())
            .ok_or_else(|| anyhow::anyhow!("未设置解密密钥"))?;

        // 解密
        let decrypted = if self.config.image_xor_key.is_some() {
            Decryptor::xor_decrypt(&data, key)
        } else {
            let key_array: [u8; 16] = key[..16.min(key.len())]
                .try_into()
                .map_err(|_| anyhow::anyhow!("AES 密钥长度必须是 16 字节"))?;
            Decryptor::aes_decrypt(&data, &key_array)
        };

        // 识别格式
        let format = ImageFormat::from_magic_bytes(&decrypted);
        if format == ImageFormat::Unknown {
            warn!("无法识别解密后的图片格式: {}", input.display());
        }

        // 构建输出路径
        let stem = input.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");
        let output_path = output_dir.join(format!("{}.{}.{}", stem, "decrypted", format.extension()));

        // 确保输出目录存在
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // 写入文件
        fs::write(&output_path, &decrypted)
            .with_context(|| format!("写入文件失败: {}", output_path.display()))?;

        info!("解密成功: {} -> {}", input.display(), output_path.display());

        Ok(ImageDecryptResult {
            success: true,
            output_path: Some(output_path.to_string_lossy().to_string()),
            format: format.extension().to_string(),
            error: None,
            is_thumbnail: false,
        })
    }
}

/// 解密数据（直接操作字节）
#[napi]
pub fn decrypt_image_data(
    data: Buffer,
    xor_key: Option<Buffer>,
) -> napi::Result<Buffer> {
    let data = data.to_vec();
    
    let key = match xor_key {
        Some(k) => k.to_vec(),
        None => return Err(napi::Error::new(napi::Status::InvalidArg, "需要 XOR 密钥")),
    };

    let decrypted = Decryptor::xor_decrypt(&data, &key);
    Ok(Buffer::from(decrypted))
}
