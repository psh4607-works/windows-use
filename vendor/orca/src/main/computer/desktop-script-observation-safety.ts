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
  if (typeof value !== 'string') return value
  let text: string = value
  for (const secret of [...new Set(secrets.filter(secret => secret && /\S/u.test(secret) && secret !== REDACTED))].sort((a, b) => b.length - a.length)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const characters = Array.from(secret)
    const short = characters.length < 4
    const before = short && /[\p{L}\p{N}_]/u.test(characters[0]) ? '(?<![\\p{L}\\p{N}_])' : ''
    const after = short && /[\p{L}\p{N}_]/u.test(characters.at(-1)!) ? '(?![\\p{L}\\p{N}_])' : ''
    const pattern = new RegExp(`${before}${escaped}${after}`, 'gu')
    // Do not replace parts of a redaction marker on subsequent passes.
    text = text.split(REDACTED).map(part => part.replace(pattern, () => REDACTED)).join(REDACTED)
  }
  return text as T
}

export function sanitizeResponse(response: BridgeResponse, secrets: string[] = []): BridgeResponse {
  const sensitive = (response.snapshot?.elements ?? []).filter(sensitiveElement)
  const needles = [...secrets, ...sensitive.map(element => element.value ?? '')]
  const clean = structuredClone(response)
  if (clean.snapshot) {
    const snapshot = clean.snapshot
    // Native selector/protocol fields (including MSAA names) must remain stable.
    // Values and rendered text are the user-data surfaces; never rewrite all strings.
    snapshot.elements = snapshot.elements?.map(element => sensitiveElement(element)
      ? { ...element, isSensitive: true, value: REDACTED }
      : { ...element, value: redactStrings(element.value, needles) })
    const sensitiveIndexes = new Set(sensitive.map(element => element.index))
    snapshot.treeLines = snapshot.treeLines?.map(line => {
      const indexed = /^(\s*\d+)(\s+)([\s\S]*)$/.exec(line)
      if (!indexed) return redactStrings(line, needles)
      if (sensitiveIndexes.has(Number(indexed[1].trim()))) return `${indexed[1]} ${REDACTED}`
      return `${indexed[1]}${indexed[2]}${redactStrings(indexed[3], needles)}`
    })
    snapshot.windowTitle = redactStrings(snapshot.windowTitle, needles)
    if (snapshot.screenshotError) snapshot.screenshotError.message = redactStrings(snapshot.screenshotError.message, needles)
    if (sensitive.length || secrets.length) {
      // Unstructured selection/focus text and pixels have no per-field provenance.
      snapshot.selectedText = null
      snapshot.focusedSummary = null
      snapshot.screenshotPngBase64 = null
      snapshot.screenshotError = { message: 'Screenshot withheld for sensitive observation' }

    }
  }
  if (clean.action) {
    clean.action.fallbackReason = redactStrings(clean.action.fallbackReason, needles)
    if ((sensitive.length || secrets.length) && clean.action.verification) {
      const verification = clean.action.verification
      if ('expected' in verification) verification.expected = REDACTED
      if ('actualPreview' in verification) verification.actualPreview = REDACTED
    }
  }
  return clean
}
