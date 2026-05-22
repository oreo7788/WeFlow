const MD5_PATTERN = /^[a-f0-9]{32}$/i

export type ImageHardlinkSource = {
  imageMd5?: unknown
  imageOriginSourceMd5?: unknown
  imageDatName?: unknown
}

export function collectImageHardlinkMd5s(sources: Iterable<ImageHardlinkSource>): string[] {
  const md5Set = new Set<string>()

  for (const source of sources) {
    const imageMd5 = String(source?.imageMd5 || '').trim().toLowerCase()
    if (imageMd5) {
      md5Set.add(imageMd5)
    }

    const imageOriginSourceMd5 = String(source?.imageOriginSourceMd5 || '').trim().toLowerCase()
    if (imageOriginSourceMd5) {
      md5Set.add(imageOriginSourceMd5)
    }

    if (imageMd5 || imageOriginSourceMd5) {
      continue
    }

    const imageDatName = String(source?.imageDatName || '').trim().toLowerCase()
    if (MD5_PATTERN.test(imageDatName)) {
      md5Set.add(imageDatName)
    }
  }

  return Array.from(md5Set)
}
