import { parseArgs } from 'node:util';
const STRINGS = ['host', 'remote-dir', 'session', 'observation', 'app', 'element', 'window-id', 'window-index', 'text', 'value', 'key', 'action', 'direction', 'pages', 'click-count', 'mouse-button', 'modifiers', 'x', 'y', 'from-element', 'to-element', 'from-x', 'from-y', 'to-x', 'to-y', 'screenshot', 'text-file', 'value-file', 'accessibility'];
const BOOLEANS = ['json', 'help', 'version', 'restore-window', 'allow-pointer', 'all'];
const PARAMS = { all: 'all', app: 'app', element: 'elementIndex', 'window-id': 'windowId', 'window-index': 'windowIndex', text: 'text', value: 'value', key: 'key', action: 'action', direction: 'direction', pages: 'pages', 'click-count': 'clickCount', 'mouse-button': 'mouseButton', modifiers: 'modifiers', x: 'x', y: 'y', 'from-element': 'fromElementIndex', 'to-element': 'toElementIndex', 'from-x': 'fromX', 'from-y': 'fromY', 'to-x': 'toX', 'to-y': 'toY', 'restore-window': 'restoreWindow', 'allow-pointer': 'allowPointer' };
const NUMERIC = new Set(['element', 'window-id', 'window-index', 'pages', 'click-count', 'x', 'y', 'from-element', 'to-element', 'from-x', 'from-y', 'to-x', 'to-y']);
const QUERY_PARAMS = { 'after-inventory': 'afterInventory', role: 'role', name: 'name', 'automation-id': 'automationId', condition: 'condition', 'window-title': 'windowTitle', 'timeout-ms': 'timeoutMs', 'poll-ms': 'pollMs' };
STRINGS.push(...Object.keys(QUERY_PARAMS), 'remote-home');
Object.assign(PARAMS, QUERY_PARAMS);
NUMERIC.add('timeout-ms'); NUMERIC.add('poll-ms');

export function parseCli(args) {
  const options = Object.fromEntries([...STRINGS.map(key => [key, { type: 'string' }]), ...BOOLEANS.map(key => [key, { type: 'boolean' }])]);
  const { values, positionals } = parseArgs({ args, options, strict: true, allowPositionals: true });
  if (positionals.length > 1) throw new Error('Expected one command; pass target data with named options.');
  if (!['query', 'wait-for'].includes(positionals[0]) && Object.keys(QUERY_PARAMS).some(key => values[key] !== undefined)) {
    throw new Error('Selectors and wait options require query or wait-for; actions require an observed element index.');
  }
  if (values.all !== undefined && positionals[0] !== 'windows') throw new Error('--all requires windows.');
  if (values['after-inventory'] !== undefined && positionals[0] !== 'wait-for') throw new Error('--after-inventory requires wait-for.');
  const params = {};
  if (values.accessibility !== undefined) {
    if (!['uia', 'msaa'].includes(values.accessibility)) throw new Error('Invalid --accessibility backend; expected uia or msaa');
    params.accessibility = values.accessibility;
  }
  for (const [key, target] of Object.entries(PARAMS)) {
    if (values[key] === undefined) continue;
    if (NUMERIC.has(key)) {
      if (!/^-?\d+(?:\.\d+)?$/.test(values[key]) || !Number.isFinite(Number(values[key]))) throw new Error(`Invalid --${key} number`);
      params[target] = Number(values[key]);
    } else params[target] = values[key];
  }
  params.noScreenshot = !values.screenshot;
  return {
    help: values.help || !positionals.length, version: values.version,
    host: values.host, remoteDir: values['remote-dir'], remoteHome: values['remote-home'], screenshot: values.screenshot,
    textFile: values['text-file'], valueFile: values['value-file'],
    request: { command: positionals[0], session: values.session, observation: values.observation, params }
  };
}
