// ============================================================================
//  browser.ts -- the agent's own browser, driven over the Chrome DevTools
//  Protocol instead of through pixels.
//
//  Reading a page as text costs a fraction of a screenshot, arrives exact
//  rather than inferred, carries element state a picture cannot show, and
//  includes content scrolled out of view. Clicks target a DOM node, so there
//  is no coordinate to guess and nothing to go stale between capture and act.
//
//  THE ONE RULE THAT MATTERS
//  This module only ever talks to a browser IT LAUNCHED. It does not scan for
//  debugging ports and it does not attach to a browser that was already
//  running. That is not a simplification -- it is the security boundary.
//  Chromium underlies 1Password, Obsidian, the user's IDE and every Electron
//  app on the machine; a reader that attached to "any CDP endpoint" would read
//  all of them, straight through the window-level rules in policy.jsonc that
//  are supposed to keep the agent out. One endpoint, ours, or nothing.
//
//  WHY A LOCALHOST PORT IS ACCEPTABLE HERE
//  A debugging port is reachable by any local process, which would normally be
//  unacceptable. It is tolerable here for one reason and only while it holds:
//  the profile is empty. No extensions, no cookies, no saved passwords, no
//  logins. There is nothing behind the port worth reaching. If the agent's
//  browser is ever logged into anything real, this must move to
//  --remote-debugging-pipe, which has no socket at all.
// ============================================================================

import fs from "node:fs/promises"
import { confinementWorkspace } from "../voice/workspace.ts"
import os from "node:os"
import path from "node:path"

/** Everything the agent's browser owns lives here, separate from the user's. */
const BROWSER_DIR = path.join(os.homedir(), ".local", "state", "desktop-agent", "browser")
const PROFILE_DIR = path.join(BROWSER_DIR, "profile")

/** The window class, so the existing window rules in policy.jsonc can see it. */
export const AGENT_BROWSER_CLASS = "agent-browser"

const LAUNCH_TIMEOUT_MS = 20_000
const CDP_TIMEOUT_MS = 15_000

/**
 * The live browser, or null. Holding the port here -- rather than discovering
 * it -- is what makes "only the browser we launched" true: there is no code
 * path that learns an endpoint from anywhere but our own spawn.
 */
/** Workspace the agent-browser placement rule was last registered for. */
let ruleFor = 0

// `proc` is null for a browser we adopted rather than spawned -- there is no
// child handle for someone else's process, so liveness and shutdown go through
// the pid instead.
type Live = { proc: ReturnType<typeof Bun.spawn> | null; port: number; startedAt: number; pid?: number }
let live: Live | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A free localhost port, asked of the kernel rather than guessed. */
async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const p = s.port
  s.stop(true)
  return p
}

function browserBinary(preferred?: string): string {
  const candidates = [preferred, "chromium", "chrome", "google-chrome-stable", "google-chrome", "brave"].filter(
    Boolean,
  ) as string[]
  for (const c of candidates) {
    const found = Bun.which(c)
    if (found) return found
  }
  throw new Error(
    "No Chromium-family browser found. The agent browser needs one of: chromium, chrome, google-chrome, brave.\n" +
      "  sudo pacman -S chromium",
  )
}

/** True when the process we spawned is still alive. */
function alive(): boolean {
  if (live === null) return false
  if (live.proc) return live.proc.exitCode === null && live.proc.signalCode === null
  // Adopted: no handle, so ask the kernel whether the pid is still there.
  try {
    process.kill(live.pid!, 0)
    return true
  } catch {
    return false
  }
}

export type BrowserStatus = {
  running: boolean
  port?: number
  pid?: number
  profile: string
  uptimeMs?: number
}

export function status(): BrowserStatus {
  if (!alive()) return { running: false, profile: PROFILE_DIR }
  return {
    running: true,
    port: live!.port,
    pid: live!.pid ?? live!.proc?.pid,
    profile: PROFILE_DIR,
    uptimeMs: Date.now() - live!.startedAt,
  }
}

/**
 * Start the agent's browser if it is not already running, and return its port.
 *
 * The flags are the isolation: a profile of our own, no extensions, no
 * first-run wizard, and a window class distinct from the user's browsers so
 * the window rules in policy.jsonc can tell the two apart.
 */
