// vendor/orca/src/main/computer/desktop-script-provider-client.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";

// vendor/orca/src/main/computer/runtime-client-error.ts
var RuntimeClientError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "RuntimeClientError";
    this.code = code;
  }
};

// vendor/orca/src/main/computer/desktop-script-provider-params.ts
function stringParam(params, key) {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeClientError("invalid_argument", `missing ${key}`);
  }
  return value;
}
function optionalStringParam(params, key) {
  const value = params[key];
  return typeof value === "string" ? value : void 0;
}
function optionalNumberParam(params, key) {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}

// vendor/orca/src/main/computer/desktop-script-observation-safety.ts
var REDACTED = "[redacted]";
function sensitiveElement(element) {
  return element?.isSensitive === true || element?.isSensitive !== false && element?.value === REDACTED;
}
function refreshedElement(snapshot, target) {
  if (!target) return void 0;
  const hasRuntimeId = Array.isArray(target.runtimeId) && target.runtimeId.length > 0;
  const matches = (snapshot?.elements ?? []).filter((element) => {
    if (hasRuntimeId) return JSON.stringify(element.runtimeId) === JSON.stringify(target.runtimeId);
    if (target.automationId) return element.automationId === target.automationId;
    return false;
  });
  return matches.length === 1 ? matches[0] : void 0;
}
function sensitiveAction(snapshot, target) {
  const refreshed = refreshedElement(snapshot, target);
  return sensitiveElement(target) || sensitiveElement(refreshed) || !refreshed && (snapshot?.elements ?? []).some(sensitiveElement);
}
function redactStrings(value, secrets) {
  if (typeof value === "string") {
    return secrets.filter((secret) => secret && secret !== REDACTED).sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join(REDACTED), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, secrets)]));
  }
  return value;
}
function sanitizeResponse(response, secrets = []) {
  const sensitive = (response.snapshot?.elements ?? []).filter(sensitiveElement);
  const clean = redactStrings(response, [...secrets, ...sensitive.map((element) => element.value ?? "")]);
  if (clean.snapshot) {
    clean.snapshot.elements = clean.snapshot.elements?.map((element) => sensitiveElement(element) ? { ...element, isSensitive: true, value: REDACTED } : element);
    if (sensitive.length || secrets.length) {
      clean.snapshot.selectedText = null;
      clean.snapshot.focusedSummary = null;
      clean.snapshot.screenshotPngBase64 = null;
      clean.snapshot.screenshotError = { message: "Screenshot withheld for sensitive observation" };
    }
  }
  return clean;
}

// vendor/orca/src/main/computer/desktop-script-action.ts
function bridgeTool(method) {
  return {
    click: "click",
    performSecondaryAction: "perform_secondary_action",
    scroll: "scroll",
    drag: "drag",
    typeText: "type_text",
    pressKey: "press_key",
    hotkey: "hotkey",
    pasteText: "paste_text",
    setValue: "set_value"
  }[method];
}
function actionCapabilityKey(method) {
  const keys = {
    click: "click",
    performSecondaryAction: "performAction",
    scroll: "scroll",
    drag: "drag",
    typeText: "typeText",
    pressKey: "pressKey",
    hotkey: "hotkey",
    pasteText: "pasteText",
    setValue: "setValue"
  };
  return keys[method];
}
function desktopActionMetadata(method, targetWindowId, targetWindowIndex) {
  const path = method === "pasteText" ? "clipboard" : method === "setValue" || method === "performSecondaryAction" ? "accessibility" : "synthetic";
  return {
    path,
    actionName: method === "hotkey" ? "hotkey" : method === "pasteText" ? "paste" : method === "setValue" ? "setValue" : method === "performSecondaryAction" ? "performSecondaryAction" : method === "typeText" ? "typeText" : method === "pressKey" ? "pressKey" : null,
    fallbackReason: null,
    targetWindowId,
    targetWindowIndex,
    verification: method === "hotkey" || method === "pasteText" ? {
      state: "unverified",
      reason: method === "pasteText" ? "clipboard_paste" : "synthetic_input"
    } : void 0
  };
}
function desktopActionWindowTarget(explicitWindowId, explicitWindowIndex, current) {
  if (explicitWindowId !== void 0) {
    if (current?.windowId !== explicitWindowId) {
      throw new RuntimeClientError("window_not_found", "Take a fresh snapshot of this window handle before acting");
    }
    return { windowId: explicitWindowId };
  }
  if (explicitWindowIndex !== void 0) {
    if (current?.windowId !== null && current?.windowId !== void 0) {
      return { windowId: current.windowId };
    }
    throw new RuntimeClientError("window_not_found", "Take a fresh snapshot of this window index before acting");
  }
  if (current?.windowId !== null && current?.windowId !== void 0) {
    return { windowId: current.windowId };
  }
  if (current?.windowIndex !== null && current?.windowIndex !== void 0) {
    throw new RuntimeClientError("window_not_found", "Take a fresh snapshot with a window handle before acting");
  }
  throw new RuntimeClientError("window_not_found", "Take a fresh snapshot with a window handle before acting");
}
function desktopActionMetadataFromResponse(action, method, targetWindowId, targetWindowIndex) {
  return action ? {
    ...action,
    targetWindowId: action.targetWindowId ?? targetWindowId,
    targetWindowIndex: action.targetWindowIndex ?? targetWindowIndex
  } : desktopActionMetadata(method, targetWindowId, targetWindowIndex);
}
function verifyDesktopAction(action, method, params, rawAction, snapshot, targetElement, observedWindowId) {
  if (isWindowChangedAction(action) || snapshot?.windowId !== void 0 && snapshot.windowId !== observedWindowId) {
    return { ...action, verification: { state: "unverified", reason: "window_changed" } };
  }
  if (method === "setValue" && sensitiveAction(snapshot, targetElement)) {
    return { ...action, verification: { state: "unverified", reason: "sensitive_value", expected: REDACTED, actualPreview: REDACTED } };
  }
  if (rawAction?.verification && (method !== "setValue" || rawAction.verification.state === "unverified")) {
    return action;
  }
  if (method === "typeText" || method === "pressKey" || method === "hotkey") {
    return {
      ...action,
      verification: { state: "unverified", reason: "synthetic_input" }
    };
  }
  if (method === "pasteText") {
    return {
      ...action,
      verification: { state: "unverified", reason: "clipboard_paste" }
    };
  }
  if (method !== "setValue") {
    return action;
  }
  const expected = optionalStringParam(params, "value");
  const elementIndex = optionalNumberParam(params, "elementIndex");
  if (expected === void 0 || elementIndex === void 0) {
    return action;
  }
  const actual = refreshedElement(snapshot, targetElement)?.value;
  if (actual === expected) {
    return {
      ...action,
      verification: { state: "verified", property: "value", expected, actualPreview: actual }
    };
  }
  return {
    ...action,
    verification: {
      state: "unverified",
      reason: actual === void 0 ? "provider_unavailable" : "value_mismatch",
      expected,
      actualPreview: actual ?? null
    }
  };
}
function cacheParamsForActionResult(params, action) {
  if (!isWindowChangedAction(action)) {
    return params;
  }
  const { windowId: _windowId, windowIndex: _windowIndex, ...withoutStaleWindowTarget } = params;
  return withoutStaleWindowTarget;
}
function isWindowChangedAction(action) {
  return action.verification?.state === "unverified" && action.verification.reason === "window_changed";
}
function elementParam(snapshot, index) {
  if (index === void 0) {
    return void 0;
  }
  const element = snapshot?.elements?.find((candidate) => candidate.index === index);
  if (!element) {
    throw new RuntimeClientError(
      "element_not_found",
      `element ${index} is not in the current cached snapshot; run get-app-state again and use a fresh element index`
    );
  }
  return element;
}

