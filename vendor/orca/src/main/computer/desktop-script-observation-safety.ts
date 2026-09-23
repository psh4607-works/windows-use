import type { BridgeElement, BridgeResponse, BridgeSnapshot } from './desktop-script-provider-types'

export const REDACTED = '[redacted]'

export function sensitiveElement(element: BridgeElement | undefined): boolean {
  // Explicit native classification is authoritative. Support old redacted snapshots
  // conservatively, without treating a literal value on a public field as secret.
  return element?.isSensitive === true ||
    (element?.isSensitive !== false && element?.value === REDACTED)
}

export function refreshedElement(snapshot: BridgeSnapshot | undefined, target: BridgeElement | undefined): BridgeElement | undefined {
  if (!target) return undefined
  const hasRuntimeId = Array.isArray(target.runtimeId) && target.runtimeId.length > 0
  const matches = (snapshot?.elements ?? []).filter(element => {
    if (hasRuntimeId) return JSON.stringify(element.runtimeId) === JSON.stringify(target.runtimeId)
    if (target.automationId) return element.automationId === target.automationId
    return false
  })
  // No identity, a lost identity, or duplicate provider identities cannot prove success.
  return matches.length === 1 ? matches[0] : undefined
}

export function sensitiveAction(snapshot: BridgeSnapshot | undefined, target: BridgeElement | undefined): boolean {
  const refreshed = refreshedElement(snapshot, target)
  return sensitiveElement(target) || sensitiveElement(refreshed) ||
    (!refreshed && (snapshot?.elements ?? []).some(sensitiveElement))
}

export function redactStrings<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') {
    return secrets.filter(secret => secret && secret !== REDACTED)
      .sort((a, b) => b.length - a.length)
      .reduce((text, secret) => text.split(secret).join(REDACTED), value) as T
  }
  if (Array.isArray(value)) return value.map(item => redactStrings(item, secrets)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, secrets)])) as T
  }
  return value
}

export function sanitizeResponse(response: BridgeResponse, secrets: string[] = []): BridgeResponse {
  const sensitive = (response.snapshot?.elements ?? []).filter(sensitiveElement)
  const clean = redactStrings(response, [...secrets, ...sensitive.map(element => element.value ?? '')])
  if (clean.snapshot) {
    clean.snapshot.elements = clean.snapshot.elements?.map(element => sensitiveElement(element)
      ? { ...element, isSensitive: true, value: REDACTED } : element)
    if (sensitive.length || secrets.length) {
      // Unstructured selection/focus text and pixels have no per-field provenance.
      clean.snapshot.selectedText = null
      clean.snapshot.focusedSummary = null
      clean.snapshot.screenshotPngBase64 = null
      clean.snapshot.screenshotError = { message: 'Screenshot withheld for sensitive observation' }
    }
  }
  return clean
}
