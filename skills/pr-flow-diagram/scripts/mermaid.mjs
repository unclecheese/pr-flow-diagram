#!/usr/bin/env node
/**
 * Emits a flow document as Mermaid flowcharts, one per flow.
 *
 *   node mermaid.mjs <input.json>
 *
 * Mermaid is what GitHub renders natively in markdown, so this is the view
 * that shows up inline in a PR comment rather than inside a downloaded zip.
 * It is an overview, not a replacement for the HTML page: no side panel, no
 * concern colours (an explicit fill would misread in one of GitHub's two
 * themes), no click-through to source.
 *
 * Deterministic, like the HTML build: node ids come from position, never
 * from a hash or iteration order.
 */
import { readFileSync, realpathSync } from "node:fs"
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

const main = () => {
  const [input] = process.argv.slice(2)
  if (!input) {
    console.error("usage: node mermaid.mjs <input.json>")
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
  const diagrams = docToMermaid(doc)
  for (const { flow, mermaid } of diagrams) {
    console.log(`## ${flow.name}\n`)
    console.log(flow.summary ? `${flow.summary}\n` : "")
    console.log("```mermaid")
    console.log(mermaid)
    console.log("```\n")
  }
  const big = oversized(diagrams)
  if (big.length > 0) {
    console.error(
      `warning: ${JSON.stringify(big)} exceed ${RENDER_BUDGET} characters; GitHub will refuse to draw them`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main()
