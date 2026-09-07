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

export type BlenderResult = {
  applied: string[]
  errors: string[]
  scene: Array<Record<string, unknown>>
  render: string | null
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
