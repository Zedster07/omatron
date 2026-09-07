// Does every tool that synthesises input, or drives the browser, appear in the
// set that governs it?
//
// Written because desktop_type_secret did not. It types a credential, and
// being absent from INPUT_TOOLS meant it could do so while an approval card
// was on screen or while one of our own surfaces held keyboard focus -- the
// exact case that set exists for. Adding a tool means remembering to add it to
// two unrelated collections a thousand lines away, and nothing enforced that.
//
// Run from the repo: bun bin/check-tool-sets.ts
import { readFileSync } from "fs"
const src = readFileSync(new URL("../server/server.ts", import.meta.url), "utf8")

const tools = [...src.matchAll(/server\.registerTool\(\s*"(desktop_[a-z_]+)"/g)].map((m) => m[1])
const setOf = (name: string) => {
  const i = src.indexOf(`const ${name}`)
  const body = src.slice(i, src.indexOf("\n}", i) + 2)
  return new Set([...body.matchAll(/desktop_[a-z_]+/g)].map((m) => m[0]))
}
const input = setOf("INPUT_TOOLS")
const master = setOf("MASTER_ONLY")

const typesOrClicks = tools.filter((t) => /_(type|key|mouse|type_secret)$/.test(t) && !t.includes("browser"))
const browsery = tools.filter((t) => t.startsWith("desktop_browser_"))

let bad = 0
for (const t of typesOrClicks) if (!input.has(t)) { console.log(`  MISSING from INPUT_TOOLS:  ${t}`); bad++ }
for (const t of [...typesOrClicks, ...browsery]) if (!master.has(t)) { console.log(`  MISSING from MASTER_ONLY: ${t}`); bad++ }
console.log(`\n  ${tools.length} tools registered; ${bad} gap(s)`)
if (bad) process.exit(1)
