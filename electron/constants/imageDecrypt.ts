// 与 src/constants/imageDecrypt.ts 保持同步
/** 超过该数量的唯一 md5 标识时，批量解密跳过预热阶段 */
export const IMAGE_HARDLINK_PRELOAD_SKIP_THRESHOLD = 2000

/** hardlink 批量查询每批大小 */
export const IMAGE_HARDLINK_PRELOAD_BATCH_SIZE = 300

/** 批量解密失败条数超过该阈值时不弹窗，引导用户前往独立页面查看 */
export const BATCH_DECRYPT_FAILURE_MODAL_MAX = 10

/** 解密失败记录 localStorage 最大保留条数 */
export const BATCH_DECRYPT_FAILURE_STORAGE_MAX = 2000
