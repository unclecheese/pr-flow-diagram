import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { buildArtifact, buildHtml, validateDoc } from "../skills/pr-flow-diagram/scripts/build.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const example = () =>
  JSON.parse(readFileSync(join(HERE, "../example/example.flow.json"), "utf8"))

test("golden: the example builds byte-identical to the committed output", () => {
  const committed = readFileSync(join(HERE, "../example/example.html"), "utf8")
  assert.equal(buildHtml(example()), committed)
})

test("the build is deterministic", () => {
  assert.equal(buildHtml(example()), buildHtml(example()))
})

test("the example document is valid", () => {
  assert.deepEqual(validateDoc(example()), [])
})

test("refuses a wrong schema version, naming it", () => {
  const doc = example()
  doc.schema = 2
  const errors = validateDoc(doc)
  assert.ok(errors.some((e) => e.includes("document.schema")), errors.join("\n"))
})

test("refuses a step in a lane the flow does not declare", () => {
  const doc = example()
  doc.flows[0].steps[0].lane = "Mainframe"
  const errors = validateDoc(doc)
  assert.ok(
    errors.some((e) => e.includes("steps[0].lane") && e.includes("Mainframe")),
    errors.join("\n"),
  )
})

test("refuses an edge to a step that does not exist", () => {
  const doc = example()
  doc.flows[0].steps[0].next = [{ to: "nowhere" }]
  const errors = validateDoc(doc)
  assert.ok(errors.some((e) => e.includes('no step with id "nowhere"')), errors.join("\n"))
})

test("refuses a cycle, naming its members", () => {
  const doc = example()
  const steps = doc.flows[1].steps
  steps[steps.length - 1].next = [{ to: steps[0].id }]
  const errors = validateDoc(doc)
  assert.ok(errors.some((e) => e.includes("cycle")), errors.join("\n"))
})

test("refuses unknown keys on a step", () => {
  const doc = example()
  doc.flows[0].steps[0].weight = 12
  const errors = validateDoc(doc)
  assert.ok(errors.some((e) => e.includes("unknown key")), errors.join("\n"))
})

test("buildHtml throws the validator's line items", () => {
  const doc = example()
  doc.pr.headSha = "not-hex"
  assert.throws(() => buildHtml(doc), /document\.pr\.headSha/)
})

test("refuses a repo that is not owner/name", () => {
  for (const repo of ["storefront", "a/b/c", 'x/y"><script>', ""]) {
    const doc = example()
    doc.pr.repo = repo
    const errors = validateDoc(doc)
    assert.ok(errors.some((e) => e.includes("document.pr.repo")), `${repo}: ${errors.join("\n")}`)
  }
})

test("repo is optional", () => {
  const doc = example()
  delete doc.pr.repo
  assert.deepEqual(validateDoc(doc), [])
  assert.doesNotThrow(() => buildHtml(doc))
})

test("the template carries exactly one data slot", () => {
  assert.throws(() => buildHtml(example(), "<html></html>"), /exactly one/)
})

test("the injected script parses as javascript", async () => {
  const html = buildHtml(example())
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"))
  // Parse only -- no DOM here. A syntax error in the template would otherwise
  // only surface when someone opens the page.
  const { Script } = await import("node:vm")
  assert.doesNotThrow(() => new Script(script))
})

test("hostile note: </script> and $-patterns survive injection inert", () => {
  const doc = example()
  doc.flows[0].steps[0].note =
    "</script><img src=x onerror=alert(1)> <!-- $' $& $`   "
  const html = buildHtml(doc)
  // The template's one script block is still the only one.
  assert.equal(html.split("</script>").length, 2)
  assert.ok(!html.includes("</script><img"))
  // No $-splice: the injected data line round-trips to the exact input doc.
  const m = html.match(/^ *const DOC = \/\*__DATA__\*\/ (.*);$/m)
  assert.ok(m, "data line not found")
  assert.deepEqual(JSON.parse(m[1]), doc)
})

