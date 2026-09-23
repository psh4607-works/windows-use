import type {
  ComputerActionMetadata,
  ComputerProviderCapabilities
} from '../../shared/runtime-types'
import { optionalNumberParam, optionalStringParam } from './desktop-script-provider-params'
import { REDACTED, refreshedElement, sensitiveAction } from './desktop-script-observation-safety'
import { RuntimeClientError } from './runtime-client-error'
import type {
  BridgeElement,
  BridgeRequest,
  BridgeSnapshot,
  NativeActionMethod
} from './desktop-script-provider-types'

export function bridgeTool(method: NativeActionMethod): string {
  return {
    click: 'click',
    performSecondaryAction: 'perform_secondary_action',
    scroll: 'scroll',
    drag: 'drag',
    typeText: 'type_text',
    pressKey: 'press_key',
    hotkey: 'hotkey',
    pasteText: 'paste_text',
    setValue: 'set_value'
  }[method]
}

export function actionCapabilityKey(
  method: NativeActionMethod
): keyof ComputerProviderCapabilities['supports']['actions'] {
  const keys = {
    click: 'click',
    performSecondaryAction: 'performAction',
    scroll: 'scroll',
    drag: 'drag',
    typeText: 'typeText',
    pressKey: 'pressKey',
    hotkey: 'hotkey',
    pasteText: 'pasteText',
    setValue: 'setValue'
  } satisfies Record<NativeActionMethod, keyof ComputerProviderCapabilities['supports']['actions']>
  return keys[method]
}

function desktopActionMetadata(
  method: NativeActionMethod,
  targetWindowId: number | null,
  targetWindowIndex: number | null
): ComputerActionMetadata {
  const path =
    method === 'pasteText'
      ? ('clipboard' as const)
      : method === 'setValue' || method === 'performSecondaryAction'
        ? ('accessibility' as const)
        : ('synthetic' as const)
  return {
    path,
    actionName:
      method === 'hotkey'
        ? 'hotkey'
        : method === 'pasteText'
          ? 'paste'
          : method === 'setValue'
            ? 'setValue'
            : method === 'performSecondaryAction'
              ? 'performSecondaryAction'
              : method === 'typeText'
                ? 'typeText'
                : method === 'pressKey'
                  ? 'pressKey'
                  : null,
    fallbackReason: null,
    targetWindowId,
    targetWindowIndex,
    verification:
      method === 'hotkey' || method === 'pasteText'
        ? {
            state: 'unverified' as const,
            reason:
              method === 'pasteText' ? ('clipboard_paste' as const) : ('synthetic_input' as const)
          }
        : undefined
  }
}

export function desktopActionWindowTarget(
  explicitWindowId: number | undefined,
  explicitWindowIndex: number | undefined,
  current: BridgeSnapshot | null
): Pick<BridgeRequest, 'windowId' | 'windowIndex'> {
  if (explicitWindowId !== undefined) {
    if (current?.windowId !== explicitWindowId) {
      throw new RuntimeClientError('window_not_found', 'Take a fresh snapshot of this window handle before acting')
    }
    return { windowId: explicitWindowId }
  }
  if (explicitWindowIndex !== undefined) {
    if (current?.windowId !== null && current?.windowId !== undefined) {
      // Indexes follow enumeration order; input must follow the observed window.
      return { windowId: current.windowId }
    }
    throw new RuntimeClientError('window_not_found', 'Take a fresh snapshot of this window index before acting')
  }
  if (current?.windowId !== null && current?.windowId !== undefined) {
    return { windowId: current.windowId }
  }
  if (current?.windowIndex !== null && current?.windowIndex !== undefined) {
    throw new RuntimeClientError('window_not_found', 'Take a fresh snapshot with a window handle before acting')
  }
  throw new RuntimeClientError('window_not_found', 'Take a fresh snapshot with a window handle before acting')
}

export function desktopActionMetadataFromResponse(
  action: ComputerActionMetadata | undefined,
  method: NativeActionMethod,
  targetWindowId: number | null,
  targetWindowIndex: number | null
): ComputerActionMetadata {
  return action
    ? {
        ...action,
        targetWindowId: action.targetWindowId ?? targetWindowId,
        targetWindowIndex: action.targetWindowIndex ?? targetWindowIndex
      }
    : desktopActionMetadata(method, targetWindowId, targetWindowIndex)
}

export function verifyDesktopAction(
  action: ComputerActionMetadata,
  method: NativeActionMethod,
  params: Record<string, unknown>,
  rawAction: ComputerActionMetadata | undefined,
  snapshot: BridgeSnapshot | undefined,
  targetElement: BridgeElement | undefined,
  observedWindowId: number | undefined
): ComputerActionMetadata {
  if (isWindowChangedAction(action) || (snapshot?.windowId !== undefined && snapshot.windowId !== observedWindowId)) {
    return { ...action, verification: { state: 'unverified', reason: 'window_changed' } }
  }
  if (method === 'setValue' && sensitiveAction(snapshot, targetElement)) {
    return { ...action, verification: { state: 'unverified', reason: 'sensitive_value', expected: REDACTED, actualPreview: REDACTED } }
  }
  if (rawAction?.verification && (method !== 'setValue' || rawAction.verification.state === 'unverified')) {
    return action
  }
  if (method === 'typeText' || method === 'pressKey' || method === 'hotkey') {
    return {
      ...action,
      verification: { state: 'unverified', reason: 'synthetic_input' }
    }
  }
  if (method === 'pasteText') {
    return {
      ...action,
      verification: { state: 'unverified', reason: 'clipboard_paste' }
    }
  }
  if (method !== 'setValue') {
    return action
  }
  const expected = optionalStringParam(params, 'value')
  const elementIndex = optionalNumberParam(params, 'elementIndex')
  if (expected === undefined || elementIndex === undefined) {
    return action
  }
  const actual = refreshedElement(snapshot, targetElement)?.value
  if (actual === expected) {
    return {
      ...action,
      verification: { state: 'verified', property: 'value', expected, actualPreview: actual }
    }
  }
  return {
    ...action,
    verification: {
      state: 'unverified',
      reason: actual === undefined ? 'provider_unavailable' : 'value_mismatch',
      expected,
      actualPreview: actual ?? null
    }
  }
}

export function cacheParamsForActionResult(
  params: Record<string, unknown>,
  action: ComputerActionMetadata
): Record<string, unknown> {
  if (!isWindowChangedAction(action)) {
    return params
  }
  const { windowId: _windowId, windowIndex: _windowIndex, ...withoutStaleWindowTarget } = params
  return withoutStaleWindowTarget
}

export function isWindowChangedAction(action: ComputerActionMetadata): boolean {
  return (
    action.verification?.state === 'unverified' && action.verification.reason === 'window_changed'
  )
}

export function elementParam(
  snapshot: BridgeSnapshot | null,
  index: number | undefined
): BridgeElement | undefined {
  if (index === undefined) {
    return undefined
  }
  const element = snapshot?.elements?.find((candidate) => candidate.index === index)
  if (!element) {
    throw new RuntimeClientError(
      'element_not_found',
      `element ${index} is not in the current cached snapshot; run get-app-state again and use a fresh element index`
    )
  }
  return element
}
