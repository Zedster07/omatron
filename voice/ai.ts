// Talking to whatever AI CLI the user already has.
//
// This is the third tier of command resolution and it only ever runs when the
// deterministic matcher found nothing. Tiers, in order:
//
//   1. registry match   instant, deterministic, no AI at all
//   2. AI routing       map an unrecognised phrase onto an EXISTING intent
//   3. AI planning      propose a new command for a genuinely novel request
//
// Nothing here executes anything. Every tier-2 and tier-3 result is a
// PROPOSAL that goes through the approval overlay with the exact argv on
// display. The AI widens what you can ask for; it does not widen what can
// happen without you seeing it.

export interface Provider {
  id: string
  /** "local" never leaves the machine. "agent" may call a hosted model. */
  kind: "local" | "agent"
  argv(prompt: string): string[]
  /** Rough budget; agents are slower and are only used for tier 3. */
  timeoutMs: number
}

function configuredModel(): string {
  if (process.env.DESKTOP_AGENT_OLLAMA_MODEL) return process.env.DESKTOP_AGENT_OLLAMA_MODEL
  try {
    const raw = JSON.parse(
      require("node:fs").readFileSync(`${process.env.HOME}/.config/omarchy/shell.json`, "utf8"))
    let found: any
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === "object") {
        if (typeof v.id === "string" && v.id.includes("desktop-agent") && v.settings) found = v.settings
        Object.values(v).forEach(walk)
      }
    }
    walk(raw)
    if (found?.aiModel) return String(found.aiModel)
  } catch {}
  return "llama3.2:3b"
}
const OLLAMA_MODEL = configuredModel()

/**
 * Which model a given provider should use. Empty means the CLI's own default.
 *
 * Kept per provider. It used to be a single "claudeModel", which was fine
 * while claude was the only one whose model could be set -- and wrong the
 * moment the panel let you choose gemini, because the setting still said
 * "sonnet" and still looked like it applied.
 */
function configuredModel(provider: string): string {
  try {
    const raw = JSON.parse(
      require("node:fs").readFileSync(
        `${process.env.HOME}/.config/desktop-agent/settings.json`, "utf8"))
    const per = raw?.ai?.model?.[provider]
    if (typeof per === "string" && per) return per
    // What this setting used to be called, so an existing choice survives.
    if (provider === "claude") return String(raw?.ai?.claudeModel ?? "")
  } catch {}
  return ""
}

// Ordered by preference, best first.
//
// A CLI agent leads and Ollama is the fallback. The local model is free and
// offline, which is the right default in the abstract -- but in practice a 3B
// model asked "which of these twelve commands, or none?" answers badly: it
// routed "play Despacito on YouTube" to audio.mute, and "desktop 3" to
// workspace.next instead of workspace.switch with a slot. Saying "none of
// these" is the single thing small models are worst at, and this is a job
// made almost entirely of that.
//
// So: use the good model when there is one, and keep the local one for the
// machine that has no agent installed rather than as the everyday path.
const CANDIDATES: Provider[] = [
  {
    id: "claude",
    kind: "agent",
    // The model is configurable because this call is latency-sensitive and
    // small: a few thousand tokens of catalogue in, a line of JSON out. That is
    // not the shape that needs the most capable model, and the cheaper one is
    // 2.5x less per token.
    argv: p => {
      const m = process.env.DESKTOP_AGENT_CLAUDE_MODEL || configuredModel("claude")
      return m ? ["claude", "-p", "--model", m, p] : ["claude", "-p", p]
    },
    timeoutMs: 90_000,
  },
  // Each takes its model the way its own CLI spells it. Unset means the CLI
  // decides, which is the right default and the only safe one: naming a model
  // a given install cannot reach fails the call outright.
  {
    id: "opencode",
    kind: "agent",
    argv: p => {
      const m = configuredModel("opencode")
      return m ? ["opencode", "run", "--model", m, p] : ["opencode", "run", p]
    },
    timeoutMs: 90_000,
  },
  {
    id: "codex",
    kind: "agent",
    argv: p => {
      const m = configuredModel("codex")
      return m ? ["codex", "exec", "-m", m, p] : ["codex", "exec", p]
    },
    timeoutMs: 90_000,
  },
  {
    id: "gemini",
    kind: "agent",
    argv: p => {
      const m = configuredModel("gemini")
      return m ? ["gemini", "-m", m, "-p", p] : ["gemini", "-p", p]
    },
    timeoutMs: 90_000,
  },
  {
    id: "ollama",
    kind: "local",
    // --format json constrains decoding to valid JSON, which matters more for
    // a small model than size does: we need a parseable answer, not prose.
    argv: p => ["ollama", "run", configuredModel("ollama") || OLLAMA_MODEL, "--format", "json", p],
    timeoutMs: 60_000,
  },
]

