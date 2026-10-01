import { incompleteReasons, observationErrors } from './observation-completeness.mjs';

export function queryError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function validateQuery(params, { allowEmpty = false, wait = false } = {}) {
  const fields = ['role', 'name', 'automationId'];
  const allowed = new Set(['app', 'windowId', 'accessibility', 'noScreenshot', 'restoreWindow', ...fields,
    ...(wait ? ['condition', 'windowTitle', 'timeoutMs', 'pollMs', 'value', 'afterInventory'] : [])]);
  if ((!allowEmpty && !fields.some(key => params[key] !== undefined)) ||
      Object.keys(params).some(key => params[key] !== undefined && !allowed.has(key)) ||
      fields.some(key => params[key] !== undefined && (typeof params[key] !== 'string' || !params[key].length)) ||
      params.windowIndex !== undefined || params.restoreWindow === true || params.noScreenshot === false ||
      (params.windowId !== undefined && (!Number.isSafeInteger(params.windowId) || params.windowId <= 0))) {
    throw queryError('invalid_query', 'Use nonempty exact selectors and a positive window ID; window indexes, screenshots and focus changes are not supported.');
  }
  if (params.accessibility === 'msaa' && params.automationId !== undefined) {
    throw queryError('unsupported_selector', 'MSAA does not provide AutomationId; use its native role and name.');
  }
}

export async function observeQuery(provider, params) {
  validateQuery(params);
  const target = { ...params, noScreenshot: true, restoreWindow: false };
  if (target.windowId === undefined) {
    const { windows } = await provider.listWindows({ app: target.app });
    if (windows.length !== 1) throw queryError('ambiguous_window', 'Query requires exactly one window or an explicit window ID.');
    target.windowId = windows[0].id;
  }
  if (!Number.isSafeInteger(target.windowId) || target.windowId <= 0) throw queryError('invalid_observation', 'A native window ID is required.');
  const result = await provider.snapshot(target);
  if (result.snapshot?.window?.id !== target.windowId) throw queryError('invalid_observation', 'The observation does not belong to the pinned window.');
  const raw = [...provider.snapshots.values()].find(snapshot => snapshot.windowId === result.snapshot.window.id);
  if (!Array.isArray(raw?.elements)) throw queryError('invalid_observation', 'Native element metadata is unavailable.');
  const matches = (raw?.elements ?? []).map(element => {
    const marker = element.isSensitive ?? element.sensitive ?? element.isPassword;
    const sensitive = typeof marker === 'boolean' ? marker : element.value === '[redacted]' || element.name === '[redacted]';
    return { index: element.index, role: element.controlType ?? null,
      roleLabel: element.localizedControlType ?? null, name: sensitive ? '[redacted]' : element.name ?? null,
      automationId: sensitive || params.accessibility === 'msaa' ? null : element.automationId || null,
      value: sensitive || element.valueAvailable !== true ? null : element.value ?? null,
      valueTruncated: element.valueTruncated === true, sensitive, identity: element.runtimeId ?? null,
      actions: Array.isArray(element.actions) ? element.actions : [],
      isEnabled: typeof element.isEnabled === 'boolean' ? element.isEnabled : null,
      isKeyboardFocusable: typeof element.isKeyboardFocusable === 'boolean' ? element.isKeyboardFocusable : null,
      hasKeyboardFocus: typeof element.hasKeyboardFocus === 'boolean' ? element.hasKeyboardFocus : null,
      expansionState: element.expansionState ?? null,
      isSelected: typeof element.isSelected === 'boolean' ? element.isSelected : null,
      actionabilityReasons: [...new Set([
        ...(element.isEnabled === false ? ['disabled'] : []),
        ...(!element.actions?.length ? ['no_accessible_action'] : []),
        ...(element.actionabilityReason ? [element.actionabilityReason] : [])
      ])] };
  }).filter(element =>
    (params.role === undefined || element.role === params.role) &&
    (params.name === undefined || element.name === params.name) &&
    (params.automationId === undefined || element.automationId === params.automationId)
  );
  const { treeText, ...snapshot } = result.snapshot;
  snapshot.observationErrors = observationErrors(raw.observationErrors);
  const reasons = incompleteReasons(raw);
  const complete = reasons.length === 0;
  return { snapshot, query: { matchCount: matches.length, unique: complete && matches.length === 1,
    complete, incompleteReasons: reasons, matches } };
}
