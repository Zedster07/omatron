// Tier 4: hand the request to an agent that can see and touch the screen.
//
// Tiers 1-3 turn a sentence into commands. Some requests are not commands at
// all -- anything that needs to read what is on screen, click a particular
// thing, or react to what happens next. That is what the MCP half of this
// project already does, so this tier is a hand-off rather than new machinery.
//
// The safety comes from the policy engine, and the agent must be unable to
// step around it. We support multiple agent CLIs (Claude Code, Gemini CLI,
// Codex, OpenCode) through the runner abstraction in ./runners.
//
// Every gated action still raises the desktop policy's own approval overlay,
// which fails closed when the plugin that serves it is not loaded.

import { settingStr } from "./settings.ts"
import { resetBeat, sinceBeat } from "./heartbeat.ts"
import { killTree } from "./killtree.ts"
import { sandboxAvailable, startBridge, sandboxArgv, bridgeCommand } from "./sandbox.ts"
import { appendFileSync } from "node:fs"
import { getRunner, listAvailableRunners, unconfinedRunners, taskPrompt } from "./runners/index.ts"

export { taskPrompt }

const HOME = process.env.HOME!
const STATE = `${HOME}/.local/state/desktop-agent`

const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call"]

export interface AgentOutcome {
  ok: boolean
  /** First line of the report: what the HUD shows. */
  summary: string
  /** The whole markdown report, for the file the person can open. */
  report: string
}

