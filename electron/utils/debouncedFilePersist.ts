export function createDebouncedFilePersist(write: () => void, delayMs = 500): {
  schedule: () => void
  flush: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    write()
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      write()
    }, delayMs)
  }

  const cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { schedule, flush, cancel }
}