// vendor/orca/src/shared/computer-use-key-spec.ts
var HOTKEY_MODIFIERS = /* @__PURE__ */ new Set([
  "alt",
  "cmd",
  "cmdorctrl",
  "command",
  "commandorcontrol",
  "control",
  "ctrl",
  "meta",
  "option",
  "shift",
  "super",
  "win"
]);
var HOTKEY_HINT = "Hotkey requires a modifier and one key, e.g. CmdOrCtrl+A. Use press-key for a single key.";
var PRESS_KEY_HINT = "Press-key accepts one key only, e.g. Return, Escape, Tab, or +. Use hotkey for modifier combinations.";
var CLICK_MODIFIERS_HINT = "Click modifiers accept modifier keys only, e.g. CmdOrCtrl or CmdOrCtrl+Shift.";
function computerUseHotkeyValidationMessage(key) {
  const parts = key.split("+").map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    return HOTKEY_HINT;
  }
  let keyPartCount = 0;
  for (const part of parts) {
    if (!HOTKEY_MODIFIERS.has(normalizeHotkeyPart(part))) {
      keyPartCount += 1;
    }
  }
  if (keyPartCount !== 1) {
    return HOTKEY_HINT;
  }
  return null;
}
function computerUsePressKeyValidationMessage(key) {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return PRESS_KEY_HINT;
  }
  if (trimmed !== "+" && trimmed.includes("+")) {
    return PRESS_KEY_HINT;
  }
  return null;
}
function computerUseClickModifiersValidationMessage(modifiers) {
  const parts = modifiers.split("+").map((part) => part.trim());
  if (parts.length === 0 || parts.length > 4 || parts.some((part) => part.length === 0 || !HOTKEY_MODIFIERS.has(part.toLowerCase()))) {
    return CLICK_MODIFIERS_HINT;
  }
  return null;
}
function normalizeHotkeyPart(part) {
  return part.toLowerCase().replace(/[\s_-]/g, "");
}

// vendor/orca/src/shared/event-loop-yield.ts
var pendingRendererYields = /* @__PURE__ */ new Map();
var nextRendererYieldId = 0;
var rendererYieldChannel = null;
function isVitestEnvironment() {
  return typeof process !== "undefined" && process.env?.VITEST === "true";
}
function getRendererYieldChannel() {
  if (!rendererYieldChannel) {
    rendererYieldChannel = new globalThis.MessageChannel();
    rendererYieldChannel.port1.onmessage = (event) => {
      const yieldId = event.data;
      const resolve2 = typeof yieldId === "number" ? pendingRendererYields.get(yieldId) : void 0;
      if (!resolve2) {
        return;
      }
      pendingRendererYields.delete(yieldId);
      resolve2();
    };
  }
  return rendererYieldChannel;
}
function yieldToEventLoop() {
  return new Promise((resolve2) => {
    if (isVitestEnvironment()) {
      globalThis.setTimeout(resolve2, 0);
      return;
    }
    const setImmediate = globalThis.setImmediate;
    if (typeof window === "undefined" && setImmediate) {
      setImmediate(resolve2);
      return;
    }
    if (typeof globalThis.MessageChannel === "function") {
      const yieldId = nextRendererYieldId;
      nextRendererYieldId += 1;
      pendingRendererYields.set(yieldId, resolve2);
      getRendererYieldChannel().port2.postMessage(yieldId);
      return;
    }
    globalThis.setTimeout(resolve2, 0);
  });
}

// vendor/orca/src/shared/utf8-byte-limits.ts
function readUtf8CodePointAt(text, index) {
  const leadUnit = text.charCodeAt(index);
  if (leadUnit < 55296 || leadUnit > 56319 || index + 1 >= text.length) {
    return leadUnit;
  }
  const trailUnit = text.charCodeAt(index + 1);
  if (trailUnit < 56320 || trailUnit > 57343) {
    return leadUnit;
  }
  return (leadUnit - 55296) * 1024 + (trailUnit - 56320) + 65536;
}
function measureUtf8ByteLength(text, options = {}) {
  const stopAfterBytes = options.stopAfterBytes;
  let byteLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index);
    byteLength += getUtf8ByteLengthForCodePoint(codePoint);
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true };
    }
    if (codePoint > 65535) {
      index += 1;
    }
  }
  return { byteLength, exceededLimit: false };
}
function getUtf8ByteLengthForCodePoint(codePoint) {
  if (codePoint <= 127) {
    return 1;
  }
  if (codePoint <= 2047) {
    return 2;
  }
  if (codePoint <= 65535) {
    return 3;
  }
  return 4;
}

