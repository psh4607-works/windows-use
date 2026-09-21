# Source provenance

The Windows runtime, focus helper and desktop provider modules were extracted from
a pinned Orca source snapshot at commit `75cf4aa5075d6e33ae4b2a5ded581c21907bc729`.
The private extraction repository location is omitted from this distribution.
The upstream copyright and MIT license are retained in LICENSE.
`provenance.json` lists the original paths and SHA-256 hashes.
Its `localModifications` section records patched files and their current hashes;
all other listed source files are unmodified. `dist/provider.mjs` is generated
from the provider subset.

The standalone Windows runtime explicitly binds `PostMessageW` so Unicode keyboard
text is not converted through the ANSI message entry point. This correction was
verified with Korean text and a surrogate-pair emoji in a live WPF text box.

Additional standalone changes support F1-F16 input, enumerate visible process-owned
windows (including menus and dialogs), and pass an explicitly selected MSAA backend
through the provider. `native/computer-use-windows/msaa.cs` is a standalone adapter;
it was not extracted from the upstream revision. UIA remains the default backend.

The CLI, task session persistence, authenticated desktop IPC and SSH transport are
standalone adapters. Electron, the renderer, terminal subsystem, relay server,
mobile app and upstream GitHub Actions workflows are not required at runtime.

The retained provider uses the upstream PowerShell process invocation, including
its process-local execution policy flag. The package does not change a machine or
user execution policy, install a service, or expose a TCP listener.
