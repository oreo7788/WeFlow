export function logOptionalError(scope: string, error: unknown): void {
  if (error === undefined || error === null || error === '') return
  console.warn(`[${scope}]`, error)
}
