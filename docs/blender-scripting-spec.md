# Sandboxed Blender scripting — design, before any code

Written after GPT-6 Astra (3 Sept 2026) showed strong Blender results using a
method we had ruled out. This is the argument for adopting it without giving
up the property that makes this plugin shippable.

## What Astra actually does

Per neural4d's analysis, it *"writes real Blender Python to create objects,
modifiers, materials, and cameras"*, renders intermediate frames to inspect the
outcome, and revises — plan, script, render, analyse, revise, repeated.

Three of those four steps already exist here. `look` and `viewport` render and
return frames; `silhouette` compares against references; the live session makes
a round trip cost about 17 ms. The missing step is the first one.

Worth recording: its reported weakness is *"strong results on regular,
geometric objects with weaker performance on organic forms"* — the same profile
as this op table, which produced a clean revolved wheel and a poor car. And
there is no published Blender benchmark, so the demos are demos.

## Why we refused Python, and what actually changes

The objection was never that Python is bad. It is that
`blender --python <a file the agent wrote>` is an interpreter running **as the
user**, with `os`, `subprocess` and `shutil` in scope. It can read `~/.ssh`,
write anywhere the user can, and open a socket. `run.commands` denies `python3`,
`node`, `bun` and `sh` by name for exactly that reason, and a Blender that
accepts scripts is those commands wearing a hat.

What changes is not the language. It is who Blender runs as.

Inside a sandbox with no network and nothing writable but one directory,
arbitrary `bpy` stops being a route to the machine and becomes what it should
have been all along: a modelling language in a box. The plugin already does
this for agents that keep their own shell — `bwrap`, compositor sockets
removed, filesystem read-only, the MCP server outside holding what matters.
This is the same pattern pointed at a different process.

## The split that resolves the GUI problem

A live GUI session needs a Wayland socket. Handing that to a sandbox that runs
arbitrary code hands over the compositor, which defeats the point. So the two
paths stay separate, and each keeps the property it needs:

| path | runs | executes | can reach |
|---|---|---|---|
| **live session** (exists) | GUI, on the agent workspace | the shipped op table only, no `eval` | compositor, to draw a window |
| **script** (new) | headless, in `bwrap` | arbitrary `bpy` | one project directory. No network, no compositor, no home |

The loop between them: the script runs sandboxed and writes the `.blend`; the
GUI session reloads it; the agent inspects with `viewport`, `measure` and
`silhouette`, then writes the next script. The person watches the same window
throughout, and nothing that executes arbitrary code can see their desktop.

## The sandbox, concretely

```
bwrap
  --unshare-net                      no network. Nothing exfiltrates, nothing phones home
  --unshare-pid --unshare-ipc --unshare-uts
  --die-with-parent
  --ro-bind /usr /usr                system, read-only
  --ro-bind /lib /lib  --ro-bind /lib64 /lib64
  --ro-bind /etc/ld.so.cache /etc/ld.so.cache
  --ro-bind <blender install> <blender install>
  --tmpfs /home                      the user's home simply is not there
  --tmpfs /tmp
  --bind <models dir> <models dir>   the ONLY writable path
  --proc /proc --dev /dev
  --setenv HOME <models dir>
  --unsetenv WAYLAND_DISPLAY --unsetenv DISPLAY
  --unsetenv HYPRLAND_INSTANCE_SIGNATURE --unsetenv XDG_RUNTIME_DIR
  -- blender --background --factory-startup <project>.blend --python <script>
```

`--factory-startup` matters: it stops the sandboxed run loading the user's
Blender preferences and add-ons, which are code, and which live outside the
box.

## What it can still do, stated plainly

- **Burn CPU and fill the models directory.** Mitigated by a wall-clock
  timeout, an output-size cap, and the subdivision budget that already exists
  after a script reached 3.5 million vertices and took the machine into swap.
- **Corrupt or delete other projects in the models directory.** The bind is one
  directory, not one file, because Blender writes siblings (`.blend1`,
  renders). Narrowing it to a per-project subdirectory is the fix and should be
  done at the same time.
- **Produce a wrong model.** Not a security property. That is what the
  verification layer is for.

What it cannot do — measured, not asserted. Running the invocation above with
probes inside it:

```
  read ~/.ssh            BLOCKED (FileNotFoundError)
  network connect        BLOCKED (OSError)
  wayland socket         BLOCKED (KeyError)
  host processes         2                (429 outside)
  models dir write       OK
  /home/dada contains    ['.cache', 'Documents']   -- a tmpfs skeleton, nothing of the user's
```

`/home` is a tmpfs holding only the path needed to reach the bound directory.
The user's actual home is not mounted, so there is nothing there to read.

## Gating

Unchanged in shape. `desktop_blender_script` is a capability like any other and
goes through `gate()`. It is `NEVER_YOLO` — a lease must not auto-approve
arbitrary code, however contained. The audit line records the script's hash and
its first line, so what ran is recoverable afterwards.

## Prerequisite: the contract and the tests

This must not be built first.

Sixteen defects were found in the reference and view subsystem, and nearly all
were one mistake repeated: a coordinate or state convention assumed at a call
site rather than stated once. Thirty commits, zero test files. Every check was
"run it once and look", so nothing caught a view that had not been tried, and
the person using it found the last several failures on screen.

Iterating faster on that is not an improvement, it is the same errors arriving
sooner. Two things first:

1. **One view contract.** Across-axis, up-axis, anchor rule, facing and
   rotation derived from a single table, so no function can invent its own.
   Most of those sixteen become unrepresentable rather than merely fixed.
2. **Synthetic ground-truth tests.** Generate references whose answers are
   known — a 4.0 x 1.5 m rectangle with a marked nose, rotated 90°, deliberately
   offset — run the pipeline, assert it recovers the numbers. Every one of
   those defects fails such a test in milliseconds, headless, before anyone
   sees it.

## What this will and will not achieve

It should close the method gap: same loop Astra runs, on the same fast session,
with reference checking it does not appear to have.

It will not match a frontier model tuned for the task. Some of that gap is
capability, not method, and this document should not pretend otherwise. The
honest expectation is better geometric and parametric work — where this op
table already does well — and organic form remaining hard, which is where Astra
is also reported to be weakest.
