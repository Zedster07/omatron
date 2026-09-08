// Talking to a Blender that is already open.
//
// The batch path spawns Blender per call: about a second of process start
// before a single question is answered, and several for a heavy file. That
// cost is what makes batching feel obligatory -- and batching is what forces
// every decision to be made blind and up front.
//
// A live session answers a measurement in ~17ms and a change-and-look in
// ~100ms, measured. At that price, act-then-look is simply how you work, which
// is the whole difference between driving an application and posting it a
// letter.
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { BlenderResult } from "./blender.ts"

/** One socket per project, under the user's own runtime directory. */
export function socketPath(project: string): string {
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `omatron-${process.getuid?.()}`)
  return path.join(base, `omatron-blender-${project}.sock`)
}

export async function isLive(project: string): Promise<boolean> {
  const p = socketPath(project)
  try {
    await fs.access(p)
  } catch {
    return false
  }
  // A socket file outlives the process that made it, so its presence proves
  // nothing. Connecting does.
  return await new Promise<boolean>((resolve) => {
    const c = net.createConnection(p)
    const done = (v: boolean) => { try { c.destroy() } catch {} ; resolve(v) }
    c.once("connect", () => done(true))
    c.once("error", () => done(false))
    setTimeout(() => done(false), 700)
  })
}

/** Send one batch to the live session and wait for its answer. */
export function send(
  project: string,
  request: Record<string, unknown>,
  timeoutMs = 300_000,
): Promise<BlenderResult> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath(project))
    let buf = ""
    const fail = (e: Error) => { try { c.destroy() } catch {} ; reject(e) }
    const timer = setTimeout(
      () => fail(new Error("the live Blender session did not answer in time")), timeoutMs)

    c.on("connect", () => c.write(JSON.stringify({ ...request, timeout: timeoutMs / 1000 }) + "\n"))
    c.on("data", (d) => {
      buf += d.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as BlenderResult)
      } catch (e) {
        fail(new Error(`the live session sent something unreadable: ${String(e)}`))
      }
      try { c.destroy() } catch {}
    })
    c.on("error", (e) => { clearTimeout(timer); fail(e as Error) })
  })
}

/** Stop a live session, leaving the .blend as it stands. */
export async function stop(project: string): Promise<boolean> {
  const p = socketPath(project)
  try {
    await send(project, { ops: [], quit: true }, 5_000)
  } catch {}
  try { await fs.unlink(p) } catch {}
  return true
}
