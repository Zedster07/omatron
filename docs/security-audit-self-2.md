# Independent security review, second pass — the areas the first one skipped

**Repo**: `/home/dada/Work/omatron` · **Commit**: `HEAD` on `master`
**Scope**: the five areas `docs/security-audit-self.md` named as uncovered —
the Quickshell IPC surface as reachable from other local processes, the
scheduling / systemd-timer path, `magick` on hostile input during redaction,
the MCP bridge under concurrent connections, and the STT path.

Everything below was probed on the running system. Three of the five areas came
back clean, and that is written down too: a review that only reports faults
gives no information about what was actually looked at.

---

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| **SELF2-01** | **HIGH** | The shell IPC grants a full-access lease with no authentication, and `qs` is guarded only by a policy rule — not by the code-level set that exists for exactly this | Reproduced |
| **SELF2-02** | **LOW** | The lease the panel reports can be four times the lease the server honours | Reproduced |
| **SELF2-03** | **LOW** | The bridge forks a server per connection with no cap | Confirmed in source |
| **SELF2-04** | **INFO** | Remote STT sends the local command and application vocabulary off the machine alongside the audio | Confirmed in source |

Clean: the redaction pipeline, the scheduling path, bridge and socket
permissions.

---

## [SELF2-01] A lease can be granted over IPC with no credential — HIGH

### The defect

The plugin's IPC target exposes, among others:

```
function yolo(minutes: int): string
function yoloOff(): string
function toggleKillswitch(): string
function command(phrase: string): void
```

`yolo` grants a full-access lease. `toggleKillswitch` operates the emergency
stop. Neither takes any credential, because Quickshell IPC has none to take —
it is a socket in `XDG_RUNTIME_DIR`, and the security boundary is the Unix user.

That boundary is the right one for a desktop shell. It is the wrong one here,
because **the agent runs as that user**, and the entire plugin exists to
constrain something that already has the user's privileges.

### Reproduced

With no authentication of any kind, from an ordinary shell:

```
lease before:   {"active":false,"remainingSeconds":0}
$ qs -p /usr/share/omarchy/shell ipc call io.github.zedster07.desktop-agent yolo 240
  on for 240 min (clamped by policy)
lease after:    {"active":true,"remainingSeconds":14399}
```

Restored to off immediately; it was already off before the test.

### Why this is the same finding as the last audit's CRITICAL, wearing different clothes

The previous audit found that `desktop_run` could invoke
`desktop-agent-config policy-set-yolo true`. The fix was deliberately made **in
code**, not in policy, and the reasoning was written into the source:

> Refused here rather than through run.commands because run.commands is a rule
> in the very file these commands rewrite: a policy carrying `"*": "allow"`, or
> one written before this rule existed, re-opens the loop completely.

`qs` reaches the same outcome by a different route, and that reasoning was
never carried across:

```
server/policy.default.jsonc:501   "qs": "deny",  // would drive the approval overlay itself
server/server.ts:1078             SELF_CONTROL = { desktop-agent, desktop-agent-config,
                                                   desktop-yolo, desktop-agent-arm }
```

`qs` is in the first and not the second. So a policy with `"*": "allow"` under
`run.commands`, a policy written before that deny existed, or a user who adds
`"qs": "allow"` because it is the shell's own CLI, hands back exactly the
capability `SELF_CONTROL` was written to remove. `hyprctl` sits in the same
position.

Two things currently make this harder than it sounds, and neither is the
boundary: sandboxed runners have no Wayland socket, so `qs` cannot connect at
all; and the shipped policy denies it. The first does not apply to Claude, which
is not sandboxed. The second is the file being defended.

### Suggested remediation

1. Add `qs`, `hyprctl` and `omarchy` to `SELF_CONTROL`, so `desktop_run`
   refuses them before the policy is consulted — the same treatment, for the
   same reason, as the commands already there.
2. Longer term the IPC deserves a real answer, because a code-level deny in
   `desktop_run` does not stop anything else on the machine calling it. The
   mutating verbs (`yolo`, `toggleKillswitch`) could require a token the panel
   holds and the agent never sees, or simply be removed from IPC and driven
   only from the panel's own process.

The read-only verbs are fine as they are, and worth keeping: `verdict()` is a
poll, not an answer — I checked specifically, because an IPC that could
*answer* an approval card would defeat the geometry check that stops the agent
clicking one.

---

## [SELF2-02] The reported lease can be four times the honoured lease — LOW

`Service.qml:483` clamps a grant at 240 minutes:

```qml
root.grantYolo(Math.min(minutes, 240))
```

while the policy's ceiling is `yolo.maxMinutes`, 60 by default. The server does
enforce its own ceiling at read time (`yoloState`):

```ts
const effective = Math.min(until, grantedAt + policy.yolo.maxMinutes * 60_000)
```

so this is not a ceiling bypass — the extra time is never honoured. What is
wrong is the reporting: after the grant above, `yoloStatus` returned
`remainingSeconds: 14399`, four hours, and that is the number the panel counts
down from. The person is shown a lease that does not exist.

