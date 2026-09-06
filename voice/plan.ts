// Asking an AI what a phrase meant, when the matcher had no idea.
//
// Two jobs, deliberately kept apart because they carry very different risk:
//
//   route()  maps the phrase onto an intent that ALREADY EXISTS. The output is
//            an id from a list -- the model cannot invent an action, only pick
//            one. Cheap, local, and the answer is as safe as the registry.
//
//   plan()   lets the model propose a NEW command for something the registry
//            does not cover. This is the only place in the plugin where an
//            action can come from a model rather than a person, so its output
//            is checked against voice/safety.ts and then always shown for
//            approval with the exact argv on display. It is never eligible for
//            the unattended lease.

import type { Intent } from "./intents.ts"
import { ask, pickProvider, extractJson, type Provider } from "./ai.ts"
import { loadOsCommands, relevantCommands, availableTools, installedApps } from "./osmap.ts"
import { checkProposedCommand } from "./safety.ts"
import { asContext } from "./history.ts"

export interface RouteResult { id: string; slots: Record<string, string> }
export interface PlanResult {
  /**
   * The commands to run, in order. Usually one.
   *
   * A single argv could not express "play this song": the best one-shot answer
   * is a search URL, which opens a page and stops -- the request half-done and
   * looking like a failure. Some intents genuinely take a sequence, so the
   * plan is a list and the approval prompt shows all of it.
   */
  steps: string[][]
  explanation: string
  severity: "normal" | "destructive"
  provider: string
}

/** How many commands one spoken sentence may turn into. */
const MAX_STEPS = 5

// ------------------------------------------------------------------ tier 2

export async function route(
  phrase: string, intents: Intent[], preference = "auto",
): Promise<{ result: RouteResult | null; provider: string | null }> {
  const provider = pickProvider(preference, "local")
  if (!provider) return { result: null, provider: null }

  const catalogue = intents.map(i => {
    const slots = i.slots ? ` slots:${Object.keys(i.slots).join(",")}` : ""
    return `${i.id} — ${i.description ?? i.id}. examples: ${i.phrases.slice(0, 3).join("; ")}${slots}`
  }).join("\n")

  const prompt = `You match a spoken phrase to one desktop command from a fixed list.

Commands:
${catalogue}

Phrase: "${phrase}"

Reply with JSON only, no prose:
{"id": "<exact command id from the list>", "slots": {"<slot>": "<value>"}}
If nothing in the list fits, reply {"id": null}.
Do not invent an id. Only ids from the list above are valid.`

  const answer = await ask(provider, prompt)
  const json = extractJson(answer.text)
  if (!json || !json.id || typeof json.id !== "string")
    return { result: null, provider: provider.id, failure: answer.failure }

  // The model is not trusted to stay inside the list; verify.
  if (!intents.some(i => i.id === json.id)) return { result: null, provider: provider.id }

  const slots: Record<string, string> = {}
  if (json.slots && typeof json.slots === "object") {
    for (const [k, v] of Object.entries(json.slots)) {
      if (typeof v === "string" || typeof v === "number") slots[k] = String(v)
    }
  }
  return { result: { id: json.id, slots }, provider: provider.id }
}

// ------------------------------------------------------------------ tier 3

