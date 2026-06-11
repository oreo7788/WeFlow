import type { MessagePort } from 'worker_threads'

export const WORKER_RESULT_BUFFER_THRESHOLD_BYTES = 65536

export function postWorkerResult(port: MessagePort, id: number, result: unknown): void {
  let serialized = ''
  try {
    serialized = JSON.stringify(result)
  } catch {
    port.postMessage({ id, error: 'Worker result serialization failed' })
    return
  }

  if (serialized.length < WORKER_RESULT_BUFFER_THRESHOLD_BYTES) {
    port.postMessage({ id, result })
    return
  }

  const buffer = Buffer.from(serialized, 'utf8')
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  )
  port.postMessage(
    {
      id,
      resultFormat: 'buffer',
      resultBuffer: arrayBuffer,
      resultBytes: buffer.byteLength
    },
    [arrayBuffer]
  )
}

export function decodeWorkerResult(msg: {
  result?: unknown
  resultFormat?: string
  resultBuffer?: ArrayBuffer
}): unknown {
  if (msg.resultFormat === 'buffer' && msg.resultBuffer) {
    const text = Buffer.from(msg.resultBuffer).toString('utf8')
    return JSON.parse(text)
  }
  return msg.result
}