// vendor/orca/src/shared/clipboard-text.ts
var CLIPBOARD_TEXT_READ_MAX_BYTES = 16 * 1024 * 1024;
var CLIPBOARD_TEXT_WRITE_MAX_BYTES = 16 * 1024 * 1024;
var CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR = "Clipboard text is too large to copy safely.";
var CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS = 256 * 1024;
function measureClipboardTextByteLength(text, options = {}) {
  return measureUtf8ByteLength(text, options);
}
async function measureClipboardTextByteLengthWithYield(text, options = {}) {
  const stopAfterBytes = options.stopAfterBytes;
  const yieldAfterCodeUnits = Math.max(
    1,
    options.yieldAfterCodeUnits ?? CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS
  );
  const yieldBetweenBatches = options.yieldToEventLoop ?? yieldToEventLoop;
  let nextYieldAt = yieldAfterCodeUnits;
  let byteLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index);
    byteLength += getUtf8ByteLengthForCodePoint(codePoint);
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true };
    }
    if (codePoint > 65535) {
      index += 1;
    }
    if (index >= nextYieldAt) {
      await yieldBetweenBatches();
      nextYieldAt = index + yieldAfterCodeUnits;
    }
  }
  return { byteLength, exceededLimit: false };
}
function isClipboardTextByteLengthOverLimit(text, maxBytes) {
  return text.length > maxBytes || measureClipboardTextByteLength(text, { stopAfterBytes: maxBytes }).exceededLimit;
}
async function isClipboardTextByteLengthOverLimitWithYield(text, maxBytes, options = {}) {
  if (text.length > maxBytes) {
    return true;
  }
  return (await measureClipboardTextByteLengthWithYield(text, {
    stopAfterBytes: maxBytes,
    yieldAfterCodeUnits: options.yieldAfterCodeUnits,
    yieldToEventLoop: options.yieldToEventLoop
  })).exceededLimit;
}
function getClipboardTextWriteMaxBytes(options, fallback = CLIPBOARD_TEXT_WRITE_MAX_BYTES) {
  return Number.isFinite(options?.maxBytes) && (options?.maxBytes ?? 0) > 0 ? Math.floor(options?.maxBytes ?? fallback) : fallback;
}
function assertClipboardTextWriteWithinLimit(text, options) {
  const maxBytes = getClipboardTextWriteMaxBytes(options);
  if (isClipboardTextByteLengthOverLimit(text, maxBytes)) {
    throw new Error(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
  }
  return text;
}
async function assertClipboardTextWriteWithinLimitWithYield(text, options) {
  const maxBytes = getClipboardTextWriteMaxBytes(options);
  if (await isClipboardTextByteLengthOverLimitWithYield(text, maxBytes)) {
    throw new Error(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
  }
  return text;
}
function isClipboardTextWriteTooLargeError(error) {
  return error instanceof Error && error.message.includes(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
}

// vendor/orca/src/main/computer/computer-clipboard-paste-validation.ts
function validateComputerClipboardPasteText(text) {
  try {
    assertClipboardTextWriteWithinLimit(text);
  } catch (error) {
    if (isClipboardTextWriteTooLargeError(error)) {
      throw new RuntimeClientError("invalid_argument", CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
    }
    throw error;
  }
}
async function validateComputerClipboardPasteTextWithYield(text) {
  try {
    await assertClipboardTextWriteWithinLimitWithYield(text);
  } catch (error) {
    if (isClipboardTextWriteTooLargeError(error)) {
      throw new RuntimeClientError("invalid_argument", CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
    }
    throw error;
  }
}
function validateComputerClipboardPasteTextWithBoundedYield(text) {
  if (text.length <= CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS) {
    validateComputerClipboardPasteText(text);
    return;
  }
  return validateComputerClipboardPasteTextWithYield(text);
}

// vendor/orca/src/main/computer/computer-provider-action-validation.ts
async function validateComputerProviderActionParams(method, params) {
  const app = requireNonEmptyString(params, "app");
  validateWindowTarget(params);
  switch (method) {
    case "click":
      validateElementOrCoordinates("Click", params);
      validatePositiveInteger(params, "clickCount");
      validateMouseButton(params);
      validateClickModifiers(params);
      return app;
    case "performSecondaryAction":
      requireNonNegativeInteger(params, "elementIndex");
      requireNonEmptyString(params, "action");
      return app;
    case "scroll":
      validateElementOrCoordinates("Scroll", params);
      validateScrollDirection(params);
      validatePositiveNumber(params, "pages");
      return app;
    case "drag":
      validateDragTarget(params);
      return app;
    case "typeText":
      requireNonEmptyString(params, "text");
      return app;
    case "pasteText":
      await validatePasteText(params);
      return app;
    case "pressKey":
      validatePressKey(params);
      return app;
    case "hotkey":
      validateHotkey(params);
      return app;
    case "setValue":
      requireNonNegativeInteger(params, "elementIndex");
      requireStringAllowingEmpty(params, "value");
      return app;
  }
}
function validateWindowTarget(params) {
  if (params.windowId !== void 0 && params.windowIndex !== void 0) {
    throw new RuntimeClientError(
      "invalid_argument",
      "Window targeting accepts either windowId or windowIndex, not both"
    );
  }
}
function validateElementOrCoordinates(actionName, params) {
  const hasElement = params.elementIndex !== void 0;
  const hasX = params.x !== void 0;
  const hasY = params.y !== void 0;
  if (!hasElement && !(hasX && hasY)) {
    throw new RuntimeClientError(
      "invalid_argument",
      `${actionName} requires elementIndex or both x and y`
    );
  }
  if (hasX !== hasY) {
    throw new RuntimeClientError(
      "invalid_argument",
      `${actionName} coordinates require both x and y`
    );
  }
  if (hasElement && (hasX || hasY)) {
    throw new RuntimeClientError(
      "invalid_argument",
      `${actionName} accepts either elementIndex or coordinate fields, not both`
    );
  }
  if (params.elementIndex !== void 0) {
    requireNonNegativeInteger(params, "elementIndex");
  }
  requireFiniteNumber(params, "x");
  requireFiniteNumber(params, "y");
}
function validateDragTarget(params) {
  const hasElementPair = params.fromElementIndex !== void 0 && params.toElementIndex !== void 0;
  const hasPartialElementPair = params.fromElementIndex !== void 0 || params.toElementIndex !== void 0;
  const coordinates = [params.fromX, params.fromY, params.toX, params.toY];
  const hasCoordinatePair = coordinates.every((coordinate) => coordinate !== void 0);
  const hasPartialCoordinatePair = coordinates.some((coordinate) => coordinate !== void 0);
  if (hasElementPair && hasCoordinatePair) {
    throw new RuntimeClientError(
      "invalid_argument",
      "Drag accepts either element indexes or coordinate fields, not both"
    );
  }
  if (hasPartialElementPair && !hasElementPair) {
    throw new RuntimeClientError(
      "invalid_argument",
      "Drag element targeting requires both fromElementIndex and toElementIndex"
    );
  }
  if (hasPartialCoordinatePair && !hasCoordinatePair) {
    throw new RuntimeClientError(
      "invalid_argument",
      "Drag coordinates require fromX, fromY, toX, and toY"
    );
  }
  if (!hasElementPair && !hasCoordinatePair) {
    throw new RuntimeClientError(
      "invalid_argument",
      "Drag requires fromElementIndex and toElementIndex, or all coordinate fields"
    );
  }
  if (hasElementPair) {
    requireNonNegativeInteger(params, "fromElementIndex");
    requireNonNegativeInteger(params, "toElementIndex");
  }
  if (hasCoordinatePair) {
    requireFiniteNumber(params, "fromX");
    requireFiniteNumber(params, "fromY");
    requireFiniteNumber(params, "toX");
    requireFiniteNumber(params, "toY");
  }
}
function validateMouseButton(params) {
  const mouseButton = params.mouseButton;
  if (mouseButton !== void 0 && mouseButton !== "left" && mouseButton !== "right" && mouseButton !== "middle") {
    throw new RuntimeClientError(
      "invalid_argument",
      "Unsupported mouseButton; expected left, right, or middle"
    );
  }
}
function validateClickModifiers(params) {
  if (params.modifiers === void 0) {
    return;
  }
  const modifiers = requireNonEmptyString(params, "modifiers");
  const message = computerUseClickModifiersValidationMessage(modifiers);
  if (message) {
    throw new RuntimeClientError("invalid_argument", message);
  }
}
function validateScrollDirection(params) {
  const direction = requireNonEmptyString(params, "direction");
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
    throw new RuntimeClientError(
      "invalid_argument",
      "Unsupported direction; expected up, down, left, or right"
    );
  }
}
function validatePressKey(params) {
  const key = requireNonEmptyString(params, "key");
  const message = computerUsePressKeyValidationMessage(key);
  if (message) {
    throw new RuntimeClientError("invalid_argument", message);
  }
}
function validateHotkey(params) {
  const key = requireNonEmptyString(params, "key");
  const message = computerUseHotkeyValidationMessage(key);
  if (message) {
    throw new RuntimeClientError("invalid_argument", message);
  }
}
function validatePasteText(params) {
  const text = requireNonEmptyString(params, "text");
  return validateComputerClipboardPasteTextWithBoundedYield(text);
}
function requireStringAllowingEmpty(params, key) {
  const value = params[key];
  if (typeof value !== "string") {
    throw new RuntimeClientError("invalid_argument", `Missing ${key}`);
  }
  return value;
}
function requireNonEmptyString(params, key) {
  const value = requireStringAllowingEmpty(params, key);
  if (value.length === 0) {
    throw new RuntimeClientError("invalid_argument", `Missing ${key}`);
  }
  return value;
}
function requireNonNegativeInteger(params, key) {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RuntimeClientError("invalid_argument", `${key} must be a non-negative integer`);
  }
  return value;
}
function requireFiniteNumber(params, key) {
  const value = params[key];
  if (value === void 0) {
    return void 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuntimeClientError("invalid_argument", `${key} must be a finite number`);
  }
  return value;
}
function validatePositiveInteger(params, key) {
  const value = params[key];
  if (value === void 0) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError("invalid_argument", `${key} must be a positive integer`);
  }
}
function validatePositiveNumber(params, key) {
  const value = params[key];
  if (value === void 0) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RuntimeClientError("invalid_argument", `${key} must be a positive number`);
  }
}

// vendor/orca/src/main/computer/desktop-script-provider-bridge.ts
import { execFile } from "node:child_process";
var REQUEST_TIMEOUT_MS = 3e4;
var FORCE_KILL_GRACE_MS = 1e3;
function execBridge(platform, scriptPath, operationPath, extraEnv = {}) {
  const command = platform === "windows" ? "powershell.exe" : "python3";
  const args = platform === "windows" ? [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    operationPath
  ] : [scriptPath, operationPath];
  return new Promise((resolve2, reject) => {
    let child = null;
    let settled = false;
    let forceKillTimer = null;
    const clearForceKillTimer = () => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };
    const finish = (error, result, options = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (!options.keepForceKillTimer) {
        clearForceKillTimer();
      }
      if (error) {
        reject(error);
        return;
      }
      resolve2(result ?? { stdout: "", stderr: "" });
    };
    const timeout = setTimeout(() => {
      child?.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child?.kill("SIGKILL");
        forceKillTimer = null;
      }, FORCE_KILL_GRACE_MS);
      finish(
        new RuntimeClientError(
          "action_timeout",
          `desktop provider timed out after ${REQUEST_TIMEOUT_MS}ms`
        ),
        void 0,
        { keepForceKillTimer: true }
      );
    }, REQUEST_TIMEOUT_MS);
    try {
      child = execFile(
        command,
        args,
        {
          env: { ...process.env, ...extraEnv },
          maxBuffer: 20 * 1024 * 1024,
          timeout: REQUEST_TIMEOUT_MS,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            const message = stderr.trim() || stdout.trim() || error.message;
            finish(
              error.killed ? new RuntimeClientError("action_timeout", message) : mapBridgeError(message)
            );
            return;
          }
          finish(null, { stdout, stderr });
        }
      );
      child?.once("exit", clearForceKillTimer);
    } catch (error) {
      finish(mapBridgeError(error instanceof Error ? error.message : String(error)));
    }
  });
}
function mapBridgeError(message) {
  const text = message.trim() || "desktop provider failed";
  if (/appNotFound|app not found/i.test(text)) {
    return new RuntimeClientError("app_not_found", text);
  }
  if (/appBlocked|app blocked/i.test(text)) {
    return new RuntimeClientError("app_blocked", text);
  }
  if (/unsupported capability|hotkey.*require|paste_text requires|modified clicks require xdotool|GDK is required for non-character key synthesis/i.test(
    text
  )) {
    return new RuntimeClientError("unsupported_capability", text);
  }
  if (/unsupported mouse button|unsupported scroll direction|unsupported (?:key|modifier)|windowId is not supported|must be a positive|must be a finite number|\b(?:x|y|from_x|from_y|to_x|to_y|pages|click_count|text|key|direction) is required\b/i.test(
    text
  )) {
    return new RuntimeClientError("invalid_argument", text);
  }
  if (/ModuleNotFoundError: No module named 'gi'|PyGObject|python3-gi/i.test(text)) {
    return new RuntimeClientError(
      "unsupported_capability",
      "Linux Computer Use requires python3-gi and AT-SPI packages. Install python3-gi gir1.2-atspi-2.0 at-spi2-core, then retry."
    );
  }
  if (/not a valid secondary action|action.*not supported/i.test(text)) {
    return new RuntimeClientError("action_not_supported", text);
  }
  if (/value is not settable|not settable/i.test(text)) {
    return new RuntimeClientError("value_not_settable", text);
  }
  if (/stale element|fresh element index/i.test(text)) {
    return new RuntimeClientError("element_not_found", text);
  }
  if (/windowStale|window stale/i.test(text)) {
    return new RuntimeClientError("window_stale", text);
  }
  if (/window_not_focused|keyboard input requires.*window.*focused|target window.*focused/i.test(text)) {
    return new RuntimeClientError("window_not_focused", text);
  }
  if (/screenshot_failed|screenshot.*failed|screen recording|payload cap/i.test(text)) {
    return new RuntimeClientError("screenshot_failed", text);
  }
  if (/window_not_found|No top-level(?: AT-SPI| UI Automation)? window|has no (?:on-screen |accessibility )?window|could not match accessibility window|unknown window(?:_index| id)?/i.test(
    text
  )) {
    return new RuntimeClientError("window_not_found", text);
  }
  if (/permission|desktop session|DBUS|XDG_RUNTIME_DIR|AT-SPI/i.test(text)) {
    return new RuntimeClientError("permission_denied", text);
  }
  if (/element_not_found|stale element|fresh element index|unknown element_index|element \d+ is stale|element indexes require|element \d+ changed since|element \d+ is not in the current cached snapshot/i.test(
    text
  )) {
    return new RuntimeClientError("element_not_found", text);
  }
  return new RuntimeClientError("accessibility_error", text);
}

