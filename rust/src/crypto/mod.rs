//! 解密模块 - 微信数据解密
//! 
//! 包含：
//! - 图片解密 (.dat 文件)
//! - 数据库解密
//! - 密钥管理

pub mod image;
pub mod key;

use aes::cipher::{BlockDecrypt, KeyInit, generic_array::GenericArray};
use aes::Aes128;

/// 解密配置
#[derive(Debug, Clone)]
pub struct DecryptConfig {
    pub image_xor_key: Option<Vec<u8>>,
    pub image_aes_key: Option<Vec<u8>>,
    pub db_key: Option<Vec<u8>>,
}

impl Default for DecryptConfig {
    fn default() -> Self {
        Self {
            image_xor_key: None,
            image_aes_key: None,
            db_key: None,
        }
    }
}

/// 解密器
pub struct Decryptor {
    config: DecryptConfig,
}

impl Decryptor {
    pub fn new(config: DecryptConfig) -> Self {
        Self { config }
    }

    /// XOR 解密
    pub fn xor_decrypt(data: &[u8], key: &[u8]) -> Vec<u8> {
        data.iter()
            .zip(key.iter().cycle())
            .map(|(b, k)| b ^ k)
            .collect()
    }

    /// AES-128-ECB 解密
    pub fn aes_decrypt(data: &[u8], key: &[u8; 16]) -> Vec<u8> {
        let cipher = Aes128::new_from_slice(key).expect("Invalid key length");
        let mut result = Vec::with_capacity(data.len());

        for chunk in data.chunks(16) {
            let mut block = GenericArray::default();
            let len = chunk.len().min(16);
            block[..len].copy_from_slice(&chunk[..len]);

            cipher.decrypt_block(&mut block);
            result.extend_from_slice(&block[..len]);
        }

        result
    }

    /// 解密微信 DAT 文件 (支持 v1 和 v2 格式)
    pub fn decrypt_dat(data: &[u8], xor_key: u8, aes_key: Option<&[u8; 16]>) -> Vec<u8> {
        if data.len() < 6 {
            return Self::xor_decrypt(data, &[xor_key]);
        }

        // 检查 DAT 版本签名
        let sig_v1: [u8; 6] = [0x07, 0x08, 0x56, 0x31, 0x08, 0x07]; // "V1"
        let sig_v2: [u8; 6] = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07]; // "V2"

        if data[..6] == sig_v1 {
            // DAT v1: 纯 XOR 加密，跳过 6 字节头
            Self::xor_decrypt(&data[6..], &[xor_key])
        } else if data[..6] == sig_v2 {
            // DAT v2: AES + XOR 混合加密
            Self::decrypt_dat_v2(data, xor_key, aes_key)
        } else {
            // 无签名，纯 XOR 加密
            Self::xor_decrypt(data, &[xor_key])
        }
    }

    /// 解密 DAT v2 格式 (AES-128-ECB + XOR)
    fn decrypt_dat_v2(data: &[u8], xor_key: u8, aes_key: Option<&[u8; 16]>) -> Vec<u8> {
        if data.len() < 0x0f {
            return data.to_vec();
        }

        // 读取头部信息 (little endian)
        let aes_size = i32::from_le_bytes([data[6], data[7], data[8], data[9]]) as usize;
        let xor_size = i32::from_le_bytes([data[10], data[11], data[12], data[13]]) as usize;

        // 计算对齐后的 AES 大小 (16字节对齐)
        let remainder = (aes_size % 16 + 16) % 16;
        let aligned_aes_size = aes_size + (16 - remainder);

        let payload = &data[0x0f..]; // 从偏移 0x0f 开始是数据

        let mut result = Vec::new();

        // 1. AES 解密前半部分
        if aes_size > 0 && aligned_aes_size <= payload.len() {
            let aes_data = &payload[..aligned_aes_size];
            if let Some(key) = aes_key {
                let decrypted_aes = Self::aes_decrypt(aes_data, key);
                // 移除 PKCS7 填充
                if let Some(&pad_len) = decrypted_aes.last() {
                    let pad = pad_len as usize;
                    if pad > 0 && pad <= 16 && pad <= decrypted_aes.len() {
                        let valid = decrypted_aes.iter().rev().take(pad).all(|&b| b == pad_len);
                        if valid {
                            result.extend_from_slice(&decrypted_aes[..decrypted_aes.len() - pad]);
                        } else {
                            result.extend_from_slice(&decrypted_aes);
                        }
                    } else {
                        result.extend_from_slice(&decrypted_aes);
                    }
                }
            }
        }

        // 2. 处理中间未加密部分
        let remaining_offset = aligned_aes_size;
        if remaining_offset < payload.len() {
            let raw_len = payload.len() - remaining_offset - xor_size as usize;
            if raw_len > 0 {
                result.extend_from_slice(&payload[remaining_offset..remaining_offset + raw_len]);
            }

            // 3. XOR 解密后半部分
            if xor_size > 0 {
                let xor_offset = payload.len() - xor_size as usize;
                let xor_data = &payload[xor_offset..];
                let decrypted_xor = Self::xor_decrypt(xor_data, &[xor_key]);
                result.extend_from_slice(&decrypted_xor);
            }
        }

        result
    }
}
