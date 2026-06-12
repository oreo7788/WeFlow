import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Rust 模块桥接
let rustModule: any = null
try {
  // 计算 rust 模块路径
  // 当前文件在 dist-electron/services/ 或 electron/services/
  let rustPath: string
  if (__dirname.includes('dist-electron')) {
    // 打包后: dist-electron/services/ -> ../../rust
    rustPath = join(__dirname, '..', '..', 'rust')
  } else {
    // 开发环境: electron/services/ -> ../../rust
    rustPath = join(__dirname, '..', '..', 'rust')
  }

  // 检查路径是否存在
  if (!existsSync(rustPath)) {
    // 尝试从项目根目录找
    const cwdRustPath = join(process.cwd(), 'rust')
    if (existsSync(cwdRustPath)) {
      rustPath = cwdRustPath
    }
  }

  rustModule = require(rustPath)
  console.log('[🔥 Rust] 核心模块加载成功! version=' + (rustModule.version?.() || 'unknown'))
} catch (e) {
  console.log('[🔥 Rust] 模块加载失败:', (e as Error).message)
  // Rust 模块不可用
}

type NativeDecryptResult = {
  data: Buffer
  ext: string
  isWxgf?: boolean
  is_wxgf?: boolean
  version?: number
  aesSize?: number
  aes_size?: number
  xorSize?: number
  xor_size?: number
  rawSize?: number
  raw_size?: number
  flag?: number
}

export type NativeDatMeta = {
  version?: number
  aesSize?: number
  aes_size?: number
  xorSize?: number
  xor_size?: number
  rawSize?: number
  raw_size?: number
  flag?: number
}

type NativeAddon = {
  decryptDatNative: (inputPath: string, xorKey: number, aesKey?: string) => NativeDecryptResult
  encryptDatNative?: (inputPath: string, xorKey: number, aesKey?: string, meta?: NativeDatMeta) => Buffer
}

let cachedAddon: NativeAddon | null | undefined

function shouldEnableNative(): boolean {
  return process.env.WEFLOW_IMAGE_NATIVE !== '0'
}

function expandAsarCandidates(filePath: string): string[] {
  if (!filePath.includes('app.asar') || filePath.includes('app.asar.unpacked')) {
    return [filePath]
  }
  return [filePath.replace('app.asar', 'app.asar.unpacked'), filePath]
}

function getPlatformDir(): string {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  return process.platform
}

function getArchDir(): string {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

function getAddonCandidates(): string[] {
  const platformDir = getPlatformDir()
  const archDir = getArchDir()
  const cwd = process.cwd()
  const fileNames = [
    `weflow-image-native-${platformDir}-${archDir}.node`
  ]
  const roots = [
    join(cwd, 'resources', 'wedecrypt', platformDir, archDir),
    ...(process.resourcesPath
      ? [
          join(process.resourcesPath, 'resources', 'wedecrypt', platformDir, archDir),
          join(process.resourcesPath, 'wedecrypt', platformDir, archDir)
        ]
      : [])
  ]
  const candidates = roots.flatMap((root) => fileNames.map((name) => join(root, name)))
  return Array.from(new Set(candidates.flatMap(expandAsarCandidates)))
}

function loadAddon(): NativeAddon | null {
  if (!shouldEnableNative()) return null
  if (cachedAddon !== undefined) return cachedAddon

  for (const candidate of getAddonCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require(candidate) as NativeAddon
      if (addon && typeof addon.decryptDatNative === 'function') {
        cachedAddon = addon
        return addon
      }
    } catch {
      // try next candidate
    }
  }

  cachedAddon = null
  return null
}