// vendor/orca/src/main/computer/desktop-script-provider-paths.ts
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
function desktopScriptPlatform() {
  if (process.platform === "linux") {
    return "linux";
  }
  if (process.platform === "win32") {
    return "windows";
  }
  return null;
}
function resolveDesktopScriptProviderPath(platform = desktopScriptPlatform()) {
  const override = process.env.ORCA_COMPUTER_DESKTOP_SCRIPT_PROVIDER_PATH;
  if (override && existsSync(override)) {
    return override;
  }
  if (!platform) {
    return null;
  }
  const filename = platform === "windows" ? "runtime.ps1" : "runtime.py";
  const directory = platform === "windows" ? "computer-use-windows" : "computer-use-linux";
  const sourceDirectory = platform === "windows" ? "native/computer-use-windows" : "native/computer-use-linux";
  const packaged = [join(process.resourcesPath ?? "", directory, filename)];
  const dev = [
    join(process.cwd(), sourceDirectory, filename),
    resolve(__dirname, "../../", sourceDirectory, filename)
  ];
  const candidates = process.resourcesPath ? [...packaged, ...dev] : dev;
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

// vendor/orca/src/main/computer/desktop-script-snapshot-cache.ts
var MAX_CACHED_DESKTOP_SNAPSHOTS = 32;
var MAX_CACHED_DESKTOP_SNAPSHOT_AGE_MS = 2 * 60 * 1e3;
function snapshotCacheKeys(query, snapshot, params) {
  const namespace = snapshotNamespace(params);
  const pidKeys = snapshotPidKeys(snapshot.app.pid);
  const keys = /* @__PURE__ */ new Set();
  if (snapshot.windowId !== null && snapshot.windowId !== void 0) {
    keys.add(canonicalWindowIdKey(snapshot.windowId));
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIdKey(snapshot.windowId)));
  }
  const resolvedWindowIndex = optionalNumberParam(params, "windowIndex") ?? snapshot.windowIndex;
  if (resolvedWindowIndex !== null && resolvedWindowIndex !== void 0) {
    keys.add(canonicalWindowIndexKey(resolvedWindowIndex));
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIndexKey(resolvedWindowIndex)));
  }
  for (const key of [
    query,
    snapshot.app.name,
    snapshot.app.bundleId,
    snapshot.app.bundleIdentifier,
    ...pidKeys,
    ...snapshotKeysForWindow(query, snapshot),
    ...snapshotKeysForWindow(snapshot.app.name, snapshot),
    ...snapshot.app.bundleId ? snapshotKeysForWindow(snapshot.app.bundleId, snapshot) : [],
    ...snapshot.app.bundleIdentifier ? snapshotKeysForWindow(snapshot.app.bundleIdentifier, snapshot) : [],
    ...pidKeys.flatMap((pidKey) => snapshotKeysForWindow(pidKey, snapshot)),
    ...snapshotKeysForWindowIndex(query, snapshot, params),
    ...snapshotKeysForWindowIndex(snapshot.app.name, snapshot, params),
    ...snapshot.app.bundleId ? snapshotKeysForWindowIndex(snapshot.app.bundleId, snapshot, params) : [],
    ...snapshot.app.bundleIdentifier ? snapshotKeysForWindowIndex(snapshot.app.bundleIdentifier, snapshot, params) : [],
    ...pidKeys.flatMap((pidKey) => snapshotKeysForWindowIndex(pidKey, snapshot, params))
  ]) {
    if (!key) {
      continue;
    }
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.add(key.toLowerCase());
    }
    keys.add(namespacedSnapshotKey(namespace, key));
  }
  return [...keys];
}
function snapshotKeysForWindow(query, snapshot) {
  return snapshot.windowId === null || snapshot.windowId === void 0 ? [] : [snapshotWindowKey(query, snapshot.windowId)];
}
function snapshotWindowKey(query, windowId) {
  return `${query.toLowerCase()}#window:${windowId}`;
}
function canonicalWindowIdKey(windowId) {
  return `window-id:${windowId}`;
}
function canonicalWindowIndexKey(windowIndex) {
  return `window-index:${windowIndex}`;
}
function snapshotKeysForWindowIndex(query, snapshot, params) {
  const windowIndex = optionalNumberParam(params, "windowIndex") ?? snapshot.windowIndex;
  return windowIndex === null || windowIndex === void 0 ? [] : [snapshotWindowIndexKey(query, windowIndex)];
}
function snapshotWindowIndexKey(query, windowIndex) {
  return `${query.toLowerCase()}#window-index:${windowIndex}`;
}
function snapshotNamespace(params) {
  const session = optionalStringParam(params, "session");
  const worktree = optionalStringParam(params, "worktree");
  return session ? `session:${session}` : worktree ? `worktree:${worktree}` : "default";
}
function namespacedSnapshotKey(namespace, key) {
  return `${namespace}:${key.toLowerCase()}`;
}
function staleWindowTargetKeys(query, params, snapshot) {
  const namespace = snapshotNamespace(params);
  const windowId = optionalNumberParam(params, "windowId");
  const windowIndex = optionalNumberParam(params, "windowIndex");
  if (windowId === void 0 && windowIndex === void 0) {
    return [];
  }
  const keys = /* @__PURE__ */ new Set();
  if (windowId !== void 0) {
    keys.add(canonicalWindowIdKey(windowId));
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIdKey(windowId)));
  }
  if (windowIndex !== void 0) {
    keys.add(canonicalWindowIndexKey(windowIndex));
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIndexKey(windowIndex)));
  }
  for (const appKey of snapshotAppKeys(query, snapshot)) {
    const targetKey = windowId !== void 0 ? snapshotWindowKey(appKey, windowId) : snapshotWindowIndexKey(appKey, windowIndex);
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.add(targetKey.toLowerCase());
    }
    keys.add(namespacedSnapshotKey(namespace, targetKey));
  }
  return [...keys];
}
function lookupCachedSnapshotKey(app, params, windowId, windowIndex) {
  const namespace = snapshotNamespace(params);
  const keys = [];
  if (windowId !== void 0) {
    keys.push(
      namespacedSnapshotKey(namespace, canonicalWindowIdKey(windowId)),
      namespacedSnapshotKey(namespace, snapshotWindowKey(app, windowId))
    );
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.push(canonicalWindowIdKey(windowId), snapshotWindowKey(app, windowId));
    }
  }
  if (windowIndex !== void 0) {
    keys.push(
      namespacedSnapshotKey(namespace, canonicalWindowIndexKey(windowIndex)),
      namespacedSnapshotKey(namespace, snapshotWindowIndexKey(app, windowIndex))
    );
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.push(canonicalWindowIndexKey(windowIndex), snapshotWindowIndexKey(app, windowIndex));
    }
  }
  keys.push(namespacedSnapshotKey(namespace, app));
  if (!isExplicitSnapshotNamespace(namespace)) {
    keys.push(app.toLowerCase());
  }
  return keys;
}
function snapshotAppKeys(query, snapshot) {
  return [
    query,
    snapshot?.app.name,
    snapshot?.app.bundleId,
    snapshot?.app.bundleIdentifier,
    ...snapshot ? snapshotPidKeys(snapshot.app.pid) : []
  ].filter((value) => typeof value === "string" && value.length > 0);
}
function snapshotPidKeys(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return [];
  }
  return [snapshotPidSelector(pid), String(pid)];
}
function snapshotPidSelector(pid) {
  return `pid:${pid}`;
}
function isExplicitSnapshotNamespace(namespace) {
  return namespace !== "default";
}

