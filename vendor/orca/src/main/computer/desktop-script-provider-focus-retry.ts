import type { DesktopScriptPlatform } from './desktop-script-provider-paths'
import type { BridgeRequest, BridgeResponse } from './desktop-script-provider-types'
import { RuntimeClientError } from './runtime-client-error'

export type WindowsFocusHelperLifecycle = {
  environmentFor: (
    request: Pick<BridgeRequest, 'tool' | 'restoreWindow'>
  ) => Promise<NodeJS.ProcessEnv>
  shutdown: () => void
}

type BridgeAttempt = (extraEnv: NodeJS.ProcessEnv) => Promise<{
  response: BridgeResponse
  stderr: string
}>

export async function callDesktopBridgeWithFocusFallback({
  platform,
  request,
  focusHelper,
  attempt
}: {
  platform: DesktopScriptPlatform
  request: BridgeRequest
  focusHelper: WindowsFocusHelperLifecycle | null
  attempt: BridgeAttempt
}): Promise<{ response: BridgeResponse; stderr: string }> {
  const native = await attempt({})
  if (!shouldRetryWithWindowsFocusHelper(platform, request, focusHelper, native.response)) {
    return native
  }
  const helperEnvironment = await focusHelper.environmentFor(request)
  return Object.keys(helperEnvironment).length > 0 ? await attempt(helperEnvironment) : native
}

export function parseDesktopBridgeResponse(stdout: string): BridgeResponse {
  try {
    return JSON.parse(stdout) as BridgeResponse
  } catch (error) {
    throw new RuntimeClientError(
      'accessibility_error',
      `desktop provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function shouldRetryWithWindowsFocusHelper(
  platform: DesktopScriptPlatform,
  request: BridgeRequest,
  focusHelper: WindowsFocusHelperLifecycle | null,
  response: BridgeResponse
): focusHelper is WindowsFocusHelperLifecycle {
  return (
    platform === 'windows' &&
    focusHelper !== null &&
    request.restoreWindow === true &&
    response.ok === false &&
    /window_not_focused|target window.*focused/i.test(response.error ?? '')
  )
}
