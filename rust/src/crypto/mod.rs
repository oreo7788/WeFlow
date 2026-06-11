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
}