// vendor/orca/src/main/computer/desktop-script-snapshot-rendering.ts
function renderSnapshot(snapshot, noScreenshot) {
  const bounds = snapshot.windowBounds;
  const treeText = renderTreeText(snapshot);
  const focusedElementId = normalizedFocusedElementId(snapshot);
  const screenshotWidth = positiveRoundedNumber(snapshot.screenshotWidth) ?? Math.max(1, Math.round(bounds?.width ?? 1));
  const screenshotHeight = positiveRoundedNumber(snapshot.screenshotHeight) ?? Math.max(1, Math.round(bounds?.height ?? 1));
  const screenshotScale = positiveNumber(snapshot.screenshotScale) ?? 1;
  const screenshot = snapshot.screenshotPngBase64 ? {
    data: snapshot.screenshotPngBase64,
    format: "png",
    width: screenshotWidth,
    height: screenshotHeight,
    scale: screenshotScale
  } : null;
  return {
    snapshot: {
      // Why: bridge elements can be large; keep them cached internally for actions
      // instead of returning duplicated metadata in every agent-facing snapshot.
      id: snapshot.snapshotId ?? fallbackSnapshotId(snapshot),
      app: {
        name: snapshot.app.name,
        bundleId: snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? null,
        pid: snapshot.app.pid
      },
      window: {
        title: snapshot.windowTitle ?? snapshot.app.name,
        id: snapshot.windowId ?? null,
        index: snapshot.windowIndex ?? null,
        x: bounds ? Math.round(bounds.x) : null,
        y: bounds ? Math.round(bounds.y) : null,
        width: Math.max(0, Math.round(bounds?.width ?? 0)),
        height: Math.max(0, Math.round(bounds?.height ?? 0)),
        isMinimized: null,
        isOffscreen: null,
        screenIndex: null
      },
      coordinateSpace: snapshot.coordinateSpace ?? "window",
      treeText,
      elementCount: snapshot.elements?.length ?? 0,
      focusedElementId,
      truncation: {
        truncated: snapshot.truncation?.truncated === true,
        maxNodes: snapshot.truncation?.maxNodes,
        maxDepth: snapshot.truncation?.maxDepth,
        maxDepthReached: snapshot.truncation?.maxDepthReached === true
      }
    },
    screenshot,
    screenshotStatus: screenshot ? {
      state: "captured",
      metadata: { engine: "unknown", windowId: snapshot.windowId ?? null }
    } : noScreenshot ? { state: "skipped", reason: "no_screenshot_flag" } : desktopScreenshotFailureStatus(snapshot)
  };
}
function desktopScreenshotFailureStatus(snapshot) {
  if (snapshot.screenshotError?.message) {
    return {
      state: "failed",
      code: "screenshot_failed",
      message: snapshot.screenshotError.message
    };
  }
  return {
    state: "failed",
    code: "screenshot_failed",
    message: "desktop provider returned no image; grant screen capture permission or pass --no-screenshot to inspect accessibility state only."
  };
}
function snapshotWithoutScreenshot(snapshot) {
  return snapshot.screenshotPngBase64 ? { ...snapshot, screenshotPngBase64: null } : snapshot;
}
function normalizedFocusedElementId(snapshot) {
  const focusedElementId = snapshot.focusedElementId;
  if (focusedElementId === null || focusedElementId === void 0) {
    return null;
  }
  return snapshot.elements?.some((element) => element.index === focusedElementId) === true ? focusedElementId : null;
}
function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function positiveRoundedNumber(value) {
  const numberValue = positiveNumber(value);
  return numberValue === null ? null : Math.max(1, Math.round(numberValue));
}
function fallbackSnapshotId(snapshot) {
  const appRef = snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? snapshot.app.name;
  const windowRef = snapshot.windowId !== null && snapshot.windowId !== void 0 ? String(snapshot.windowId) : snapshot.windowIndex !== null && snapshot.windowIndex !== void 0 ? `window-index:${snapshot.windowIndex}` : "window";
  return `${appRef}:${snapshot.app.pid}:${windowRef}`;
}
function renderTreeText(snapshot) {
  const appRef = snapshot.app.bundleId ?? snapshot.app.bundleIdentifier ?? snapshot.app.name;
  const lines = [
    `App=${appRef} (pid ${snapshot.app.pid})`,
    `Window: "${sanitize(snapshot.windowTitle ?? snapshot.app.name)}", App: ${sanitize(snapshot.app.name)}.`,
    "",
    ...snapshot.treeLines ?? []
  ];
  if (snapshot.selectedText) {
    lines.push("", `Selected text: [${sanitize(snapshot.selectedText)}]`);
  } else if (snapshot.focusedSummary) {
    lines.push("", `The focused UI element is ${sanitize(snapshot.focusedSummary)}.`);
  }
  return lines.join("\n");
}
function normalizeBridgeApp(app) {
  if (!app) {
    throw new RuntimeClientError("accessibility_error", "desktop provider returned no app");
  }
  return {
    name: app.name,
    bundleId: app.bundleId ?? app.bundleIdentifier ?? null,
    pid: app.pid
  };
}
function sanitize(value) {
  return value.replaceAll("\n", " ").replaceAll("\r", " ");
}

