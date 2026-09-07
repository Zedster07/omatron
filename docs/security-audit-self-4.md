# Fourth-Round Security Audit Report: Omatron Desktop Agent

**Repository**: `/home/dada/Work/omatron`  
**Commit Baseline**: [`fc60069`](file:///home/dada/Work/omatron) (*"Fix both third-pass findings"*)  
**Scope**: In-depth audit of previously unexamined components: installer/uninstaller lifecycle (`bin/desktop-agent`), scheduled job execution under systemd (`voice/runjob.ts`, `voice/schedule.ts`, `voice/jobs-cli.ts`), subagent delegation and scratch directory isolation (`voice/subagent.ts`), tmux terminal execution (`voice/workspace.ts`), supervisory watchdog and legacy voxtype paths (`voice/watch.ts`, `bin/desktop-agent-arm`), UI components (`ui/RecapCard.qml`, `ui/CommandBar.qml`, `BarWidget.qml`), and rigorous verification of prior fixes (specifically PASS6-01's `LAUNCH_FORBIDDEN`).

---

## Executive Summary

Across the preceding 6 audit passes (Gemini 1–3 and Claude Self 1–3), 20 distinct vulnerabilities were identified and patched. This round targeted the remaining untested codebase areas and stress-tested earlier fixes.

### Key Results
1. **PASS6-01 Fix is Ineffective (Bypassed)**: The `LAUNCH_FORBIDDEN` deny-list in [`server/server.ts`](file:///home/dada/Work/omatron/server/server.ts#L927) only checks `--flag` arguments. Chromium's POSIX command-line parser (`base::CommandLine`) natively accepts single-dash flags (`-flag`). Passing `-user-data-dir=/home/dada/.config/chromium` is allowed by `checkLaunchArgs()` and accepted by Chromium, completely reopening the ability to drive the user's authenticated browser profile.
2. **Subagents Inherit Master's YOLO Lease**: `gate()` checks the global `yolo.json` lease without verifying whether the caller is a subagent. An unattended full-access lease granted by the user to the master agent auto-approves all non-destructive commands executed by background subagents.
3. **Tmux Interactive Shell Execution vs Pipe Discrepancy**: While `desktop_run` is documented as invoking commands directly without a shell, when `visible` is enabled commands are typed into an active interactive bash shell via `tmux send-keys`.
4. **Rich Text / HTML Injection in Recap Card**: While `SEC3-03` patched `ui/ApprovalOverlay.qml` with `textFormat: Text.PlainText`, [`ui/RecapCard.qml`](file:///home/dada/Work/omatron/ui/RecapCard.qml#L143-L153) lacks this declaration, leaving end-of-run notifications vulnerable to HTML markup injection.
5. **Installer/Uninstaller Lifecycle Residue**: `desktop-agent uninstall` leaves dangling symlinks in `~/.local/bin/`, orphan systemd `.service` files in `~/.config/systemd/user/`, and dangling MCP configurations in `~/.claude.json`, `~/.gemini/settings.json`, `~/.codex/config.toml`, and `~/.config/opencode/opencode.json`.
6. **Strong Subsystems (What Held Up)**: The scheduled jobs engine (`voice/runjob.ts` & `voice/schedule.ts`) rigorously enforces `JOB_CAPS`, resists YOLO lease elevation, prevents recursive self-scheduling, and handles 90-day timer expiration and self-healing cleanly. PASS6-02 (`sessionAlways` ordering below `noYolo` and severity propagation) and all Round 3 patches held up under verification.

---

## 1. Vulnerability Findings & Evaluations

Findings are ranked by concrete impact:
- **Grants Capability**: Defeats a stated boundary or policy restriction to grant unauthorized control.
- **Hardening**: Closes defense-in-depth gaps, state leaks, or architectural inconsistencies.
- **Cosmetic / Hygiene**: Visual anomalies, dead code, or cleanup omissions.

---

### [FINDING 4-01] PASS6-01 Bypass: Single-Dash Flag Laundering in `checkLaunchArgs()`
- **Severity**: **GRANTS CAPABILITY** (High/Critical)
- **Location**: [`server/server.ts:927-953`](file:///home/dada/Work/omatron/server/server.ts#L927-L953)
- **Status**: Reproduced directly against live binary.

#### Mechanism & Reproduction
In commit [`fc60069`](file:///home/dada/Work/omatron), `checkLaunchArgs()` was added to prevent `desktop_launch` from accepting flags like `--user-data-dir`:
```typescript
const LAUNCH_FORBIDDEN = [
  "--user-data-dir", "--profile-directory", "--disk-cache-dir",
  "--remote-debugging-port", "--remote-debugging-pipe", ...
]

function checkLaunchArgs(app: string, argv: string[]): void {
  for (const a of argv) {
    const flag = a.split("=")[0]
    if (LAUNCH_FORBIDDEN.includes(flag)) {
      throw new Refused(...)
    }
  }
}
```
Chromium's POSIX command-line parser (`base/command_line.cc`) accepts both `"--"` and `"-"` prefixes for all switches:
```cpp
#if BUILDFLAG(IS_POSIX) || BUILDFLAG(IS_FUCHSIA)
const CommandLine::CharType kSwitchPrefixes[][4] = {"--", "-"};
#endif
```

#### Test Executed
1. **Filter validation in Bun**:
   ```bash
   bun -e '
   const LAUNCH_FORBIDDEN = ["--user-data-dir", "--remote-debugging-port"];
   const flag = "-user-data-dir=/home/dada/.config/chromium".split("=")[0];
   console.log("Allowed?", !LAUNCH_FORBIDDEN.includes(flag));
   '
   ```
   **Output**: `Allowed? true`
2. **Execution test against Chromium**:
   ```bash
   chromium --headless=new --dump-dom -user-data-dir=/tmp/chromium-test-profile about:blank
   ls -d /tmp/chromium-test-profile/Default
   ```
   **Output**: Directory `/tmp/chromium-test-profile/Default` created and populated.

#### Impact
An agent can execute:
```json
desktop_launch({ "app": "browser", "args": ["-user-data-dir=/home/dada/.config/chromium"] })
```
or `-remote-debugging-port=9222`. The arguments pass `checkLaunchArgs()` without refusal. Chromium launches with the user's authentic profile, exposing logged-in cookies and credentials to the agent's window input tools (`desktop_screenshot`, `desktop_type`, `desktop_key`).

#### Remediation
Deny-lists for complex binaries like Chromium fail because flag formats, synonyms, and environment variables are unbounded. Instead:
1. Strip leading hyphens when checking flags: `flag.replace(/^-+/, "--")`.
2. Better: **Disallow flags entirely for launched applications**. If `args: true` is set on `browser`, only allow arguments matching valid URLs (`/^https?:\/\//i`) or local file paths. If the app is `files`, only allow directory paths.

---

### [FINDING 4-02] Background Subagents Inherit Master's Global YOLO Lease
- **Severity**: **HARDENING / POLICY SCOPE** (Medium)
- **Location**: [`server/server.ts:1520-1539`](file:///home/dada/Work/omatron/server/server.ts#L1520-L1539)
- **Status**: Confirmed by code inspection.

#### Mechanism
When a user clicks "Full Access" on the panel, `yolo.json` is written to disk with an expiration timestamp. In `server/server.ts`:
```typescript
const ROLE = process.env.DESKTOP_AGENT_ROLE?.trim() || "subagent"
const IS_SUBAGENT = ROLE !== "master"
...
// Inside gate():
const y = await yoloState(policy)
if (y.active) {
  if (!noYolo) {
    ...
    return // Auto-approved!
  }
}
```
`yoloState()` evaluates the global file `yolo.json`. It does **not** check `IS_SUBAGENT`.
`voice/subagent.ts` sets `DESKTOP_AGENT_ROLE: name` (`sub-1`), which sets `IS_SUBAGENT = true`.
While `MASTER_ONLY` prevents subagents from using browser, mouse, keyboard, or scheduling tools, subagents *are* permitted to call `desktop_run`, `desktop_write_file`, etc.

#### Impact
The user grants a YOLO lease to the master voice agent to avoid interactive confirmation prompts during a specific foreground workflow. If the master agent delegates work to multiple background subagents, every subagent's unlisted shell commands and file writes (`action: "ask"`) are silently auto-approved across all subagent threads without prompting the user.

#### Remediation
In `gate()`, restrict YOLO lease auto-approval strictly to the master role:
```typescript
if (y.active && !IS_SUBAGENT) {
```
If a subagent requires an action that evaluates to `ask`, it should either be refused (because subagents are meant for headless, non-interactive execution) or explicitly require human confirmation.

---

### [FINDING 4-03] Interactive Shell Execution Inconsistency in `sendToAgentTerminal`
- **Severity**: **HARDENING / BOUNDARY INTEGRITY** (Medium)
- **Location**: [`voice/workspace.ts:203-258`](file:///home/dada/Work/omatron/voice/workspace.ts#L203-L258)
- **Status**: Confirmed by inspection and tmux session reproduction.

#### Mechanism
`policy.default.jsonc` specifies:
> *"desktop_run takes a program plus an argument LIST, never a shell line. There is no pipe, no glob, no $(...) and no redirection, which is what makes the rules below mean what they say: the first token is always the real binary, so 'bash' cannot be smuggled in as 'sh -c ...'."*

When `VISIBLE_RUNS` is enabled and confinement workspace is active, `desktop_run` does not execute via direct process spawn (`execve`). Instead, it executes:
```typescript
const cd = cwd ? `cd ${shq(cwd)} && ` : ""
Bun.spawnSync(["tmux", "send-keys", "-t", TARGET, `${cd}da ${id} ${argv.map(shq).join(" ")}`, "Enter"])
```
This types the command string into a live, interactive Bash shell running inside a tmux window.
Inside that shell, `da` is a shell function:
```bash
da() { local id=$1; shift; "$@" > run-$id.out 2>&1; rc=$?; cat run-$id.out; echo $rc > run-$id.code; return $rc; }
```

#### Implications
1. **Interactive Shell Side Effects**: The command executes within an interactive login shell environment (`~/.bashrc`, aliases, shell traps, history expansion, readline bindings).
2. **Subprocess Orphan Leaks on Timeout**: If a command times out, `abortAgentTerminal()` sends `tmux send-keys C-c` and `C-u`. Unlike the pipe path (`proc.kill(9)` / process tree termination), sending `SIGINT` to the foreground process group does not terminate detached child processes, processes that trap or ignore `SIGINT`, or commands waiting on background jobs.

#### Remediation
In `ensureAgentTerminal`, run commands via a dedicated non-interactive runner script rather than typing arbitrary command lines into an open interactive shell.

---

### [FINDING 4-04] Rich Text / HTML Injection in `ui/RecapCard.qml`
- **Severity**: **COSMETIC / HARDENING** (Low)
- **Location**: [`ui/RecapCard.qml:142-154`](file:///home/dada/Work/omatron/ui/RecapCard.qml#L142-L154)
- **Status**: Confirmed by code inspection.

#### Mechanism
In Round 3, finding `SEC3-03` fixed rich text injection in `ui/ApprovalOverlay.qml` by declaring `textFormat: Text.PlainText`.
However, `ui/RecapCard.qml` renders the summary lines emitted by `describeCall()`:
```qml
Repeater {
  model: root.recap ? root.recap.lines : []
  Text {
    width: col.width
    text: (modelData.tone === "bad" ? "✕  " : modelData.tone === "warn" ? "!  " : "·  ") + modelData.text
    color: modelData.tone === "bad" ? Theme.danger
      : modelData.tone === "warn" ? Theme.caution
      : Theme.cardTextSecondary
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }
}
```
`describeCall()` in `server/server.ts` formats tool inputs directly into `recap.lines`, including visited URLs (`opened ${args.url} in the agent browser`) and command arguments (`ran ${args.join(" ")}`).

Because Qt Quick's `Text` defaults to `Text.AutoText`, if an agent accesses a URL or runs a command with HTML tags (e.g. `<font color="...">` or `<b>`), Qt parses and renders it as rich text formatting in the desktop recap notification toast.

#### Remediation
Add `textFormat: Text.PlainText` to the `Text` element in [`ui/RecapCard.qml:143`](file:///home/dada/Work/omatron/ui/RecapCard.qml#L143).

---

### [FINDING 4-05] Uninstaller Residue and Broken Post-Removal State
- **Severity**: **COSMETIC / HYGIENE** (Low)
- **Location**: [`bin/desktop-agent:423-464`](file:///home/dada/Work/omatron/bin/desktop-agent#L423-L464)
- **Status**: Confirmed by code inspection.

#### Mechanism
`desktop-agent uninstall` performs the following steps:
1. Cancels scheduled jobs via `jobs-cli.ts cancel all`.
2. Disables systemd services `desktop-agent-voice` and `desktop-agent-stt`.
3. Warns the user to clean up `~/.config/hypr/bindings.lua`.

It omits cleanup for:
1. **Command symlinks**: The symlinks created by `desktop-agent link` in `~/.local/bin` (`desktop-agent`, `desktop-agent-config`, `desktop-agent-listen`) are not unlinked and become broken symlinks once the plugin folder is deleted.
2. **Systemd unit files**: The unit files in `~/.config/systemd/user/` (`desktop-agent-voice.service`, `desktop-agent-stt.service`) are disabled but remain on disk.
3. **MCP client registrations**: `~/.claude.json`, `~/.gemini/settings.json`, `~/.codex/config.toml`, and `~/.config/opencode/opencode.json` retain `mcpServers.desktop` pointing to the deleted plugin's `server/server.ts`. After uninstall, starting Claude Code, Gemini CLI, or Codex displays startup errors attempting to load the missing server script.

#### Remediation
In `bin/desktop-agent` under `uninstall`:
- Remove symlinks matching `~/.local/bin/desktop-agent*`.
- Remove unit files from `$UNITS/desktop-agent-*.service` and run `systemctl --user daemon-reload`.
- Provide an uninstaller option or automated script to remove the `desktop` MCP entry from the 4 agent configuration files.

---

### [FINDING 4-06] Legacy Voxtype Integration (`voice/watch.ts`) Divergence
- **Severity**: **HYGIENE / DEAD CODE** (Low)
- **Location**: [`voice/watch.ts:177-208`](file:///home/dada/Work/omatron/voice/watch.ts#L177-L208) and [`bin/desktop-agent-arm`](file:///home/dada/Work/omatron/bin/desktop-agent-arm)
- **Status**: Confirmed by code inspection.

#### Mechanism
`voice/watch.ts` is the predecessor to `voice/voiced.ts`, designed to follow `voxtype status --follow`. It remains invoked by `bin/desktop-agent-arm`.
Inspection revealed that `watch.ts` has diverged from the rest of the codebase:
1. It queries obsolete settings keys: `settingStr("aiAssist", ...)` and `settingStr("aiProvider", ...)` instead of `"ai.assist"` and `"ai.provider"`.
2. It passes an outdated `aiProposal` payload shape (`{ argv: string[] }` instead of `{ steps: string[][] }`), which will fail schema validation if fed into modern `execute.ts`.

#### Remediation
Deprecate or delete `bin/desktop-agent-arm` and `voice/watch.ts` now that `voiced.ts` provides native push-to-talk audio streaming with PipeWire.

---

## 2. Verification of Prior Fixes & Subsystems (What Held Up)

The following components and earlier patches were verified and confirmed solid:

| Subsystem / Finding | File / Component | Verification Result |
| :--- | :--- | :--- |
| **Scheduled Job Execution** | [`voice/runjob.ts`](file:///home/dada/Work/omatron/voice/runjob.ts), [`voice/schedule.ts`](file:///home/dada/Work/omatron/voice/schedule.ts) | **PASSED**: End-to-end trace under systemd timer verified. `JOB_CAPS` correctly passed via environment; `gate()` strictly validates `JOB_CAPS.has(cap)`. Unattended jobs cannot auto-approve destructive commands (`blocked = noYolo ?? unattended`). `desktop_schedule` is not callable by scheduled jobs. Expiration (90 days) self-cleans. |
| **PASS6-02 (Always & Severity)** | [`server/server.ts:1505-1565`](file:///home/dada/Work/omatron/server/server.ts#L1505-L1565) | **PASSED**: `sessionAlways` is now evaluated *after* `noYolo` check. Approval scope includes arguments (`app:${args.app} ...`, `cmd:${base} ...`). `severity` is sent with every approval request, enabling `ApprovalOverlay.qml` to correctly withhold the "Always" button on destructive actions. |
| **SEC3-01 (Overlay Layout)** | [`ui/ApprovalOverlay.qml`](file:///home/dada/Work/omatron/ui/ApprovalOverlay.qml) | **PASSED**: Buttons are pinned to the bottom of the card outside the scrolling content area. Extreme string overflows no longer conceal `Deny` or `Allow once`. |
| **SEC3-02 (STT SSRF Proxy)** | [`stt/server.py`](file:///home/dada/Work/omatron/stt/server.py) | **PASSED**: Vestigial `transcribe_remote` function and `urllib` imports were completely deleted. Server only handles local inference. |
| **SEC3-03 (Overlay TextFormat)** | [`ui/ApprovalOverlay.qml`](file:///home/dada/Work/omatron/ui/ApprovalOverlay.qml) | **PASSED**: Untrusted text fields in the approval dialog are pinned to `textFormat: Text.PlainText`. |
| **SEC3-04 (Symlink Preservation)** | [`bin/desktop-agent-config`](file:///home/dada/Work/omatron/bin/desktop-agent-config#L336) | **PASSED**: `_edit_policy()` resolves `os.path.realpath(path)` prior to acquiring locks and creating temporary swap files. |
| **Master-Only Tools Isolation** | [`server/server.ts:226-268`](file:///home/dada/Work/omatron/server/server.ts#L226-L268) | **PASSED**: `MASTER_ONLY` comprehensively rejects browser, typing, mouse, scheduling, and delegation calls from subagents. |

---

## 3. What Was NOT Covered

In accordance with audit standard 4, the following areas were excluded or only partially inspected:
1. **Wayland Compositor Internals**: We did not audit the C++ source code of Hyprland or Quickshell themselves; all interactions were evaluated at the IPC and layer-shell protocol boundaries.
2. **Third-Party Model Runner Binaries**: The internal implementations of `claude`, `gemini`, `codex`, and `opencode` CLIs were treated as black-box binaries running on the host.
3. **Audio Hardware Driver Stack**: PipeWire and ALSA kernel driver interactions were not examined beyond the standard `pw-record` CLI interface.

---

## 4. Architectural Analysis & Answers to Specific Questions

### Question A: Defining the Threat Model Boundary for an Agent Running as the User
> *"The threat model is 'an agent running as the user'. That adversary has the user's privileges by construction, so almost any local capability is in scope and the surface has no natural boundary. Where should the line actually be drawn, and which current findings fall outside it?"*

#### Where the Line Must Be Drawn
Because the agent runs under the user's UID (1000), this system is **not** a Mandatory Access Control (MAC) boundary in the operating system kernel sense. It cannot prevent a process with UID 1000 from reading an unencrypted file owned by UID 1000 if that process has an open shell.

The true security boundary of Omatron is a **Supervisory Control and Confinement Envelope**:
1. **Gating Integrity**: The agent must never be able to approve its own actions, forge approvals, manipulate the Quickshell UI to click "Allow", or grant itself a YOLO lease.
2. **The Destructive Floor**: Irreversible operations (data destruction, formatting, modifying the policy itself) must halt for human presence regardless of autonomous settings.
3. **Session & Identity Isolation**: The agent must not inadvertently reach or drive the user's authenticated identities (such as the personal browser profile or password managers).
4. **Subagent Containment**: Delegated subagents must remain bounded micro-workers without permission to escalate to foreground interaction.

#### Which Findings Fall Outside the Legitimate Boundary
- **Same-UID IPC Access from Host Processes**: Findings that argue "any local script on the machine can write to `desktop-agent-voice.sock` or modify `~/.local/state/desktop-agent`" fall outside the threat model. In standard POSIX security, processes running under the same UID already have arbitrary control over each other via `ptrace`, `/proc/<pid>/mem`, and direct file writes.
- **Uninstaller Artifacts (Finding 4-05)**: Leaving dangling symlinks or dead MCP configurations in dotfiles is an operational lifecycle flaw, not an exploit vector.
- **Loopback CDP Exposure without Sandbox (SEC3-05)**: If an agent runs unconfined on the host, loopback TCP connections to localhost ports are normal user activity. It *only* becomes a valid vulnerability when applied to an agent that was explicitly declared to be "sandboxed" away from the desktop (via `bwrap`).

---

### Question B: Systemic Defect vs Expanding Coverage
> *"Six passes have each found new issues in code the previous passes did not read. Is that coverage expanding, or is there a systemic defect generating them? If systemic, name it."*

While coverage has expanded into previously unreviewed modules, the fact that almost every new file inspected reveals a security flaw points directly to a systemic defect.

The systemic defect is:  
### **"Symptomatic Mitigation via String Filtering instead of Primitive Reduction"**

Throughout the project's evolution, when a vulnerability was identified, the remediation almost always took the form of **adding an ad-hoc regex, string check, or deny-list entry**, rather than **constraining the underlying primitive**:

1. **`LAUNCH_FORBIDDEN` vs Argument Typing**: When PASS6-01 discovered that Chromium arguments allow opening the real profile, the fix was a deny-list of 20 Chromium string flags. Because command-line flag syntax has multiple representations (`--flag`, `-flag`), the deny-list was bypassed immediately. The proper fix was primitive reduction: `launch.browser` should take a structured `{ url: string }` and construct its own fixed command line.
2. **`desktop_run` vs Tmux Injection**: The policy defines `desktop_run` as an argument list with no shell expansion. But when visible execution was added, arguments were shell-quoted and typed into an interactive Bash prompt in tmux.
3. **HTML / Text Injection Across Surfaces**: When HTML injection was identified in `ApprovalOverlay.qml`, `PlainText` was added to that single file, while `RecapCard.qml` retained the default `AutoText` behavior for the same underlying data.
4. **Dual Execution Pipelines**: When the speech pipeline was rewritten from `voxtype` to native `pw-record` + `stt/server.py`, the old `bin/desktop-agent-arm` and `voice/watch.ts` scripts were left in place with outdated settings and schemas.

### Strategic Recommendation
To bring the plugin to architectural stability:
1. **Retire Deny-Lists on Command Flags**: Replace arbitrary CLI argument passing in `desktop_launch` with typed parameters (e.g. `url` or `path`).
2. **Enforce Global Consistency in UI Text**: Set `textFormat: Text.PlainText` across all QML text items displaying agent-derived data.
3. **Isolate Subagents from Master Leases**: Explicitly restrict YOLO leases to `ROLE === "master"`.
4. **Prune Deprecated Code Paths**: Remove `watch.ts` and `desktop-agent-arm` to eliminate dual-stack maintenance divergence.