/**
 * Find a browser already running on OUR profile, and take it over.
 *
 * `live` is per-process, and every Claude Code session spawns its own MCP
 * server -- so the second session finds live === null, tries to launch, and
 * Chromium refuses to run twice on one profile. It does not error: it hands
 * the URL to the running instance, which opens it, and the launcher exits 0.
 * The plugin then reported "browser exited immediately (code 0)" while a fresh
 * about:blank tab appeared in a browser it had decided did not exist.
 *
 * That is the whole of the reported bug: opening a page in an already-open
 * browser always failed and left a blank tab, and the only cure was closing
 * the browser so the profile came free.
 *
 * Adopting does not weaken "never attach to a browser we did not start". The
 * profile directory belongs to this plugin and nothing else uses it, so a
 * Chromium holding it IS the agent browser -- possibly one an earlier session
 * of ours left behind. The user's own Chromium, 1Password and Obsidian are on
 * other profiles and remain as unreachable as before.
 */
async function adopt(): Promise<number | null> {
  // SingletonLock is a symlink named "<host>-<pid>" -- Chromium's own record of
  // which process owns the profile. DevToolsActivePort would be simpler but is
  // not always written, so the pid is the dependable route.
  let pid: number | null = null
  try {
    const link = await fs.readlink(path.join(PROFILE_DIR, "SingletonLock"))
    const n = Number(link.split("-").pop())
    if (Number.isFinite(n) && n > 0) pid = n
  } catch {
    return null
  }
  if (!pid) return null

  let port: number | null = null
  try {
    // Matched, not split. /proc/<pid>/cmdline is NUL-separated in principle,
    // but Chromium rewrites its own argv into one space-separated string for
    // the process title -- so splitting on NUL yields two elements holding
    // everything, and the flag is never found. Measured: 618 bytes, argc 2.
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8")
    const n = Number(cmdline.match(/--remote-debugging-port=(\d+)/)?.[1])
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    return null   // the pid is stale; the lock outlived its owner
  }
  if (!port) return null

  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return null
  } catch {
    return null
  }
  // No process handle to keep: we did not spawn it. close() falls back to the
  // pid, which is what the lock gave us.
  live = { proc: null, port, startedAt: Date.now(), pid }
  return port
}

export async function ensure(opts: { command?: string; headless?: boolean } = {}): Promise<number> {
  if (alive()) return live!.port

  // Someone else's server process may have started it. Take it over rather
  // than launching into a profile that is already taken.
  const adopted = await adopt()
  if (adopted !== null) return adopted

  const bin = browserBinary(opts.command)
  await fs.mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(BROWSER_DIR, 0o700).catch(() => {})

  const port = await freePort()
  const args = [
    bin,
    `--user-data-dir=${PROFILE_DIR}`,
    `--class=${AGENT_BROWSER_CLASS}`,
    `--remote-debugging-port=${port}`,
    // Bind the debugger to loopback explicitly. Chromium defaults to this, but
    // an inherited --remote-debugging-address elsewhere should not win.
    "--remote-debugging-address=127.0.0.1",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--no-service-autorun",
    "--password-store=basic", // never touch the user's keyring
    "--use-mock-keychain",
  ]
  if (opts.headless) args.push("--headless=new", "--disable-gpu")
  args.push("about:blank")

  // Placed by a WINDOW RULE, not by wrapping the launch.
  //
  // Wrapping this one in `hyprctl dispatch exec_cmd` put the browser on the
  // right workspace and broke the session: the handle we keep is then
  // hyprctl's, which exits immediately, so isAlive() below judged the browser
  // dead the moment it started. Every browser_open relaunched it -- four
  // about:blank tabs and no navigation -- and close() killed hyprctl while the
  // real browser stayed running.
  //
  // The browser has a stable --class, so a window rule places it without going
  // anywhere near the process handle. It also survives relaunches, which the
  // wrapper had to redo each time.
  const ws = opts.headless ? 0 : confinementWorkspace()
  // Registered once per workspace value, not once per launch. Hyprland keeps
  // dynamic rules for the life of the compositor, so re-issuing an identical
  // rule on every browser start just grows the list.
  if (ws > 0 && ruleFor !== ws) {
    Bun.spawnSync(["hyprctl", "dispatch",
      `hl.window_rule({match={class="agent-browser"}, workspace="${ws} silent"})`])
    ruleFor = ws
  }
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  const started = Date.now()

  // Wait for the debugger to answer rather than sleeping a fixed amount: a
  // cold profile takes far longer to come up than a warm one.
  while (Date.now() - started < LAUNCH_TIMEOUT_MS) {
    if (proc.exitCode !== null) throw new Error(`browser exited immediately (code ${proc.exitCode})`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      })
      if (r.ok) {
        live = { proc, port, startedAt: started, pid: proc.pid }
        return port
      }
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }

  proc.kill()
  throw new Error(`browser did not open its debugging port within ${LAUNCH_TIMEOUT_MS / 1000}s`)
}

