/**
 * Hand-rolled validator for flow documents (../../references/flow-doc.schema.json).
 * The tool stays dependency-free, so the schema file is the reference and
 * this is the enforcement. Returns a list of line-item errors; empty means valid.
 */

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const checkKeys = (errors, path, obj, allowed) => {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`${path}.${k}: unknown key`);
  }
};

const nonEmptyString = (errors, path, v) => {
  if (typeof v !== "string" || v.length === 0) {
    errors.push(`${path}: expected a non-empty string, got ${JSON.stringify(v)}`);
    return false;
  }
  return true;
};

const optionalString = (errors, path, v) => {
  if (v !== undefined && typeof v !== "string") {
    errors.push(`${path}: expected a string, got ${JSON.stringify(v)}`);
  }
};

const optionalCount = (errors, path, v) => {
  if (v !== undefined && (!isInt(v) || v < 0)) {
    errors.push(`${path}: expected a non-negative integer, got ${JSON.stringify(v)}`);
  }
};

const validateStep = (errors, path, step, lanes, ids) => {
  if (!isObject(step)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  checkKeys(errors, path, step, new Set([
    "id", "lane", "file", "fn", "title", "note", "next",
    "concern", "added", "deleted", "runtime", "inStack", "pr", "trail",
  ]));
  nonEmptyString(errors, `${path}.id`, step.id);
  if (nonEmptyString(errors, `${path}.lane`, step.lane) && !lanes.includes(step.lane)) {
    errors.push(`${path}.lane: ${JSON.stringify(step.lane)} is not one of lanes ${JSON.stringify(lanes)}`);
  }
  nonEmptyString(errors, `${path}.title`, step.title);
  if (typeof step.note !== "string") {
    errors.push(`${path}.note: expected a string, got ${JSON.stringify(step.note)}`);
  }
  if (step.file !== undefined) {
    if (nonEmptyString(errors, `${path}.file`, step.file) && step.file.startsWith("/")) {
      errors.push(`${path}.file: must be repo-relative, got ${JSON.stringify(step.file)}`);
    }
  }
  optionalString(errors, `${path}.fn`, step.fn);
  optionalString(errors, `${path}.concern`, step.concern);
  optionalString(errors, `${path}.runtime`, step.runtime);
  optionalString(errors, `${path}.pr`, step.pr);
  optionalCount(errors, `${path}.added`, step.added);
  optionalCount(errors, `${path}.deleted`, step.deleted);
  if (step.inStack !== undefined && typeof step.inStack !== "boolean") {
    errors.push(`${path}.inStack: expected a boolean, got ${JSON.stringify(step.inStack)}`);
  }
  if (step.trail !== undefined) {
    if (!Array.isArray(step.trail) || step.trail.some((t) => typeof t !== "string")) {
      errors.push(`${path}.trail: expected an array of strings`);
    }
  }
  if (!Array.isArray(step.next)) {
    errors.push(`${path}.next: expected an array, got ${JSON.stringify(step.next)}`);
    return;
  }
  step.next.forEach((n, i) => {
    const np = `${path}.next[${i}]`;
    if (!isObject(n)) {
      errors.push(`${np}: expected an object`);
      return;
    }
    checkKeys(errors, np, n, new Set(["to", "label"]));
    if (nonEmptyString(errors, `${np}.to`, n.to)) {
      if (!ids.has(n.to)) errors.push(`${np}.to: no step with id ${JSON.stringify(n.to)}`);
      if (n.to === step.id) errors.push(`${np}.to: a step cannot point at itself`);
    }
    optionalString(errors, `${np}.label`, n.label);
  });
};

/** The renderer lays steps out with Kahn's algorithm; a cycle would silently
 *  drop its members from the walk order, so it is a document error. */
const checkAcyclic = (errors, path, steps) => {
  const indeg = new Map(steps.map((s) => [s.id, 0]));
  for (const s of steps) {
    for (const n of s.next ?? []) {
      if (indeg.has(n.to)) indeg.set(n.to, indeg.get(n.to) + 1);
    }
  }
  const q = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const byId = new Map(steps.map((s) => [s.id, s]));
  let seen = 0;
  while (q.length) {
    const id = q.shift();
    seen += 1;
    for (const n of byId.get(id).next ?? []) {
      if (!indeg.has(n.to)) continue;
      indeg.set(n.to, indeg.get(n.to) - 1);
      if (indeg.get(n.to) === 0) q.push(n.to);
    }
  }
  if (seen < steps.length) {
    const stuck = steps.filter((s) => indeg.get(s.id) > 0).map((s) => s.id);
    errors.push(`${path}.steps: cycle through ${JSON.stringify(stuck)}`);
  }
};

const validateFlow = (errors, path, flow, seenFlowIds) => {
  if (!isObject(flow)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  checkKeys(errors, path, flow, new Set(["id", "name", "summary", "lanes", "steps"]));
  if (nonEmptyString(errors, `${path}.id`, flow.id)) {
    if (seenFlowIds.has(flow.id)) errors.push(`${path}.id: duplicate flow id ${JSON.stringify(flow.id)}`);
    seenFlowIds.add(flow.id);
  }
  nonEmptyString(errors, `${path}.name`, flow.name);
  if (typeof flow.summary !== "string") {
    errors.push(`${path}.summary: expected a string, got ${JSON.stringify(flow.summary)}`);
  }
  if (!Array.isArray(flow.lanes) || flow.lanes.length === 0 || flow.lanes.some((l) => typeof l !== "string" || !l)) {
    errors.push(`${path}.lanes: expected a non-empty array of non-empty strings`);
    return;
  }
  if (new Set(flow.lanes).size !== flow.lanes.length) {
    errors.push(`${path}.lanes: duplicate lane names`);
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    errors.push(`${path}.steps: expected a non-empty array`);
    return;
  }
  const before = errors.length;
  const ids = new Set();
  flow.steps.forEach((s, i) => {
    if (isObject(s) && typeof s.id === "string") {
      if (ids.has(s.id)) errors.push(`${path}.steps[${i}].id: duplicate step id ${JSON.stringify(s.id)}`);
      ids.add(s.id);
    }
  });
  flow.steps.forEach((s, i) => validateStep(errors, `${path}.steps[${i}]`, s, flow.lanes, ids));
  if (errors.length === before) checkAcyclic(errors, path, flow.steps);
};

export const validateDoc = (doc) => {
  const errors = [];
  if (!isObject(doc)) return ["document: expected an object"];
  checkKeys(errors, "document", doc, new Set(["schema", "pr", "flows"]));
  if (doc.schema !== 1) {
    errors.push(`document.schema: expected 1, got ${JSON.stringify(doc.schema)}`);
  }
  if (!isObject(doc.pr)) {
    errors.push(`document.pr: expected an object, got ${JSON.stringify(doc.pr)}`);
  } else {
    checkKeys(errors, "document.pr", doc.pr, new Set(["number", "title", "headSha", "repo"]));
    if (!isInt(doc.pr.number) || doc.pr.number <= 0) {
      errors.push(`document.pr.number: expected a positive integer, got ${JSON.stringify(doc.pr.number)}`);
    }
    nonEmptyString(errors, "document.pr.title", doc.pr.title);
    if (typeof doc.pr.headSha !== "string" || !/^[0-9a-f]{7,40}$/.test(doc.pr.headSha)) {
      errors.push(`document.pr.headSha: expected 7-40 hex characters, got ${JSON.stringify(doc.pr.headSha)}`);
    }
    if (doc.pr.repo !== undefined && (typeof doc.pr.repo !== "string" || !REPO.test(doc.pr.repo))) {
      errors.push(`document.pr.repo: expected "owner/name", got ${JSON.stringify(doc.pr.repo)}`);
    }
  }
  if (!Array.isArray(doc.flows) || doc.flows.length === 0) {
    errors.push("document.flows: expected a non-empty array");
  } else {
    const seen = new Set();
    doc.flows.forEach((f, i) => validateFlow(errors, `flows[${i}]`, f, seen));
  }
  return errors;
};
