const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const { platform, arch } = process

let nativeBinding = null
let localFileExisted = false
let loadError = null

function isMusl() {
  // For Node 10
  if (!process.report || typeof process.report.getReport !== 'function') {
    try {
      const lddPath = require('child_process').execSync('which ldd').toString().trim()
      return readFileSync(lddPath, 'utf8').includes('musl')
    } catch (e) {
      return true
    }
  } else {
    const { glibcVersionRuntime } = process.report.getReport().header
    return !glibcVersionRuntime
  }
}

switch (platform) {
  case 'android':
    switch (arch) {
      case 'arm64':
        localFileExisted = existsSync(join(__dirname, 'weflow-core.android-arm64.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./weflow-core.android-arm64.node')
          } else {
            nativeBinding = require('weflow-core-android-arm64')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'arm':
        localFileExisted = existsSync(join(__dirname, 'weflow-core.android-arm-eabi.node'))
        try {
          if (localFileExisted) {
            nativeBinding = require('./weflow-core.android-arm-eabi.node')
          } else {
            nativeBinding = require('weflow-core-android-arm-eabi')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on Android ${arch}`)
    }
    break
  case 'win32':
    switch (arch) {
      case 'x64':
        localFileExisted = existsSync(
          join(__dirname, 'weflow-core.win32-x64-msvc.node')
        )
        try {
          if (localFileExisted) {
            nativeBinding = require('./weflow-core.win32-x64-msvc.node')
          } else {
            nativeBinding = require('weflow-core-win32-x64-msvc')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'ia32':
        localFileExisted = existsSync(
          join(__dirname, 'weflow-core.win32-ia32-msvc.node')
        )
        try {
          if (localFileExisted) {
            nativeBinding = require('./weflow-core.win32-ia32-msvc.node')
          } else {
            nativeBinding = require('weflow-core-win32-ia32-msvc')
          }
        } catch (e) {
          loadError = e
        }
        break
      case 'arm64':
        localFileExisted = existsSync(
          join(__dirname, 'weflow-core.win32-arm64-msvc.node')
        )
        try {
          if (localFileExisted) {
            nativeBinding = require('./weflow-core.win32-arm64-msvc.node')
          } else {
            nativeBinding = require('weflow-core-win32-arm64-msvc')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on Windows: ${arch}`)
    }
    break
  case 'darwin':
    localFileExisted = existsSync(join(__dirname, 'weflow-core.darwin-universal.node'))
    try {
      if (localFileExisted) {
        nativeBinding = require('./weflow-core.darwin-universal.node')
      } else {
        nativeBinding = require('weflow-core-darwin-universal')
      }
    } catch (e) {
      loadError = e
    }
    if (!nativeBinding) {
      localFileExisted = existsSync(join(__dirname, 'weflow-core.darwin-x64.node'))
      try {
        if (localFileExisted) {
          nativeBinding = require('./weflow-core.darwin-x64.node')
        } else {
          nativeBinding = require('weflow-core-darwin-x64')
        }
      } catch (e) {
        loadError = e
      }
    }
    if (!nativeBinding) {
      localFileExisted = existsSync(
        join(__dirname, 'weflow-core.darwin-arm64.node')
      )
      try {
        if (localFileExisted) {
          nativeBinding = require('./weflow-core.darwin-arm64.node')
        } else {
          nativeBinding = require('weflow-core-darwin-arm64')
        }
      } catch (e) {
        loadError = e
      }
    }
    break
  case 'freebsd':
    if (arch !== 'x64') {
      throw new Error(`Unsupported architecture on FreeBSD: ${arch}`)
    }
    localFileExisted = existsSync(join(__dirname, 'weflow-core.freebsd-x64.node'))
    try {
      if (localFileExisted) {
        nativeBinding = require('./weflow-core.freebsd-x64.node')
      } else {
        nativeBinding = require('weflow-core-freebsd-x64')
      }
    } catch (e) {
      loadError = e
    }
    break
  case 'linux':
    switch (arch) {
      case 'x64':
        if (isMusl()) {
          localFileExisted = existsSync(
            join(__dirname, 'weflow-core.linux-x64-musl.node')
          )
          try {
            if (localFileExisted) {
              nativeBinding = require('./weflow-core.linux-x64-musl.node')
            } else {
              nativeBinding = require('weflow-core-linux-x64-musl')
            }
          } catch (e) {
            loadError = e
          }
        } else {
          localFileExisted = existsSync(
            join(__dirname, 'weflow-core.linux-x64-gnu.node')
          )
          try {
            if (localFileExisted) {
              nativeBinding = require('./weflow-core.linux-x64-gnu.node')
            } else {
              nativeBinding = require('weflow-core-linux-x64-gnu')
            }
          } catch (e) {
            loadError = e
          }
        }
        break
      case 'arm64':
        if (isMusl()) {
          localFileExisted = existsSync(
            join(__dirname, 'weflow-core.linux-arm64-musl.node')
          )
          try {
            if (localFileExisted) {
              nativeBinding = require('./weflow-core.linux-arm64-musl.node')
            } else {
              nativeBinding = require('weflow-core-linux-arm64-musl')
            }
          } catch (e) {
            loadError = e
          }
        } else {
          localFileExisted = existsSync(
            join(__dirname, 'weflow-core.linux-arm64-gnu.node')
          )
          try {
            if (localFileExisted) {
              nativeBinding = require('./weflow-core.linux-arm64-gnu.node')
            } else {
              nativeBinding = require('weflow-core-linux-arm64-gnu')
            }
          } catch (e) {
            loadError = e
          }
        }
        break
      case 'arm':
        localFileExisted = existsSync(
          join(__dirname, 'weflow-core.linux-arm-gnueabihf.node')
        )
        try {
          if (localFileExisted) {
            nativeBinding = require('./weflow-core.linux-arm-gnueabihf.node')
          } else {
            nativeBinding = require('weflow-core-linux-arm-gnueabihf')
          }
        } catch (e) {
          loadError = e
        }
        break
      default:
        throw new Error(`Unsupported architecture on Linux: ${arch}`)
    }
    break
  default:
    throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`)
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError
  }
  throw new Error(`Failed to load native binding`)
}

const { 
  version, 
  initLogging, 
  healthCheck, 
  getSystemInfo,
  ImageDecryptService,
  KeyService,
  WcdbService,
  ExportService,
  ExportTask,
  AnalyticsService,
  decryptImageData,
  generateImageXorKey,
  deriveDbKey,
  sanitizeTableName,
} = nativeBinding

module.exports.version = version
module.exports.initLogging = initLogging
module.exports.healthCheck = healthCheck
module.exports.getSystemInfo = getSystemInfo
module.exports.ImageDecryptService = ImageDecryptService
module.exports.KeyService = KeyService
module.exports.WcdbService = WcdbService
module.exports.ExportService = ExportService
module.exports.ExportTask = ExportTask
module.exports.AnalyticsService = AnalyticsService
module.exports.decryptImageData = decryptImageData
module.exports.generateImageXorKey = generateImageXorKey
module.exports.deriveDbKey = deriveDbKey
module.exports.sanitizeTableName = sanitizeTableName
