# Blender, two ways

Omatron can drive Blender through two different servers. They are not
redundant; they sit at opposite ends of a real tradeoff, and the choice
between them is a choice about how much you want gated.

## `desktop_blender_*` — ours

Headless and atomic. Every call opens the `.blend`, applies a list of
operations, saves, and exits. No daemon, no socket, no addon.

- **Policy-gated.** Every call goes through the same gate as every other
  desktop capability. `blender` is a capability in the table like any other.
- **No arbitrary Python.** Operations dispatch through a shipped table in
  `server/blender_ops.py`. Nothing there ever `exec`s a string it was handed.
  This is load-bearing: `blender --python <a file the agent wrote>` is
  `python3` under another name, and the policy denies `python3` by name
  precisely because interpreters launder everything past the command rules.
- **Atomic.** A failed operation aborts the batch before the save, so the
  file is never left half-changed.
- **Verifiable.** `measure` and `assert` read real evaluated geometry via a
  BVH tree — overlap, surface gap, enclosure, bounds, topology. An assert
  that fails takes the whole batch down unsaved.

Nothing to install beyond Blender itself.

## `blender-ai-mcp` — PatrykIti's

A live GUI Blender, driven over JSON-RPC by an addon, executing on Blender's
main thread. Much larger surface: macros (`macro_attach_part_to_surface`,
`macro_cleanup_part_intersections`, `macro_place_symmetry_pair`), reference
images, and OBJ/FBX/glTF import and export, which we have no equivalent for.

It reached the same central conclusion we did, and says it better:

> treat Blender control as a product surface, not a code-generation stunt

There is no `execute_code` tool; the repo even carries a quality gate that
rejects `exec(` and `eval(` in generated content. That is why it is worth
running, and it is the reason to prefer it over the more popular
`ahujasid/blender-mcp`, which does expose arbitrary Python and would hand
back every boundary the audits closed.

### What running it costs you

**It is outside the policy gate.** Requests reach Blender over a TCP socket;
nothing on that path consults `policy.jsonc`. Anything the server can do, an
agent can do without being asked. It also imports and exports files to paths
of its choosing. Start it when you want that, stop it when you don't —
`bin/blender-ai-mcp` exists so that is one command either way.

**Its addon binds `0.0.0.0`.** Upstream's comment reads "Listen on all
interfaces within container", but the *addon* runs on the host, not in the
container — so as shipped it is an unauthenticated port accepting Blender
commands from anyone on the local network. The installed copy under
`~/.config/blender/*/scripts/addons/blender_ai_mcp` is patched to bind
`127.0.0.1`, which is what the documented Linux setup (`--network host` with
`BLENDER_RPC_HOST=127.0.0.1`) wants anyway. **Re-apply that patch if you ever
reinstall the addon.** The original is kept beside it as `rpc_server.py.orig`.

**It needs a Blender open.** The addon serves RPC from a running GUI session;
headless serves nothing.

**It is a heavy install.** `sentence-transformers` and `lancedb` are core
dependencies, which means the torch stack — several GB. It lives on
`/mnt/data` for that reason.

## Which to use

Reach for ours by default: it is gated, atomic, and needs nothing running.
Reach for `blender-ai-mcp` when you specifically want its macros or file
import/export, and stop it afterwards.