// vendor/orca/src/main/computer/desktop-script-snapshot-store.ts
var DesktopScriptSnapshotStore = class {
  snapshots = /* @__PURE__ */ new Map();
  snapshotEntries = [];
  clear() {
    this.snapshots.clear();
    this.snapshotEntries.length = 0;
  }
  remember(query, snapshot, params) {
    const keys = snapshotCacheKeys(query, snapshot, params);
    if (keys.length === 0) {
      return;
    }
    const cachedSnapshot = snapshotWithoutScreenshot(snapshot);
    const entry = { snapshot: cachedSnapshot, keys, createdAtMs: Date.now() };
    this.snapshotEntries.push(entry);
    for (const key of keys) {
      this.snapshots.set(key, cachedSnapshot);
    }
    this.prune();
  }
  current(app, windowId, params) {
    this.prune();
    const windowIndex = optionalNumberParam(params, "windowIndex");
    const keys = lookupCachedSnapshotKey(app, params, windowId, windowIndex);
    const hasExplicitWindowTarget = windowId !== void 0 || windowIndex !== void 0;
    for (const key of keys) {
      if (hasExplicitWindowTarget && !key.includes("#window") && !key.includes("window-id:") && !key.includes("window-index:")) {
        continue;
      }
      const cached = this.snapshots.get(key);
      if (cached) {
        return cached;
      }
    }
    return null;
  }
  forgetWindowTarget(query, params, snapshot) {
    const keys = staleWindowTargetKeys(query, params, snapshot);
    for (const key of keys) {
      this.snapshots.delete(key);
    }
  }
  prune() {
    while (this.snapshotEntries.length > 0 && (this.snapshotEntries.length > MAX_CACHED_DESKTOP_SNAPSHOTS || this.isExpired(this.snapshotEntries[0]))) {
      const expired = this.snapshotEntries.shift();
      if (!expired) {
        return;
      }
      for (const key of expired.keys) {
        if (this.snapshots.get(key) === expired.snapshot) {
          this.snapshots.delete(key);
        }
      }
    }
  }
  isExpired(entry) {
    return Date.now() - entry.createdAtMs > MAX_CACHED_DESKTOP_SNAPSHOT_AGE_MS;
  }
};

// vendor/orca/src/main/computer/computer-action-verification-normalization.ts
function normalizeComputerActionResult(result) {
  const action = result.action;
  if (!action) {
    return result;
  }
  const verificationReason = action.path === "synthetic" ? "synthetic_input" : action.path === "clipboard" ? "clipboard_paste" : action.path === "accessibility" ? "accessibility_action_unasserted" : null;
  if (!verificationReason || action.verification) {
    return result;
  }
  return {
    ...result,
    action: {
      ...action,
      verification: { state: "unverified", reason: verificationReason }
    }
  };
}

