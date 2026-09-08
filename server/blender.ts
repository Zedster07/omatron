// Driving Blender without handing it a Python interpreter.
//
// Every call runs `blender --background` with server/blender_ops.py, which is
// SHIPPED and dispatches structured operations through a fixed table. The agent
// names an operation and gives numbers; it never sends code. That is the whole
// reason this can exist at all: `blender --python <a file the agent wrote>` is
// python3 under another name, and the policy denies python3 by name because
// interpreters launder everything past the command rules.
//
// State lives in the .blend file. Each call opens it, applies, saves. No
// daemon, no socket, no addon to install -- and a crash costs the last
// operation rather than the session.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as live from "./blender_live.ts"

export type Checkpoint = {
  label: string
  view: string
  image: string
  stats: { objects: Array<{ name: string; faces: number; size: number[] }>; faces: number }
  measured: Array<Record<string, unknown>>
}

export type BlenderResult = {
  applied: string[]
  errors: string[]
  scene: Array<Record<string, unknown>>
  render: string | null
  checkpoints?: Checkpoint[]
}

/** A checkpoint's numbers, as the line that introduces its picture. */
export function describeCheckpoint(c: Checkpoint, n: number): string {
  const parts = [`[${n}] ${c.label}${c.view !== "staged" ? ` (${c.view})` : ""} — ` +
                 `${c.stats.objects.length} object(s), ${c.stats.faces} faces`]
  for (const o of c.stats.objects) {
    parts.push(`      ${o.name.padEnd(14)} ${String(o.faces).padStart(6)} faces  ` +
               `${o.size.map((v) => v.toFixed(2)).join(" x ")}`)
  }
  for (const m of c.measured) parts.push(`      ${JSON.stringify(m)}`)
  return parts.join("\n")
}

/** Where models live. The person's own directory, like saved answers. */
export const MODELS = path.join(os.homedir(), "Documents", "omatron-models")

const OPS_SCRIPT = new URL("./blender_ops.py", import.meta.url).pathname

/**
 * The Blender binary.
 *
 * Configurable because a portable build is the sensible way to install this --
 * 1.2GB that needs no root and bundles its own Python, rather than 2.5GB of
 * distribution packages. So it is frequently NOT on PATH, and guessing only
 * PATH would report "not installed" to someone who installed it deliberately.
 */
export async function blenderBinary(): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(os.homedir(), ".config", "desktop-agent", "settings.json"), "utf8")
    const configured = JSON.parse(raw)?.blender?.command
    if (typeof configured === "string" && configured) {
      try { await fs.access(configured); return configured } catch {}
    }
  } catch {}

  const onPath = Bun.which("blender")
  if (onPath) return onPath

  // Portable builds, newest first. Cheap to look, and it turns "not installed"
  // into "found it" for the install path this project actually recommends.
  for (const root of ["/mnt/data/blender", path.join(os.homedir(), "blender"), "/opt/blender"]) {
    try {
      const entries = (await fs.readdir(root)).sort().reverse()
      for (const e of entries) {
        const candidate = path.join(root, e, "blender")
        try { await fs.access(candidate); return candidate } catch {}
      }
      const direct = path.join(root, "blender")
      try { await fs.access(direct); return direct } catch {}
    } catch {}
  }
  return null
}

/** A project name to a path, refusing anything that is not just a name. */
export function projectPath(name: string): string {
  const clean = String(name ?? "").trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}$/.test(clean)) {
    throw new Error(
      `"${name}" is not a project name. Use letters, numbers, spaces, - and _ ` +
        "— it names a file in your models folder, not a path.")
  }
  return path.join(MODELS, `${clean}.blend`)
}

