# Independent security review — Omatron

**Repo**: `/home/dada/Work/omatron` · **Commit**: `HEAD` on `master` (after the
Gemini remediation commit)
**Reviewer**: Claude, working from the source and from live probes on this
machine. Scope deliberately avoids re-treading the previous audit: everything
below is a distinct finding, and every one was reproduced before it was written
down.

## What this did and did not cover

Reproduced on the running system: window-identity matching, the audit log,
role assignment, the write-path resolver, and the planner's context assembly.

**Not covered**, and worth a separate pass: the STT path and audio handling,
the Quickshell IPC surface as reachable from other local processes, the
scheduling/systemd-timer path, `magick`'s handling of hostile image input
during screenshot redaction, and the MCP bridge under concurrent connections.
Absence from this report is not evidence of absence.

---

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| **SELF-01** | **HIGH** | Window identity is asserted by the process being judged — a terminal launched as `--app-id=agent-browser` gets `input: allow` | Reproduced |
| **SELF-02** | **MEDIUM** | The privileged role is the default: an MCP server with no `DESKTOP_AGENT_ROLE` is a master | Confirmed in source |
| **SELF-03** | **MEDIUM** | Audit lines can be forged — window titles reach the log unescaped and titles contain newlines if a page wants them to | Reproduced |
| **SELF-04** | **LOW** | TOCTOU between path resolution and write | Confirmed in source |
| **SELF-05** | **LOW** | Cross-turn prompt injection through the history context | Confirmed in source |

---

## [SELF-01] Window rules trust identity chosen by the window — HIGH

### The defect

`windowSubjects()` (`server/server.ts:852`) builds the strings an app rule is
matched against:

```ts
const windowSubjects = (w: Win) => [
  `class:${w.class}`, `initialclass:${w.initialClass ?? ""}`,
  `title:${w.title}`, `initialtitle:${w.initialTitle ?? ""}`,
  `pid:${w.pid}`, w.class, w.title,
]
```

Every one of `class`, `initialClass`, `title` and `initialTitle` is set **by the
process being judged**. `class` comes from a command-line flag; `title` is
`document.title` for anything in a browser. So the policy asks the subject to
present its own credentials and then believes them.

### Reproduced

A real terminal, launched with a flag any process may pass:

```
$ foot --app-id=agent-browser -T probe sh -c 'sleep 25'
window: class='agent-browser' initialClass='agent-browser' title='probe'
```

Replaying the rule evaluation against the live `policy.jsonc` — same binary,
two identities:

```
class=foot            -> rule 'class:foot'           input = (unset -> deny)
class=agent-browser   -> rule 'class:agent-browser'  input = allow
```

`class:foot` deliberately grants `see`/`focus`/`manage` and withholds `input`,
because typing into a terminal is how an agent escapes every other rule — it is
also the first thing `~/.claude/agents/desktop.md` forbids in prose. Claiming
the browser's name turns that deny into an allow.

The launch step is reachable: `foot`, `kitty`, `alacritty` and `wezterm` are all
unlisted in `run.commands`, so they fall through to `"*": "ask"` — which a
full-access lease auto-approves.

The same flaw runs the other way, through titles. A page picks its own:

```
title='Bitwarden — Vault'   -> 'title:*Bitwarden*'  input=deny
title='Daltech dashboard'   -> 'title:*DALTECH*'    input=allow
```

A page that wants to be typed into simply calls itself `Daltech`. A previous
audit noted the *evasion* half (a login page that avoids the word "Login" is
not caught by `title:*Login*`). The **assertion** half is worse: a window can
select the most permissive rule in the file.

### Why it matters more than it looks

This is not one bad rule. It is the identity model: every `apps` rule in every
user's policy inherits it, and the more carefully someone writes rules the more
attack surface they create, because each new `allow` is another name worth
claiming.

### Suggested remediation

Match on something the process does not choose. The kernel already knows:

```ts
// Resolved from the pid the compositor reports, not from anything the
// window says about itself.
const exe = await fs.readlink(`/proc/${w.pid}/exe`).catch(() => "")
subjects.push(`exe:${exe}`, `exe:${path.basename(exe)}`)
```

Then `exe:/usr/bin/foot` identifies a terminal whatever it calls itself, and
policies can be written against `exe:` for anything that matters. Keep `class:`
and `title:` — they are convenient and usually honest — but document them as
hints, and prefer the strictest match when `exe:` and `class:` disagree rather
than letting last-match-wins hand the decision to the claimant.

A cheaper partial fix, worth doing regardless: deny the terminal binaries by
name in `run.commands`, so the launch step is not free under a lease.

---

## [SELF-02] The privileged role is the default — MEDIUM

`server/server.ts:204`:

```ts
const ROLE = process.env.DESKTOP_AGENT_ROLE?.trim() || "master"
const IS_SUBAGENT = ROLE !== "master"
```