// vendor/orca/src/main/computer/windows-focus-helper-client.ts
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { dirname, join as join2, win32 } from "node:path";

// vendor/orca/src/shared/child-process/run-process.ts
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync
} from "node:child_process";

// vendor/orca/src/shared/child-process/windows-command-line.ts
function quoteWindows(value, escapePercent) {
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += `${"\\".repeat(backslashes * 2)}""`;
      backslashes = 0;
      continue;
    }
    if (escapePercent && char === "%") {
      quoted += `${"\\".repeat(backslashes * 2)}"^%"`;
      backslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
function quoteWindowsCmdArgument(value) {
  return quoteWindows(value, true);
}
function buildWindowsCmdShimCommandLine(program, args) {
  for (const value of [program, ...args]) {
    if (/[\r\n]/.test(value)) {
      throw new Error("cmd.exe cannot receive an argument containing a line break");
    }
  }
  const inner = [program, ...args].map(quoteWindowsCmdArgument).join(" ");
  return `/d /v:off /s /c "${inner}"`;
}
var CMD_INTERPRETED_EXTENSIONS = [".cmd", ".bat"];
function isCmdInterpretedProgram(program) {
  const lower = program.toLowerCase();
  return CMD_INTERPRETED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// vendor/orca/src/shared/child-process/process-tree-termination.ts
var MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024;

// vendor/orca/src/shared/child-process/run-process.ts
var DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
function resolveSpawn(spec, platform) {
  const args = spec.args ?? [];
  const base = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false,
    ...spec.terminationBarrier && platform !== "win32" ? { detached: true } : {}
  };
  if (platform !== "win32" || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base };
  }
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  };
}
function spawnProcess(spec) {
  const resolved = resolveSpawn(spec, process.platform);
  return nodeSpawn(resolved.file, [...resolved.args], resolved.options);
}