This is the same class as two bugs already fixed in this plugin — the panel
reporting its kill-switch flag while the policy said otherwise, and a lease
counting down while `yolo.enabled` was false. Clamp the grant to the policy's
`maxMinutes` rather than to a constant, and report the effective value.

---

## [SELF2-03] The bridge forks a server per connection, uncapped — LOW

`voice/sandbox.ts`:

```ts
[socat, `UNIX-LISTEN:${socket},fork,mode=600`, `EXEC:${bun} run ${server}`]
```

`fork` is correct — concurrent tool calls need it, and `mode=600` means no
other user can connect. But nothing bounds the number of forks, so a sandboxed
agent holding the socket can spawn MCP servers until the machine runs out of
memory.

It is self-inflicted and visible, which is why this is low. `max-children=N` on
the socat address closes it in one token.

---

## [SELF2-04] Remote STT sends more than the audio — INFO

With `voice.sttMode: remote`, `voice/voiced.ts` posts the WAV to the configured
endpoint with a Bearer key, and when `biasPrompt` is on it also sends the bias
prompt — which is built from the local command registry and installed
application names.

That is not a vulnerability; it is the feature working. But it means the
provider learns what is installed on the machine and what the person has taught
it to do, and that is not the same disclosure as "your speech is transcribed
elsewhere". The README should say so plainly next to the mode switch, since
`local` is the alternative and the difference is not obvious from the name.

The key itself is handled correctly: read from a 0600 file, sent only as an
`Authorization` header, and `desktop-agent-config` reports whether one is set
without ever printing it.

---

## What came back clean

**Redaction (`magick`).** The concern was a window title reaching the argv of
an image tool. It does not: only integers are interpolated
(`-draw "rectangle x1,y1 x2,y2"`), titles go into the `redacted` array that is
returned as text, and `sh\`magick ${args}\`` passes an array — separate
arguments, not a shell string. No injection path.

**Scheduling.** The concern was agent-supplied text reaching a shell. `spec.text`
reaches only `--description=` as an argv element, truncated to 60 characters.
The one string that *is* built for `/bin/sh -c` interpolates the runner path,
unit name, jobs directory and job id — all internal — and the job id is
`Date.now().toString(36)` plus a UUID fragment, not anything a caller supplies.
`when` is validated by `systemd-analyze calendar` before use and passed as its
own argument.

**Socket and bridge permissions.** The voice socket is `srwxr-xr-x`, so other
users cannot connect; `XDG_RUNTIME_DIR` is `0700`, so they cannot traverse to it
either. The bridge directory sits inside the same tree and the bridge socket is
`mode=600`.

---

## Ranked plan

1. **SELF2-01** — add `qs`, `hyprctl`, `omarchy` to `SELF_CONTROL`. One line,
   and it closes the route that the previous audit's CRITICAL fix left open.
   Then decide separately what to do about the IPC itself.
2. **SELF2-02** — clamp the grant to `yolo.maxMinutes` and report the effective
   figure.
3. **SELF2-03** — `max-children` on the socat listener.
4. **SELF2-04** — a sentence in the README beside the STT mode switch.

## Still not covered

Neither pass has examined: the approval overlay's own rendering path with
hostile `subject`/`reasons` strings (a refusal message is built from a window
title, and the overlay renders it), `voxtype` and the keybinding integration,
the `install-local` model download path, or the plugin's behaviour when
`policy.jsonc` is a symlink. A third pass should start there.


---

## Round 3 (external) — SEC3-05, accepted and not fixed

A third audit pass found five more. Four are fixed in the commit that follows
this note. The fifth is recorded here rather than closed:

**Chromium's CDP port is unauthenticated on loopback, and the sandbox runs with
`--share-net`.** So a sandboxed subagent can scan `127.0.0.1`, find
`/json/version`, and drive the browser over the websocket — which bypasses
`MASTER_ONLY`, the one boundary that says the browser belongs to the master.

Confirmed: `voice/sandbox.ts:139` passes `--share-net`, and `server/browser.ts`
launches with `--remote-debugging-port` on `127.0.0.1` with no token, because
Chromium offers none for that transport.

Not fixed, because both real remedies are larger than a patch:

- `--remote-debugging-pipe` removes the socket entirely, and is the right
  answer — but `browser.ts` speaks CDP over a WebSocket throughout, including
  `adopt()`, which recovers a browser another session left behind by reading
  the port out of `/proc/<pid>/cmdline`. Moving to a pipe means rewriting the
  transport and giving up cross-session adoption.
- Denying the sandbox loopback needs a private network namespace and a relay
  for the outbound API calls the runners genuinely need.

What limits it today: `--share-net` applies only to the sandboxed runners
(gemini, codex, opencode), the port is random per launch, and the browser only
exists while a master is using it. That is mitigation, not a boundary, and it
should be written down as such rather than counted as a fix.
