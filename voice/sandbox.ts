// Taking the desktop away from an agent that keeps its own shell.
//
// Only Claude Code can be reduced to a tool list, so for a long time "can this
// runner be trusted unattended" and "is this runner Claude" were the same
// question. That was the wrong question. What lets an agent drive this desktop
// is not its shell, it is its REACH: Hyprland is controlled through one socket
// in $XDG_RUNTIME_DIR/hypr/<sig>/, and the input tools through the Wayland
// socket beside it. An agent that cannot see those cannot touch the screen,
// however complete its shell.
//
// So the sandbox does not try to remove anything from the agent. It removes
// the sockets, and puts the MCP server -- which still has them -- on the far
// side of a single bind-mounted pipe:
//
//     ┌ bwrap ──────────────────┐
//     │ gemini / codex / …      │        one socket
//     │ full shell, no sockets  │ ────────────────────► server (outside)
//     │ / read-only             │                       holds the sockets,
//     └─────────────────────────┘                       runs gate()
//
// The agent keeps its shell and its network. It loses exactly one thing, and
// it is the thing the policy engine exists to govern.
//
// A side effect worth naming: identity stops being a protocol problem. MCP
// carries no caller identity, which is why Claude Code's own subagents could
// never be told apart at the server. Here the identity is WHICH SOCKET you
// reached, and each listener is started with its own environment. A subagent
// cannot claim to be the master because it cannot reach the master's socket.

import { existsSync, mkdirSync, rmSync } from "node:fs"
import { killTree } from "./killtree.ts"

const RUNTIME = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`

/** Where the socket appears INSIDE the sandbox. */
const INNER_SOCK = `${RUNTIME}/mcp.sock`

export function sandboxAvailable(): { ok: boolean; missing: string[] } {
  const missing = ["bwrap", "socat"].filter(t => !Bun.which(t))
  return { ok: missing.length === 0, missing }
}

export interface Bridge {
  /** Path on the host; bind-mounted to INNER_SOCK inside. */
  socket: string
  stop: () => void
}

/**
 * Start a listener that spawns one MCP server per connection, outside the
 * sandbox, with `env` applied.
 *
 * Per-connection spawn rather than one shared server, because the environment
 * IS the identity: role, tmux window and heartbeat file all come from it, and
 * one process cannot hold four different sets of them. It also keeps the
 * existing server unchanged -- it still speaks plain stdio and does not know
 * it is being reached through a pipe.
 */
export async function startBridge(name: string, env: Record<string, string>): Promise<Bridge | null> {
  const socat = Bun.which("socat")
  const bun = Bun.which("bun")
  if (!socat || !bun) return null

  const dir = `${RUNTIME}/desktop-agent/bridges`
  const socket = `${dir}/${name}.sock`
  try {
    mkdirSync(dir, { recursive: true })
    rmSync(socket, { force: true })
  } catch { return null }

  const server = new URL("../server/server.ts", import.meta.url).pathname
  const proc = Bun.spawn(
    [socat, // fork so concurrent tool calls each get a server; max-children so an agent
      // holding the socket cannot spawn them until the machine runs out of memory.
      `UNIX-LISTEN:${socket},fork,max-children=16,mode=600`, `EXEC:${bun} run ${server}`],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: { ...process.env, ...env } },
  )

  // Wait for the socket to exist before handing it out.
  //
  // socat creates it asynchronously, so returning immediately hands the caller
  // a path that is not there yet -- and bwrap refuses to bind a source that
  // does not exist. The failure is instant and reads like a bug in the
  // sandbox rather than a race in its startup.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (existsSync(socket)) break
    if (proc.exitCode !== null) return null
    await new Promise(r => setTimeout(r, 50))
  }
  if (!existsSync(socket)) {
    try { proc.kill() } catch {}
    return null
  }

  return {
    socket,
    stop: () => {
      // The tree, not the listener. socat forks a child per connection, so
      // killing the parent leaves any in-flight server reparented to init --
      // still holding the compositor sockets the sandbox exists to withhold.
      try { killTree(proc.pid) } catch { try { proc.kill() } catch {} }
      try { rmSync(socket, { force: true }) } catch {}
    },
  }
}

/**
 * Wrap a command so it runs without any path to the compositor.
 *
 * `/` is read-only so nothing outside the agent's own directory can be
 * changed, and $XDG_RUNTIME_DIR becomes an empty tmpfs -- which is what
 * actually removes the Hyprland and Wayland sockets, since both live there.
 * The two environment variables go with them: a socket path that no longer
 * resolves is a clearer failure than one that resolves to nothing.
 *
 * Network stays. The agent has to reach its model, and blocking that would
 * make the sandbox a way of turning the feature off rather than a way of
 * making it safe.
 */
export function sandboxArgv(inner: string[], opts: { socket: string; writable: string[] }): string[] {
  const argv = [
    "bwrap",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    // Order matters: the tmpfs has to land before the socket is bound into it,
    // or the mount hides the socket that was just placed there.
    "--tmpfs", RUNTIME,
    "--bind", opts.socket, INNER_SOCK,
    "--unsetenv", "WAYLAND_DISPLAY",
    "--unsetenv", "HYPRLAND_INSTANCE_SIGNATURE",
    "--unsetenv", "DISPLAY",
    // Points at /run/user/<uid>/bus, which the tmpfs above replaced. Leaving
    // it set does not grant access -- it makes anything that tries to connect
    // wait for a timeout instead of failing immediately.
    "--unsetenv", "DBUS_SESSION_BUS_ADDRESS",
    "--share-net",
    "--die-with-parent",
  ]
  // The agent's own scratch space, and whatever the runner needs to write to
  // keep its credentials fresh. Read-only would look like it worked and then
  // fail on the first token refresh.
  for (const w of opts.writable) argv.push("--bind-try", w, w)
  return [...argv, "--", ...inner]
}

/** The MCP command a sandboxed agent uses to reach the server outside. */
export function bridgeCommand(): { command: string; args: string[] } {
  return { command: "socat", args: ["-", `UNIX-CONNECT:${INNER_SOCK}`] }
}

export { INNER_SOCK }
