type Task<T> = () => Promise<T>

const EXCLUSIVE_WORKER_TYPES = new Set([
  'setPaths',
  'setLogEnabled',
  'setMonitor',
  'testConnection',
  'open',
  'close',
  'markAllSessionsRead',
  'openMessageCursor',
  'openMessageCursorLite',
  'fetchMessageBatch',
  'closeMessageCursor',
  'getNewMessages',
  'updateMessage',
  'deleteMessage',
  'execQuery',
  'exportTableSnapshot',
  'importTableSnapshot',
  'importTableSnapshotWithSchema',
  'installMessageAntiRevokeTriggers',
  'uninstallMessageAntiRevokeTriggers',
  'installSnsBlockDeleteTrigger',
  'uninstallSnsBlockDeleteTrigger',
  'deleteSnsPost',
  'cloudInit',
  'cloudReport',
  'cloudStop',
  'verifyUser'
])

export function isExclusiveWorkerType(type: string): boolean {
  return EXCLUSIVE_WORKER_TYPES.has(type)
}

export class WcdbWorkerScheduler {
  private writeChain: Promise<void> = Promise.resolve()
  private activeReads = 0
  private writeInProgress = false
  private readonly maxConcurrentReads: number
  private readWaiters: Array<() => void> = []
  private writeWaiters: Array<() => void> = []

  constructor(maxConcurrentReads = 4) {
    this.maxConcurrentReads = Math.max(1, Math.floor(maxConcurrentReads || 4))
  }

  schedule<T>(type: string, task: Task<T>): Promise<T> {
    if (isExclusiveWorkerType(type)) {
      return this.runExclusive(task)
    }
    return this.runRead(task)
  }

  private async runRead<T>(task: Task<T>): Promise<T> {
    await this.acquireReadSlot()
    try {
      return await task()
    } finally {
      this.releaseReadSlot()
    }
  }

  private runExclusive<T>(task: Task<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.waitForReadsToDrain()
      this.writeInProgress = true
      try {
        return await task()
      } finally {
        this.writeInProgress = false
        this.flushWriteWaiters()
        this.flushReadWaiters()
      }
    }

    const result = this.writeChain.then(run, run)
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async acquireReadSlot(): Promise<void> {
    while (this.writeInProgress || this.activeReads >= this.maxConcurrentReads) {
      await new Promise<void>((resolve) => {
        this.readWaiters.push(resolve)
      })
    }
    this.activeReads += 1
  }

  private releaseReadSlot(): void {
    this.activeReads = Math.max(0, this.activeReads - 1)
    this.flushReadWaiters()
    if (this.activeReads === 0) {
      this.flushWriteWaiters()
    }
  }

  private async waitForReadsToDrain(): Promise<void> {
    while (this.activeReads > 0) {
      await new Promise<void>((resolve) => {
        this.writeWaiters.push(resolve)
      })
    }
  }

  private flushReadWaiters(): void {
    while (
      this.activeReads < this.maxConcurrentReads &&
      !this.writeInProgress &&
      this.readWaiters.length > 0
    ) {
      const next = this.readWaiters.shift()
      next?.()
    }
  }

  private flushWriteWaiters(): void {
    if (this.activeReads > 0 || this.writeInProgress) return
    const waiters = this.writeWaiters.splice(0)
    for (const waiter of waiters) {
      waiter()
    }
  }
}
