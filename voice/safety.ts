// What an AI is never allowed to propose.
//
// Tier 3 lets a model invent a command. That is only defensible because the
// result is checked here before a human is ever asked to approve it -- an
// approval prompt for `sudo rm -rf /` is not a safety mechanism, it is a trap
// with a button on it. The user's own policy engine already draws these lines
// for the MCP agent; this is the same reasoning applied to voice.
//
// Two groups, for two different reasons.

/**
 * Re-entering a shell or an interpreter launders every rule below it: the
 * first token stops being the real program. Escalation is its own category.
 */
/** Players that must only ever be handed something on this machine. */
const PLAYERS = new Set(["mpv", "vlc", "mplayer", "ffplay", "cvlc", "mpv.sh"])

const LAUNDERERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "env", "xargs", "eval",
  "python", "python3", "perl", "ruby", "node", "bun", "deno", "lua", "awk",
  "ssh", "scp", "sftp", "nc", "ncat", "socat", "telnet",
  "sudo", "pkexec", "doas", "su", "runuser",
  // Not shells, and that is exactly why they were missed: ordinary utilities
  // whose entire job is to exec something else. "timeout 10 <anything>" walked
  // straight past this filter because only the first word was ever judged.
  "timeout", "nice", "ionice", "stdbuf", "nohup", "setsid", "chrt", "taskset",
  "unshare", "flatpak-spawn", "systemd-run", "busybox",
])

/**
 * Irreversible, or reaches past the desktop into the system. A voice command
 * misheard by one word must not be able to do any of these.
 */
const DESTRUCTIVE = new Set([
  "rm", "rmdir", "shred", "dd", "mkfs", "fdisk", "parted", "wipefs",
  "mv", "cp", "install", "truncate", "tee", "ln",
  "chmod", "chown", "chgrp", "chattr", "setfacl",
  "kill", "pkill", "killall", "systemctl", "loginctl", "journalctl",
  "shutdown", "reboot", "halt", "poweroff", "mount", "umount", "swapoff",
  "pacman", "yay", "paru", "apt", "dnf", "pip", "npm", "cargo", "gem",
  "crontab", "at", "iptables", "nft", "ufw", "passwd", "usermod", "useradd",
  "git", "curl", "wget", "rsync",
  // The agent's own controls: a voice command must not be able to widen its
  // own leash or answer its own approval prompts.
  // desktop-agent-config was named in a check further down but never listed
  // here, so the argument scan never saw it -- and the argument scan is the
  // half that catches it hiding behind a launcher.
  "desktop-agent", "desktop-agent-config", "desktop-agent-arm", "desktop-yolo",
  "qs", "hyprctl", "voxtype",
])

export interface Refusal { ok: false; reason: string; token: string }
export interface Allowed { ok: true }

function basename(p: string): string {
  return String(p ?? "").split("/").filter(Boolean).pop() ?? ""
}

export function checkProposedCommand(argv: string[]): Allowed | Refusal {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
    return { ok: false, reason: "no command was proposed", token: "" }
  }

  const prog = basename(argv[0])

  // A media player is for files on this machine.
  //
  // Pointing mpv at the web is how "play despacito on youtube" became audio
  // coming out of a process with no window, nothing to pause and nothing to
  // find. Rejecting it here rather than asking for it in the prompt is the
  // point: the prompt DID ask, in a worked example, and the example is what
  // got followed. A rule the model cannot decline is a different kind of rule.
  if (PLAYERS.has(prog)) {
    const remote = argv.slice(1).find(a =>
      /^(https?|ytdl|ytsearch\d*|rtmp|rtsp):/i.test(a) || /^ytdl:\/\//i.test(a))
    if (remote) {
      return { ok: false, token: remote,
               reason: `${prog} is for local files — anything on the web opens in the browser, where it can be paused, skipped and closed` }
    }
  }

  if (LAUNDERERS.has(prog)) {
    return { ok: false, token: prog,
             reason: `${prog} would re-enter a shell, which puts every other rule out of reach` }
  }
  // This plugin's own CLI can change settings, install units and rewrite the
  // agent's configuration, so it is on the destructive list and stays there.
  // One subcommand is exempt: `remind` only sets a notification for a time,
  // which is exactly the kind of thing someone says out loud, and routing it
  // through an agent hand-off instead would spend a model on remembering.
  //
  // Named explicitly rather than by prefix. "desktop-agent" is not safe; that
  // one verb is.
  // This plugin's own settings are not something a sentence should change.
  //
  // desktop-agent-config writes the settings file and the policy's full-access
  // switch. A misheard phrase reaching it could widen what the agent may do --
  // and once the panel can toggle full access, this is the command that
  // toggle runs. The UI is unreachable to an agent by geometry; the command
  // behind it has to be unreachable too, or the boundary just moves.
  if (prog === "desktop-agent-config") {
    return { ok: false, token: prog,
             reason: "desktop-agent-config changes this plugin's own settings and permissions; it is only for you, from the panel or a terminal" }
  }

  if (prog === "desktop-agent") {
    if (argv[1] === "remind") return { ok: true }
    return { ok: false, token: `${prog} ${argv[1] ?? ""}`.trim(),
             reason: `desktop-agent can change this plugin's own configuration; only "desktop-agent remind" may be run from a spoken request` }
  }

  if (DESTRUCTIVE.has(prog)) {
    return { ok: false, token: prog,
             reason: `${prog} is not something a misheard sentence should be able to run` }
  }

  // Commands are exec'd as argv with no shell, so metacharacters are literal
  // rather than dangerous. They are still a sign the model believed it was
  // writing a shell line, which means the rest of its output is suspect.
  //
  // But only the COMPOSITION operators are that sign. A bare "&" is how every
  // URL separates query parameters, and rejecting those refused a perfectly
  // ordinary `xdg-open https://…?list=x&index=1` with "contains shell syntax"
  // -- a safety rule firing on the safest thing in the request.
  // A semicolon FOLLOWED by whitespace is the shell-composition shape. The
  // earlier form required whitespace before it too, so "x.com; rm -rf ~" slipped
  // past -- there is no space before that semicolon. Real URLs do not contain
  // "; " at all.
  const SHELL_COMPOSITION = /&&|\|\||`|\$\(|>>|<<|;\s|;$/
  for (const a of argv) {
    if (typeof a !== "string") return { ok: false, reason: "malformed argument", token: "" }
    // A URL is a single argv element and cannot be anything but data here --
    // but only if it is actually a URL. Real ones contain no whitespace, so
    // requiring that keeps the exemption from covering
    // "https://x.com; rm -rf ~", which is inert but is nobody's real link.
    if (/^https?:\/\/\S+$/i.test(a) && !/\s/.test(a)) continue
    if (SHELL_COMPOSITION.test(a)) {
      return { ok: false, token: a.slice(0, 40),
               reason: "the proposal contains shell syntax, so it was not written as a plain command" }
    }
  }

  // A denylisted program hiding in a later argument, e.g. ["flatpak","run","sudo"].
  for (const a of argv.slice(1)) {
    const b = basename(a)
    if (LAUNDERERS.has(b) || DESTRUCTIVE.has(b)) {
      return { ok: false, token: b,
               reason: `${b} appears as an argument, which is how a blocked program gets run anyway` }
    }
  }

  return { ok: true }
}