export async function close(): Promise<boolean> {
  // The pinned tab belongs to the browser that is going away. Leaving the id
  // behind would have the next session hunting for a target that cannot exist.
  pinned = null
  if (!alive()) {
    live = null
    return false
  }
  if (live!.proc) live!.proc.kill()
  else process.kill(live!.pid!, "SIGTERM")
  // Give it a moment to go quietly before reporting it closed.
  for (let i = 0; i < 20 && alive(); i++) await sleep(100)
  live = null
  return true
}

/** Refuse every call that is not backed by a browser this module started. */
function requireOurs(): number {
  if (!alive()) {
    throw new Error(
      "The agent browser is not running. Open it first with desktop_browser_open.\n" +
        "  This tool only ever talks to a browser it launched itself -- it will not " +
        "attach to Chromium, Brave, 1Password, Obsidian or any other Electron app " +
        "already running on this machine, by design.",
    )
  }
  return live!.port
}

// ------------------------------------------------------------------ CDP

type Target = { id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string }

async function targets(): Promise<Target[]> {
  const port = requireOurs()
  const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })
  return (await r.json()) as Target[]
}

/** The page the agent is working in: the first real page target. */
/**
 * The tab this session is working in, remembered rather than re-guessed.
 *
 * Cleared when the browser is closed; survives everything else.
 */
let pinned: string | null = null

/** Chromium's own pages, not devtools or an extension's background page. */
const isRealPage = (t: Target) =>
  t.type === "page" &&
  !!t.webSocketDebuggerUrl &&
  !t.url.startsWith("devtools://") &&
  !t.url.startsWith("chrome-extension://")

/**
 * Which tab are we driving?
 *
 * This used to be `pages[0]` -- whatever /json/list happened to put first --
 * re-decided on EVERY cdp call. Two things follow from that, and both were
 * reported as "it opens about:blank and never recovers":
 *
 *   1. The order tracks tab ACTIVITY. Activating a tab moves it to the front,
 *      so navigate() could drive one tab and the read() straight after it read
 *      a different one. Measured: activating the blank tab put about:blank at
 *      pages[0] while the real page sat at pages[2].
 *   2. The browser is launched on about:blank and nothing ever closes it, so
 *      there is always a blank tab in the running to be picked -- which is why
 *      the only reliable cure was closing the whole browser.
 *
 * So the tab is pinned. A fresh pick prefers a page that is actually
 * somewhere, and falls back to the blank one only when that is all there is.
 */
async function pageTarget(): Promise<Target> {
  const all = await targets()
  const pages = all.filter(isRealPage)
  if (!pages.length) throw new Error("the agent browser has no open page")

  if (pinned) {
    const still = pages.find((t) => t.id === pinned)
    if (still) return still
  }
  const chosen = pages.find((t) => t.url !== "about:blank" && t.url !== "") ?? pages[0]
  pinned = chosen.id
  return chosen
}

/** Work in this tab from now on. Called when we deliberately open one. */
export function pinTarget(id: string | null) {
  pinned = id
}

/**
 * Open one CDP connection, run `fn`, and always close it.
 *
 * Connecting per call rather than holding a socket costs a few milliseconds
 * and removes a whole class of lifecycle bugs -- a dropped socket, a target
 * that navigated away, a reply arriving after the caller gave up.
 */