/** The policy overlay must be live, or every gated action fails closed. */
export async function overlayReady(target: string): Promise<boolean> {
  try {
    const p = Bun.spawn([...SHELL_IPC, target, "status"],
                        { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out.includes("enabled")
  } catch { return false }
}

// The one running hand-off, so it can be stopped.
//
// Only one runs at a time by construction -- runCommand awaits it -- so a
// single slot is honest rather than a limitation. Without this there was no
// stop at all: "cancel" cleared the HUD and closed the prompt while the agent
// kept driving the desktop, which is worse than having no cancel, because it
// looked stopped.
let running: { kill: (sig?: number) => void } | null = null
let runningPid = 0
let stopped = false

/** Stop the hand-off in flight. Returns whether there was one. */
export function stopAgent(): boolean {
  if (!running) return false
  stopped = true
  // The whole tree, not just the handle we hold.
  //
  // A master that delegates has children, and killing only the master orphans
  // them: it dies, the HUD says stopped, and its subagents carry on driving
  // the desktop with a live lease behind them. Stop has to mean stop.
  if (runningPid) killTree(runningPid)
  else { try { running.kill() } catch {} }
  return true
}

/**
 * Run the hand-off. Resolves when the agent finishes or the deadline passes.
 * `onProgress` is called with coarse status only -- the HUD is a readout, not
 * a transcript.
 */
export async function handOff(
  phrase: string,
  opts: { timeoutMs?: number; workspace?: number; onProgress?: (s: string) => void } = {},
): Promise<AgentOutcome> {
  // Two limits, measuring different things.
  //
  // idleMs asks "has anything happened lately?" and is the one that normally
  // fires. It replaced a total-time ceiling that killed a run after thirty
  // successful tool calls for being slow, while a genuinely stuck agent got
  // exactly the same five minutes. Elapsed time was never the question.
  //
  // maxMs is the backstop for the case idle cannot see: an agent looping
  // productively forever, beating the whole way. Hours, not minutes -- it
  // exists so nothing runs unattended indefinitely, not to bound real work.
  const num = async (key: string, dflt: number) => {
    const v = Number(await settingStr(key, String(dflt)))
    return Number.isFinite(v) && v > 0 ? v * 1000 : dflt * 1000
  }
  // 120s swallows a slow model turn rather than trying to catch one. Thinking
  // happens inside the agent CLI as a network wait: no tool call, no CPU, and
  // nothing observable from here. Killing a thinking agent is worse than
  // waiting another minute for a stuck one.
  const idleMs = await num("agent.idleSec", 120)
  const maxMs = opts.timeoutMs ?? (await num("agent.maxRunSec", 3600))
  const workspace = opts.workspace ?? 10

  // agent.runner, NOT ai.provider.
  //
  // They are different jobs that happened to share a setting: ai.provider
  // picks the model that turns a sentence into commands (one small call,
  // cheap, no tools), while this picks the CLI that drives your desktop for
  // minutes with tools in its hands. Sharing one key meant choosing a planner
  // silently changed who was allowed to act -- and choosing an agent silently
  // changed who did the planning.
  const preferred = (await settingStr("agent.runner", "auto")).trim().toLowerCase()
  const runner = getRunner(preferred)

  if (!runner) {
    const loose = unconfinedRunners().map(r => r.name).join(", ")
    const available = listAvailableRunners().map(r => r.name).join(", ")
    return {
      ok: false,
      summary: loose
        // Naming the ones that exist but were not chosen, because otherwise
        // "no agent CLI" is a lie to someone who has three installed.
        ? `No confinable agent CLI. ${loose} installed but cannot be limited to the desktop tools — set agent.runner and agent.allowUnconfined to use one anyway`
        : available
          ? `No compatible agent CLI for "${preferred}" (installed: ${available})`
          : "No agent CLI installed (install Claude, Gemini, Codex, or OpenCode)",
      report: "",
    }
  }

  // An unconfined runner has to be asked for by name AND opted into. Naming it
  // is choosing a tool; this is consenting to what it gives up. The whole
  // premise of running an agent unattended is that the policy engine sees
  // every action, and it does not see anything an agent does through its own
  // shell.
  // A runner that keeps its own shell can still be made harmless: take away
  // the compositor sockets and the shell has nothing to drive. Confinement
  // stops being a property of the RUNNER and becomes a property of how it is
  // launched -- which is why this is checked before the refusal below rather
  // than as a softener for it.
  const sb = sandboxAvailable()
  const sandboxWanted = (await settingStr("agent.sandbox", "true")) !== "false"
  const sandboxed = !runner.confined && sandboxWanted && sb.ok

  if (!runner.confined && !sandboxed) {
    const allow = (await settingStr("agent.allowUnconfined", "false")) === "true"
    if (allow) {
      // Say so, in the audit log, at the time.
      //
      // The policy engine is identical whichever runner drives -- every
      // desktop_* call goes through the same gate. What changes is whether the
      // agent can avoid those tools, and an unconfined one can: it may run
      // hyprctl through its own shell, with no approval, no audit line and no
      // kill switch, because the server never sees it.
      //
      // Without this line the log of such a run is indistinguishable from a
      // fully policed one -- same entries, minus whatever happened off-road.
      // A record that cannot tell you it is incomplete is worse than a gap you
      // can see.
      try {
        appendFileSync(`${HOME}/.local/share/desktop-agent/desktop.log`,
          `${new Date().toISOString()} UNCONFINED RUN via ${runner.name} — ` +
          `only calls it chose to make through the desktop tools appear below\n`)
      } catch {}
    }
    if (!allow) {
      return {
        ok: false,
        summary: sb.ok
          ? `${runner.name} cannot be confined to the desktop tools — ${runner.unconfinedReason ?? "it keeps its own shell"}. Set agent.allowUnconfined to run it anyway.`
          // Naming what is missing, because the sandbox is the answer here and
          // "install bwrap" is a far better instruction than "turn off a
          // safety setting".
          : `${runner.name} keeps its own shell and cannot be sandboxed: ${sb.missing.join(" and ")} not installed. Install ${sb.missing.join(" and ")}, or set agent.allowUnconfined to run it unprotected.`,
        report: "",
      }
    }
  }

  const bun = Bun.which("bun")
  if (!bun) {
    return { ok: false, summary: "bun is not installed on PATH", report: "" }
  }

  const serverScript = new URL("../server/server.ts", import.meta.url).pathname

  // The bridge has to exist before prepare(), because the config prepare()
  // writes has to name it.
  // One environment for the desktop server, however it is reached.
  //
  // The bridge spawns servers too, so leaving the job's capability ceiling out
  // of it would mean a sandboxed scheduled run had no ceiling -- the same hole
  // as a runner that forgets to pass it, arrived at from the other direction.
  const mcpEnv: Record<string, string> = {
    DESKTOP_AGENT_IDENTITY: runner.id,
    DESKTOP_AGENT_ROLE: "master",
    DESKTOP_AGENT_WORKSPACE: String(workspace),
    ...(process.env.DESKTOP_AGENT_JOB_CAPS !== undefined
      ? {
          DESKTOP_AGENT_JOB_CAPS: process.env.DESKTOP_AGENT_JOB_CAPS,
          DESKTOP_AGENT_JOB: process.env.DESKTOP_AGENT_JOB ?? "",
        }
      : {}),
  }

  const bridge = sandboxed ? await startBridge("master", mcpEnv) : null
  if (sandboxed && !bridge) {
    return { ok: false, summary: "could not start the sandbox bridge — refusing to run unprotected", report: "" }
  }

  const prepared = await runner.prepare({
    phrase,
    workspace,
    serverScript,
    bunPath: bun,
    stateDir: STATE,
    mcp: bridge ? bridgeCommand() : { command: bun, args: ["run", serverScript] },
    mcpEnv,
    externallySandboxed: sandboxed,
  })

  if (!prepared) {
    // Not "could not confine" any more: prepare() failing means its config
    // files could not be written, which is a different fault and was
    // misleading for the three runners that never confine anything.
    return { ok: false, summary: `Could not set up ${runner.name} — refusing to run`, report: "" }
  }

  // Run from a directory of its own.
  //
  // The daemon's cwd is the home directory, so `claude -p` treated
  // ~/.claude/settings.local.json as PROJECT settings and loaded it. Two rules
  // in there -- saved by an "always allow" click in some other session, with a
  // regex containing a * that the permission parser rejects -- made every
  // hand-off fail with an error about a grep on a file nobody had mentioned.
  //
  // It is also a hole in the confinement. Project settings can ADD permissions,
  // and inheriting whatever happens to sit at the daemon's cwd is not a
  // decision anyone made. An empty directory has no .claude/ to inherit.
  const runDir = `${STATE}/run`
  try { require("node:fs").mkdirSync(runDir, { recursive: true }) } catch {}

    // Writable: its own working directory and where reports go, plus the
    // runner's own config directory so a token refresh does not fail on a
    // read-only mount. Everything else is read-only, and the compositor
    // sockets are not there at all.
    //
    // NOT the whole of STATE, which is what this used to mount. Two of the
    // things the sandbox exists to protect live directly in it:
    //
    //   yolo.json   the lease the server reads to decide whether ask means yes
    //   disabled    the kill switch, whose mere existence denies everything
    //
    // A sandboxed runner keeps its own shell, so a writable STATE let it write
    // itself an hour-long lease and delete the kill switch from inside the
    // sandbox -- the one file whose whole purpose is to be reachable when
    // nothing else is. The confinement was handing over the controls it exists
    // to enforce.
    const reportsDir = `${STATE}/runs`
    try { require("node:fs").mkdirSync(reportsDir, { recursive: true }) } catch {}
  const argv = bridge
    ? sandboxArgv(prepared.argv, {
        socket: bridge.socket,
        writable: [
            runDir, reportsDir,
          // Where the runners actually keep state. A read-only mount here does
          // not fail at startup, it fails on the first token refresh or cache
          // write -- late, and looking like something else.
          `${HOME}/.${runner.id}`,
          `${HOME}/.config/${runner.id}`,
          `${HOME}/.local/share/${runner.id}`,
          `${HOME}/.cache/${runner.id}`,
        ],
      })
    : prepared.argv

  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: prepared.cwd ?? runDir,
    env: { ...process.env, ...prepared.env },
  })

  running = proc
  runningPid = proc.pid
  stopped = false
  resetBeat()

  const startedAt = Date.now()
  let killedBy: "idle" | "max" | null = null
  const killer = setInterval(() => {
    if (Date.now() - startedAt > maxMs) killedBy = "max"
    else if (sinceBeat() > idleMs) killedBy = "idle"
    else return
    // Same reasoning as stopAgent: a timed-out master must not leave working
    // subagents behind it.
    killTree(proc.pid)
  }, 5000)
  const ticker = setInterval(() => opts.onProgress?.("working"), 4000)

  try {
    const out = (await new Response(proc.stdout).text()).trim()
    const code = await proc.exited
    if (stopped) {
      return { ok: false, summary: "Stopped", report: out }
    }
    // Neither limit is a failure of the agent, and "Claude Code failed" sends
    // someone hunting for a bug that is not there. Say which limit stopped it
    // and name the setting that governs it.
    if (killedBy === "idle") {
      return {
        ok: false,
        summary: `Stopped: nothing happened for ${Math.round(idleMs / 1000)}s — raise agent.idleSec if it was still thinking`,
        report: out,
      }
    }
    if (killedBy === "max") {
      return {
        ok: false,
        summary: `Stopped after ${Math.round(maxMs / 60000)} min at the hard limit — raise agent.maxRunSec`,
        report: out,
      }
    }
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim()
      return {
        ok: false,
        summary: (err || out).split("\n").pop()?.slice(0, 160) || `${runner.name} failed`,
        report: out,
      }
    }
    // The report's first heading is the summary. Falling back to the first
    // non-empty line covers a model that skipped the "#".
    const lines = out.split("\n").map(l => l.trim())
    const heading = lines.find(l => l.startsWith("# "))
    const summary = (heading ? heading.slice(2) : lines.find(Boolean) ?? "").trim()
    return { ok: true, summary: summary.slice(0, 200) || "Done", report: out }
  } finally {
    bridge?.stop()
    running = null
    runningPid = 0
    clearInterval(killer)
    clearInterval(ticker)
    if (prepared.cleanup) {
      try { await prepared.cleanup() } catch {}
    }
  }
}
