# Observation safety

Input requires a fresh observation from the same session, app, accessibility backend,
and desktop input revision. The existing two-minute expiry and single-use token
checks still apply.

## Desktop input revision

All sessions using the same state directory share `.input-revision.json`. Every
input attempt advances this opaque revision **before** provider dispatch, including
attempts that later fail, time out, or lose their response. A snapshot with
`restoreWindow: true` also advances it because restoring focus changes input state.
The policy is deliberately desktop-wide within that directory: input to another
app/window revokes older observations too, since focus and dialogs cross windows.

Ordinary snapshots, element `query`, apps/windows/capabilities queries, status and doctor do not
advance the revision. A successful action returns a new token for its refreshed
snapshot; other sessions must snapshot again. A failed action does not return a
replacement token. Observations do not detect changes made by a person, another
application, another installation/state directory, or an older runtime.

Element `query` and the observations returned by `wait-for` use the same versioned
state, global lock and input revision as `snapshot`. Read-only polling preserves
other sessions' tokens; subsequent input revokes them. A completed wait's token
must still pass the normal revision check before an action. Polls release the
broker between requests and stop when pause/resume changes the access epoch.

The IPC broker queues requests, but token/revision checks happen when each request
**executes**, not just when it enters the queue. `executeRequest` uses an exclusive
filesystem lock shared across processes, covering validation, snapshot capture or
input, and atomic observation publication. Direct concurrent callers get `busy`
rather than queueing. The sibling `state.input.lock` remains outside the state
directory so pause/resume/startup cannot delete a live direct caller's lock.
Existing per-session locks are also honored.

Pause rejects newly admitted work and queued work from an earlier access revision.
It drains broker work before clearing observations. If a direct caller holds the
lock, clearing fails closed and the broker stays paused; resume can be retried
after that caller finishes. Starting or resuming the desktop clears observations,
so tokens from an earlier owner or before a pause cannot be replayed.

A process crash can leave `state.input.lock` or a session lock behind. They are not
automatically stolen: stop all clients/direct callers, back up state, remove the
abandoned lock files, then start the desktop and take a fresh snapshot. This favors
rejection over overlapping an input whose outcome is unknown.

## State migration

Observation files now use `version: 2` and include `inputRevision`. Legacy state,
invalid expiry, malformed snapshot collections, or a missing/mismatched revision
are rejected before input. A fresh snapshot or element query replaces old session state. A missing
or malformed revision file can be reset by either observation; its new random revision
also revokes every old token. Filesystem permission/write errors remain failures.
Revision and session files use temporary files followed by rename, under the lock.

Upgrade all clients sharing a state directory and restart the desktop. Mixed old
and new runtimes are unsupported because old code does not participate in revision
checks. Changing state directories creates an independent safety domain.

## Window and element identity

Every provider input path, including keyboard and authorized coordinates, requires
an observed HWND. An explicit HWND must equal the cached observed HWND; it cannot
redirect input to an unobserved window. Window indexes remain pinned to the observed
handle when enumeration order changes. A changed window requires a new snapshot.
This does not detect OS handle reuse by itself; native app and element resolution
remain additional checks.

Set-value verification follows one unique runtime ID (UIA or MSAA). If the target
had a runtime ID, a missing/changed ID cannot fall back to automation ID or array
index. With no runtime ID, a unique automation ID may verify. Missing or ambiguous
identity stays unverified; reindexing the same identity may still verify. A changed
window stays `window_changed`, even if a new window contains the same element ID.
Native `unverified` results are preserved; a native `verified` claim does not bypass
provider identity checks.

## Sensitive observations

Native UIA and MSAA records carry `isSensitive`, using their existing password and
sensitive-label classifiers. The provider retains that metadata in cached/session
observations and redacts sensitive values before rendering or persistence. Legacy
records with `[redacted]` and no explicit classification are treated conservatively;
`isSensitive: false` preserves an ordinary field whose literal value is `[redacted]`.

Sensitive set-value results are `unverified` with `reason: sensitive_value` and
redacted expected/actual preview values. Before/after sensitivity is considered;
when identity disappears, sensitive candidates in the returned snapshot cause
conservative redaction. Synthetic typing and paste also redact echoed input when
the target is sensitive or cannot be uniquely identified in a sensitive snapshot.
Bridge errors redact submitted text/value instead of echoing it. The native input
still receives the original value; the private temporary operation file is removed
by the existing bridge cleanup.

For sensitive observations, unstructured selection/focus summaries and screenshots
are withheld because they lack field-level provenance. Sensitive values and their rendered tree rows are redacted structurally. App/element
selectors and protocol fields stay unchanged; free-text redaction matches short
inputs (under four Unicode characters) with boundaries at letter/digit/underscore
edges, preserving unrelated
words and existing redaction markers. Whitespace-only needles are skipped in
free text while sensitive values/rows and verification remain structurally redacted.
Native classification cannot detect every
secret in an arbitrary third-party application. Ordinary values still support verification.

## Verification scope

Regression tests exercise the built `dist/provider.mjs`, direct requests, real local
IPC, separate Node processes, and isolated native UIA/MSAA record serialization.
The fixtures use synthetic values only. PowerShell isolated tests on macOS do not
prove Windows COM marshalling, real UIA password controls, HWND behavior, or native
keyboard/pointer dispatch. Those require a separate Windows desktop smoke test.