test("independent flows each report their own errors", () => {
  const doc = example()
  doc.flows[0].steps[0].lane = "Nowhere"
  const steps = doc.flows[1].steps
  steps[steps.length - 1].next = [{ to: steps[0].id }]
  const errors = validateDoc(doc)
  assert.ok(
    errors.some((e) => e.includes("flows[0]") && e.includes("Nowhere")),
    errors.join("\n"),
  )
  assert.ok(
    errors.some((e) => e.includes("flows[1]") && e.includes("cycle")),
    errors.join("\n"),
  )
})

test("duplicate step ids report the duplicate, not a phantom cycle", () => {
  const doc = example()
  // Two distinct steps sharing an id would collapse in checkAcyclic's map
  // into a -> b -> a, a cycle nobody authored.
  doc.flows[0] = {
    id: "dup",
    name: "dup",
    summary: "dup",
    lanes: ["L"],
    steps: [
      { id: "a", lane: "L", title: "a", note: "", next: [{ to: "b" }] },
      { id: "b", lane: "L", title: "b1", note: "", next: [] },
      { id: "b", lane: "L", title: "b2", note: "", next: [{ to: "a" }] },
    ],
  }
  const errors = validateDoc(doc)
  assert.ok(errors.some((e) => e.includes("duplicate step id")), errors.join("\n"))
  assert.ok(!errors.some((e) => e.includes("cycle")), errors.join("\n"))
})

test("the built title comes from the doc, escaped", () => {
  const doc = example()
  doc.pr.title = "x & y </title><script>alert(1)"
  const html = buildHtml(doc)
  assert.ok(html.includes("<title>Flow: x &amp; y &lt;/title>&lt;script>alert(1)</title>"))
  assert.equal(html.split("<script>").length, 2)
})

test("a title that is literally the data slot cannot hijack the data replace", () => {
  const doc = example()
  doc.pr.title = "/*__DATA__*/ null"
  const html = buildHtml(doc)
  const m = html.match(/^ *const DOC = \/\*__DATA__\*\/ (.*);$/m)
  assert.ok(m, "data line not found")
  assert.deepEqual(JSON.parse(m[1]), doc)
  assert.ok(html.includes("<title>Flow: /*__DATA__*/ null</title>"))
})

test("every flow is offered in the picker and its summary is rendered", () => {
  const doc = example()
  assert.ok(doc.flows.length > 1, "the example must keep more than one flow")
  const html = buildHtml(doc)
  const m = html.match(/^ *const DOC = \/\*__DATA__\*\/ (.*);$/m)
  assert.deepEqual(JSON.parse(m[1]).flows.map((f) => f.id), doc.flows.map((f) => f.id))
  // The picker is built from DOC.flows and the panel prints flow.summary;
  // both were once authored, validated, and then dropped on the floor.
  assert.match(html, /flowPick\.appendChild\(o\)/)
  assert.match(html, /flow\.summary \? `<p>\$\{md\(flow\.summary\)\}<\/p>`/)
})

test("the artifact build drops the document skeleton and keeps the page", () => {
  const out = buildArtifact(example())
  for (const tag of ["<!doctype", "<html", "<head>", "</head>", "<body", "</body>", "</html>"]) {
    assert.ok(!out.toLowerCase().includes(tag), `${tag} should not survive`)
  }
  assert.ok(out.startsWith("<title>PR 128 Flow Lens</title>"), out.slice(0, 60))
  assert.ok(out.includes("fonts.googleapis.com"), "the font link is required")
  assert.ok(out.includes("<style>"))
  assert.ok(out.includes('id="flowPick"'), "the flow picker must survive")
  assert.ok(out.includes("/*__DATA__*/"), "the data must survive")
})

test("the artifact build is deterministic", () => {
  assert.equal(buildArtifact(example()), buildArtifact(example()))
})

test("the artifact build refuses a page it cannot take apart", () => {
  assert.throws(
    () => buildArtifact(example(), "<title>PR flow diagram</title>/*__DATA__*/ null"),
    /no font stylesheet found/,
  )
})
