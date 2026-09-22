// Cross-platform integration fixture for the real C# tray bridge; never packaged.
import { runManagedHost } from '../src/managed-host.mjs';
import { startDesktop } from '../src/desktop.mjs';
await runManagedHost({ start: options => startDesktop({ ...options, handler: async () => ({ apps: [] }) }) });