export async function plan(
  phrase: string, preference = "auto",
): Promise<{ result: PlanResult | null; provider: string | null; refusal?: string }> {
  const provider: Provider | null = pickProvider(preference, "any")
  if (!provider) return { result: null, provider: null }

  const all = await loadOsCommands()
  // A hosted agent gets the whole surface; a local model gets the relevant
  // slice, because 6.5k tokens of prompt through a 3B model on a laptop CPU
  // is slower than the request is worth.
  const routes = provider.kind === "agent" ? all : relevantCommands(phrase, all, 45)
  const catalogue = routes
    .map(c => `${c.route}${c.args ? " " + c.args : ""} — ${c.summary}`)
    .join("\n")

  const prompt = `You turn a spoken request into the commands to run on an Omarchy Linux desktop (Arch Linux, Hyprland, Wayland).

Omarchy CLI routes available:
${catalogue}

Other programs installed: ${availableTools().join(", ")}

Apps that can be opened by name (use: uwsm-app -- "<Name>.desktop"):
${installedApps().join(", ")}

Rules:
- Commands are executed directly as argv arrays. There is NO shell, so pipes, redirects, globs, $(...) and ; do not work. Do not use them.
- Never use sudo, a shell (sh/bash), a package manager, or anything that deletes, moves or overwrites files.
- Prefer an "omarchy ..." route when one fits. To open an installed app use uwsm-app with its Desktop Entry ID. Do NOT use "omarchy launch <app>": that route exists only for a fixed handful of names.
- FINISH THE REQUEST. Do not stop at a step that merely gets close to it. Opening a search page for something the user asked you to play is not playing it.
- Use at most ${MAX_STEPS} steps, and only more than one when a single command genuinely cannot do the job.

Worked examples of finishing rather than approaching:
- "play <song> on youtube" -> [["xdg-open", "https://www.youtube.com/results?search_query=<song>"]]
  (ytsearch1 resolves and plays the first hit; a youtube.com/results URL only opens a search)
- "watch <video> on youtube" -> [["xdg-open", "https://www.youtube.com/results?search_query=<video>"]]
- "open <app>" -> [["uwsm-app", "--", "<Name>.desktop"]]
- "look up <thing>" -> [["xdg-open", "https://duckduckgo.com/?q=<thing>"]]
- A service with no app installed is still reachable on the web. "open youtube
  music and play something" -> [["xdg-open", "https://music.youtube.com/"]]
  Not having a desktop entry is not a reason to give up on it.

Request: "${phrase}"

Reply with JSON only, no prose and no code fence:
{"steps": [["program","arg"], ["program","arg"]], "explanation": "<one short sentence a user will read before approving>", "severity": "normal"}
Use "severity": "destructive" if anything in it closes, deletes, or interrupts something.
If you cannot do it safely, reply {"steps": null, "reason": "<why>"}.`

  const answer = await ask(provider, prompt)
  const json = extractJson(answer.text)

  // Accept a bare `argv` too: models fall back to the older single-command
  // shape often enough that rejecting it would look like a random failure.
  const rawSteps: unknown[] =
    Array.isArray(json?.steps) ? json.steps
    : Array.isArray(json?.argv) ? [json.argv]
    : []
  if (rawSteps.length === 0) return { result: null, provider: provider.id }

  const steps: string[][] = []
  for (const s of rawSteps.slice(0, MAX_STEPS)) {
    if (!Array.isArray(s) || s.length === 0) continue
    steps.push(s.map((a: unknown) => String(a)))
  }
  if (steps.length === 0) return { result: null, provider: provider.id }

  // EVERY step is checked, not just the first. A plan is only as safe as its
  // worst command, and a denied one must stop the whole thing before a person
  // is asked -- an approval prompt for something the rules already forbid is
  // not a safeguard, it is a trap with a button.
  for (const step of steps) {
    const verdict = checkProposedCommand(step)
    if (!verdict.ok) return { result: null, provider: provider.id, refusal: verdict.reason }
  }

  return {
    result: {
      steps,
      explanation: String(json.explanation ?? "").slice(0, 200),
      severity: json.severity === "destructive" ? "destructive" : "normal",
      provider: provider.id,
    },
    provider: provider.id,
  }
}


// ---------------------------------------------------------------- combined
//
// One call that either picks a registered command or writes new ones.
//
// route() and plan() used to run in sequence on a miss, which meant TWO round
// trips -- about twenty seconds before anything happened. They also ask
// overlapping questions: "is this one of these twelve?" and "what would you
// run?" are the same judgement seen twice. Asking once halves the latency and
// removes the case where routing picks a poor match and planning never gets
// consulted.
//
// The registry is still preferred where it fits: a registered command is one
// somebody wrote down on purpose, and its argv has been seen before.
export interface Resolution {
  kind: "intent" | "steps" | "agent"
  id?: string
  slots?: Record<string, string>
  steps?: string[][]
  explanation: string
  severity: "normal" | "destructive"
  provider: string
}

