# Omatron

**Say what you want, and your desktop does it — on a leash you own.**

Press `F10` and say *"workspace three"*, *"close discord"*, or *"find me a
4-star hotel near the airport under 15,000 dinars"*. The first is answered in
under a millisecond from a declared list. The second resolves a window by name.
The third opens a browser, reads results, compares them and writes you a note.

Same sentence, three completely different amounts of machinery — chosen by what
the sentence needs, not by what it costs.

Everything that touches your machine passes one default-deny policy: an approval
overlay for anything irreversible, an audit line for everything that runs, and a
kill switch that is a single line in a file you own.

> **Omatron replaces Omarchy's dictation.** It ships its own speech stack
> (faster-whisper locally, or Groq remotely) and the setup instructions unbind
> Voxtype's `F9` and `SUPER+CTRL+X`, because two engines on one key would both
> record. That handover is printed for you to paste, never applied behind your
> back, and `desktop-agent uninstall` prints the exact lines to remove if you
> ever want Voxtype back.

## Installing

```bash
omarchy plugin add https://github.com/Zedster07/omatron --enable
```

That clones it into `~/.config/omarchy/plugins/` and registers it with the
shell, which is what gives you the panel, the HUD and the approval overlay.
Then, from that directory:

```bash
~/.config/omarchy/plugins/io.github.zedster07.desktop-agent/bin/desktop-agent setup
```

`setup` seeds the policy, installs and starts the voice daemon, links the
commands into `~/.local/bin`, and prints the keybindings to paste into
`~/.config/hypr/bindings.lua`. Paste them, `hyprctl reload`, and press `F10`.

Two things it cannot do for you:

