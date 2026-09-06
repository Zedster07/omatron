// Reading the plugin's settings.
//
// One source of truth: ~/.config/desktop-agent/settings.json, written by the
// panel through bin/desktop-agent-config. The scripts used to dig these out of
// shell.json, which meant the panel and the shell's own settings form were two
// writers over one file -- and the panel would have silently done nothing.

const HOME = process.env.HOME!
const PATH = `${HOME}/.config/desktop-agent/settings.json`

const DEFAULTS: Record<string, unknown> = {
  "voice.sttMode": "local",
  "voice.biasPrompt": true,
  // The full path, and no longer offered as a choice.
  //
  // It was four tiers in a dropdown, and the three lesser ones only described
  // the plugin with parts of itself switched off. Nobody chooses "route" on
  // purpose -- they choose it once, forget, and later wonder why a request
  // that needed the screen came back as "I cannot do that". Kept as a setting
  // so an existing file still parses and anyone who wants it can hand-edit.
  "ai.assist": "route+plan+agent",
  "ai.provider": "auto",
  // Seconds to wait for a planning answer. Right for a hosted model; a free
  // tier or a local one on a busy machine can want several times this.
  "ai.timeoutSeconds": 90,
  "ai.localModel": "llama3.2:3b",
  "command.enabled": true,
  "command.confirm": "destructive-only",
  "command.thirdParty": true,
  "command.threshold": 62,
  "policy.recap": true,
}

// Keyed on the file's mtime, not cached forever. The daemon is long-lived and
// the panel writes this file underneath it, so a plain `if (cache) return
// cache` meant every settings change silently did nothing until the daemon was
// restarted -- the panel would appear to work and change no behaviour. Same
// bug the app cache had.
let cache: any = null
let cachedAt = -1

async function load(): Promise<any> {
  let mtime = 0
  try { mtime = (await Bun.file(PATH).stat()).mtimeMs } catch {}
  if (cache && mtime === cachedAt) return cache
  try { cache = await Bun.file(PATH).json() } catch { cache = {} }
  cachedAt = mtime
  return cache
}

/** Dotted lookup with a default, e.g. setting("ai.assist", "route"). */
export async function setting<T = string>(path: string, fallback?: T): Promise<T> {
  const cfg = await load()
  let node: any = cfg
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") { node = undefined; break }
    node = node[part]
  }
  if (node === undefined || node === null) {
    return (fallback !== undefined ? fallback : DEFAULTS[path]) as T
  }
  return node as T
}

export async function settingStr(path: string, fallback: string): Promise<string> {
  return String(await setting(path, fallback))
}
