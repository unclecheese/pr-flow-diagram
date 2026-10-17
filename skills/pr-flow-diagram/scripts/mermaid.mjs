#!/usr/bin/env node
/**
 * Emits a flow document as a markdown fragment for a PR description or
 * comment: one collapsed <details> per flow, holding its Mermaid flowchart
 * and the steps the author flagged with a concern.
 *
 *   node mermaid.mjs <input.json> [output.md]
 *
 * Mermaid is what GitHub renders natively in markdown, so this is the view
 * that shows up inline on the PR itself. It is an overview, not a
 * replacement for the HTML page: no side panel, no concern colours (an
 * explicit fill would misread in one of GitHub's two themes), no keyboard
 * walkthrough.
 *
 * Deterministic, like the HTML build: node ids come from position, never
 * from a hash or iteration order.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { validateDoc } from "./lib/validate.mjs"

/** Mermaid reads these inside a quoted label, so they cannot survive raw.
 *  # goes first: it introduces every other entity. */
const label = (text) =>
  String(text)
    .replaceAll("#", "#35;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;")
    .replace(/\s+/g, " ")
    .trim()

export const flowToMermaid = (flow) => {
  const nodeId = new Map(flow.steps.map((s, i) => [s.id, `n${i}`]))
  const lines = ["flowchart TD"]
  flow.lanes.forEach((lane, i) => {
    const inLane = flow.steps.filter((s) => s.lane === lane)
    if (inLane.length === 0) return
    lines.push(`  subgraph lane${i}["${label(lane)}"]`)
    for (const s of inLane) {
      const file = s.file ? s.file.split("/").pop() : "infrastructure"
      lines.push(
        `    ${nodeId.get(s.id)}["${label(s.title)}<br/><small>${label(file)}</small>"]`,
      )
    }
    lines.push("  end")
  })
  for (const s of flow.steps) {
    for (const n of s.next) {
      const edge = n.label ? `-->|"${label(n.label)}"|` : "-->"
      lines.push(`  ${nodeId.get(s.id)} ${edge} ${nodeId.get(n.to)}`)
    }
  }
  // Dashes only, no fills: GitHub picks the mermaid theme from the reader's
  // colour scheme, and a hardcoded fill loses its contrast in one of them.
  const passthrough = flow.steps
    .filter((s) => !s.inStack || !s.file)
    .map((s) => nodeId.get(s.id))
  if (passthrough.length > 0) {
    lines.push("  classDef passthrough stroke-dasharray: 4 3")
    lines.push(`  class ${passthrough.join(",")} passthrough`)
  }
  return lines.join("\n")
}

export const docToMermaid = (doc) =>
  doc.flows.map((f) => ({ flow: f, mermaid: flowToMermaid(f) }))

/** GitHub gives up on a long mermaid block and shows a bare "unable to
 *  render" box, well before a comment reaches its own 65536-character cap. */
export const RENDER_BUDGET = 45000

export const oversized = (diagrams) =>
  diagrams
    .filter(({ mermaid }) => mermaid.length > RENDER_BUDGET)
    .map(({ flow }) => flow.id)

/** GitHub rejects a PR body or comment longer than this. */
export const BODY_LIMIT = 65536

const html = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim()

/** <summary> is HTML, so markdown backticks would show literally. */
const inline = (text) => html(text).replace(/`([^`]+)`/g, "<code>$1</code>")

const where = (step, pr) => {
  if (!step.file) return ""
  const code = step.fn ? `\`${step.file}\` \`${step.fn}\`` : `\`${step.file}\``
  if (!pr.repo) return ` (${code})`
  return ` ([${code}](https://github.com/${pr.repo}/blob/${pr.headSha}/${encodeURI(step.file)}))`
}

const reviewFocus = (flow, pr) => {
  const byConcern = new Map()
  for (const s of flow.steps) {
    if (!s.concern) continue
    if (!byConcern.has(s.concern)) byConcern.set(s.concern, [])
    byConcern.get(s.concern).push(s)
  }
  if (byConcern.size === 0) return []
  const lines = ["", "**Review focus**", ""]
  for (const [concern, steps] of byConcern) {
    lines.push(`- **${html(concern)}**`)
    for (const s of steps) lines.push(`  - ${html(s.title)}${where(s, pr)}`)
  }
  return lines
}

export const flowToDetails = (flow, pr) => {
  const summary = flow.summary
    ? `<b>${inline(flow.name)}</b>: ${inline(flow.summary)}`
    : `<b>${inline(flow.name)}</b>`
  // GitHub only parses markdown inside <details> after a blank line.
  return [
    "<details>",
    `<summary>${summary}</summary>`,
    "",
    "```mermaid",
    flowToMermaid(flow),
    "```",
    ...reviewFocus(flow, pr),
    "",
    "</details>",
  ].join("\n")
}

export const docToDetails = (doc) =>
  doc.flows.map((f) => flowToDetails(f, doc.pr)).join("\n\n") + "\n"

const main = () => {
  const [input, output] = process.argv.slice(2)
  if (!input) {
    console.error("usage: node mermaid.mjs <input.json> [output.md]")
    process.exit(2)
  }
  let doc
  try {
    doc = JSON.parse(readFileSync(input, "utf8"))
  } catch (e) {
    console.error(`${input}: ${e.message}`)
    process.exit(1)
  }
  const errors = validateDoc(doc)
  if (errors.length > 0) {
    console.error(`invalid flow document:\n  ${errors.join("\n  ")}`)
    process.exit(1)
  }
  const md = docToDetails(doc)
  if (output) writeFileSync(output, md)
  else process.stdout.write(md)
  const big = oversized(docToMermaid(doc))
  if (big.length > 0) {
    console.error(
      `warning: ${JSON.stringify(big)} exceed ${RENDER_BUDGET} characters; GitHub will refuse to draw them`,
    )
  }
  console.error(`${doc.flows.length} flow(s), ${md.length} characters`)
  if (md.length > BODY_LIMIT) {
    console.error(`warning: over GitHub's ${BODY_LIMIT}-character limit for a PR body or comment`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main()