export async function resolveRequest(
  phrase: string, intents: Intent[], preference = "auto", allowAgent = false,
): Promise<{ result: Resolution | null; provider: string | null; refusal?: string; failure?: string }> {
  const provider = pickProvider(preference, "any")
  if (!provider) return { result: null, provider: null }

  const all = await loadOsCommands()
  const routes = provider.kind === "agent" ? all : relevantCommands(phrase, all, 45)
  const catalogue = routes
    .map(c => `${c.route}${c.args ? " " + c.args : ""} — ${c.summary}`)
    .join("\n")

  const registry = intents.map(i => {
    const slots = i.slots ? ` slots:${Object.keys(i.slots).join(",")}` : ""
    return `${i.id} — ${i.description ?? i.id}${slots}`
  }).join("\n")

  const prompt = `Someone spoke this request to their Linux desktop (Arch, Hyprland, Wayland):

"${phrase}"
${asContext()}
There is a list of ready-made commands. If one of them IS the request, use it.
Otherwise write the commands to carry it out yourself.

Ready-made commands:
${registry}

Omarchy CLI routes:
${catalogue}

Other programs installed: ${availableTools().join(", ")}

Apps that can be opened by name (use: uwsm-app -- "<Name>.desktop"):
${installedApps().join(", ")}

Rules:
- Commands run as argv arrays. There is NO shell: no pipes, redirects, globs, $(...) or ;.
- Never use sudo, a shell, a package manager, or anything that deletes, moves or overwrites files.
- For a reminder -- anything shaped like "remind me at/in X to Y" -- use:
    ["desktop-agent", "remind", "<systemd time>", "<what to say>"]
  systemd times look like "2026-09-06 14:30" (once), "Mon..Fri 08:30" or "09:00" (every day). "tomorrow 09:00" and "today 18:30" also work. A BARE TIME REPEATS DAILY, so give a full date when they meant once. It sends a notification then and runs no agent, which is the whole of what a reminder is.
- mpv, vlc and other players are for files ON THIS MACHINE. Never hand one a URL, a ytdl:// address or a ytsearch query — that is rejected before it runs. Anything on the web opens in the BROWSER, where it can be paused, skipped, searched from and closed. A background player satisfies the sentence and not the request: no window, nothing to press, and noise coming from nowhere.
- FINISH the request. Do not stop at a step that merely gets close to it. Opening a search page for something you were asked to PLAY is not playing it: the person asked for a song and got a list of links, which is the same failure as opening a homepage.
- So if the request is to actually play, watch or listen to something, and you cannot name the exact URL that starts it, that is not a job for commands. Hand it to the agent, which can open the page, pick the right result and press play. Do not settle for a search page and call it done.
- To open an installed app use uwsm-app with its Desktop Entry ID. Do NOT use "omarchy launch <app>": that route exists for a fixed handful of names only.
- A service with no app installed is still reachable on the web.
- At most ${MAX_STEPS} steps.
${allowAgent ? `- If the request genuinely CANNOT be done with commands -- it needs to read what
  is on the screen, click one particular thing, or react to whatever happens
  next -- reply {"kind":"agent","reason":"<why commands are not enough>"} and an
  agent that can see and click will take it instead. This is the expensive path
  and it is slow, so do not reach for it to avoid thinking: if commands can
  finish the job, write the commands.` : ""}

Examples:
- "mute" -> {"kind":"intent","id":"audio.mute","slots":{}}
- "go to the third workspace" -> {"kind":"intent","id":"workspace.switch","slots":{"n":"3"}}
- "play <song> on youtube" -> {"kind":"steps","steps":[["xdg-open","https://www.youtube.com/results?search_query=<song>"]]}
- "open youtube music and play something" -> {"kind":"steps","steps":[["xdg-open","https://music.youtube.com/"]]}
${allowAgent ? `- "reply to the message that just came in" -> {"kind":"agent","reason":"needs to read what the message says"}
- "close whichever window is covering the clock" -> {"kind":"agent","reason":"needs to see what is on screen"}
- "play despacito on youtube" -> {"kind":"agent","reason":"a search URL only lists results; playing it means picking one and pressing play"}` : ""}

Reply with JSON only, no prose and no code fence:
{"kind":"intent","id":"<id from the list>","slots":{}}
or
{"kind":"steps","steps":[["program","arg"]],"explanation":"<one short sentence the user reads before approving>","severity":"normal"}
${allowAgent ? `or
{"kind":"agent","reason":"<why commands cannot do it>"}
` : ""}Use "severity":"destructive" if anything closes, deletes or interrupts something.
If you cannot do it safely, reply {"kind":"none","reason":"<why>"}.`

  const answer = await ask(provider, prompt)
  const json = extractJson(answer.text)
  // A provider that could not answer is not a request that cannot be done.
  // Carrying the reason up is the difference between "your gemini login has
  // lapsed" and "nothing matched", which is what this said before.
  if (!json) return { result: null, provider: provider.id, failure: answer.failure }

  if (json.kind === "intent" && typeof json.id === "string") {
    // Never trusted to stay inside the list.
    if (!intents.some(i => i.id === json.id)) return { result: null, provider: provider.id }
    const slots: Record<string, string> = {}
    if (json.slots && typeof json.slots === "object") {
      for (const [k, v] of Object.entries(json.slots)) {
        if (typeof v === "string" || typeof v === "number") slots[k] = String(v)
      }
    }
    return {
      result: { kind: "intent", id: json.id, slots, explanation: "", severity: "normal", provider: provider.id },
      provider: provider.id,
    }
  }

  // The agent tier is only reachable when the setting allows it. A model that
  // asks for it anyway is treated as having no answer, rather than being
  // quietly upgraded past the user's choice.
  if (json.kind === "agent") {
    if (!allowAgent) return { result: null, provider: provider.id }
    return {
      result: {
        kind: "agent", explanation: String(json.reason ?? json.explanation ?? "").slice(0, 200),
        severity: "normal", provider: provider.id,
      },
      provider: provider.id,
    }
  }

  const rawSteps: unknown[] = Array.isArray(json.steps) ? json.steps
    : Array.isArray(json.argv) ? [json.argv] : []
  const steps: string[][] = []
  for (const st of rawSteps.slice(0, MAX_STEPS)) {
    if (Array.isArray(st) && st.length) steps.push(st.map((a: unknown) => String(a)))
  }
  if (steps.length === 0) return { result: null, provider: provider.id }

  for (const step of steps) {
    const verdict = checkProposedCommand(step)
    if (!verdict.ok) return { result: null, provider: provider.id, refusal: verdict.reason }
  }

  return {
    result: {
      kind: "steps", steps,
      explanation: String(json.explanation ?? "").slice(0, 200),
      severity: json.severity === "destructive" ? "destructive" : "normal",
      provider: provider.id,
    },
    provider: provider.id,
  }
}
