# The flow document

Reference for the `pr-flow-diagram` skill's renderer: the schema you author
against and how to build it. `SKILL.md` is the workflow; this is
the format.

The renderer takes a JSON document you author by reading a diff and produces
one HTML file: topologically laid-out steps in swim lanes, click or arrow-key
through them, step details (file, function, concern, line counts) in a side
panel, a picker across flows, light and dark themes. Plain node, no
dependencies.

## Build

```
node scripts/build.mjs <input.flow.json> <output.html> \
  [--artifact] [--check-files <repo-root>]
```

- Validation failures print one line per problem and exit 1. Nothing is
  written.
- The build is deterministic: the same JSON produces byte-identical HTML.
- `--artifact` emits the page without its `doctype`, `html`, `head` and
  `body` wrappers, for an Artifact tool that supplies its own skeleton and
  publishes the page at a URL. Without the flag you get a standalone file
  that opens from disk.
- `--check-files` warns (never fails) about steps whose `file` doesn't exist
  under the given root. Warning-only is deliberate: a flow doc describes a
  PR's head, and the checkout you're building from may be on another branch.

## Mermaid output

The HTML page needs a browser. For the times a diagram belongs on the PR
itself, `scripts/mermaid.mjs` emits the same document as a markdown
fragment GitHub renders natively:

```
node scripts/mermaid.mjs <input.flow.json> [output.md]
```

Each flow becomes a collapsed `<details>`: the flow's name and summary on
the `<summary>` line, then a Mermaid flowchart, then a **Review focus**
list of steps grouped by `concern`. With `pr.repo` set, each listed file
links to GitHub at `headSha`. Without an output path it prints to stdout.

In the diagram, lanes become `subgraph`s, `next` becomes labelled edges,
and steps the PR did not touch are dashed. It is an overview, not a
replacement: no side panel, no keyboard walkthrough, and no concern
colours -- GitHub picks the Mermaid theme from the reader's colour scheme,
so a hardcoded fill would lose its contrast in one of the two. The Review
focus list carries the concerns instead.

The CLI warns on stderr when a flow passes `RENDER_BUDGET` characters
(GitHub shows a bare "unable to render" box instead of the diagram) or the
fragment passes `BODY_LIMIT` (GitHub rejects the PR body or comment).

## Schema

`references/flow-doc.schema.json` (JSON Schema 2020-12) documents the format;
`scripts/lib/validate.mjs` is the enforcement: the build refuses documents the
schema merely describes. Unknown keys are rejected everywhere, so typos fail
loudly instead of rendering as missing chips.

Top level:

| key | | |
|---|---|---|
| `schema` | required | literal `1` |
| `pr` | required | `{number, title, headSha, repo?}`; headSha is a 7-40 char hex sha; `repo` is the GitHub `owner/name`. With `repo` set, each step's file links to GitHub at headSha; without it the page has no source links |
| `flows` | required | one entry per coherent path through the change -- a read path and a write path with different origin steps are two flows, not one. The header picker switches between them (hidden when there is only one); the first is selected on load |

Flow:

| key | | |
|---|---|---|
| `id` | required | unique across the document |
| `name` | required | shown in the flow picker |
| `summary` | required | one sentence of context, shown above the step card whenever the flow loads |
| `lanes` | required | ordered lane names (e.g. Browser / node-server / Postgres); every step's `lane` must be one of these |
| `steps` | required | the nodes; edges via `next` must be acyclic |

Step:

| key | | |
|---|---|---|
| `id` | required | unique within the flow |
| `lane` | required | one of the flow's `lanes` |
| `title` | required | node label |
| `note` | required | side-panel prose; backticks render as code, `**double asterisks**` as bold |
| `next` | required | `[{to, label?}]`, empty for a terminal step; `to` names another step in the flow, no self-edges, no cycles |
| `file` | optional | repo-relative path, no leading slash; omit it for an infrastructure step (a queue, a poll loop) and the node renders in the muted infra style |
| `fn` | optional | function or symbol name shown with the file |
| `concern` | optional | reviewer-focus tag; steps sharing a concern share a colour, assigned by first appearance so it's stable across builds |
| `added` / `deleted` | optional | non-negative line counts for the step's diff hunk |
| `runtime` | optional | free-text runtime note chip (e.g. `202 + poll`) |
| `inStack` | optional | boolean; `true` = this PR adds or changes the step (solid border), absent/false = pre-existing code the flow passes through |
| `pr` | optional | cross-reference chip when a step belongs to another PR |
| `trail` | optional | string array of breadcrumb chips |
