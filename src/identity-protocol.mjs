import { sameBuild, PROTOCOL_REVISION } from './build-identity.mjs';

const diagnostic = command => ['status', 'doctor'].includes(command);
const actions = new Set(['click', 'invoke', 'set-value', 'type-text', 'press-key', 'hotkey', 'paste-text', 'scroll', 'drag']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function requiredCapabilities(request) {
  const capabilities = [];
  if (request.command === 'query') capabilities.push('query');
  if (request.trackAccess === true) capabilities.push('waitAccessEpoch');
  if (actions.has(request.command) || request.params?.restoreWindow === true) capabilities.push('observationSafety');
  return capabilities;
}

export function assertCompatible(caller, server, request) {
  if (!caller || !server || caller.protocolRevision !== PROTOCOL_REVISION || server.protocolRevision !== PROTOCOL_REVISION) {
    fail('unsupported_protocol', 'Caller or desktop server has an unknown protocol. Update both packages and restart the interactive server; no input was sent.');
  }
  if (caller.integrity !== 'verified' || server.integrity !== 'verified') {
    fail('unverified_build', 'Caller or server package failed build verification. Rebuild/reinstall before using desktop commands.');
  }
  for (const capability of requiredCapabilities(request)) {
    if (!(caller.capabilities?.[capability] >= 1) || !(server.capabilities?.[capability] >= 1)) {
      fail('unsupported_capability', `Caller/server capability ${capability} is unavailable. Update both packages and restart the interactive server.`);
    }
  }
}

export function buildDiagnosis(caller, installation, server) {
  const callerMatchesInstallation = sameBuild(caller, installation);
  const installationMatchesServer = sameBuild(installation, server);
  const callerMatchesServer = sameBuild(caller, server);
  const skillMatches = !!caller?.skillSha256 && caller.skillSha256 === installation?.skillSha256 && caller.skillSha256 === server?.skillSha256;
  let compatible = true;
  try { assertCompatible(caller, server, { command: 'query', trackAccess: true, params: { restoreWindow: true } }); }
  catch { compatible = false; }
  return { ok: callerMatchesInstallation && installationMatchesServer && skillMatches && compatible,
    compatible, callerMatchesInstallation, installationMatchesServer, callerMatchesServer, skillMatches };
}

// Runs at the outer caller too: a legacy remote RPC ignores new request metadata.
// The receiving server checks the captured build and epoch again before execution.
export function identityReader(read, caller, { localInstallation } = {}) {
  return async (request, limits = {}) => {
    const started = performance.now();
    const remaining = () => {
      limits.signal?.throwIfAborted();
      if (limits.timeoutMs === undefined) return limits;
      const timeoutMs = limits.timeoutMs - (performance.now() - started);
      if (timeoutMs <= 0) fail('transport_timeout', 'Request deadline elapsed during build compatibility verification.');
      return { ...limits, timeoutMs };
    };
    if (diagnostic(request.command)) {
      let result;
      try { result = await read(request, remaining()); }
      catch (error) {
        if (request.command !== 'doctor') throw error;
        result = { state: 'unavailable', desktop: { ok: false, code: 'transport_unavailable',
          message: 'Transport or remote diagnostics failed. Check the SSH connection and remote package installation.' } };
      }
      const installation = result.identities?.installation ?? localInstallation ?? null;
      const server = result.identities?.server ?? null;
      return { ...result, identities: { caller, installation, server }, build: buildDiagnosis(caller, installation, server) };
    }
    if (requiredCapabilities(request).length) {
      const status = await read({ command: 'status' }, remaining());
      if (status.state === 'paused') fail('desktop_paused', 'Windows Use is paused. Resume from the local tray before observing again.');
      const server = status.identities?.server;
      assertCompatible(caller, server, request);
      if (typeof status.accessEpoch !== 'string') fail('unsupported_protocol', 'Desktop server does not provide a verifiable instance identity.');
      return read({ ...request, callerIdentity: caller, expectedServerBuildId: server.buildId, expectedAccessEpoch: status.accessEpoch }, remaining());
    }
    return read(request, remaining());
  };
}