`MASTER_ONLY` — the browser, delegation, scheduling, mouse, keyboard — is
enforced by `IS_SUBAGENT`. Absence of the marker therefore grants the
privileged role. Every failure mode points the same way: an env var dropped by
a wrapper, a runner that sanitises its child environment, a config written
without the `env` block, or a subagent that starts a server itself. All of them
produce a master.

This is the one direction a default should never fail in, and it costs nothing
to invert: make the *master* prove itself.

```ts
// A master is declared. Anything that arrives without a declaration is
// treated as a subagent, because that is the safe direction to be wrong in.
const ROLE = process.env.DESKTOP_AGENT_ROLE?.trim() || "subagent"
```

`voice/agent.ts:196` already sets `DESKTOP_AGENT_ROLE: "master"` explicitly for
the real master, and `desktop-agent mcp-install` writes the env block for every
runner — so the honest paths already declare themselves and would not change
behaviour. What changes is what happens when something goes wrong.

---

## [SELF-03] Audit lines can be forged — MEDIUM

`audit()` (`server/server.ts`) appends the caller's string verbatim:

```ts
await fs.appendFile(AUDIT_PATH, `${new Date().toISOString()} ${line}\n`)
```

and several call sites interpolate a window title:

```ts
await audit(policy, `window ${args.action} ${w.class} "${w.title}" ${w.address}`)
await audit(policy, `typed secret "${args.name}" into ${w.class} "${w.title}"`)
```

A title is whatever a page says it is, newlines included. One call then writes
several lines:

```
2026-09-07T02:00:00.000Z window close chromium "ok"
2026-09-07T00:00:00.000Z yolo desktop_run rm -rf / -> auto-approved (59 min left)
x" 0x1
```

No capability is gained. What is lost is the record — and the record is what
this plugin points people at: refusals cite it, `doctor` reports it, the recap
is built from it. A log that can be written by the thing it is logging cannot
answer "what did the agent actually do", which is the only question it exists
for.

Fix is one function: `JSON.stringify` the interpolated fields, or strip
`[\r\n]` at the `audit()` boundary so no call site has to remember.

---

## [SELF-04] TOCTOU between resolution and write — LOW

`realPath()` resolves the deepest existing ancestor and rejoins the tail, and
`openForWrite()` gates on the resolved path and returns it — so the resolved
path is what gets written. That part is correct, and I checked it specifically
because a resolve-then-write-the-original bug would have been critical.

The gap is time. Between `realPath()` and `fs.writeFile()`, a component of the
path can become a symlink. Exploiting it needs a concurrent writer — the agent
holds one via a backgrounded `desktop_run` — and a race window of a few
milliseconds, so this is genuinely low. Closing it properly means opening with
`O_NOFOLLOW` on the final component and writing to the descriptor rather than
re-opening by name.

---

## [SELF-05] Cross-turn injection through history context — LOW

`voice/history.ts:100` builds planner context from previous turns:

```ts
return `- (${when}) they said "${t.said}" -> ${t.did}`
```

`t.did` for a tier-4 run is the agent's own summary, which can contain text it
read from a page. That text lands in the next planning prompt with no
delimiter and no escaping, and the surrounding instruction ("Use it only to
resolve what the person is referring to") is the only thing separating data
from instruction.

The blast radius is small: whatever the planner proposes is filtered by
`checkProposedCommand` and then shown for approval with the exact argv on
display. So this is a nudge, not a bypass. Worth fencing anyway — the
containing prompt already does the right thing for the command catalogue, and
history deserves the same treatment.

---

## What held up

Worth recording, because a review that only lists faults implies the rest was
not examined:

- **The resolved path is what gets written.** `openForWrite` returns `abs` and
  every caller uses it. No resolve-then-write-original bug.
- **The secret store never returns a value upward.** Exercised both tools with
  a stored secret: the value appears zero times in anything returned to the
  caller, and the audit line carries the name only.
- **Window rules still apply to credentials.** `desktop_type_secret` into a
  terminal refuses on `app "input" -> deny` before the store is ever read.
- **The lease cannot reach a deny.** `gate()` returns at `deny` before the
  lease is consulted; the promotion path only ever turns `ask` into `allow`.
- **Redaction survives into saved captures.** The kept PNG has the black box
  with the red border where a denied window was.

---

## Ranked plan

1. **SELF-01** — add `exe:` subjects from `/proc/<pid>/exe`; deny terminal
   binaries in `run.commands`. This is the one that grants capability.
2. **SELF-02** — default `ROLE` to `subagent`. One line, no behaviour change on
   the honest paths.
3. **SELF-03** — strip newlines at the `audit()` boundary.
4. **SELF-05** — fence history context the way the catalogue is fenced.
5. **SELF-04** — `O_NOFOLLOW` on write, when the write path is next touched.