export async function run(
  project: string,
  request: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<BlenderResult> {
  // A live session answers in milliseconds and is showing the person the same
  // scene. If one is open for this project, it IS the project -- going around
  // it to a headless process would edit the file underneath the window and
  // leave the two disagreeing about what the model is.
  if (await live.isLive(project)) return live.send(project, request, timeoutMs)

  const bin = await blenderBinary()
  if (!bin) {
    throw new Error(
      "Blender is not installed, or not where I can find it.\n" +
        "  Looked on PATH and in /mnt/data/blender, ~/blender and /opt/blender.\n" +
        '  Set "blender": { "command": "/path/to/blender" } in settings.json if it is elsewhere.')
  }
  await fs.mkdir(MODELS, { recursive: true })
  const file = projectPath(project)

  const proc = Bun.spawn(
    [bin, "--background", "--python", OPS_SCRIPT, "--", file, JSON.stringify(request)],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  )
  const timer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  let out = "", err = ""
  try {
    ;[out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
  } finally {
    clearTimeout(timer)
  }

  // Blender prints a great deal on the way past. The result is one tagged line,
  // which is why it is tagged.
  const line = out.split("\n").find((l) => l.startsWith("OMATRON_RESULT "))
  if (!line) {
    const why = (err.split("\n").filter((l) => l.trim()).pop() ?? "").slice(0, 200)
    throw new Error(`Blender produced no result${why ? `: ${why}` : ""}`)
  }
  return JSON.parse(line.slice("OMATRON_RESULT ".length)) as BlenderResult
}

/** The scene as a table a person or a model can read at a glance. */
export function describeScene(scene: BlenderResult["scene"]): string {
  if (!scene.length) return "(the scene is empty)"
  const rows = scene.map((o) => {
    const at = (o.at as number[]).join(", ")
    const size = (o.size as number[]).map((n) => Number(n).toFixed(2)).join(" x ")
    const mods = (o.modifiers as string[]).length ? ` [${(o.modifiers as string[]).join(", ")}]` : ""
    const mat = o.material ? ` {${o.material}}` : ""
    return `  ${String(o.name).padEnd(16)} ${String(o.type).padEnd(7)} at (${at})  ${size}${mods}${mat}`
  })
  return rows.join("\n")
}


/**
 * Close Omatron viewers that are watching some other project.
 *
 * Matched on the command line -- blender_watch.py plus a path under the models
 * directory -- because that pair is ours and nothing else is. Class "blender"
 * would also match the person's own session, and killing that would be
 * unforgivable: theirs holds unsaved work, ours reloads from disk by design
 * and loses nothing.
 */
async function closeStaleViewers(keep: string): Promise<void> {
  let pids: string[]
  try {
    const listed = Bun.spawnSync(["pgrep", "-f", "blender_watch.py"])
    pids = new TextDecoder().decode(listed.stdout).split("\n").filter(Boolean)
  } catch { return }

  for (const pid of pids) {
    try {
      const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8")
      const argv = raw.split("\0").filter(Boolean)
      const watched = argv.find((a) => a.startsWith(MODELS) && a.endsWith(".blend"))
      if (!watched) continue                       // not one of ours
      if (watched === projectPath(keep)) continue  // the one we want
      process.kill(Number(pid), "SIGTERM")
    } catch {}
  }
}

const LIVE_SCRIPT = new URL("./blender_live.py", import.meta.url).pathname

/**
 * Open a Blender the agent drives and the person watches -- the same window.
 *
 * The viewer (blender_watch.py) only ever reloaded the file; this one takes
 * instructions. That difference matters more than it sounds: with a viewer the
 * person watches a recording of decisions already made, and with a session
 * they are sitting in front of the thing being worked on and can take the
 * mouse.
 */
export async function openLive(project: string, workspace: number): Promise<string | null> {
  const bin = await blenderBinary()
  if (!bin) return null
  await fs.mkdir(MODELS, { recursive: true })
  const file = projectPath(project)
  const sock = live.socketPath(project)
  if (await live.isLive(project)) return sock

  await fs.mkdir(path.dirname(sock), { recursive: true }).catch(() => {})
  await fs.unlink(sock).catch(() => {})
  await closeStaleViewers(project)

  const launcher = Bun.which("setsid")
  const argv = [bin, file, "--python", LIVE_SCRIPT, "--", sock, file]
  Bun.spawn(launcher ? [launcher, ...argv] : argv,
            { stdout: "ignore", stderr: "ignore", stdin: "ignore" })

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (await live.isLive(project)) break
  }
  if (!(await live.isLive(project))) return null

  if (workspace > 0) {
    void (async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const listed = Bun.spawnSync(["hyprctl", "-j", "clients"])
          const clients = JSON.parse(new TextDecoder().decode(listed.stdout)) as any[]
          const w = clients.find((c) => c.mapped && String(c.title ?? "").includes(project + ".blend"))
          if (!w) continue
          if (w.workspace?.id === workspace) return
          Bun.spawnSync(["hyprctl", "dispatch",
            `hl.dsp.window.move({window="address:${w.address}", workspace="${workspace}", silent=true})`])
          return
        } catch {}
      }
    })()
  }
  return sock
}