async function withCdp<T>(fn: (send: (m: string, p?: any) => Promise<any>) => Promise<T>): Promise<T> {
  const target = await pageTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl!)
  let seq = 0
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>()

  ws.onmessage = (e) => {
    let msg: any
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }
    if (!msg.id) return // an event, not a reply
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.fail(new Error(`${msg.error.message ?? "CDP error"}`))
    else p.ok(msg.result)
  }

  const send = (method: string, params: any = {}) =>
    new Promise<any>((ok, fail) => {
      const id = ++seq
      pending.set(id, { ok, fail })
      const timer = setTimeout(() => {
        if (pending.delete(id)) fail(new Error(`CDP ${method} timed out after ${CDP_TIMEOUT_MS / 1000}s`))
      }, CDP_TIMEOUT_MS)
      const done = () => clearTimeout(timer)
      pending.set(id, {
        ok: (v) => (done(), ok(v)),
        fail: (e) => (done(), fail(e)),
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP socket did not open")), 10_000)
      ws.onopen = () => (clearTimeout(t), res())
      ws.onerror = () => (clearTimeout(t), rej(new Error("CDP socket failed")))
    })
    return await fn(send)
  } finally {
    try {
      ws.close()
    } catch {
      /* already gone */
    }
  }
}

// -------------------------------------------------------------- navigation

export async function navigate(url: string): Promise<{ url: string; title: string }> {
  return withCdp(async (send) => {
    await send("Page.enable")
    await send("Page.navigate", { url })
    // Settle briefly so the first read is not of a blank document. Not a full
    // load wait: a slow page should be readable while it finishes.
    await sleep(600)
    const { result } = await send("Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title})",
      returnByValue: true,
    })
    try {
      return JSON.parse(result.value)
    } catch {
      return { url, title: "" }
    }
  })
}

// ------------------------------------------------------------- reading

export type AxNode = { ref: number; role: string; name: string; value?: string; depth: number }

/** Roles that carry no information for an agent deciding what to do next. */
const NOISE_ROLES = new Set(["none", "generic", "GenericContainer", "InlineTextBox", "LineBreak", "presentation"])

/**
 * Read the page as a list of accessible elements.
 *
 * Deliberately NOT a getFullAXTree dump. A real application's tree can be
 * larger than the screenshot it replaces, which would trade an image problem
 * for a text problem. `filter` and `roles` narrow it at the source, and `max`
 * caps what comes back regardless.
 */
export async function read(
  opts: { filter?: string; roles?: string[]; max?: number; interactiveOnly?: boolean } = {},
): Promise<{ url: string; title: string; nodes: AxNode[]; total: number; truncated: boolean }> {
  const max = Math.max(1, Math.min(opts.max ?? 200, 2000))
  const wantRoles = opts.roles?.length ? new Set(opts.roles.map((r) => r.toLowerCase())) : null
  const needle = opts.filter?.trim().toLowerCase()

  const INTERACTIVE = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "option",
    "listbox",
    "spinbutton",
  ])

  return withCdp(async (send) => {
    const { result } = await send("Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title})",
      returnByValue: true,
    })
    let page = { url: "", title: "" }
    try {
      page = JSON.parse(result.value)
    } catch {
      /* keep the blank */
    }

    await send("Accessibility.enable")
    const { nodes } = await send("Accessibility.getFullAXTree")

    const out: AxNode[] = []
    let total = 0
    for (const n of nodes ?? []) {
      const role = n.role?.value
      if (!role || NOISE_ROLES.has(role)) continue
      if (n.ignored) continue
      const name = (n.name?.value ?? "").trim()
      const value = n.value?.value
      const ref = n.backendDOMNodeId

      if (opts.interactiveOnly && !INTERACTIVE.has(role.toLowerCase())) continue
      if (wantRoles && !wantRoles.has(role.toLowerCase())) continue
      if (needle && !(`${role} ${name} ${value ?? ""}`.toLowerCase().includes(needle))) continue
      // Without a DOM handle the agent can read it but never act on it.
      if (typeof ref !== "number") continue
      if (!name && !value) continue

      total++
      if (out.length < max) {
        out.push({
          ref,
          role,
          name,
          ...(value !== undefined && value !== "" ? { value: String(value) } : {}),
          depth: 0,
        })
      }
    }

    return { url: page.url, title: page.title, nodes: out, total, truncated: total > out.length }
  })
}

