#!/usr/bin/env node
/**
 * Renders a flow document into a self-contained HTML page.
 *
 *   node build.mjs <input.json> <output.html> [--artifact] [--check-files <repo root>]
 *
 * Deterministic: the same JSON in gives byte-identical HTML out (the input's
 * own key order is preserved). --check-files warns (never fails) when a step
 * references a file that does not exist under the given root -- a step may
 * legitimately point at a file the PR deleted. --artifact emits the same page
 * shaped for the Artifact tool, which supplies its own document skeleton.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { validateDoc } from "./lib/validate.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const SLOT = "/*__DATA__*/ null"
const TITLE_SLOT = "<title>PR flow diagram</title>"

export { validateDoc }

export const buildHtml = (
  doc,
  template = readFileSync(join(HERE, "template.html"), "utf8"),
) => {
  const errors = validateDoc(doc)
  if (errors.length > 0) {
    const err = new Error(`invalid flow document:\n  ${errors.join("\n  ")}`)
    err.errors = errors
    throw err
  }
  const slots = template.split(SLOT).length - 1
  if (slots !== 1)
    throw new Error(
      `template must contain exactly one "${SLOT}" slot, found ${slots}`,
    )
  // Escape for script context: a note containing </script> or <!-- must not
  // terminate the block, and U+2028/9 are line terminators to older parsers.
  // < only occurs inside JSON string values, so the global replace is safe.
  const escaped = JSON.stringify(doc)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
  const titles = template.split(TITLE_SLOT).length - 1
  if (titles !== 1)
    throw new Error(
      `template must contain exactly one "${TITLE_SLOT}", found ${titles}`,
    )
  const title = `Flow: ${doc.pr.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}`
  // Function form: string form would interpret $-patterns ($', $&) in the doc.
  // Data first: the <-escaped JSON can never contain TITLE_SLOT, but a
  // pr.title equal to the data slot text would hijack a later data replace.
  return template
    .replace(SLOT, () => `/*__DATA__*/ ${escaped}`)
    .replace(TITLE_SLOT, () => `<title>${title}</title>`)
}

/** The Artifact tool wraps what it publishes in its own doctype, html, head
 *  and body, so the standalone page's skeleton has to come off: the title,
 *  the font link, the styles and the body's own markup go up verbatim. Every
 *  piece is asserted rather than optional -- a silent miss here publishes an
 *  unstyled page, which is worse than a failed build. .app is fixed to the
 *  viewport, so nothing needs resizing for the smaller frame. */
export const buildArtifact = (doc, template) => {
  const html = buildHtml(doc, template)
  const part = (name, re) => {
    const m = html.match(re)
    if (!m)
      throw new Error(`artifact build: no ${name} found in the built page`)
    return m[0]
  }
  part("title", /<title>[\s\S]*?<\/title>/)
  // The standalone page's title is the whole PR subject, which is a summary
  // rather than a name. A published artifact is picked out of a gallery, so
  // it gets a short one; pr.number is a validated integer.
  const title = `<title>PR ${doc.pr.number} Flow Lens</title>`
  const fonts = part(
    "font stylesheet",
    /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*">/,
  )
  const style = part("style block", /<style>[\s\S]*?<\/style>/)
  const body = part("body", /<body[^>]*>[\s\S]*<\/body>/)
    .replace(/^<body[^>]*>/, "")
    .replace(/<\/body>$/, "")
    .trim()
  return [title, fonts, style, body].join("\n")
}

export const checkFiles = (doc, root) => {
  const missing = []
  for (const flow of doc.flows) {
    for (const step of flow.steps) {
      if (step.file && !existsSync(join(root, step.file))) {
        missing.push(`${flow.id}/${step.id}: ${step.file}`)
      }
    }
  }
  return missing
}

const main = () => {
  const args = process.argv.slice(2)
  const checkIdx = args.indexOf("--check-files")
  let root = null
  if (checkIdx !== -1) {
    root = args[checkIdx + 1]
    if (!root) {
      console.error("--check-files needs a repo root")
      process.exit(2)
    }
    args.splice(checkIdx, 2)
  }
  const artifactIdx = args.indexOf("--artifact")
  const artifact = artifactIdx !== -1
  if (artifact) args.splice(artifactIdx, 1)
  const [input, output] = args
  if (!input || !output) {
    console.error(
      "usage: node build.mjs <input.json> <output.html> [--artifact] [--check-files <repo root>]",
    )
    process.exit(2)
  }
  let doc
  try {
    doc = JSON.parse(readFileSync(input, "utf8"))
  } catch (e) {
    console.error(`${input}: ${e.message}`)
    process.exit(1)
  }
  let html
  try {
    html = artifact ? buildArtifact(doc) : buildHtml(doc)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  if (root) {
    for (const line of checkFiles(doc, root)) {
      console.warn(`warning: missing file ${line}`)
    }
  }
  writeFileSync(output, html)
  console.log(`${output}: ${html.length} bytes, ${doc.flows.length} flow(s)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main()