const WATCH_SCRIPT = new URL("./blender_watch.py", import.meta.url).pathname
let ruleFor = 0

/**
 * A window showing the model, on the agent's workspace, reloading as it changes.
 *
 * Placed by a WINDOW RULE matched on TITLE, not class. Every Blender reports
 * class "blender", so a class rule would sweep up the person's own Blender and
 * move it out from under them. The title carries the file path -- "ring
 * [~/Documents/omatron-models/ring.blend] - Blender" -- so matching the models
 * folder catches ours and nothing else.
 */
export async function openViewer(project: string, workspace: number): Promise<boolean> {
  const bin = await blenderBinary()
  if (!bin) return false
  const file = projectPath(project)
  try { await fs.access(file) } catch { return false }

  // Close viewers on OTHER projects FIRST -- before the already-watching fast
  // path below, which returns early and would otherwise leave them running
  // exactly in the case where the right window is already up and a wrong one
  // is sitting next to it.
  //
  // A viewer watches one path forever. Build a second model and the first
  // window sits there showing the first model, which is not stale-looking --
  // it looks exactly like a current, correct viewer of the wrong thing. That
  // is how workspace 10 ended up displaying a car three revisions old while
  // its replacement had never been opened at all.
  //
  // One viewer, showing what is being worked on. Identified by the watch
  // script in the process's own command line, never by window class, so the
  // person's own Blender is never a candidate however it is titled.
  await closeStaleViewers(project)

  // Already watching? Two viewers on one file would both reload correctly and
  // the person would get two windows for no reason.
  try {
    const listed = Bun.spawnSync(["hyprctl", "-j", "clients"])
    const clients = JSON.parse(new TextDecoder().decode(listed.stdout)) as any[]
    if (clients.some((c) => c.mapped && String(c.title ?? "").includes(project + ".blend"))) return true
  } catch {}

  // setsid, so the window outlives the session that opened it.
  //
  // A plain spawn makes it a child of this MCP server, and an MCP server lives
  // exactly as long as the agent session -- so the viewer vanished the moment
  // the conversation ended, taking the thing the person was watching with it.
  // The window is for them, not for the session.
  const launcher = Bun.which("setsid")
  const argv = launcher
    ? [launcher, bin, file, "--python", WATCH_SCRIPT, "--", file]
    : [bin, file, "--python", WATCH_SCRIPT, "--", file]
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })

  // Moved once it appears, rather than placed by a window rule.
  //
  // A title rule looked right and did not work: Hyprland matches when the
  // window MAPS, and Blender maps before it loads the file, so at that moment
  // the title is just "Blender" with no path in it. The viewer landed on
  // whatever workspace the person was on -- the exact thing this is meant to
  // avoid. Matching on class would work at map time and would also drag the
  // person's own Blender across, which is worse.
  //
  // So: wait for the window carrying this project's file, then move that one.
  if (workspace > 0) {
    void (async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const listed = Bun.spawnSync(["hyprctl", "-j", "clients"])
          const clients = JSON.parse(new TextDecoder().decode(listed.stdout)) as any[]
          const w = clients.find((c) => c.mapped && String(c.title ?? "").includes(project + ".blend"))
          if (!w) continue
          if (w.workspace?.id === workspace) return
          Bun.spawnSync(["hyprctl", "dispatch",
            `hl.dsp.window.move({window="address:${w.address}", workspace="${workspace}", silent=true})`])
          return
        } catch {}
      }
    })()
  }
  return true
}