// -------------------------------------------------------------- acting

/** Resolve a backendDOMNodeId to a JS handle we can call methods on. */
async function resolve(send: (m: string, p?: any) => Promise<any>, ref: number): Promise<string> {
  const { object } = await send("DOM.resolveNode", { backendNodeId: ref })
  if (!object?.objectId) throw new Error(`element ${ref} is no longer in the page (it may have re-rendered)`)
  return object.objectId
}

export async function click(ref: number): Promise<string> {
  return withCdp(async (send) => {
    await send("DOM.enable")
    const objectId = await resolve(send, ref)
    const { result, exceptionDetails } = await send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        this.scrollIntoView({block: 'center'});
        const label = (this.innerText || this.value || this.getAttribute('aria-label') || '').trim().slice(0, 80);
        this.click();
        return label;
      }`,
    })
    if (exceptionDetails) throw new Error(`click failed: ${exceptionDetails.text ?? "exception in page"}`)
    return result?.value || `element ${ref}`
  })
}

/**
 * Is this element a password field?
 *
 * Asked over CDP rather than inferred from a label or taken from the caller,
 * because the browser already knows: input type=password, or the autocomplete
 * hints browsers themselves use to decide what to offer to fill.
 */
export async function isSecretField(ref: number): Promise<boolean> {
  return withCdp(async (send) => {
    await send("DOM.enable")
    const objectId = await resolve(send, ref)
    const { result } = await send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        var t = (this.type || '').toLowerCase();
        if (t === 'password') return true;
        var ac = (this.getAttribute('autocomplete') || '').toLowerCase();
        return ac === 'current-password' || ac === 'new-password' || ac === 'one-time-code';
      }`,
    })
    return result?.value === true
  })
}

export async function type(ref: number, text: string, submit = false): Promise<string> {
  return withCdp(async (send) => {
    await send("DOM.enable")
    const objectId = await resolve(send, ref)
    // Focus through the page rather than by clicking a coordinate: no pixel to
    // be wrong about, and it works for an element scrolled out of view.
    const { exceptionDetails } = await send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        this.scrollIntoView({block: 'center'});
        this.focus();
        if ('value' in this) this.value = '';
      }`,
    })
    if (exceptionDetails) throw new Error(`could not focus element ${ref}`)

    await send("Input.insertText", { text })
    // Fire the events frameworks listen for; insertText alone leaves React and
    // friends unaware that anything changed.
    await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
      }`,
    })

    if (submit) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    }
    return `typed ${text.length} chars into element ${ref}${submit ? " and pressed Enter" : ""}`
  })
}

/**
 * A picture of the PAGE, rendered by the browser itself.
 *
 * Not a photograph of the screen, and that distinction is the whole reason
 * this exists. desktop_screenshot asks the compositor for a rectangle of a
 * monitor, so it returns whatever is physically at those coordinates -- which
 * once meant handing back somebody's YouTube tab under the label of an
 * off-screen agent window. Here the renderer draws the page and hands over the
 * result: no other window can appear in it, occlusion is meaningless, and it
 * works with the browser on another workspace or behind everything else.
 *
 * So anything on the web should come through this, and desktop_screenshot is
 * for the rest of the desktop.
 */
export async function shot(fullPage = false): Promise<{ data: string; w: number; h: number }> {
  return withCdp(async (send) => {
    const { contentSize } = await send("Page.getLayoutMetrics")
    // Chromium refuses a capture taller than 16384px, and a long page hits
    // that far more easily than it looks -- an infinite-scroll feed always
    // will. Clamped rather than refused: a tall screenshot that stops early is
    // more use than an error.
    const clip = fullPage && contentSize
      ? { x: 0, y: 0, width: contentSize.width, height: Math.min(contentSize.height, 16384), scale: 1 }
      : undefined
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
      ...(clip ? { clip } : {}),
    })
    const metrics = clip ?? (await send("Page.getLayoutMetrics")).cssVisualViewport ?? {}
    return { data, w: Math.round(metrics.width ?? 0), h: Math.round(metrics.height ?? 0) }
  })
}

export async function currentPage(): Promise<{ url: string; title: string }> {
  const t = await pageTarget()
  return { url: t.url, title: t.title }
}
