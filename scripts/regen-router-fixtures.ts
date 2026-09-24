/**
 * Recompute the derived expectations in src/router/fixtures/*.json from the current policy.
 *
 *   node --import tsx scripts/regen-router-fixtures.ts           # dry run: print what would change
 *   node --import tsx scripts/regen-router-fixtures.ts --write   # rewrite the fixture files
 *   node --import tsx scripts/regen-router-fixtures.ts --check   # exit 1 when anything would change (CI)
 *
 * It rewrites only fields that the labels and the code determine:
 * - intake / reply `expected` (per bias): the route for the ideal answers built from `labels`;
 * - intake / reply `heuristicExpected`: the route with no Jev answers;
 * - failure `sequence[].expected` / `heuristicExpected` (per bias) and `heuristic` {kind, needsUserRegex}.
 *
 * It never touches requests, outputs, labels or tags. Tags the deterministic checks read
 * (`risky`, `too_many`, `explicit_*`, `no_egress`) are only reported when they disagree with the
 * code, because they state what a fixture is meant to test: fix those by hand.
 * Review the diff: a changed expectation is a behavior change of the router.
 */
import fs from "node:fs";
import path from "node:path";
import {
  failureSignals,
  fixturesDir,
  idealFailureAnswers,
  idealIntakeAnswers,
  idealReplyAnswers,
  replySignals,
  simulateFailure,
  simulateIntake,
  simulateReply,
} from "../src/router/eval.js";
import { parseFailureAnswers, parseIntakeAnswers, parseReplyAnswers } from "../src/router/questions.js";
import { detectExplicitRoute, detectNoEgress } from "../src/router/signals.js";
import { ROUTER_BIASES, type Route, type RouterBias } from "../src/router/types.js";

type Json = Record<string, any>;

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const check = args.has("--check");
const dir = fixturesDir();
const changes: string[] = [];
const tagIssues: string[] = [];

function note(id: string, what: string, from: unknown, to: unknown): void {
  changes.push(`${id} ${what}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
}

function setBiasRoutes(id: string, what: string, target: Record<RouterBias, Route>, next: Record<RouterBias, Route>): void {
  for (const bias of ROUTER_BIASES) {
    if (target[bias] !== next[bias]) {
      note(id, `${what}.${bias}`, target[bias], next[bias]);
      target[bias] = next[bias];
    }
  }
}

/** One route for every bias (the heuristic paths ignore the bias); warns when they differ. */
function singleRoute(id: string, routes: Record<RouterBias, Route>): Route {
  const distinct = new Set(ROUTER_BIASES.map((bias) => routes[bias]));
  if (distinct.size > 1) tagIssues.push(`${id}: heuristic route differs by bias ${JSON.stringify(routes)}`);
  return routes.balanced;
}

function byBias(run: (bias: RouterBias) => Route): Record<RouterBias, Route> {
  return { economy: run("economy"), balanced: run("balanced"), speed: run("speed") };
}

function regenIntake(f: Json): void {
  const ideal = parseIntakeAnswers(idealIntakeAnswers(f.labels));
  setBiasRoutes(f.id, "expected", f.expected, byBias((bias) => simulateIntake(f as never, bias, ideal).route));
  const heuristic = singleRoute(f.id, byBias((bias) => simulateIntake(f as never, bias, null).route));
  if (f.heuristicExpected !== heuristic) {
    note(f.id, "heuristicExpected", f.heuristicExpected, heuristic);
    f.heuristicExpected = heuristic;
  }
  const explicit = detectExplicitRoute(f.request);
  const tagged = f.tags.includes("explicit_chatgpt") ? "chatgpt" : f.tags.includes("explicit_codex") ? "codex" : null;
  if (explicit !== tagged) tagIssues.push(`${f.id}: detectExplicitRoute=${explicit} but tags say ${tagged}`);
  if (detectNoEgress(f.request) !== f.tags.includes("no_egress")) tagIssues.push(`${f.id}: no_egress tag disagrees with detectNoEgress`);
}

function regenFailure(f: Json): void {
  const signals = failureSignals(f.output);
  if (f.heuristic) {
    const next = { kind: signals.heuristicKind, needsUserRegex: signals.needsUserRegex };
    if (f.heuristic.kind !== next.kind || f.heuristic.needsUserRegex !== next.needsUserRegex) {
      note(f.id, "heuristic", f.heuristic, next);
      f.heuristic = next;
    }
  }
  const ideal = parseFailureAnswers(idealFailureAnswers(f.labels));
  const idealRoutes = { economy: [], balanced: [], speed: [] } as Record<RouterBias, Route[]>;
  const heuristicRoutes = { economy: [], balanced: [], speed: [] } as Record<RouterBias, Route[]>;
  for (const bias of ROUTER_BIASES) {
    idealRoutes[bias] = simulateFailure(f as never, bias, ideal, signals).map((r) => r.route);
    heuristicRoutes[bias] = simulateFailure(f as never, bias, null, signals).map((r) => r.route);
  }
  f.sequence.forEach((step: Json, i: number) => {
    const where = `${f.id} step ${step.attempt}`;
    setBiasRoutes(where, "expected", step.expected, byBias((bias) => idealRoutes[bias][i]));
    if (step.heuristicExpected) {
      setBiasRoutes(where, "heuristicExpected", step.heuristicExpected, byBias((bias) => heuristicRoutes[bias][i]));
    }
  });
}

function regenReply(f: Json): void {
  const signals = replySignals(f.followups);
  if (signals.riskItem !== f.tags.includes("risky")) tagIssues.push(`${f.id}: risky tag disagrees with the follow-up floor (${signals.riskItem})`);
  if (signals.tooMany !== f.tags.includes("too_many")) tagIssues.push(`${f.id}: too_many tag disagrees (${signals.tooMany})`);
  if (signals.items.length !== f.labels.levels.length || signals.items.length === 0) {
    tagIssues.push(`${f.id}: ${signals.items.length} parsed items for ${f.labels.levels.length} labels`);
    return;
  }
  const ideal = parseReplyAnswers(idealReplyAnswers(f.labels.levels), signals.items.length);
  setBiasRoutes(f.id, "expected", f.expected, byBias((bias) => simulateReply(f as never, bias, ideal, signals).route));
  const heuristic = singleRoute(f.id, byBias((bias) => simulateReply(f as never, bias, null, signals).route));
  if (f.heuristicExpected !== heuristic) {
    note(f.id, "heuristicExpected", f.heuristicExpected, heuristic);
    f.heuristicExpected = heuristic;
  }
}

const REGEN: Record<string, (f: Json) => void> = { intake: regenIntake, failure: regenFailure, reply: regenReply };

for (const name of ["intake", "failure", "reply", "adversarial"]) {
  const file = path.join(dir, `${name}.json`);
  const before = fs.readFileSync(file, "utf8");
  const data = JSON.parse(before) as Json[];
  for (const f of data) REGEN[name === "adversarial" ? f.point : name](f);
  const after = `${JSON.stringify(data, null, 2)}\n`;
  if (write && after !== before) fs.writeFileSync(file, after);
}

for (const line of changes) console.log(line);
for (const line of tagIssues) console.log(`CHECK BY HAND: ${line}`);
console.log(`${changes.length} expectation(s) ${write ? "updated" : "would change"}; ${tagIssues.length} tag issue(s).`);
if (check && (changes.length > 0 || tagIssues.length > 0)) process.exit(1);