export function detectProviders(): Provider[] {
  return CANDIDATES.filter(p => Bun.which(p.argv("x")[0]) !== null)
}

/**
 * Pick a provider.
 *
 * `tier` no longer steers the choice toward local or hosted -- both jobs want
 * the best available model. It is kept because the caller uses it to decide
 * how much of the OS command surface to send, which does still depend on
 * whether the far end is a 3B model on this laptop or not.
 */
export function pickProvider(preference: string, _tier: "local" | "any"): Provider | null {
  const available = detectProviders()
  if (preference && preference !== "auto") {
    return available.find(p => p.id === preference) ?? available[0] ?? null
  }
  return available[0] ?? null
}

/**
 * Why a provider produced nothing, when it produced nothing.
 *
 * This used to return "" for every failure, so an unauthenticated CLI, one
 * that hung past its timeout, and a model that genuinely had no answer were
 * indistinguishable -- all three surfaced to the person as "nothing matched,
 * so nothing ran". Measured on this machine: gemini exits with
 * IneligibleTierError because its login lapsed, and opencode produced zero
 * bytes in two minutes. Both were reported as the request being unsupported,
 * which sent someone looking at the wrong thing entirely.
 */
export type Answer = { text: string; failure?: string }

/**
 * How long to wait for a planning answer, in milliseconds.
 *
 * Configurable because the right number is a property of the model, not of
 * this plugin: a hosted Sonnet answers this prompt in a few seconds, and a
 * free-tier or local model on a busy machine can take minutes. 90s was picked
 * for the former and silently failed the latter -- and, until the previous
 * commit, failed it in a way that read as "nothing matched".
 *
 * 0 or unset keeps each provider's own default, which is what someone who has
 * not thought about it wants.
 */
function configuredTimeoutMs(fallback: number): number {
  try {
    const raw = JSON.parse(
      require("node:fs").readFileSync(
        `${process.env.HOME}/.config/desktop-agent/settings.json`, "utf8"))
    const secs = Number(raw?.ai?.timeoutSeconds)
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000)
  } catch {}
  return fallback
}

export async function ask(provider: Provider, prompt: string): Promise<Answer> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(provider.argv(prompt), { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  } catch (e) {
    return { text: "", failure: `${provider.id} could not be started: ${e}` }
  }

  // Read per call, not at module load: the daemon is long-lived and the panel
  // writes this underneath it.
  const limitMs = configuredTimeoutMs(provider.timeoutMs)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill() } catch {}
  }, limitMs)

  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    if (timedOut) {
      return { text: out, failure: `${provider.id} did not answer within ${Math.round(limitMs / 1000)}s (raise "answer timeout" in the panel's AI tab if the model is just slow)` }
    }
    if (proc.exitCode !== 0) {
      // First non-empty line of stderr: these CLIs print a stack trace under
      // it, and the first line is the part a person can act on.
      const why = (err.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160)
      return { text: out, failure: `${provider.id} exited ${proc.exitCode}${why ? `: ${why}` : ""}` }
    }
    if (!out.trim()) {
      return { text: "", failure: `${provider.id} returned nothing` }
    }
    return { text: out }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull the first JSON object out of a model's reply.
 *
 * Every one of these CLIs decorates its output differently -- fenced blocks,
 * a preamble, reasoning traces from thinking models. Rather than fight each
 * one, find the first balanced {...} and parse that. A model that cannot
 * produce one is treated as having produced nothing, which is the safe
 * reading.
 */
export function extractJson(text: string): any | null {
  const s = String(text ?? "")
  const start = s.indexOf("{")
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) { esc = false; continue }
    if (c === "\\") { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}