**An API key.** Transcription runs against Groq by default, so nothing is
downloaded — get a free key at [console.groq.com](https://console.groq.com) and
paste it into the panel's voice tab. Prefer to keep audio on the machine? Pick
`local` in the same tab; it shows the download size and asks first.

**The agent half.** Tiers 3 and 4 need an agent CLI. If you have Claude Code:

```bash
desktop-agent mcp-install     # registers the desktop tools
desktop-agent agent-check     # confirms the agent is confined to them
```

Then `desktop-agent doctor` tells you what is still missing. It checks the two
things a fresh install most often gets wrong — commands not on `PATH`, and the
plugin not registered with the shell — because both fail silently: the
keybindings do nothing and the panel shows blanks.

### Removing it

```bash
desktop-agent uninstall                 # cancels schedules, stops services
omarchy plugin remove io.github.zedster07.desktop-agent
```

`uninstall` prints the exact keybinding lines to delete from your
`bindings.lua`, with line numbers. Those are the one thing that outlives the
plugin: the `hl.unbind("F9")` it asked you to add keeps working after it is
gone, so Voxtype would stay dead until you remove them.

## Two front-ends, one gate

```
  VOICE                                AGENT (optional)
  F9   dictate  ─┐                 ┌── Claude Code, or any MCP client
  F10  command  ─┤                 │
                 ▼                 ▼
          ┌──────────────┐   ┌──────────────────┐
          │ capture+VAD  │   │ INTENT REGISTRY  │
          │ stt/server.py│──▶│ declared templates│
          └──────────────┘   └────────┬─────────┘
                                      ▼
                             ┌──────────────────┐
                             │  POLICY ENGINE   │  allow · ask · deny
                             └────────┬─────────┘
                                 ┌────┴────┐
                             approval    audit
                              overlay     log
```

## The speech stack

This plugin owns the whole speech path: capture, VAD, transcription,
filtering, injection.

**Transcription is remote by default and downloads nothing.** A free Groq key
gets you `whisper-large-v3-turbo` — a far larger model than anything that
runs comfortably on a laptop CPU, with no install and no disk cost. Paste the
key into the panel's voice tab and it works.

**Local is one dropdown away, and it asks first.** Choosing it shows exactly
what will be downloaded before anything happens:

```
local transcription needs a download
speech packages 432 MB  ·  model small.en 464 MB  —  896 MB total,
kept on this machine.
       [ Download and switch ]   [ Stay on remote ]
```

Nothing is fetched without that yes, and the numbers are measured rather than
guessed. Already have the packages? It only counts the model.

### Why not the dictation tool that ships with Omarchy

The first version wrapped voxtype, on the reasoning that a plugin should not
reinvent something shipping with the OS. Three things changed that: voxtype's
released build accepts a remote-transcription config and silently ignores it,
it exposes no vocabulary biasing, and integrating through a result file plus a
status stream produced three separate bugs in that seam alone.

The deciding number was the runtime. Same machine, same 5s clip:

| engine | |
|---|---|
| faster-whisper `base.en`, CPU int8 | **0.96s** |
| faster-whisper `small.en`, CPU int8 | **2.02s** |
| whisper.cpp (voxtype) on the Vulkan iGPU | 13.06s |

CTranslate2 beats whisper.cpp six times over here, on the CPU, with the larger
model. Owning the pipeline turned out to be less code than working around not
owning it.

### What makes the transcript trustworthy

Both paths apply the same discipline: VAD **before** decode, forced language,
temperature 0, no conditioning on previous text, and per-segment confidence
thresholds. A decoder handed silence writes plausible sentences, so the
silence never reaches it.

## Two ways in

**Speak it.** Hold `F9` to dictate into whatever has focus, `F10` to give a
command.

**Type it.** `SUPER + F1` opens a prompt in the middle of the screen. Same
tiers, same policy, same approval — the only difference is that it skipped the
microphone. Useful when a name is hard to say, when the room is loud, or when
you want to see the request before it runs.

`F9` dictate · `F10` command · `SUPER+F1` prompt · `SUPER+F2` cancel.

Two rules behind those, both learned by getting them wrong:

**Position, not character.** A layout moves punctuation and letters but never
function keys. `/` is Shift+: on AZERTY and elsewhere again on other layouts,
so binding it works only for whoever picked it.

**Check `hyprctl binds`, not `omarchy menu keybindings --print`.** The latter
lists only bindings that were given a description, so one registered without
a description looks free and is not. `desktop-agent keybinds` now checks the
real table and tells you about a collision — including the case where a key
legitimately carries two bindings because one is press and one is release.

## Four tiers, escalating

Most requests never reach a model at all.

| tier | who decides | when |
|---|---|---|
| **1 match** | nobody — string comparison | a registered phrase. Sub-millisecond. |
| **2 route** | AI picks from the same list | an unregistered wording of a known command |
| **3 plan** | AI writes commands | something the list does not cover: playing a song, opening a URL |
| **4 agent** | AI drives the desktop | anything not expressible as commands at all |

Tier 4 is a hand-off to the agent half of this plugin: it can take a
screenshot, click a particular thing, and react to what it finds. It is opt-in,
and the safety is not new — every action goes through the same policy engine,
approval overlay and audit log, and it fails closed if the overlay is not
loaded.

That half ships here: `server/` is the MCP server, the policy engine and the
Hyprland plumbing. `desktop-agent mcp-install` registers it with Claude Code,
pointing at this plugin's copy. One plugin, one policy, one overlay — an
install that half-works because it is driving someone else's server is not
something anyone can ship.

The agent gets `mcp__desktop__*` and nothing else: no file editing, no shell,
no tools of its own. `--permission-mode bypassPermissions` means "do not add a
second prompt on top of the one the policy already shows" — the person is
talking, not watching a terminal — not "skip the checks".

Anything a model decided still needs your approval before it runs.

## The action space is a registry, not a prompt

This is the design decision everything else follows from. A spoken phrase is
matched against declared templates with typed slots:

```json
{
  "id": "workspace.switch",
  "phrases": ["workspace {n}", "go to workspace {n}"],
  "slots": { "n": { "type": "number", "min": 1, "max": 10 } },
  "run": ["hyprctl", "dispatch", "workspace", "{n}"]
}
```

No language model decides what to run. That makes it **fast** (matching is
string work, so the hook returns in ~130ms and cannot trip Voxtype's timeout),
**offline**, **auditable**, and — most importantly — **bounded**. It can only
ever do things someone declared.

A phrase that does not match well enough is reported as unrecognised. It is
never guessed at, and never quietly typed into whatever window had focus.

Two rules earn their keep:

- **Filler words are stripped**, so *"could you please switch to workspace two"*
  hits the same template as *"workspace 2"*.
- **Homophone digits are not.** Mapping `"to"→2` looked helpful and silently
  turned *"set volume to seventy"* into 2%. A preposition is far more common
  than the digit it sounds like, and a wrong action is much worse than an
  unmatched one — an unmatched one says so.

## Which model, and why sonnet

The resolve call is small: a catalogue in, a line of JSON out. That is not the
shape that needs the most capable model, so it defaults to **sonnet**.

Measured on this workload, same prompts, same machine:

| | median | hard cases | price per Mtok |
|---|---|---|---|
| sonnet | 6.1s | 7/7 | $2 in / $10 out |
| opus | 6.6s | 7/7 | $5 in / $25 out |

Identical answers on every case, including the ones that must decline or must
escalate. Sonnet is marginally faster and 2.5x cheaper, so it is the default;
change it in the panel's ai tab.

Worth knowing where the time actually goes: most of those six seconds is
`claude -p` process startup, not inference. Model choice barely moves it —
which is also why a faster model is not the lever for making this feel
instant. More registered phrases is.

## Which AI, and when

Most commands never reach a model: a registered phrase is matched by string
comparison in under a millisecond.

On a miss, your installed CLI agent is asked to pick from the same list —
claude first, then opencode, codex, gemini, with a local Ollama model as the
fallback for a machine that has none. The agent is preferred because the job
is mostly about saying *"none of these"*, and that is the single thing a small
local model is worst at: asked to route "play Despacito on YouTube", a 3B
model picked `audio.mute`.

That accuracy costs about ten seconds on the miss path instead of five, and
tokens. Set `aiProvider` to `ollama` if you would rather have the speed and
keep it offline.

## Opening apps

"open whatsapp", "launch gmail", "open google maps" — resolved against the
`.desktop` entries actually installed on the machine and launched with
`uwsm-app`, the same way Omarchy's own launchers do, so a voice-started app
lands in the same systemd slice as a menu-started one.

Webapps come for free: Omarchy installs them AS desktop entries, so WhatsApp,
Gmail, Discord and the rest are found without special-casing.

Generic words are checked first and mean your configured default:
`browser`, `terminal`, `editor`, `files` go through `omarchy launch`. That
ordering matters — "browser" legitimately substring-matches
*Avahi Zeroconf Browser*, and no scoring can tell those apart, so a role word
must never reach the app search.

An app that is not installed is refused by name rather than guessed at.

Nothing here is configured or per-machine. The list is read from the XDG
entry directories at use time, so it is whatever *that* user has installed,
and it is re-read when those directories change — install an app and it is
speakable immediately, with no restart and no registry to maintain.

## Other plugins can be spoken to

There are over two thousand plugins on the marketplace and none of them can be
spoken to. Any plugin that drops a `voice-intents.json` beside its manifest
becomes voice-controllable, without knowing this plugin exists.

Sources are **approved once** before their intents go live. Installing a plugin
must not silently extend what your microphone can do to your machine.

## The agent stays out of your way

Anything the agent opens lands on **workspace 10** by default, placed with
Hyprland's `silent` rule so the window appears there without your focus
moving. Change it in the panel's ai tab; set it to 0 to let things open
wherever they like.

Only launches are relocated. "close this window", "volume 40" and
"workspace three" are about where you already are, and moving those would be
actively wrong.

This is **placement, not permission**. What the agent may touch is the
policy's `workspaces` dimension, and the two are separate on purpose —
confining new windows is a courtesy, and a courtesy is not a boundary. For
real confinement, say so in the policy:

```jsonc
"workspaces": {
  "*": "deny",          // nothing outside the agent's own workspace
  "10": "allow",
  "special:*": "deny"   // scratchpads stay private
}
```

## Nothing irreversible happens quietly

Intents can be marked `destructive`. Those always raise the approval overlay —
whatever your confirmation setting says, and regardless of any lease — and the
overlay drops its "Always" button so there is no one-click way to stop being
asked.

The prompt shows what it heard, which intent matched, the exact argv, and why
it stopped. You are never approving a black box.

## If it keeps mishearing you

Check the microphone before the model. A signal that is too quiet or clipped
destroys the waveform, and whisper responds by writing plausible language
instead of what you said — "open chrome" heard as "hope chrome", or an opening
word invented outright.

```bash
desktop-agent-mictest
```

It records five seconds, reports peak/RMS/clipping, and transcribes the same
clip. Peak wants to be roughly **0.2–0.6** with no clipping. Two real failures
found this way on one laptop: a USB dongle capturing at peak 0.013 (barely
above the noise floor), and the internal mic clipping 34% of samples behind
+50 dB of hardware gain.

The durable fix is automatic gain control rather than a hand-tuned level,
because the right gain depends on how loudly you happen to be speaking.
PipeWire's `libpipewire-module-echo-cancel` wraps the same webrtc-audio-processing
a browser applies to `getUserMedia`:

```
context.modules = [
  { name = libpipewire-module-echo-cancel
    args = {
      aec.args = { webrtc.gain_control = true, webrtc.noise_suppression = true }
      capture.props = { node.target = "<your mic>" }
      source.props  = { node.name = "mic_agc" }
    } }
]
```

Then make `mic_agc` your default source. Leave the raw mic with headroom
(~30%) so AGC has something to work with rather than a clipped signal.

## Parallel work

Some jobs split into pieces that do not need each other's results — five papers
to read, ten folders to inspect. The agent hands those to `desktop_delegate`,
which runs them at the same time and gives the answers back in order for the
agent to join.

Each subagent is its own process with its own everything: scratch directory,
tmux window, MCP server, policy identity, idle watchdog. Two subagents share no
mutable path, so one cannot read another's output by accident.

They are deliberately handless. A subagent gets `run`, `screenshot`, `windows`,
`write`, `edit` and `policy` — headless work. It has no browser, no mouse, no
keyboard, no window or workspace control, and it cannot delegate or schedule.
Not because those are dangerous in themselves, but because there is **one**
cursor and **one** keyboard focus and several of them: two subagents typing at
once do not each get a keyboard, they interleave keystrokes into whatever
happened to be focused. Anything exclusive stays with the master.

Those tools are not merely refused to a subagent — they are never offered. An
agent that can see a browser tool it may not use goes looking for another way
to browse.

Four at a time by default (`agent.maxSubagents`, hard limit 8). More tasks than
that are queued, not refused. Stopping the master kills the whole tree.

## Confinement

The policy engine only sees calls that reach the desktop MCP server. An agent
with its own shell can run `hyprctl` directly and the policy never knows — so
the question is not whether an agent is trustworthy, but whether it can reach
the compositor at all.

**Claude Code** is reduced to the desktop tools by a deny list: no Bash, no
file access, no network of its own. `desktop-agent agent-check` asks it to
enumerate its own tools and fails if anything outside `mcp__desktop__*` comes
back.

**Everything else** — Gemini, Codex, OpenCode — keeps its own shell, so it runs
inside a `bwrap` sandbox with the compositor sockets removed and the filesystem
read-only. The MCP server stays outside, holding those sockets, reached through
a single bound socket. The shell survives; its reach does not:

```
inside the sandbox:   hyprctl activewindow → HYPRLAND_INSTANCE_SIGNATURE not set!
through the socket:   desktop_windows      → 3 windows, 3 withheld by policy
```

Needs `bwrap` and `socat`. Without them those runners are refused rather than
run unprotected.

## Reminders and schedules

Ask for something later, or repeatedly:

```
"remind me at 3pm tomorrow to renew the domain"
"every weekday at 8:30, check my disk space and warn me if root is over 85%"
```

The first is a **reminder**: a notification at a time, running no agent at all.
Most of what people want from scheduling is this, and it cannot fail in the
night because there is nothing in it to fail.

The second is a **scheduled task**: a real agent run with nobody watching. That
inverts the assumption everything else here rests on, so it works differently.
The job declares what it will need when it is created, you approve that list
once, and at 3am the declared capabilities are treated as already answered —
while anything outside them is **refused**, not queued for a question nobody is
awake to hear. The list is a ceiling, not a licence: a task cannot grow new
powers by drifting into them.

Irreversible commands are never pre-approved, whatever a job declared. At 3am
there is nobody to catch a mistaken `rm`.

One-off jobs remove themselves once fired. Recurring ones expire after 90 days
unless renewed, so a job nobody remembers creating cannot still be running next
year. Everything is listed in the panel and by `desktop-agent jobs`, cancellable
by name, and a job whose plugin has been deleted removes itself on its next
firing.

```
desktop-agent jobs                    # everything scheduled
desktop-agent job-cancel <id|all>     # stop one, or all
desktop-agent remind "09:00" "..."    # a bare time repeats daily
```

## When a command is misheard

Matching is strict on purpose, so the usual failure is *"No command matched"* —
which costs you a repeat, not a wrong action. Turn `Match strictness` up if you
get false matches, down if it is too fussy.

For dictation itself, Voxtype owns accuracy: `voxtype configure` gives you the
engine, model, language and a custom-vocabulary list. This plugin does not
duplicate those settings — one source of truth per setting.

## Settings

Everything you need is in the panel. Whether spoken commands are on, when a
command needs confirmation, whether other plugins may register intents, match
strictness, the unattended-lease ceiling, and — in the Policy tab — the master
desktop-control switch, whether full access is permitted at all, and each of
the twelve capabilities as allow / ask / deny.

The two switches and the capability table used to be reachable only by editing
`policy.jsonc`, on the reasoning that a file is somewhere the agent cannot
get to. That was protection by location, and it only held while the switch
stayed inconvenient for you too. It is no longer needed: the agent is refused
clicks onto this plugin's own surfaces by geometry, and refused
`desktop-agent-config` by name from any spoken request. So the switches live
where you can find them.

The panel edits `policy.jsonc` line by line and never re-serialises it, so the
comments explaining every rule survive. It also skips comment lines when
locating a key — the file's own header contains the text `"enabled": false`,
and a naive match rewrites that instead of the setting.

`policy.jsonc` is still a text file worth reading, and the pattern lists
(`workspaces`, `apps`, `paths`, `run.commands`) are still edited there: they
are rule sets, not switches. "Edit policy" in the Policy tab opens it.

## Logging in without handing over the password

The agent can use a credential without ever seeing it.

```bash
desktop-agent-config secret-add dalti-test "dev login for the Dalti app"
# value is read from stdin or prompted for; never passed as an argument
desktop-agent-config secret-list      # names and notes, never values
desktop-agent-config secret-rm dalti-test
```

Then it types by name — `desktop_type_secret` for a window,
`desktop_browser_type_secret` for a page field:

```
desktop_browser_type_secret({ ref: 12, name: "dalti-test", submit: true })
```

The value is resolved by the server and goes straight to the field. It never
enters the model's context, its transcript, or the audit log, which records the
name only. That is the whole point: a password handed to an agent is a password
in every log that agent's output touches, so no policy setting can make that
safe — and an agent that refuses one relayed to it is right. Naming it sidesteps
the question rather than arguing with it.

The store is `~/.config/desktop-agent/secrets.json`, mode 0600. It is plain
JSON, not a keyring: it holds throwaway development credentials, and anything
that matters belongs somewhere with a lock on it.

Typing one is gated by the `secret` capability — it asks once, a full-access
lease covers it, and a scheduled job never gets it. Window rules still apply, so
a password manager or a terminal stays refused whatever the name.

## The policy

Five dimensions, evaluated independently, **most restrictive wins**:

1. `capabilities` — may it do this kind of thing at all?
2. `workspaces` — is the target somewhere it may touch?
3. `apps` — may it do this to this particular window?
4. `paths` — may it write to this file?
5. `run.commands` — may it run this program?

Within a dimension the **last matching pattern wins**, so put broad rules first
and exceptions last. Anything unmatched is **denied**, and every refusal names
the rule responsible.

Fail-closed throughout: an unreadable policy refuses everything, and if the
shell plugin is not loaded there is nobody to ask, so every `ask` refuses.

## The kill switch is a flag file

`~/.local/state/desktop-agent/disabled`. Nothing has to be running for it to
hold, and it cannot corrupt your policy — an earlier version rewrote
`"enabled": true` inside `policy.jsonc` with `sed`, which silently flips the
wrong key when that string appears in a nested section first.

The full-access lease works the same way: a timestamp at
`~/.local/state/desktop-agent/yolo.json`. It expires with nothing running, it
survives nothing, and `rm` ends it immediately. A lease only ever promotes
`ask` to `allow` — it never reaches a `deny`, and never auto-approves a
destructive command.

## Theming

Every colour is derived from Omarchy's tokens; there is not one literal in the
QML. The approval prompt is built on the shell's **polkit** surface rather than
the generic popup one, so a theme that styles the system password dialog styles
this identically, gradients included.

## Requirements

**For voice:** `pw-record` (pipewire), `wtype`, `socat`, `wl-clipboard`,
`python3`, `bun`, and a free Groq API key — or local transcription instead, see
below.

**For tiers 3 and 4** — anything the intent registry does not already know —
an agent CLI: **Claude Code** is the only one that can be reduced to the
desktop tools without a sandbox, and the only one subagents run on. Gemini,
Codex and OpenCode work for single runs if `bwrap` and `socat` are installed;
without those they are refused rather than run unprotected.

**For watching the agent work:** `tmux`, which puts its commands in a terminal
you can read instead of a pipe you cannot. Without it they still run, silently.

**For scheduling:** `systemd --user` timers, which Omarchy already has.

Tiers 1 and 2 need none of the agent parts.

Choosing local transcription later creates a
virtualenv under `~/.local/share/desktop-agent/` and installs faster-whisper
into it (432 MB plus the model) — but only after the panel has shown you the
size and you have said yes. Nothing is installed system-wide.

## Developing on this

Plugin QML does not reliably hot-reload for panel components — a `Panel.qml`
change can leave the old one instantiated, so a new dropdown option or a
changed label simply will not appear.

```bash
omarchy restart shell
qs -p /usr/share/omarchy/shell log | grep zedster07
```

That is the first thing to try when an edit looks like it did nothing.

## Licence

MIT.
