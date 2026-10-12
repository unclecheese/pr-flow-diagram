import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { docToMermaid, flowToMermaid, oversized, RENDER_BUDGET } from "../skills/pr-flow-diagram/scripts/mermaid.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const example = () =>
  JSON.parse(readFileSync(join(HERE, "../example/example.flow.json"), "utf8"))

test("the mermaid emitter is deterministic", () => {
  assert.equal(
    flowToMermaid(example().flows[0]),
    flowToMermaid(example().flows[0]),
  )
})

test("every step becomes a node and every edge an arrow", () => {
  const flow = example().flows[0]
  const out = flowToMermaid(flow)
  for (const s of flow.steps) {
    assert.ok(out.includes(`["${s.title}`), `${s.id} missing from the diagram`)
  }
  const edges = flow.steps.reduce((n, s) => n + s.next.length, 0)
  assert.equal(out.split("\n").filter((l) => l.includes("-->")).length, edges)
})

test("lanes become subgraphs, and an empty lane is skipped", () => {
  const doc = example()
  doc.flows[0].lanes.push("Unused")
  const out = flowToMermaid(doc.flows[0])
  assert.ok(out.includes('subgraph lane0["Browser"]'))
  assert.ok(!out.includes("Unused"), "an empty lane should not render a box")
})

test("existing and infrastructure steps are dashed, in-stack steps are not", () => {
  const flow = example().flows[0]
  const out = flowToMermaid(flow)
  const dashed = out.match(/^ {2}class (.+) passthrough$/m)[1].split(",")
  const expected = flow.steps
    .map((s, i) => (!s.inStack || !s.file ? `n${i}` : null))
    .filter(Boolean)
  assert.deepEqual(dashed, expected)
})

test("label metacharacters cannot break out of a mermaid label", () => {
  const doc = example()
  doc.flows[0].steps[0].title = 'a "quoted" #hash <tag> [bracket]'
  doc.flows[0].steps[0].next[0].label = 'edge "quoted" #hash'
  const out = flowToMermaid(doc.flows[0])
  const labels = out.match(/"[^"]*"/g)
  // Every quote in the output opens or closes a label, so they stay balanced.
  assert.equal(out.split('"').length % 2, 1)
  assert.ok(labels.some((l) => l.includes("#quot;quoted#quot;")))
  assert.ok(labels.some((l) => l.includes("#35;hash")))
  assert.ok(labels.some((l) => l.includes("#lt;tag#gt;")))
})

test("a newline in a title cannot inject a mermaid statement", () => {
  const doc = example()
  const clean = flowToMermaid(doc.flows[0])
  doc.flows[0].steps[0].title = 'x"]\n  n0 --> n99\n  z["y'
  const out = flowToMermaid(doc.flows[0])
  // The hostile text survives as label content, which is inert. What must not
  // survive is its shape: no extra line, and no extra edge.
  assert.equal(out.split("\n").length, clean.split("\n").length)
  assert.equal(
    out.split("\n").filter((l) => /^ {2}n\d+ (-->|-->\|)/.test(l)).length,
    clean.split("\n").filter((l) => /^ {2}n\d+ (-->|-->\|)/.test(l)).length,
  )
  assert.ok(!/n0 --> n99/.test(out), out)
})

test("docToMermaid pairs each diagram with its flow, in document order", () => {
  const doc = example()
  assert.deepEqual(
    docToMermaid(doc).map((d) => d.flow.id),
    doc.flows.map((f) => f.id),
  )
})

test("a diagram over the render budget is reported, not silently posted", () => {
  const doc = example()
  assert.deepEqual(oversized(docToMermaid(doc)), [])
  doc.flows[0].steps[0].title = "x".repeat(RENDER_BUDGET)
  assert.deepEqual(oversized(docToMermaid(doc)), [doc.flows[0].id])
})