// vendor/orca/src/main/computer/windows-focus-helper-client.ts
var DEFAULT_STARTUP_TIMEOUT_MS = 3e3;
var PIPE_ENV = "ORCA_COMPUTER_WINDOWS_FOCUS_PIPE";
var TOKEN_ENV = "ORCA_COMPUTER_WINDOWS_FOCUS_TOKEN";
var defaultDeps = {
  exists: existsSync2,
  spawn: (program, args, env) => spawnProcess({
    program,
    args,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  }),
  pipeName: () => `orca-computer-focus-${process.pid}-${randomUUID()}`,
  token: () => randomBytes(32).toString("hex"),
  parentPid: process.pid,
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS
};
function shouldPrepareWindowsFocusHelper(request) {
  return request.restoreWindow === true;
}
var WindowsFocusHelperClient = class {
  helperPath;
  deps;
  child = null;
  environment = null;
  starting = null;
  constructor(runtimePath, deps = {}) {
    this.helperPath = join2(dirname(runtimePath), "focus-helper.ps1");
    this.deps = { ...defaultDeps, ...deps };
  }
  async environmentFor(request) {
    if (!shouldPrepareWindowsFocusHelper(request) || !this.deps.exists(this.helperPath)) {
      return {};
    }
    if (this.environment) {
      return this.environment;
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return await this.starting;
  }
  shutdown() {
    const child = this.child;
    this.child = null;
    this.environment = null;
    this.starting = null;
    child?.kill("SIGTERM");
  }
  async start() {
    const pipeName = this.deps.pipeName();
    const token = this.deps.token();
    const child = this.deps.spawn(
      windowsPowerShellPath(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.helperPath,
        "-PipeName",
        pipeName,
        "-ParentPid",
        String(this.deps.parentPid)
      ],
      { ...process.env, [TOKEN_ENV]: token }
    );
    this.child = child;
    child.stderr?.on("data", () => {
    });
    const ready = await this.waitForReady(child);
    if (!ready || this.child !== child) {
      if (this.child === child) {
        this.child = null;
      }
      child.kill("SIGTERM");
      return {};
    }
    this.environment = { [PIPE_ENV]: pipeName, [TOKEN_ENV]: token };
    child.once("exit", () => this.clearExitedChild(child));
    child.once("error", () => this.clearExitedChild(child));
    return this.environment;
  }
  waitForReady(child) {
    return new Promise((resolve2) => {
      let settled = false;
      let output = "";
      const finish = (ready) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        resolve2(ready);
      };
      const onData = (chunk) => {
        output += chunk.toString();
        const lines = output.split(/\r?\n/);
        output = lines.pop() ?? "";
        if (lines.some((line) => line.trim() === '{"ready":true}')) {
          finish(true);
        }
      };
      const onExit = () => finish(false);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), this.deps.startupTimeoutMs);
      child.stdout?.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }
  clearExitedChild(child) {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.environment = null;
  }
};
function windowsPowerShellPath(env = process.env) {
  const systemRoot = env.SystemRoot?.trim() || env.WINDIR?.trim() || "C:\\Windows";
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// vendor/orca/src/main/computer/desktop-script-provider-focus-retry.ts
async function callDesktopBridgeWithFocusFallback({
  platform,
  request,
  focusHelper,
  attempt
}) {
  const native = await attempt({});
  if (!shouldRetryWithWindowsFocusHelper(platform, request, focusHelper, native.response)) {
    return native;
  }
  const helperEnvironment = await focusHelper.environmentFor(request);
  return Object.keys(helperEnvironment).length > 0 ? await attempt(helperEnvironment) : native;
}
function parseDesktopBridgeResponse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new RuntimeClientError(
      "accessibility_error",
      `desktop provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function shouldRetryWithWindowsFocusHelper(platform, request, focusHelper, response) {
  return platform === "windows" && focusHelper !== null && request.restoreWindow === true && response.ok === false && /window_not_focused|target window.*focused/i.test(response.error ?? "");
}

// vendor/orca/src/main/computer/desktop-script-provider-client.ts
function shouldUseDesktopScriptProvider() {
  return desktopScriptPlatform() !== null && resolveDesktopScriptProviderPath() !== null;
}
var DesktopScriptProviderClient = class {
  constructor(platform = requiredPlatform(), scriptPath = requiredScriptPath(), windowsFocusHelper) {
    this.platform = platform;
    this.scriptPath = scriptPath;
    this.windowsFocusHelper = windowsFocusHelper === void 0 ? platform === "windows" ? new WindowsFocusHelperClient(scriptPath) : null : windowsFocusHelper;
  }
  snapshotStore = new DesktopScriptSnapshotStore();
  snapshots = this.snapshotStore.snapshots;
  providerCapabilities = null;
  windowsFocusHelper;
  shutdown() {
    this.snapshotStore.clear();
    this.providerCapabilities = null;
    this.windowsFocusHelper?.shutdown();
  }
  async listApps() {
    const response = await this.callBridge({ tool: "list_apps" });
    return {
      apps: (response.apps ?? []).map((app) => ({
        name: app.name,
        bundleId: app.bundleId ?? app.bundleIdentifier ?? null,
        pid: app.pid,
        isRunning: true,
        lastUsedAt: null,
        useCount: null
      }))
    };
  }
  async capabilities() {
    return await this.readCapabilities();
  }
  async listWindows(params) {
    const capabilities = await this.readCapabilities();
    if (!capabilities.supports.windows.list) {
      throw new RuntimeClientError(
        "unsupported_capability",
        `${capabilities.provider} does not support windows.list`
      );
    }
    const response = await this.callBridge({
      tool: "list_windows",
      app: stringParam(params, "app")
    });
    return {
      app: normalizeBridgeApp(response.app),
      windows: (response.windows ?? []).map((window2) => ({
        index: window2.index,
        app: normalizeBridgeApp(window2.app),
        id: window2.id ?? null,
        title: window2.title,
        x: window2.x ?? null,
        y: window2.y ?? null,
        width: window2.width,
        height: window2.height,
        isMinimized: window2.isMinimized ?? null,
        isOffscreen: window2.isOffscreen ?? null,
        screenIndex: window2.screenIndex ?? null,
        platform: window2.platform
      }))
    };
  }
  async snapshot(params) {
    const app = stringParam(params, "app");
    const response = await this.callBridge({
      tool: "get_app_state",
      app,
      accessibility: optionalStringParam(params, "accessibility"),
      windowId: optionalNumberParam(params, "windowId"),
      windowIndex: optionalNumberParam(params, "windowIndex"),
      noScreenshot: params.noScreenshot === true,
      restoreWindow: params.restoreWindow === true
    });
    return this.rememberAndRender(app, response, params.noScreenshot === true, params);
  }
  async action(method, params) {
    const app = await validateComputerProviderActionParams(method, params);
    const explicitWindowId = optionalNumberParam(params, "windowId");
    const explicitWindowIndex = optionalNumberParam(params, "windowIndex");
    const current = this.snapshotStore.current(app, explicitWindowId, params);
    const actionWindowTarget = desktopActionWindowTarget(
      explicitWindowId,
      explicitWindowIndex,
      current
    );
    const element = elementParam(current, optionalNumberParam(params, "elementIndex"));
    const fromElement = elementParam(current, optionalNumberParam(params, "fromElementIndex"));
    const toElement = elementParam(current, optionalNumberParam(params, "toElementIndex"));
    await this.ensureActionSupported(method);
    const inputStrings = [optionalStringParam(params, "value"), optionalStringParam(params, "text")].filter((value) => Boolean(value));
    const sensitiveBefore = sensitiveAction(current ?? void 0, element);
    let response = await this.callBridge({
      tool: bridgeTool(method),
      app,
      accessibility: optionalStringParam(params, "accessibility"),
      element,
      fromElement,
      toElement,
      x: optionalNumberParam(params, "x"),
      y: optionalNumberParam(params, "y"),
      from_x: optionalNumberParam(params, "fromX"),
      from_y: optionalNumberParam(params, "fromY"),
      to_x: optionalNumberParam(params, "toX"),
      to_y: optionalNumberParam(params, "toY"),
      click_count: optionalNumberParam(params, "clickCount"),
      mouse_button: optionalStringParam(params, "mouseButton"),
      modifiers: optionalStringParam(params, "modifiers"),
      action: optionalStringParam(params, "action"),
      direction: optionalStringParam(params, "direction"),
      pages: optionalNumberParam(params, "pages"),
      text: optionalStringParam(params, "text"),
      key: optionalStringParam(params, "key"),
      value: optionalStringParam(params, "value"),
      windowBounds: null,
      ...actionWindowTarget,
      noScreenshot: params.noScreenshot === true,
      restoreWindow: params.restoreWindow === true
    }).catch((error) => {
      throw new RuntimeClientError(error.code ?? "accessibility_error", redactStrings(String(error.message), inputStrings));
    });
    const sensitiveAfter = sensitiveAction(response.snapshot, element);
    response = sanitizeResponse(response, sensitiveBefore || sensitiveAfter ? inputStrings : []);
    const action = verifyDesktopAction(
      desktopActionMetadataFromResponse(
        response.action,
        method,
        actionWindowTarget.windowId ?? null,
        response.snapshot?.windowIndex ?? current?.windowIndex ?? null
      ),
      method,
      params,
      response.action,
      response.snapshot,
      element,
      actionWindowTarget.windowId
    );
    if (isWindowChangedAction(action)) {
      this.snapshotStore.forgetWindowTarget(app, params, current);
    }
    return normalizeComputerActionResult({
      ...this.rememberAndRender(
        app,
        response,
        params.noScreenshot === true,
        cacheParamsForActionResult(params, action)
      ),
      action
    });
  }
  async ensureActionSupported(method) {
    const capabilities = await this.readCapabilities();
    const actionKey = actionCapabilityKey(method);
    if (!capabilities.supports.actions[actionKey]) {
      throw new RuntimeClientError(
        "unsupported_capability",
        `${capabilities.provider} does not support actions.${actionKey}`
      );
    }
  }
  async callBridge(request) {
    const operationDirectory = await mkdtemp(join3(tmpdir(), "orca-computer-use-"));
    const operationPath = join3(operationDirectory, "operation.json");
    try {
      await writeFile(operationPath, JSON.stringify(request), { encoding: "utf8", mode: 384 });
      const { response, stderr } = await callDesktopBridgeWithFocusFallback({
        platform: this.platform,
        request,
        focusHelper: this.windowsFocusHelper,
        attempt: async (extraEnv) => {
          const { stdout, stderr: stderr2 } = await execBridge(
            this.platform,
            this.scriptPath,
            operationPath,
            extraEnv
          );
          return { response: parseDesktopBridgeResponse(stdout), stderr: stderr2 };
        }
      });
      if (!response.ok) {
        throw mapBridgeError(response.error ?? stderr);
      }
      return response;
    } finally {
      await rm(operationDirectory, { force: true, recursive: true });
    }
  }
  async readCapabilities() {
    if (this.providerCapabilities) {
      return this.providerCapabilities;
    }
    const response = await this.callBridge({ tool: "handshake" });
    if (!response.capabilities) {
      throw new RuntimeClientError(
        "accessibility_error",
        "desktop provider returned no capabilities"
      );
    }
    this.providerCapabilities = response.capabilities;
    return response.capabilities;
  }
  rememberAndRender(app, response, noScreenshot, params) {
    if (!response.snapshot) {
      throw new RuntimeClientError("accessibility_error", "desktop provider returned no snapshot");
    }
    const safe = sanitizeResponse(response).snapshot;
    this.snapshotStore.remember(app, safe, params);
    return renderSnapshot(safe, noScreenshot);
  }
};
function requiredPlatform() {
  const platform = desktopScriptPlatform();
  if (!platform) {
    throw new RuntimeClientError("accessibility_error", "desktop script provider is not available");
  }
  return platform;
}
function requiredScriptPath() {
  const scriptPath = resolveDesktopScriptProviderPath();
  if (!scriptPath) {
    throw new RuntimeClientError(
      "accessibility_error",
      "desktop script provider script was not found"
    );
  }
  return scriptPath;
}
export {
  DesktopScriptProviderClient,
  shouldUseDesktopScriptProvider
};