export function nativeAddonLocation(): string | null {
  for (const candidate of getAddonCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/// 使用 Rust 模块解密
function decryptDatViaRust(
  inputPath: string,
  xorKey: number,
  _aesKey?: string
): { data: Buffer; ext: string; isWxgf: boolean; meta: NativeDatMeta } | null {
  if (!rustModule?.decryptImageData) return null

  const fileName = inputPath.split('/').pop() || 'unknown'
  const start = performance.now()
  try {
    // 读取文件
    const fileData = readFileSync(inputPath)

    // 创建 XOR 密钥 buffer（单字节）
    const keyByte = xorKey & 0xFF
    const keyBuffer = Buffer.from([keyByte])

    // 创建 AES 密钥 buffer（如果有）
    let aesKeyBuffer: Buffer | undefined = undefined
    if (_aesKey && _aesKey.length >= 16) {
      aesKeyBuffer = Buffer.from(_aesKey.slice(0, 16), 'ascii')
    }

    console.log(`[🔍 Debug] ${fileName}: 大小=${fileData.length}, XOR=0x${keyByte.toString(16).padStart(2, '0')}, AES=${aesKeyBuffer ? '有' : '无'}, 前8字节=${fileData.slice(0, 8).toString('hex')}`)

    // 调用 Rust 解密（支持 DAT v2）
    const decrypted = rustModule.decryptImageData(fileData, keyBuffer, aesKeyBuffer)
    const decryptMs = performance.now() - start

    if (!decrypted || !Buffer.isBuffer(decrypted)) {
      console.log(`[❌ Rust] 返回无效数据: ${fileName}`)
      return null
    }

    // 检测图片格式
    const format = detectImageFormat(decrypted)
    const decryptedHeader = decrypted.slice(0, 8).toString('hex')
    if (!format) {
      console.log(`[❌ Rust] 无法识别格式: ${fileName}, 解密后前8字节=${decryptedHeader}`)
      return null
    }

    const ext = `.${format}`
    console.log(`[✅ Rust解密] ${fileName} -> ${ext} (${fileData.length}字节, ${decryptMs.toFixed(1)}ms)`)

    return {
      data: decrypted,
      ext,
      isWxgf: false,
      meta: {}
    }
  } catch (e) {
    console.log(`[❌ Rust异常] ${fileName}: ${(e as Error).message}`)
    return null
  }
}

/// 检测图片格式
function detectImageFormat(buffer: Buffer): string | null {
  if (buffer.length < 8) return null

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg'
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png'
  }
  // GIF: GIF87a or GIF89a
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'gif'
  }
  // WebP: RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp'
  }
  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return 'bmp'
  }
  // TIFF BE: MM 00 2A
  if (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A) {
    return 'tif'
  }
  // TIFF LE: II 2A 00
  if (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) {
    return 'tif'
  }
  // wxgf: wxgf
  if (buffer[0] === 0x77 && buffer[1] === 0x78 && buffer[2] === 0x67 && buffer[3] === 0x66) {
    return 'wxgf'
  }

  return null
}

let rustDecryptCount = 0
let nativeDecryptCount = 0
let jsDecryptCount = 0

export function decryptDatViaNative(
  inputPath: string,
  xorKey: number,
  aesKey?: string
): { data: Buffer; ext: string; isWxgf: boolean; meta: NativeDatMeta } | null {
  const fileName = inputPath.split('/').pop() || 'unknown'

  // 优先尝试 Rust 模块
  const rustResult = decryptDatViaRust(inputPath, xorKey, aesKey)
  if (rustResult) {
    rustDecryptCount++
    console.log(`[✅ Rust成功 #${rustDecryptCount}] ${fileName} -> ${rustResult.ext}`)
    return rustResult
  }

  // Rust 失败，记录原因
  console.log(`[❌ Rust失败] ${fileName}, 尝试Native模块...`)

  // 回退到传统原生模块
  const addon = loadAddon()
  if (!addon) {
    jsDecryptCount++
    console.log(`[⚠️ 无Native模块 #${jsDecryptCount}] ${fileName} -> 尝试JS解密`)
    return null
  }

  try {
    const result = addon.decryptDatNative(inputPath, xorKey, aesKey)
    if (!result || !Buffer.isBuffer(result.data)) {
      console.log(`[❌ Native失败] ${fileName} -> 无有效数据`)
      return null
    }
    nativeDecryptCount++
    const isWxgf = Boolean(result?.isWxgf ?? result?.is_wxgf)
    const rawExt = typeof result.ext === 'string' && result.ext.trim()
      ? result.ext.trim().toLowerCase()
      : ''
    let ext = rawExt ? (rawExt.startsWith('.') ? rawExt : `.${rawExt}`) : ''
    if (!ext) {
      const inferred = detectImageFormat(result.data)
      if (inferred) {
        ext = `.${inferred}`
      }
    }
    console.log(`[✅ Native成功 #${nativeDecryptCount}] ${fileName} -> ${ext || '(未知)'}${isWxgf ? '(wxgf)' : ''}`)
    const meta: NativeDatMeta = {
      version: result.version,
      aes_size: result.aes_size ?? result.aesSize,
      xor_size: result.xor_size ?? result.xorSize,
      raw_size: result.raw_size ?? result.rawSize,
      flag: result.flag
    }
    return { data: result.data, ext, isWxgf, meta }
  } catch (e) {
    console.log(`[❌ Native异常] ${fileName}: ${(e as Error).message}`)
    return null
  }
}

export function encryptDatViaNative(
  inputPath: string,
  xorKey: number,
  aesKey?: string,
  meta?: NativeDatMeta
): Buffer | null {
  const addon = loadAddon()
  if (!addon || typeof addon.encryptDatNative !== 'function') return null

  try {
    const result = addon.encryptDatNative(inputPath, xorKey, aesKey, meta)
    return Buffer.isBuffer(result) ? result : null
  } catch {
    return null
  }
}
