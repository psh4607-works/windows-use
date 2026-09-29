import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { validateQuery, queryError } from './query.mjs';
import { incompleteReasons } from './observation-completeness.mjs';

// This orchestrator runs in the caller, never in the serialized desktop broker.
export async function waitFor(request, { read, now = () => performance.now(), sleep = delay, signal } = {}) {
  const params = { ...request.params };
  const condition = params.condition ?? 'element';
  validateQuery(params, { allowEmpty: condition === 'window', wait: true });
  const started = now();
  const timeoutMs = params.timeoutMs ?? 10000, pollMs = params.pollMs ?? 250;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 ||
      !Number.isInteger(pollMs) || pollMs < 50 || pollMs > 10000 ||
      !['element', 'window', 'value', 'changed'].includes(condition) ||
      (condition === 'window' && ['role', 'name', 'automationId'].some(key => params[key] !== undefined)) ||
      (params.windowTitle !== undefined && (typeof params.windowTitle !== 'string' || !params.windowTitle.length)) ||
      (condition === 'value' ? typeof params.value !== 'string' : params.value !== undefined) ||
      (params.accessibility !== undefined && !['uia', 'msaa'].includes(params.accessibility)) ||
      typeof params.app !== 'string' || !params.app.trim() ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.session ?? '')) {
    throw queryError('invalid_wait', 'Use a valid app/session, condition, timeout (1-600000 ms), poll interval (50-10000 ms), and a value only for the value condition.');
  }
  const deadline = started + timeoutMs;
  const timeoutError = () => queryError('wait_timeout', 'UI condition was not satisfied before the deadline.');
  const controller = new AbortController();
  const cancel = () => controller.abort(queryError('wait_cancelled', 'UI wait was cancelled.'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (now() >= deadline) throw timeoutError();
  };
  const bounded = async operation => {
    check();
    let onAbort;
    try {
      return await Promise.race([operation(), new Promise((resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      })]);
    } catch (error) {
      // Abortable reads/sleeps can reject before our race listener. Preserve
      // the public wait reason regardless of abort listener/microtask order.
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally { controller.signal.removeEventListener('abort', onAbort); }
  };
  let accessEpoch;
  const unsupportedWait = () => queryError('unsupported_wait', 'Update the desktop server to support stamped read access epochs.');
  const observe = async req => {
    check();
    let result;
    try {
      result = await bounded(() => read({ ...req, trackAccess: true, accessEpoch },
        { timeoutMs: Math.max(1, Math.ceil(deadline - now())), signal: controller.signal }));
    } catch (error) {
      // The broker converts app_not_found to a stamped empty list on EVERY
      // tracked windows read. A real app disappearance reaches window_closed
      // below; this raw error means the current read path lacks that contract,
      // even if an earlier response came from a supporting server/adapter.
      if (req.command === 'windows' && error.code === 'app_not_found') throw unsupportedWait();
      throw error;
    }
    check();
    if (typeof result.accessEpoch !== 'string') throw unsupportedWait();
    if (accessEpoch !== undefined && accessEpoch !== result.accessEpoch) {
      throw queryError('desktop_paused', 'Desktop access changed during the wait; start a new wait after resuming.');
    }
    accessEpoch ??= result.accessEpoch;
    return result;
  };
  let windowId = params.windowId, pinned = false, polls = 0, baseline;
  try {
    while (true) {
      check(); polls++;
      const { windows } = await observe({ command: 'windows', params: { app: params.app } });
      const candidates = windows.filter(window => (windowId === undefined || window.id === windowId) &&
        (pinned || params.windowTitle === undefined || window.title === params.windowTitle));
      if (pinned && !candidates.length) throw queryError('window_closed', 'The pinned window closed; start a new wait for another window.');
      if (candidates.length > 1) throw queryError('ambiguous_window', 'Multiple windows match; specify a window ID or exact title.');
      if (candidates.length === 1) {
        windowId = candidates[0].id; pinned = true;
        const result = await observe({ command: condition === 'window' ? 'snapshot' : 'query', session: request.session,
          params: { app: params.app, accessibility: params.accessibility, role: params.role, name: params.name,
            automationId: params.automationId, windowId, noScreenshot: true } });
        if (!Number.isSafeInteger(windowId) || windowId <= 0 || result.snapshot?.window?.id !== windowId) {
          throw queryError('invalid_observation', 'The observation does not belong to the pinned window.');
        }
        const reasons = incompleteReasons(result.snapshot);
        if (reasons.length || (condition !== 'window' && !result.query.complete)) {
          const summary = reasons.map(reason => `${reason.code} (${reason.count})`).join(', ');
          const message = condition === 'window'
            ? 'The window was found, but its accessibility observation is incomplete; no successful observation is returned.'
            : 'The accessibility tree is incomplete; uniqueness cannot be established.';
          throw queryError('incomplete_observation', `${message}${summary ? ` Reasons: ${summary}.` : ''}`);
        }
        if (condition !== 'window') {
          if (result.query.matchCount > 1) throw queryError('ambiguous_selector', 'Multiple elements match; narrow the selectors.');
        }
        let satisfied = condition === 'window' || result.query.unique;
        if (result.query?.unique && ['value', 'changed'].includes(condition)) {
          const element = result.query.matches[0];
          if (element.sensitive) throw queryError('sensitive_value', 'Value conditions are unavailable for sensitive controls.');
          if (typeof element.value !== 'string' || element.valueTruncated) throw queryError('unsupported_value', 'This control does not expose a complete readable value.');
          if (condition === 'value') satisfied = element.value === params.value;
          else {
            if (!Array.isArray(element.identity) || !element.identity.length) throw queryError('unsupported_identity', 'A native element identity is required for change detection.');
            if (baseline && JSON.stringify(baseline.identity) !== JSON.stringify(element.identity)) {
              throw queryError('element_changed', 'The matching native element was replaced; start a new wait.');
            }
            satisfied = baseline !== undefined && element.value !== baseline.value;
            baseline ??= element;
          }
        }
        if (satisfied) {
          const { treeText, ...snapshot } = result.snapshot;
          return { snapshot, ...(result.query ? { query: result.query } : {}), session: result.session,
            wait: { condition, polls, elapsedMs: now() - started } };
        }
      }
      await bounded(() => sleep(Math.min(pollMs, deadline - now()), undefined, { signal: controller.signal }));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
