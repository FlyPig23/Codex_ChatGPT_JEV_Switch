import { describe, expect, it } from "vitest";
import {
  HIGH_RISK_PATH_CATEGORIES,
  MAX_LOCAL_FOLLOWUPS,
  POLICY_SIGNAL_IDS,
  THRESHOLDS,
  decideFailure,
  decideIntake,
  decideReply,
  decideReviewGate,
  explainThresholds,
  failureCap,
} from "../src/router/policy.js";
import { FAILURE_KIND_PATTERNS, heuristicFailureKind, needsUserRegex } from "../src/router/heuristics.js";
import { CATEGORY_LABEL_ZH, GENERIC_NEXT, renderNext, renderSay } from "../src/router/messages.js";
import {
  CONNECTIONS,
  DECISION_POINTS,
  FAILURE_KINDS,
  PATH_CATEGORIES,
  REASON_CODES,
  ROUTER_BIASES,
  ROUTES,
  SIZE_BUCKETS,
  TASK_KINDS,
  type Connection,
  type DecisionPoint,
  type FailureAnswers,
  type FailureContext,
  type FailureKind,
  type IntakeAnswers,
  type IntakeContext,
  type PathCategory,
  type PolicyResult,
  type ReasonCode,
  type ReplyContext,
  type ReviewContext,
  type Route,
  type RouterBias,
  type SizeBucket,
  type Source,
  type TaskKind,
} from "../src/router/types.js";

type Expect = readonly [Route, ReasonCode];
type PerBias = Record<RouterBias, Expect>;

const all = (e: Expect): PerBias => ({ economy: e, balanced: e, speed: e });

function routeOf(r: PolicyResult): Expect {
  return [r.route, r.reason];
}

const results: PolicyResult[] = [];
function track(r: PolicyResult): PolicyResult {
  results.push(r);
  return r;
}

/** Deterministic PRNG so the property checks are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

// ---------------------------------------------------------------- builders

function kinds(partial: Partial<Record<TaskKind, number>>): Record<TaskKind, number> {
  const out = Object.fromEntries(TASK_KINDS.map((k) => [k, 0])) as Record<TaskKind, number>;
  return { ...out, ...partial };
}

function scope(level: number, p = 1, rest?: number): IntakeAnswers["scope"] {
  const s: IntakeAnswers["scope"] = [0, 0, 0, 0, 0, 0];
  s[level] = p;
  if (rest !== undefined) s[1] += rest;
  return s;
}

interface IntakeSpec {
  kind?: Partial<Record<TaskKind, number>>;
  scope?: IntakeAnswers["scope"];
  needsDesign?: number;
  goalIsClear?: number;
  risk?: Partial<IntakeAnswers["risk"]>;
  kc?: number;
  sc?: number;
}

function answers(spec: IntakeSpec = {}): IntakeAnswers {
  return {
    taskKind: kinds(spec.kind ?? { targeted_change: 1 }),
    taskKindConfidence: spec.kc ?? 0.8,
    scope: spec.scope ?? scope(1),
    scopeConfidence: spec.sc ?? 0.8,
    needsDesign: spec.needsDesign ?? 0,
    goalIsClear: spec.goalIsClear ?? 0.9,
    risk: { auth: 0.05, data: 0.05, concurrency: 0.05, publicInterface: 0.05, ...spec.risk },
  };
}

/**
 * planOffload = 0.35·needsDesign + 0.20·P_hard (scope4 = 0) for readable fixtures. The hard kind is a
 * refactor so the design shortcut (P(design) ≥ 0.5 and needs_design ≥ 0.6) stays out of the way.
 */
function offload(needsDesign: number, hard: number, extra: IntakeSpec = {}): IntakeAnswers {
  return answers({
    kind: { refactor_or_restructure: hard, new_feature: 1 - hard },
    scope: scope(2),
    needsDesign,
    ...extra,
  });
}

const PRESETS = {
  light: answers({ kind: { question_or_explanation: 0.5, run_command_or_ops: 0.2, targeted_change: 0.3 } }),
  small: answers(),
  big: answers({
    kind: { design_or_architecture: 0.9, new_feature: 0.1 },
    scope: [0, 0, 0.05, 0.05, 0.3, 0.6],
    needsDesign: 0.9,
  }),
  mid: offload(1, 0.75), // 0.50
  riskySmall: answers({ risk: { auth: 0.8 } }),
  mechanicalBig: answers({
    kind: { mechanical_bulk_change: 0.7, refactor_or_restructure: 0.3 },
    scope: scope(5),
    needsDesign: 0.9,
  }),
  bigUnclear: answers({
    kind: { design_or_architecture: 0.9, new_feature: 0.1 },
    scope: scope(5),
    needsDesign: 0.9,
    goalIsClear: 0.1,
  }),
  midUnclear: offload(1, 0.75, { goalIsClear: 0.29 }),
} satisfies Record<string, IntakeAnswers>;

function ictx(over: Partial<IntakeContext> = {}): IntakeContext {
  return {
    bias: "balanced",
    connection: "ready",
    warm: false,
    workspaceBusy: false,
    consentAskedToday: false,
    ...over,
  };
}

function fctx(over: Partial<FailureContext> = {}): FailureContext {
  return {
    bias: "balanced",
    inLoop: false,
    consecutive: 2,
    sameSignatureStreak: 2,
    uncertainIntake: false,
    needsUserRegex: false,
    heuristicKind: "runtime_exception",
    pin: null,
    noEgress: false,
    workspaceBusy: false,
    outSwitches: 0,
    reservedReview: false,
    connection: "ready",
    consentAskedToday: false,
    ...over,
  };
}

function fans(kind: FailureKind, confidence = 0.8, needsUser = 0.05): FailureAnswers {
  const probs = Object.fromEntries(
    FAILURE_KINDS.map((k) => [k, k === kind ? confidence : (1 - confidence) / (FAILURE_KINDS.length - 1)])
  ) as Record<FailureKind, number>;
  return { kind: probs, kindConfidence: confidence, needsUser };
}

/** n-th failure of the same command with the same signature. */
const repeat = (n: number, over: Partial<FailureContext> = {}) =>
  fctx({ consecutive: n, sameSignatureStreak: n, ...over });

function rctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    bias: "balanced",
    engaged: false,
    wasEngaged: false,
    tests: "passed",
    isGitRepo: true,
    files: 2,
    lines: 20,
    bucket: "tiny",
    categories: ["other"],
    headMoved: false,
    userAskedReview: false,
    intakeRoute: "codex_solo",
    intendedReview: false,
    mechanical: false,
    pin: null,
    noEgress: false,
    workspaceBusy: false,
    outSwitches: 0,
    connection: "ready",
    consentAskedToday: false,
    ...over,
  };
}

function pctx(over: Partial<ReplyContext> = {}): ReplyContext {
  return { bias: "balanced", itemCount: 2, riskItem: false, iteration: 2, maxIterations: 12, ...over };
}

// ---------------------------------------------------------------- thresholds

describe("THRESHOLDS", () => {
  it("matches §3.5 / §6.2 exactly and is frozen", () => {
    expect(THRESHOLDS).toEqual({
      tPlan: { economy: 0.4, balanced: 0.55, speed: 0.75 },
      warmAdj: 0.05,
      band: { economy: null, balanced: 0.15, speed: null },
      riskFloor: 0.6,
      capBase: { economy: 2, balanced: 3, speed: 4 },
      reviewSize: { economy: "xlarge", balanced: "large", speed: null },
      followupTheta: { economy: 0.35, balanced: 0.25, speed: 0.4 },
      goalUnclear: 0.3,
      light: 0.6,
      mech: 0.6,
      kindConfidence: 0.4,
      needsUser: 0.6,
    });
    expect(Object.isFrozen(THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(THRESHOLDS.tPlan)).toBe(true);
    expect(() => {
      (THRESHOLDS.tPlan as Record<string, number>).balanced = 0;
    }).toThrow();
  });

  it("explainThresholds returns numbers only for every point and bias", () => {
    for (const point of DECISION_POINTS) {
      for (const bias of ROUTER_BIASES) {
        for (const value of Object.values(explainThresholds(point, bias))) expect(typeof value).toBe("number");
      }
    }
    expect(explainThresholds("intake", "balanced").band).toBe(0.15);
    expect(explainThresholds("intake", "speed").band).toBeUndefined();
    expect(explainThresholds("reply", "economy").followupTheta).toBe(0.35);
  });
});

// ---------------------------------------------------------------- intake

describe("decideIntake", () => {
  const table: Array<[keyof typeof PRESETS, PerBias]> = [
    ["light", all(["codex_solo", "not_coding"])],
    ["small", all(["codex_solo", "low_offload"])],
    ["big", all(["chatgpt_plan", "plan_offload"])],
    [
      "mid",
      {
        economy: ["chatgpt_plan", "plan_offload"],
        balanced: ["codex_then_review", "review_band"],
        speed: ["codex_solo", "low_offload"],
      },
    ],
    ["riskySmall", all(["codex_then_review", "risk_floor"])],
    ["mechanicalBig", all(["codex_solo", "low_offload"])],
    ["bigUnclear", all(["ask_user", "goal_unclear"])],
    [
      "midUnclear",
      {
        economy: ["ask_user", "goal_unclear"],
        balanced: ["ask_user", "goal_unclear"],
        speed: ["codex_solo", "low_offload"],
      },
    ],
  ];

  for (const [name, expected] of table) {
    for (const bias of ROUTER_BIASES) {
      it(`${name} / ${bias} → ${expected[bias].join(" / ")}`, () => {
        const r = track(decideIntake(ictx({ bias }), PRESETS[name]));
        expect(routeOf(r)).toEqual(expected[bias]);
        expect(r.source).toBe("jev");
      });
    }
  }

  it("the warm-chat adjustment lowers T_plan by 0.05 for every bias", () => {
    const cases: Array<[RouterBias, IntakeAnswers, Expect, Expect]> = [
      ["economy", offload(1, 0.1), ["codex_solo", "low_offload"], ["chatgpt_plan", "plan_offload"]], // 0.37
      ["balanced", offload(1, 0.85), ["codex_then_review", "review_band"], ["chatgpt_plan", "plan_offload"]], // 0.52
      ["balanced", offload(1, 0.1), ["codex_solo", "low_offload"], ["codex_then_review", "review_band"]], // 0.37
      [
        "speed",
        answers({ kind: { design_or_architecture: 0.5, new_feature: 0.5 }, scope: scope(4, 0.6, 0.4), needsDesign: 1 }),
        ["codex_solo", "low_offload"],
        ["chatgpt_plan", "plan_offload"],
      ], // 0.72
    ];
    for (const [bias, a, cold, warm] of cases) {
      expect(routeOf(track(decideIntake(ictx({ bias }), a))), `${bias} cold`).toEqual(cold);
      expect(routeOf(track(decideIntake(ictx({ bias, warm: true }), a))), `${bias} warm`).toEqual(warm);
    }
  });

  it("thresholds are inclusive and robust to float noise", () => {
    // 0.35 + 0.2 === 0.5499999999999999 in IEEE doubles
    expect(routeOf(decideIntake(ictx({ bias: "balanced" }), offload(1, 1)))).toEqual(["chatgpt_plan", "plan_offload"]);
    // 0.35 + 0.05 === 0.39999999999999997
    expect(routeOf(decideIntake(ictx({ bias: "balanced" }), offload(1, 0.25)))).toEqual([
      "codex_then_review",
      "review_band",
    ]);
    expect(routeOf(decideIntake(ictx({ bias: "economy" }), offload(1, 0.25)))).toEqual(["chatgpt_plan", "plan_offload"]);
    expect(routeOf(decideIntake(ictx({ bias: "balanced" }), offload(1, 0.2)))).toEqual(["codex_solo", "low_offload"]);
    expect(routeOf(decideIntake(ictx(), answers({ risk: { data: 0.6 } })))).toEqual(["codex_then_review", "risk_floor"]);
    expect(routeOf(decideIntake(ictx(), answers({ risk: { data: 0.59 } })))).toEqual(["codex_solo", "low_offload"]);
    expect(
      routeOf(decideIntake(ictx(), answers({ kind: { question_or_explanation: 0.3, run_command_or_ops: 0.3 } })))
    ).toEqual(["codex_solo", "not_coding"]);
    expect(routeOf(decideIntake(ictx(), offload(1, 1, { goalIsClear: 0.3 })))).toEqual(["chatgpt_plan", "plan_offload"]);
  });

  it("computes the numeric signals from probabilities", () => {
    const r = decideIntake(ictx(), PRESETS.big);
    expect(r.signals.planOffload).toBeCloseTo(0.9);
    expect(r.signals.P_scope4).toBeCloseTo(0.9);
    expect(r.signals.P_hard).toBeCloseTo(0.9);
    expect(r.signals.P_light).toBe(0);
    expect(r.signals.maxRisk).toBe(0.05);
    expect(r.signals.tPlan).toBe(0.55);
    expect(r.signals.desired).toBe("chatgpt_plan");
    const warm = decideIntake(ictx({ warm: true }), PRESETS.big);
    expect(warm.signals.tPlan).toBe(0.5);
  });

  it("sets outSwitches = 1 and engaged only for chatgpt_plan when routing out", () => {
    expect(decideIntake(ictx(), PRESETS.big).stateDelta).toMatchObject({
      intakeRoute: "chatgpt_plan",
      outSwitches: 1,
      engaged: true,
    });
    expect(decideIntake(ictx(), PRESETS.riskySmall).stateDelta).toMatchObject({
      intakeRoute: "codex_then_review",
      outSwitches: 1,
      engaged: false,
    });
    const solo = decideIntake(ictx(), PRESETS.small).stateDelta!;
    expect(solo.intakeRoute).toBe("codex_solo");
    expect(solo.outSwitches).toBeUndefined();
    expect(solo.engaged).toBeUndefined();
  });

  it("mechanical bulk edits zero planOffload but keep the risk floor", () => {
    const r = decideIntake(ictx(), PRESETS.mechanicalBig);
    expect(r.signals.planOffload).toBe(0);
    expect(r.signals.mechanical).toBe(true);
    expect(r.stateDelta?.mechanical).toBe(true);
    const risky = decideIntake(
      ictx(),
      answers({ kind: { mechanical_bulk_change: 0.6, targeted_change: 0.4 }, scope: scope(5), risk: { auth: 0.9 } })
    );
    expect(routeOf(risky)).toEqual(["codex_then_review", "risk_floor"]);
    expect(risky.stateDelta?.mechanical).toBe(true);
    expect(decideIntake(ictx(), PRESETS.big).stateDelta?.mechanical).toBe(false);
  });

  it("uncertainIntake needs both confidences below 0.35", () => {
    const u = (kc: number, sc: number) => decideIntake(ictx(), answers({ kc, sc })).stateDelta?.uncertainIntake;
    expect(u(0.3, 0.3)).toBe(true);
    expect(u(0.3, 0.5)).toBe(false);
    expect(u(0.5, 0.1)).toBe(false);
    expect(u(0.35, 0.1)).toBe(false);
    // confidence is never a routing gate
    expect(routeOf(decideIntake(ictx(), { ...PRESETS.big, taskKindConfidence: 0.05, scopeConfidence: 0.05 }))).toEqual([
      "chatgpt_plan",
      "plan_offload",
    ]);
  });

  it("not_coding wins over any offload, and the risk floor names itself inside the review band", () => {
    const lightButBig = answers({
      kind: { question_or_explanation: 0.4, run_command_or_ops: 0.2, design_or_architecture: 0.4 },
      scope: scope(5),
      needsDesign: 1,
      risk: { auth: 0.95 },
    });
    for (const bias of ROUTER_BIASES) {
      expect(routeOf(track(decideIntake(ictx({ bias }), lightButBig)))).toEqual(["codex_solo", "not_coding"]);
    }
    // planOffload 0.50 is inside the balanced band and maxRisk clears the floor
    expect(routeOf(track(decideIntake(ictx(), offload(1, 0.75, { risk: { concurrency: 0.7 } }))))).toEqual([
      "codex_then_review",
      "risk_floor",
    ]);
  });

  it("a design request with an open approach goes to ChatGPT under economy and balanced", () => {
    const design = answers({ kind: { design_or_architecture: 0.6, new_feature: 0.4 }, scope: scope(2), needsDesign: 0.7 });
    // planOffload = 0.35·0.7 + 0.20·0.6 = 0.365: below every T_plan and the balanced band
    expect(decideIntake(ictx(), design).signals.planOffload).toBeCloseTo(0.365);
    expect(routeOf(track(decideIntake(ictx({ bias: "economy" }), design)))).toEqual(["chatgpt_plan", "plan_offload"]);
    expect(routeOf(track(decideIntake(ictx({ bias: "balanced" }), design)))).toEqual(["chatgpt_plan", "plan_offload"]);
    expect(routeOf(track(decideIntake(ictx({ bias: "speed" }), design)))).toEqual(["codex_solo", "low_offload"]);
    expect(decideIntake(ictx(), design).signals.designShortcut).toBe(true);
    expect(decideIntake(ictx({ bias: "speed" }), design).signals.designShortcut).toBe(false);
    // both conditions are needed, inclusively
    const at = (design: number, needsDesign: number) =>
      decideIntake(ictx(), answers({ kind: { design_or_architecture: design, new_feature: 1 - design }, scope: scope(2), needsDesign }))
        .signals.designShortcut;
    expect(at(0.5, 0.6)).toBe(true);
    expect(at(0.49, 0.9)).toBe(false);
    expect(at(0.9, 0.59)).toBe(false);
    // the later gates still apply
    expect(routeOf(decideIntake(ictx(), { ...design, goalIsClear: 0.1 }))).toEqual(["ask_user", "goal_unclear"]);
    expect(routeOf(decideIntake(ictx({ workspaceBusy: true }), design))).toEqual(["codex_solo", "workspace_busy"]);
    expect(decideIntake(ictx({ connection: "not_setup" }), design).stateDelta).toMatchObject({ intendedReview: true });
  });

  it("goal_unclear only applies when escalation is desired, and before workspaceBusy", () => {
    expect(routeOf(decideIntake(ictx(), answers({ goalIsClear: 0.05 })))).toEqual(["codex_solo", "low_offload"]);
    expect(routeOf(decideIntake(ictx({ workspaceBusy: true }), PRESETS.bigUnclear))).toEqual(["ask_user", "goal_unclear"]);
  });

  it("workspaceBusy never engages ChatGPT", () => {
    for (const bias of ROUTER_BIASES) {
      for (const a of [PRESETS.big, PRESETS.riskySmall, PRESETS.mid]) {
        const r = track(decideIntake(ictx({ bias, workspaceBusy: true }), a));
        expect(["codex_solo"]).toContain(r.route);
        expect(["workspace_busy", "low_offload"]).toContain(r.reason);
        expect(r.stateDelta?.outSwitches).toBeUndefined();
      }
    }
  });

  describe("connection gating", () => {
    const cases: Array<[Connection, boolean, PerBias]> = [
      ["ready", false, all(["chatgpt_plan", "plan_offload"])],
      ["ready_after_restart", false, all(["chatgpt_plan", "plan_offload"])],
      [
        "needs_repair",
        false,
        {
          economy: ["ask_user", "connection_consent"],
          balanced: ["ask_user", "connection_consent"],
          speed: ["codex_solo", "connection_unavailable"],
        },
      ],
      [
        "needs_project",
        false,
        {
          economy: ["ask_user", "connection_consent"],
          balanced: ["ask_user", "connection_consent"],
          speed: ["codex_solo", "connection_unavailable"],
        },
      ],
      ["needs_repair", true, all(["codex_solo", "connection_unavailable"])],
      ["needs_project", true, all(["codex_solo", "connection_unavailable"])],
      ["not_setup", false, all(["codex_solo", "connection_unavailable"])],
    ];
    for (const [connection, consentAskedToday, expected] of cases) {
      for (const bias of ROUTER_BIASES) {
        it(`plan-worthy, ${connection}${consentAskedToday ? " (asked today)" : ""} / ${bias}`, () => {
          const r = track(decideIntake(ictx({ bias, connection, consentAskedToday }), PRESETS.big));
          expect(routeOf(r)).toEqual(expected[bias]);
          if (r.reason === "connection_consent") expect(r.stateDelta?.consentAskedFor).toBe("plan");
          if (r.route === "codex_solo") {
            expect(r.stateDelta?.outSwitches).toBeUndefined();
            // a plan-worthy task still wants at least a review once the connection is back
            expect(r.stateDelta?.intendedReview).toBe(true);
          }
        });
      }
    }

    it("a plan-worthy task that could not connect gets at least the review a smaller risky one gets (monotonic)", () => {
      for (const bias of ROUTER_BIASES) {
        for (const over of [{ connection: "not_setup" as const }, { connection: "needs_repair" as const, consentAskedToday: true }]) {
          for (const preset of [PRESETS.big, PRESETS.riskySmall]) {
            const intake = decideIntake(ictx({ bias, ...over }), preset);
            expect(routeOf(intake)).toEqual(["codex_solo", "connection_unavailable"]);
            // the connection is back by the gate; a medium diff with no high-risk path
            const gate = track(
              decideReviewGate(
                rctx({
                  bias,
                  intakeRoute: intake.stateDelta?.intakeRoute ?? "codex_solo",
                  intendedReview: intake.stateDelta?.intendedReview ?? false,
                  files: 4,
                  lines: 120,
                  bucket: "medium",
                  categories: ["other"],
                })
              )
            );
            expect(routeOf(gate)).toEqual(["send_review", "intended_review"]);
          }
        }
      }
    });

    it("a wanted review with no ready connection never asks, and remembers intendedReview", () => {
      for (const bias of ROUTER_BIASES) {
        for (const connection of ["needs_repair", "needs_project", "not_setup"] as const) {
          const r = track(decideIntake(ictx({ bias, connection }), PRESETS.riskySmall));
          expect(routeOf(r)).toEqual(["codex_solo", "connection_unavailable"]);
          expect(r.stateDelta).toMatchObject({ intendedReview: true, intakeRoute: "codex_solo" });
          expect(r.stateDelta?.outSwitches).toBeUndefined();
        }
      }
    });
  });

  it("heuristic mode (answers = null) never escalates, for every context", () => {
    for (const bias of ROUTER_BIASES) {
      for (const connection of CONNECTIONS) {
        for (const warm of [false, true]) {
          for (const workspaceBusy of [false, true]) {
            for (const consentAskedToday of [false, true]) {
              const r = track(decideIntake({ bias, connection, warm, workspaceBusy, consentAskedToday }, null));
              expect(routeOf(r)).toEqual(["codex_solo", "heuristic_default"]);
              expect(r.source).toBe("heuristic");
              expect(r.stateDelta).toEqual({ intakeRoute: "codex_solo" });
            }
          }
        }
      }
    }
  });

  it("the risk floor holds for any answers that clear the earlier steps", () => {
    const r = rng(11);
    for (let i = 0; i < 400; i++) {
      const a = answers({
        kind: { targeted_change: r(), new_feature: r() * 0.5, question_or_explanation: r() * 0.5 },
        scope: [r(), r(), r(), r(), r(), r()],
        needsDesign: r(),
        goalIsClear: 0.3 + r() * 0.7,
        risk: { auth: r(), data: r(), concurrency: r(), publicInterface: 0.6 + r() * 0.4 },
      });
      const res = decideIntake(ictx({ bias: pick(r, ROUTER_BIASES), warm: r() > 0.5 }), a);
      if (res.reason === "not_coding") continue;
      expect(["codex_then_review", "chatgpt_plan"]).toContain(res.route);
    }
  });
});

// ---------------------------------------------------------------- failure

describe("decideFailure", () => {
  it("takes the local fast path on the first failure, even with alarming answers", () => {
    for (const bias of ROUTER_BIASES) {
      for (const a of [null, fans("compile_or_type_error", 0.9, 0.99)]) {
        const r = track(
          decideFailure(fctx({ bias, consecutive: 1, sameSignatureStreak: 1, needsUserRegex: true, inLoop: true }), a)
        );
        expect(routeOf(r)).toEqual(["keep_fixing", "first_failure"]);
        expect(r.source).toBe("rule");
        expect(r.sayParams).toEqual({ n: 1 });
        expect(r.stateDelta).toBeUndefined();
      }
    }
  });

  describe("caps (same signature), jev and heuristic", () => {
    const cases: Array<[FailureKind, Record<RouterBias, number>]> = [
      ["runtime_exception", { economy: 2, balanced: 3, speed: 4 }],
      ["assertion_mismatch", { economy: 2, balanced: 3, speed: 4 }],
      ["other", { economy: 2, balanced: 3, speed: 4 }],
      ["compile_or_type_error", { economy: 3, balanced: 4, speed: 5 }],
      ["missing_module_or_dependency", { economy: 3, balanced: 4, speed: 5 }],
    ];
    for (const [kind, firstEscalation] of cases) {
      for (const bias of ROUTER_BIASES) {
        it(`${kind} / ${bias} escalates at attempt ${firstEscalation[bias]}`, () => {
          const at = firstEscalation[bias];
          for (const [label, a] of [
            ["jev", fans(kind)],
            ["heuristic", null],
          ] as const) {
            const ctx = (n: number) => repeat(n, { bias, heuristicKind: kind });
            for (let n = 2; n < at; n++) {
              expect(routeOf(track(decideFailure(ctx(n), a))), `${label} n=${n}`).toEqual(["keep_fixing", "below_cap"]);
            }
            const r = track(decideFailure(ctx(at), a));
            expect(routeOf(r), `${label} n=${at}`).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
            expect(r.source).toBe(label);
            expect(r.signals.cap).toBe(at);
            expect(r.sayParams).toEqual({ n: at });
            expect(r.stateDelta).toEqual({ outSwitches: 1, engaged: true });
          }
        });
      }
    }
  });

  it("different signatures escalate at consecutive ≥ N + 2", () => {
    const expected: Record<RouterBias, number> = { economy: 4, balanced: 5, speed: 6 };
    for (const bias of ROUTER_BIASES) {
      const at = expected[bias];
      const ctx = (n: number) => fctx({ bias, consecutive: n, sameSignatureStreak: 1 });
      expect(routeOf(decideFailure(ctx(at - 1), fans("runtime_exception")))).toEqual(["keep_fixing", "below_cap"]);
      expect(routeOf(decideFailure(ctx(at), fans("runtime_exception")))).toEqual([
        "escalate_chatgpt",
        "stuck_escalate_debug",
      ]);
    }
  });

  it("uncertainIntake lowers the cap by 1, never below 2", () => {
    expect(failureCap("economy", true, "runtime_exception")).toBe(2);
    expect(failureCap("balanced", true, "runtime_exception")).toBe(2);
    expect(failureCap("speed", true, "runtime_exception")).toBe(3);
    expect(failureCap("balanced", true, "compile_or_type_error")).toBe(3);
    expect(routeOf(decideFailure(repeat(2, { bias: "balanced" }), fans("runtime_exception")))).toEqual([
      "keep_fixing",
      "below_cap",
    ]);
    expect(
      routeOf(decideFailure(repeat(2, { bias: "balanced", uncertainIntake: true }), fans("runtime_exception")))
    ).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
    expect(routeOf(decideFailure(repeat(3, { bias: "speed", uncertainIntake: true }), null))).toEqual([
      "escalate_chatgpt",
      "stuck_escalate_debug",
    ]);
    expect(
      routeOf(decideFailure(fctx({ bias: "economy", uncertainIntake: true, consecutive: 3, sameSignatureStreak: 1 }), null))
    ).toEqual(["keep_fixing", "below_cap"]);
  });

  it("a low-confidence kind counts as other", () => {
    const lowConfidence = fans("compile_or_type_error", 0.39);
    expect(decideFailure(repeat(3), lowConfidence).signals.kind).toBe("other");
    expect(routeOf(decideFailure(repeat(3), lowConfidence))).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
    const confident = fans("compile_or_type_error", 0.4);
    expect(decideFailure(repeat(3), confident).signals.kind).toBe("compile_or_type_error");
    expect(routeOf(decideFailure(repeat(3), confident))).toEqual(["keep_fixing", "below_cap"]);
    const lowEnv = fans("environment_or_tooling", 0.2);
    expect(routeOf(decideFailure(repeat(3), lowEnv))).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
  });

  it("an unconfident split inside one policy branch keeps that branch (mass, not argmax)", () => {
    const split = (probs: Partial<Record<FailureKind, number>>, confidence: number): FailureAnswers => {
      const named = Object.values(probs).reduce((sum, v) => sum + (v ?? 0), 0);
      const rest = (1 - named) / (FAILURE_KINDS.length - Object.keys(probs).length);
      const kind = Object.fromEntries(FAILURE_KINDS.map((k) => [k, probs[k] ?? rest])) as Record<FailureKind, number>;
      return { kind, kindConfidence: confidence, needsUser: 0.05 };
    };
    // env 0.46 / flaky 0.44: argmax confidence 0.37, but both kinds never escalate
    const envFlaky = split({ environment_or_tooling: 0.46, timeout_or_flaky: 0.44 }, 0.37);
    expect(decideFailure(repeat(3), envFlaky).signals.kind).toBe("environment_or_tooling");
    expect(routeOf(track(decideFailure(repeat(3), envFlaky)))).toEqual(["keep_fixing", "below_cap"]);
    expect(routeOf(track(decideFailure(repeat(4), envFlaky)))).toEqual(["ask_user", "env_or_flaky_cap"]);
    const flakyFirst = split({ environment_or_tooling: 0.25, timeout_or_flaky: 0.3 }, 0.18);
    expect(decideFailure(repeat(3), flakyFirst).signals.kind).toBe("timeout_or_flaky");
    // compile 0.47 / missing 0.45 (TS2307): both get cap + 1
    const build = split({ compile_or_type_error: 0.47, missing_module_or_dependency: 0.45 }, 0.38);
    expect(decideFailure(repeat(3), build).signals.cap).toBe(4);
    expect(routeOf(track(decideFailure(repeat(3), build)))).toEqual(["keep_fixing", "below_cap"]);
    expect(routeOf(decideFailure(repeat(4), build))).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
    // a split across branches is still "other"
    const cross = split({ runtime_exception: 0.45, environment_or_tooling: 0.45 }, 0.36);
    expect(decideFailure(repeat(3), cross).signals.kind).toBe("other");
    expect(routeOf(decideFailure(repeat(3), cross))).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
    const belowMass = split({ environment_or_tooling: 0.3, timeout_or_flaky: 0.19 }, 0.2);
    expect(decideFailure(repeat(3), belowMass).signals.kind).toBe("other");
  });

  describe("needs_user (Jev can only raise)", () => {
    for (const bias of ROUTER_BIASES) {
      it(`${bias}`, () => {
        const jev = track(decideFailure(fctx({ bias }), fans("runtime_exception", 0.8, 0.8)));
        expect(routeOf(jev)).toEqual(["ask_user", "needs_user"]);
        expect(jev.source).toBe("jev");
        expect(jev.sayParams).toEqual({ n: 2 });

        const edge = decideFailure(fctx({ bias }), fans("runtime_exception", 0.8, 0.6));
        expect(routeOf(edge)).toEqual(["ask_user", "needs_user"]);
        expect(decideFailure(fctx({ bias }), fans("runtime_exception", 0.8, 0.59)).reason).not.toBe("needs_user");

        const floor = track(decideFailure(fctx({ bias, needsUserRegex: true }), fans("runtime_exception", 0.8, 0)));
        expect(routeOf(floor)).toEqual(["ask_user", "needs_user"]);
        expect(floor.source).toBe("rule");
        expect(floor.signals.needsUser).toBe(0.7);

        const heuristic = track(decideFailure(fctx({ bias, needsUserRegex: true }), null));
        expect(routeOf(heuristic)).toEqual(["ask_user", "needs_user"]);
        expect(heuristic.source).toBe("heuristic");
        expect(decideFailure(fctx({ bias }), null).reason).not.toBe("needs_user");
      });
    }

    it("comes before the loop and escalation rules", () => {
      const r = decideFailure(repeat(9, { inLoop: true, needsUserRegex: true }), fans("runtime_exception", 0.9, 0));
      expect(routeOf(r)).toEqual(["ask_user", "needs_user"]);
    });

    it("the regex floor survives any Jev answer", () => {
      const r = rng(7);
      for (let i = 0; i < 300; i++) {
        const n = 2 + Math.floor(r() * 8);
        const ctx = fctx({
          bias: pick(r, ROUTER_BIASES),
          consecutive: n,
          sameSignatureStreak: 1 + Math.floor(r() * n),
          needsUserRegex: true,
          inLoop: r() > 0.5,
          pin: pick(r, ["chatgpt", "codex", null] as const),
          connection: pick(r, CONNECTIONS),
          outSwitches: Math.floor(r() * 3),
        });
        const a = r() > 0.2 ? fans(pick(r, FAILURE_KINDS), r(), r() * 0.6) : null;
        expect(decideFailure(ctx, a).reason).toBe("needs_user");
      }
    });
  });

  describe("environment and flaky failures never go to ChatGPT", () => {
    for (const kind of ["environment_or_tooling", "timeout_or_flaky"] as const) {
      for (const bias of ROUTER_BIASES) {
        it(`${kind} / ${bias}`, () => {
          const cap = THRESHOLDS.capBase[bias];
          for (const a of [fans(kind, 0.9), null]) {
            for (let n = 2; n <= cap; n++) {
              const ctx = repeat(n, { bias, heuristicKind: kind, inLoop: true });
              expect(routeOf(track(decideFailure(ctx, a)))).toEqual(["keep_fixing", "below_cap"]);
            }
            const r = track(decideFailure(repeat(cap + 1, { bias, heuristicKind: kind, inLoop: true }), a));
            expect(routeOf(r)).toEqual(["ask_user", "env_or_flaky_cap"]);
            expect(r.sayParams).toEqual({ n: cap + 1 });
          }
        });
      }
    }
  });

  it("in a ChatGPT loop, being stuck always goes back to ChatGPT", () => {
    for (const bias of ROUTER_BIASES) {
      const cap = THRESHOLDS.capBase[bias];
      const r = track(
        decideFailure(
          repeat(cap, {
            bias,
            inLoop: true,
            pin: "codex",
            outSwitches: 1,
            workspaceBusy: true,
            noEgress: true,
            connection: "needs_repair",
          }),
          null
        )
      );
      expect(routeOf(r)).toEqual(["escalate_chatgpt", "stuck_in_loop"]);
      expect(r.stateDelta).toBeUndefined();
    }
  });

  describe("hysteresis and pins", () => {
    for (const bias of ROUTER_BIASES) {
      const cap = THRESHOLDS.capBase[bias];
      it(`a second automatic out-switch is refused / ${bias}`, () => {
        const second = (n: number) => repeat(n, { bias, outSwitches: 1 });
        expect(routeOf(track(decideFailure(second(cap), fans("runtime_exception"))))).toEqual([
          "keep_fixing",
          "below_cap",
        ]);
        expect(routeOf(track(decideFailure(second(cap + 2), fans("runtime_exception"))))).toEqual([
          "ask_user",
          "stuck_ask_user",
        ]);
      });

      it(`pin chatgpt overrides the switch cap / ${bias}`, () => {
        const r = track(decideFailure(repeat(cap, { bias, outSwitches: 1, pin: "chatgpt" }), fans("runtime_exception")));
        expect(routeOf(r)).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
        expect(r.source).toBe("override");
        expect(r.stateDelta).toEqual({ outSwitches: 2, engaged: true });
        const noOverrideNeeded = decideFailure(repeat(cap, { bias, pin: "chatgpt" }), fans("runtime_exception"));
        expect(noOverrideNeeded.route).toBe("escalate_chatgpt");
        expect(noOverrideNeeded.source).toBe("jev");
      });

      it(`an unspent codex_then_review reservation may pay for a DEBUG escalation / ${bias}`, () => {
        const reserved = (n: number, over: Partial<FailureContext> = {}) =>
          repeat(n, { bias, outSwitches: 1, reservedReview: true, ...over });
        const r = track(decideFailure(reserved(cap), fans("runtime_exception")));
        expect(routeOf(r)).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
        expect(r.stateDelta).toEqual({ outSwitches: 1, engaged: true });
        expect(r.signals.reservedReview).toBe(true);
        expect(r.source).toBe("jev");
        expect(routeOf(decideFailure(reserved(cap), null))).toEqual(["escalate_chatgpt", "stuck_escalate_debug"]);
        // still not over pin codex, noEgress or a busy workspace
        for (const over of [{ pin: "codex" as const }, { noEgress: true }, { workspaceBusy: true }]) {
          expect(routeOf(decideFailure(reserved(cap, over), fans("runtime_exception")))).toEqual(["keep_fixing", "below_cap"]);
        }
        // and not on connection trouble without consent
        expect(routeOf(decideFailure(reserved(cap, { connection: "needs_repair", consentAskedToday: true }), null))).toEqual([
          "keep_fixing",
          "below_cap",
        ]);
      });

      it(`pin codex blocks escalation but still lets the gate ask the user / ${bias}`, () => {
        const blocked = track(decideFailure(repeat(cap, { bias, pin: "codex" }), fans("runtime_exception")));
        expect(routeOf(blocked)).toEqual(["keep_fixing", "below_cap"]);
        expect(blocked.source).toBe("override");
        expect(routeOf(track(decideFailure(repeat(cap + 2, { bias, pin: "codex" }), null)))).toEqual([
          "ask_user",
          "stuck_ask_user",
        ]);
        expect(routeOf(decideFailure(repeat(cap, { bias, pin: "codex", connection: "needs_repair" }), null))).toEqual([
          "keep_fixing",
          "below_cap",
        ]);
      });

      it(`after asking the user, the same question waits a full cap; "bring in ChatGPT" does not / ${bias}`, () => {
        const asked = cap + 2;
        for (let n = asked + 1; n < asked + cap; n++) {
          const r = track(decideFailure(repeat(n, { bias, pin: "codex", askedAt: asked }), fans("runtime_exception")));
          expect(routeOf(r)).toEqual(["keep_fixing", "below_cap"]);
          expect(r.signals.askedAt).toBe(asked);
        }
        expect(routeOf(decideFailure(repeat(asked + cap, { bias, pin: "codex", askedAt: asked }), null))).toEqual([
          "ask_user",
          "stuck_ask_user",
        ]);
        // the user answered "bring in ChatGPT": the streak is still there, so the next failure escalates
        expect(routeOf(decideFailure(repeat(asked + 1, { bias, pin: "chatgpt", outSwitches: 1, askedAt: asked }), null))).toEqual([
          "escalate_chatgpt",
          "stuck_escalate_debug",
        ]);
        // environment / flaky: asked at cap + 1, again at cap + 1 + cap
        const env = (n: number) => decideFailure(repeat(n, { bias, heuristicKind: "environment_or_tooling", askedAt: cap + 1 }), null);
        expect(routeOf(env(cap + 2))).toEqual(["keep_fixing", "below_cap"]);
        expect(routeOf(env(2 * cap + 1))).toEqual(["ask_user", "env_or_flaky_cap"]);
        // never asked: unchanged
        expect(decideFailure(repeat(cap + 2, { bias, pin: "codex" }), null).signals.askedAt).toBeUndefined();
      });

      it(`noEgress and workspaceBusy block escalation / ${bias}`, () => {
        for (const over of [{ noEgress: true }, { workspaceBusy: true }, { noEgress: true, pin: "chatgpt" as const }]) {
          expect(routeOf(track(decideFailure(repeat(cap, { bias, ...over }), null)))).toEqual([
            "keep_fixing",
            "below_cap",
          ]);
          expect(routeOf(track(decideFailure(repeat(cap + 2, { bias, ...over }), null)))).toEqual([
            "ask_user",
            "stuck_ask_user",
          ]);
        }
      });
    }
  });

  describe("connection gating and the daily consent limit", () => {
    const cases: Array<[Connection, boolean, PerBias]> = [
      ["ready_after_restart", false, all(["escalate_chatgpt", "stuck_escalate_debug"])],
      [
        "needs_repair",
        false,
        {
          economy: ["ask_user", "reconnect_consent"],
          balanced: ["ask_user", "reconnect_consent"],
          speed: ["keep_fixing", "below_cap"],
        },
      ],
      [
        "needs_project",
        false,
        {
          economy: ["ask_user", "reconnect_consent"],
          balanced: ["ask_user", "reconnect_consent"],
          speed: ["keep_fixing", "below_cap"],
        },
      ],
      ["needs_repair", true, all(["keep_fixing", "below_cap"])],
      ["not_setup", false, all(["keep_fixing", "below_cap"])],
    ];
    for (const [connection, consentAskedToday, expected] of cases) {
      for (const bias of ROUTER_BIASES) {
        it(`${connection}${consentAskedToday ? " (asked today)" : ""} / ${bias}`, () => {
          const cap = THRESHOLDS.capBase[bias];
          const r = track(decideFailure(repeat(cap, { bias, connection, consentAskedToday }), fans("runtime_exception")));
          expect(routeOf(r)).toEqual(expected[bias]);
          if (r.route !== "escalate_chatgpt") expect(r.stateDelta).toBeUndefined();
          // past N + 2 a declined / unavailable reconnect turns into a question for the user
          const late = track(
            decideFailure(repeat(cap + 2, { bias, connection, consentAskedToday }), fans("runtime_exception"))
          );
          if (expected[bias][0] === "keep_fixing") expect(routeOf(late)).toEqual(["ask_user", "stuck_ask_user"]);
          else expect(routeOf(late)).toEqual(expected[bias]);
        });
      }
    }
  });

  it("heuristic kinds come from the regex table", () => {
    const tsc = ["src/a.ts(3,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."];
    const kind = heuristicFailureKind(tsc);
    expect(kind).toBe("compile_or_type_error");
    expect(routeOf(decideFailure(repeat(3, { heuristicKind: kind }), null))).toEqual(["keep_fixing", "below_cap"]);
    expect(routeOf(decideFailure(repeat(4, { heuristicKind: kind }), null))).toEqual([
      "escalate_chatgpt",
      "stuck_escalate_debug",
    ]);
  });

  function randomFailureCtx(r: () => number): FailureContext {
    const consecutive = 1 + Math.floor(r() * 9);
    return fctx({
      bias: pick(r, ROUTER_BIASES),
      consecutive,
      sameSignatureStreak: 1 + Math.floor(r() * consecutive),
      uncertainIntake: r() > 0.7,
      needsUserRegex: r() > 0.85,
      heuristicKind: pick(r, FAILURE_KINDS),
      inLoop: r() > 0.7,
      pin: pick(r, ["chatgpt", "codex", null, null] as const),
      noEgress: r() > 0.85,
      workspaceBusy: r() > 0.85,
      outSwitches: Math.floor(r() * 3),
      connection: pick(r, CONNECTIONS),
      consentAskedToday: r() > 0.5,
    });
  }

  it("heuristic mode escalates only on code-counted evidence and only where Jev mode could", () => {
    const r = rng(23);
    for (let i = 0; i < 2000; i++) {
      const ctx = randomFailureCtx(r);
      const res = track(decideFailure(ctx, null));
      expect(res.source).not.toBe("jev");
      if (res.route !== "escalate_chatgpt") continue;
      const cap = failureCap(ctx.bias, ctx.uncertainIntake, ctx.heuristicKind);
      expect(ctx.consecutive).toBeGreaterThan(1);
      expect(ctx.needsUserRegex).toBe(false);
      expect(["environment_or_tooling", "timeout_or_flaky"]).not.toContain(ctx.heuristicKind);
      expect(ctx.sameSignatureStreak >= cap || ctx.consecutive >= cap + 2).toBe(true);
      if (res.reason === "stuck_in_loop") {
        expect(ctx.inLoop).toBe(true);
        continue;
      }
      expect(res.reason).toBe("stuck_escalate_debug");
      expect(ctx.pin).not.toBe("codex");
      expect(ctx.noEgress || ctx.workspaceBusy).toBe(false);
      expect(ctx.outSwitches < 1 || ctx.pin === "chatgpt").toBe(true);
      expect(["ready", "ready_after_restart"]).toContain(ctx.connection);
      // Jev answers that agree with the heuristic kind reach the same route
      expect(routeOf(decideFailure(ctx, fans(ctx.heuristicKind, 0.9, 0)))).toEqual(routeOf(res));
    }
  });

  it("no Jev answer lowers the needs-user floor or turns a user question into escalation", () => {
    const r = rng(29);
    for (let i = 0; i < 2000; i++) {
      const ctx = randomFailureCtx(r);
      const heuristic = decideFailure(ctx, null);
      const jev = decideFailure(ctx, fans(pick(r, FAILURE_KINDS), r(), r()));
      if (ctx.consecutive <= 1) {
        expect(routeOf(jev)).toEqual(["keep_fixing", "first_failure"]);
        continue;
      }
      const needsUser = jev.signals.needsUser as number;
      if (heuristic.reason === "needs_user") expect(jev.reason).toBe("needs_user");
      if (jev.reason === "needs_user") expect(ctx.needsUserRegex || needsUser >= 0.6).toBe(true);
      expect(needsUser).toBeGreaterThanOrEqual(ctx.needsUserRegex ? 0.7 : 0);
      if (jev.route === "escalate_chatgpt") {
        expect(jev.signals.stuck).toBe(true);
        expect(jev.reason === "stuck_in_loop" ? ctx.inLoop : jev.signals.canEngage).toBe(true);
      }
    }
  });

  it("sayParams.n is the attempt count for every n-bearing reason", () => {
    const withN: Array<[PolicyResult, number]> = [
      [decideFailure(repeat(4, { heuristicKind: "timeout_or_flaky" }), null), 4],
      [decideFailure(repeat(5, { outSwitches: 1 }), null), 5],
      [decideFailure(repeat(3, { connection: "needs_repair" }), null), 3],
      [decideFailure(repeat(3), null), 3],
    ];
    expect(withN.map(([res]) => res.reason)).toEqual([
      "env_or_flaky_cap",
      "stuck_ask_user",
      "reconnect_consent",
      "stuck_escalate_debug",
    ]);
    for (const [res, n] of withN) expect(track(res).sayParams).toEqual({ n });
  });
});

// ---------------------------------------------------------------- heuristics

describe("heuristicFailureKind", () => {
  const cases: Array<[string, FailureKind]> = [
    ["error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", "compile_or_type_error"],
    ["SyntaxError: Unexpected token '}'", "compile_or_type_error"],
    ["Type 'number' is not assignable to type 'string'.", "compile_or_type_error"],
    ["Error: Cannot find module 'zod'", "missing_module_or_dependency"],
    ["ModuleNotFoundError: No module named 'requests'", "missing_module_or_dependency"],
    ["ImportError: cannot import name 'foo' from 'bar'", "missing_module_or_dependency"],
    ["go: cannot find module providing package example.com/x", "missing_module_or_dependency"],
    ["Expected: 3", "assertion_mismatch"],
    ["Received: 2", "assertion_mismatch"],
    ["AssertionError: expected 2 to be 3", "assertion_mismatch"],
    ["expect(result).toEqual(expected)", "assertion_mismatch"],
    ["Traceback (most recent call last):", "runtime_exception"],
    ["Uncaught ReferenceError: x is not defined", "runtime_exception"],
    ["panic: runtime error: index out of range [3] with length 3", "runtime_exception"],
    ["thread 'main' panicked at src/main.rs:4:5", "runtime_exception"],
    ["TypeError: Cannot read properties of undefined (reading 'id')", "runtime_exception"],
    ["zsh: command not found: pnpm", "environment_or_tooling"],
    ["Error: listen EADDRINUSE: address already in use :::3000", "environment_or_tooling"],
    ["error: this package requires Node.js version >=20", "environment_or_tooling"],
    ["Test timed out in 5000ms.", "timeout_or_flaky"],
    ["connect ETIMEDOUT 10.0.0.1:443", "timeout_or_flaky"],
    ["Error: read ECONNRESET", "timeout_or_flaky"],
    ['error package@1.0.0: The engine "node" is incompatible with this module. Expected version ">=18". Got "16.20.0"', "environment_or_tooling"],
    [" ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)", "environment_or_tooling"],
    ["npm ERR! code EBADENGINE", "environment_or_tooling"],
    ["Expected version 2 but got 3", "assertion_mismatch"],
    ['thrown: "Exceeded timeout of 5000 ms for a test.', "timeout_or_flaky"],
    ["'pnpm' is not recognized as an internal or external command,", "environment_or_tooling"],
    ["'pnpm' 不是内部或外部命令，也不是可运行的程序", "environment_or_tooling"],
    ["Error: P1001: Can't reach database server at `localhost:5432`", "environment_or_tooling"],
    ["Error: connect ECONNREFUSED 127.0.0.1:5432", "environment_or_tooling"],
    ["error[E0308]: mismatched types", "compile_or_type_error"],
    ['[vite] Internal server error: Failed to resolve import "./foo" from "src/main.ts". Does the file exist?', "missing_module_or_dependency"],
    ["Error: connect ECONNREFUSED 127.0.0.1:8080", "other"],
    ["make: *** [all] Error 2", "other"],
    ["error: ';' expected", "other"],
  ];
  it.each(cases)("%s → %s", (line, kind) => {
    expect(heuristicFailureKind([line])).toBe(kind);
  });

  it("first match wins in the listed order, across all lines", () => {
    expect(heuristicFailureKind(["Traceback (most recent call last):", "AssertionError: assert 'a' == 'b'"])).toBe(
      "assertion_mismatch"
    );
    expect(heuristicFailureKind(["Cannot find module './x'", "error TS2307: Cannot find module './x'"])).toBe(
      "compile_or_type_error"
    );
    expect(heuristicFailureKind("TypeError: x is undefined\nTest timed out in 5000ms")).toBe("runtime_exception");
    // an engine mismatch wins over the "Expected" it prints
    expect(heuristicFailureKind(['error pkg@1.0.0: The engine "node" is incompatible with this module.', 'Expected version ">=18". Got "16.20.0"'])).toBe(
      "environment_or_tooling"
    );
    expect(heuristicFailureKind([])).toBe("other");
    expect(FAILURE_KIND_PATTERNS.map(([k]) => k)).toEqual(FAILURE_KINDS.filter((k) => k !== "other"));
  });
});

describe("needsUserRegex", () => {
  const cases: Array<[string, boolean]> = [
    ["npm ERR! 401 Unauthorized - you must be logged in", true],
    ["Error: OPENAI_API_KEY is not set", true],
    ["EACCES: permission denied, open '/usr/local/lib/x'", true],
    ["Error: EPERM: operation not permitted, mkdir '/etc/x'", true],
    ["HTTP 403 Forbidden", true],
    ["402 Payment Required", true],
    ["error: quota exceeded for this project", true],
    ["You are not logged in. Run `gh auth login`.", true],
    ["Missing credentials for registry", true],
    ["expect(res.status).toBe(401) — received 200", false],
    ["AssertionError: expected 403 to equal 200", false],
    ["TypeError: x is undefined", false],
    ["    at Object.<anonymous> (src/router/a.ts:401:12)", false],
    ["src/b.ts:403:1 - error TS2322", false],
    ['  File "/app/api/views.py", line 401, in handler', false],
    ["main.go:402 +0x1d", false],
    ["tests/test_api.py:403: in test_list", false],
    ["src/a.ts(401,5): error TS2322: Type 'string' is not assignable to type 'number'.", false],
    ["  402 |   });", false],
    ["    403|     return res.json();", false],
    ["2026-09-22 20:15:53.401 INFO worker started", false],
    ["Expected 401, 403 or 500 but the server answered", false],
    ["GET /api/me 401, retrying", true],
    ['{"error":"invalid token","status":401}', true],
    ["AxiosError: Request failed with status code 403", true],
    ["Tests: 401 passed, 2 failed", false],
    ["Tests  1 failed | 401 passed (402)", false],
    ["Tests:       1 failed, 401 passed, 402 total", false],
    ["=== 1 failed, 401 passed in 3.21s ===", false],
    [" × GET /me > returns 401 without a token", false],
    [" FAIL  tests/api.test.ts > GET /me > returns 401 without a token", false],
    ["- 401", false],
    ["+ 200", false],
    ["  ● login › rejects unauthorized users", false],
    ["--- FAIL: TestUnauthorized (0.00s)", false],
    ["    api_test.go:22: got 200, want 401", false],
    ["  12|   const res = await get('/me', 401)", false],
    ["HTTP 403 (403) Forbidden", true],
    ["Error: Not authenticated. Please run `vercel login`", true],
    ["please run: gh auth login", true],
    ["No token found. Run `netlify login` first", true],
    ["have you run firebase login?", true],
    ["Try running `npx wrangler login`", true],
    // app text that merely mentions running a login step is not a tool asking for the user
    ["Error: failed to run the login migration", false],
    ["TypeError: Cannot run the login handler twice", false],
    ["Error: could not run user login hook", false],
  ];
  it.each(cases)("%s → %s", (line, expected) => {
    expect(needsUserRegex([line])).toBe(expected);
  });

  it("accepts raw text and needs only one qualifying line", () => {
    expect(needsUserRegex("ok\nexpect(status).toBe(401)\nnpm ERR! code E401\nnpm ERR! 401 Unauthorized")).toBe(true);
    expect(needsUserRegex("expect(status).toBe(401)\nreceived: 403")).toBe(false);
  });
});

// ---------------------------------------------------------------- review gate

describe("decideReviewGate", () => {
  const sizeTable: Array<[SizeBucket, Record<RouterBias, ReasonCode>]> = [
    ["tiny", { economy: "small_safe", balanced: "small_safe", speed: "small_safe" }],
    ["small", { economy: "small_safe", balanced: "small_safe", speed: "small_safe" }],
    ["medium", { economy: "small_safe", balanced: "small_safe", speed: "small_safe" }],
    ["large", { economy: "small_safe", balanced: "large_diff", speed: "small_safe" }],
    ["xlarge", { economy: "large_diff", balanced: "large_diff", speed: "small_safe" }],
  ];
  for (const [bucket, expected] of sizeTable) {
    for (const bias of ROUTER_BIASES) {
      it(`size ${bucket} / ${bias} → ${expected[bias]}`, () => {
        const r = track(decideReviewGate(rctx({ bias, bucket, files: 30, lines: 900 })));
        expect(r.reason).toBe(expected[bias]);
        expect(r.route).toBe(expected[bias] === "large_diff" ? "send_review" : "close_local");
        expect(r.source).toBe("rule");
        expect(r.sayParams).toBeUndefined();
        const mech = track(decideReviewGate(rctx({ bias, bucket, files: 30, lines: 900, mechanical: true })));
        expect(routeOf(mech)).toEqual(["close_local", "small_safe"]);
      });
    }
  }

  const ZH: Record<string, string> = {
    auth_security: "登录/权限相关代码",
    payments: "支付相关代码",
    data_migration: "数据库结构或迁移",
    ci_pipeline: "CI 配置",
    agent_config: "Codex/ChatGPT 的配置文件",
    install_scripts: "安装脚本",
  };

  for (const category of PATH_CATEGORIES) {
    const high = HIGH_RISK_PATH_CATEGORIES.includes(category);
    for (const bias of ROUTER_BIASES) {
      it(`category ${category} / ${bias} → ${high ? "send_review" : "close_local"}`, () => {
        const r = track(decideReviewGate(rctx({ bias, categories: ["docs", category], mechanical: true })));
        if (high) {
          expect(routeOf(r)).toEqual(["send_review", "high_risk_paths"]);
          expect(r.sayParams).toEqual({ categoryZh: ZH[category] });
          expect(r.signals.highCategory).toBe(category);
        } else {
          expect(routeOf(r)).toEqual(["close_local", "small_safe"]);
          expect(r.signals.highCategory).toBe("none");
        }
      });
    }
  }

  it("names the first high category found", () => {
    const r = decideReviewGate(rctx({ categories: ["docs", "payments", "auth_security", "payments"] }));
    expect(r.sayParams?.categoryZh).toBe("支付相关代码");
    expect(r.signals.categories).toEqual(["docs", "payments", "auth_security"]);
  });

  it("an engaged task always continues the loop", () => {
    for (const bias of ROUTER_BIASES) {
      for (const over of [
        {},
        { tests: "failed" as const },
        { userAskedReview: true },
        { files: 0 },
        { pin: "codex" as const, outSwitches: 3 },
      ]) {
        const r = track(decideReviewGate(rctx({ bias, engaged: true, ...over })));
        expect(routeOf(r)).toEqual(["continue_loop", "in_loop"]);
        expect(r.stateDelta).toBeUndefined();
      }
    }
  });

  it("failing tests come first, then nothing-to-review", () => {
    expect(routeOf(track(decideReviewGate(rctx({ tests: "failed", userAskedReview: true }))))).toEqual([
      "fix_first",
      "tests_failed",
    ]);
    expect(routeOf(decideReviewGate(rctx({ tests: "not_run", categories: ["auth_security"] })))).toEqual([
      "send_review",
      "high_risk_paths",
    ]);
    expect(routeOf(track(decideReviewGate(rctx({ files: 0, userAskedReview: true }))))).toEqual([
      "close_local",
      "nothing_to_review",
    ]);
    expect(routeOf(track(decideReviewGate(rctx({ files: 0, headMoved: true }))))).toEqual(["close_local", "committed"]);
    expect(routeOf(decideReviewGate(rctx({ isGitRepo: false, headMoved: true, files: 4 })))).toEqual([
      "close_local",
      "nothing_to_review",
    ]);
  });

  it("a user-asked review ignores pins, the cap and the connection", () => {
    for (const bias of ROUTER_BIASES) {
      const r = track(
        decideReviewGate(
          rctx({
            bias,
            userAskedReview: true,
            pin: "codex",
            outSwitches: 2,
            noEgress: true,
            connection: "needs_repair",
            consentAskedToday: true,
          })
        )
      );
      expect(routeOf(r)).toEqual(["send_review", "user_asked"]);
      expect(r.source).toBe("override");
      expect(r.stateDelta).toEqual({ engaged: true });
    }
  });

  it("a user-asked review never replaces another task's live checkpoint", () => {
    for (const bias of ROUTER_BIASES) {
      const r = track(decideReviewGate(rctx({ bias, userAskedReview: true, workspaceBusy: true, pin: "chatgpt" })));
      expect(routeOf(r)).toEqual(["active_task", "workspace_busy"]);
      expect(r.source).toBe("rule");
      expect(r.stateDelta).toBeUndefined();
    }
  });

  describe("escalation blockers (step 4)", () => {
    const blockers: Array<[string, Partial<ReviewContext>, Source]> = [
      ["pin codex", { pin: "codex" }, "override"],
      ["noEgress", { noEgress: true }, "rule"],
      ["workspaceBusy", { workspaceBusy: true }, "rule"],
      ["second out-switch", { outSwitches: 1 }, "rule"],
      ["pin chatgpt does not lift noEgress", { pin: "chatgpt", noEgress: true }, "rule"],
    ];
    for (const [name, over, source] of blockers) {
      for (const bias of ROUTER_BIASES) {
        it(`${name} / ${bias}`, () => {
          const risky = track(decideReviewGate(rctx({ bias, categories: ["auth_security"], bucket: "xlarge", ...over })));
          expect(routeOf(risky)).toEqual(["close_local", "escalation_unavailable"]);
          expect(risky.source).toBe(source);
          expect(risky.sayParams).toEqual({ categoryZh: "登录/权限相关代码" });
          expect(risky.stateDelta).toBeUndefined();
          const plain = track(decideReviewGate(rctx({ bias, ...over })));
          expect(routeOf(plain)).toEqual(["close_local", "escalation_unavailable"]);
          expect(plain.sayParams).toBeUndefined();
        });
      }
    }

    it("pin chatgpt overrides the switch cap and wants a review by itself", () => {
      for (const bias of ROUTER_BIASES) {
        const capped = track(decideReviewGate(rctx({ bias, pin: "chatgpt", outSwitches: 1 })));
        expect(routeOf(capped)).toEqual(["send_review", "intended_review"]);
        expect(capped.source).toBe("override");
        expect(capped.stateDelta).toEqual({ engaged: true, outSwitches: 2 });
        const fresh = track(decideReviewGate(rctx({ bias, pin: "chatgpt" })));
        expect(routeOf(fresh)).toEqual(["send_review", "intended_review"]);
        expect(fresh.source).toBe("override");
      }
    });
  });

  it("codex_then_review spends the switch it reserved at intake", () => {
    for (const bias of ROUTER_BIASES) {
      const r = track(decideReviewGate(rctx({ bias, intakeRoute: "codex_then_review", outSwitches: 1 })));
      expect(routeOf(r)).toEqual(["send_review", "intended_review"]);
      expect(r.source).toBe("rule");
      expect(r.stateDelta).toEqual({ engaged: true, outSwitches: 1 });
      const spent = decideReviewGate(rctx({ bias, intakeRoute: "codex_then_review", outSwitches: 2 }));
      expect(routeOf(spent)).toEqual(["close_local", "escalation_unavailable"]);
      // the reservation is spent once ChatGPT was brought in (a DEBUG escalation or a finished review loop)
      const used = decideReviewGate(rctx({ bias, intakeRoute: "codex_then_review", outSwitches: 1, wasEngaged: true }));
      expect(routeOf(used)).toEqual(["close_local", "escalation_unavailable"]);
      expect(used.signals.wasEngaged).toBe(true);
    }
  });

  it("intendedReview (connection was down at intake) asks for the review now", () => {
    for (const bias of ROUTER_BIASES) {
      const r = track(decideReviewGate(rctx({ bias, intendedReview: true, categories: ["payments"] })));
      expect(routeOf(r)).toEqual(["send_review", "intended_review"]);
      expect(r.sayParams).toEqual({ categoryZh: "支付相关代码" });
      expect(r.stateDelta).toEqual({ engaged: true, outSwitches: 1 });
    }
  });

  describe("connection gating and the daily consent limit", () => {
    const cases: Array<[Connection, boolean, PerBias]> = [
      ["ready", false, all(["send_review", "high_risk_paths"])],
      ["ready_after_restart", false, all(["send_review", "high_risk_paths"])],
      [
        "needs_repair",
        false,
        {
          economy: ["ask_user", "reconnect_consent"],
          balanced: ["ask_user", "reconnect_consent"],
          speed: ["close_local", "escalation_unavailable"],
        },
      ],
      [
        "needs_project",
        false,
        {
          economy: ["ask_user", "reconnect_consent"],
          balanced: ["ask_user", "reconnect_consent"],
          speed: ["close_local", "escalation_unavailable"],
        },
      ],
      ["needs_repair", true, all(["close_local", "escalation_unavailable"])],
      ["not_setup", false, all(["close_local", "escalation_unavailable"])],
    ];
    for (const [connection, consentAskedToday, expected] of cases) {
      for (const bias of ROUTER_BIASES) {
        it(`${connection}${consentAskedToday ? " (asked today)" : ""} / ${bias}`, () => {
          const r = track(
            decideReviewGate(rctx({ bias, connection, consentAskedToday, categories: ["data_migration"] }))
          );
          expect(routeOf(r)).toEqual(expected[bias]);
          expect(r.sayParams).toEqual({ categoryZh: "数据库结构或迁移" });
          if (r.route === "ask_user") expect(r.stateDelta).toEqual({ consentAskedFor: "review" });
          if (r.route === "close_local") expect(r.stateDelta).toBeUndefined();
        });
      }
    }

    it("pin chatgpt does not override connection consent", () => {
      const r = decideReviewGate(rctx({ bias: "speed", pin: "chatgpt", connection: "needs_repair" }));
      expect(routeOf(r)).toEqual(["close_local", "escalation_unavailable"]);
      const asked = decideReviewGate(
        rctx({ bias: "balanced", pin: "chatgpt", connection: "needs_repair", consentAskedToday: true })
      );
      expect(routeOf(asked)).toEqual(["close_local", "escalation_unavailable"]);
    });
  });

  it("high-risk paths always get a review when nothing blocks it", () => {
    const r = rng(3);
    for (let i = 0; i < 300; i++) {
      const res = decideReviewGate(
        rctx({
          bias: pick(r, ROUTER_BIASES),
          bucket: pick(r, SIZE_BUCKETS),
          mechanical: r() > 0.5,
          tests: pick(r, ["passed", "not_run"] as const),
          categories: [pick(r, PATH_CATEGORIES), pick(r, HIGH_RISK_PATH_CATEGORIES), pick(r, PATH_CATEGORIES)],
          intakeRoute: pick(r, ["codex_solo", "codex_then_review"] as const),
          pin: pick(r, ["chatgpt", null] as const),
          connection: pick(r, ["ready", "ready_after_restart"] as const),
        })
      );
      expect(res.route).toBe("send_review");
    }
  });
});

// ---------------------------------------------------------------- reply

describe("decideReply", () => {
  const levelTable: Array<[number, Record<RouterBias, Route>]> = [
    [0.1, { economy: "apply_followups_local", balanced: "apply_followups_local", speed: "apply_followups_local" }],
    [0.25, { economy: "apply_followups_local", balanced: "apply_followups_then_review", speed: "apply_followups_local" }],
    [0.3, { economy: "apply_followups_local", balanced: "apply_followups_then_review", speed: "apply_followups_local" }],
    [
      0.35,
      { economy: "apply_followups_then_review", balanced: "apply_followups_then_review", speed: "apply_followups_local" },
    ],
    [
      0.4,
      {
        economy: "apply_followups_then_review",
        balanced: "apply_followups_then_review",
        speed: "apply_followups_then_review",
      },
    ],
    [
      0.95,
      {
        economy: "apply_followups_then_review",
        balanced: "apply_followups_then_review",
        speed: "apply_followups_then_review",
      },
    ],
  ];
  for (const [level, expected] of levelTable) {
    for (const bias of ROUTER_BIASES) {
      it(`max P(level≥2) = ${level} / ${bias} → ${expected[bias]}`, () => {
        const r = track(decideReply(pctx({ bias, itemCount: 3 }), { levelsGe2: [0.05, level, 0.1] }));
        expect(r.route).toBe(expected[bias]);
        expect(r.reason).toBe(r.route === "apply_followups_local" ? "followups_minor" : "followups_substantive");
        expect(r.source).toBe("jev");
        expect(r.signals.maxLevelGe2).toBe(level);
        expect(r.stateDelta).toBeUndefined();
      });
    }
  }

  it("an empty follow-up list is a plain DONE", () => {
    for (const bias of ROUTER_BIASES) {
      for (const a of [null, { levelsGe2: [] }]) {
        const r = track(decideReply(pctx({ bias, itemCount: 0 }), a));
        expect(routeOf(r)).toEqual(["close_local", "followups_none"]);
        expect(r.source).toBe("rule");
        expect(r.stateDelta).toBeUndefined();
      }
      // the review floor still wins over "nothing parsed"
      expect(routeOf(decideReply(pctx({ bias, itemCount: 0, riskItem: true }), null))).toEqual([
        "apply_followups_then_review",
        "followups_risky",
      ]);
    }
  });

  it("too many items always go back for review", () => {
    for (const bias of ROUTER_BIASES) {
      const zeros = { levelsGe2: Array(9).fill(0) };
      const r = track(decideReply(pctx({ bias, itemCount: MAX_LOCAL_FOLLOWUPS + 1 }), zeros));
      expect(routeOf(r)).toEqual(["apply_followups_then_review", "followups_too_many"]);
      expect(r.source).toBe("rule");
      const h = track(decideReply(pctx({ bias, itemCount: 12 }), null));
      expect(routeOf(h)).toEqual(["apply_followups_then_review", "followups_too_many"]);
      expect(h.source).toBe("heuristic");
      const eight = decideReply(pctx({ bias, itemCount: MAX_LOCAL_FOLLOWUPS }), { levelsGe2: Array(8).fill(0) });
      expect(routeOf(eight)).toEqual(["apply_followups_local", "followups_minor"]);
    }
  });

  it("a risky item is never applied locally, even with every level at 0", () => {
    for (const bias of ROUTER_BIASES) {
      for (const a of [{ levelsGe2: [0, 0, 0] }, null]) {
        const r = track(decideReply(pctx({ bias, itemCount: 3, riskItem: true }), a));
        expect(routeOf(r)).toEqual(["apply_followups_then_review", "followups_risky"]);
        expect(r.source).toBe(a ? "rule" : "heuristic");
      }
    }
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(r() * 13);
      const a = r() > 0.3 ? { levelsGe2: Array.from({ length: n }, () => r() * 0.2) } : null;
      const res = decideReply(pctx({ bias: pick(r, ROUTER_BIASES), itemCount: n, riskItem: true }), a);
      expect(res.route).toBe("apply_followups_then_review");
    }
  });

  it("heuristic mode runs steps 1, 2 and 4 only", () => {
    for (const bias of ROUTER_BIASES) {
      const r = track(decideReply(pctx({ bias, itemCount: 4 }), null));
      expect(routeOf(r)).toEqual(["apply_followups_local", "followups_minor"]);
      expect(r.source).toBe("heuristic");
      expect(r.signals.maxLevelGe2).toBeUndefined();
    }
  });

  it("the maxIterations limit never blocks a local apply and changes nothing else", () => {
    const atLimit = { iteration: 12, maxIterations: 12 };
    const local = decideReply(pctx(atLimit), { levelsGe2: [0.05, 0.1] });
    expect(routeOf(local)).toEqual(["apply_followups_local", "followups_minor"]);
    expect(local.signals.atIterationLimit).toBe(true);
    expect(routeOf(decideReply(pctx(atLimit), { levelsGe2: [0.05, 0.9] }))).toEqual([
      "apply_followups_then_review",
      "followups_substantive",
    ]);
    expect(routeOf(decideReply(pctx({ ...atLimit, riskItem: true }), null))).toEqual([
      "apply_followups_then_review",
      "followups_risky",
    ]);
    expect(decideReply(pctx({ iteration: 11, maxIterations: 12 }), null).signals.atIterationLimit).toBe(false);
  });

  it("an unreadable or missing level fails toward review", () => {
    expect(routeOf(decideReply(pctx({ bias: "speed" }), { levelsGe2: [0, Number.NaN] }))).toEqual([
      "apply_followups_then_review",
      "followups_substantive",
    ]);
    const short = track(decideReply(pctx({ bias: "speed", itemCount: 3 }), { levelsGe2: [0, 0] }));
    expect(routeOf(short)).toEqual(["apply_followups_then_review", "followups_substantive"]);
    expect(short.signals.maxLevelGe2).toBe(1);
  });

  it("Jev can only add a review on top of the heuristic floors, never remove one", () => {
    const r = rng(31);
    for (let i = 0; i < 2000; i++) {
      const itemCount = 1 + Math.floor(r() * 12);
      const ctx = pctx({
        bias: pick(r, ROUTER_BIASES),
        itemCount,
        riskItem: r() > 0.7,
        iteration: Math.floor(r() * 14),
        maxIterations: 12,
      });
      const heuristic = track(decideReply(ctx, null));
      const jev = track(decideReply(ctx, { levelsGe2: Array.from({ length: itemCount }, () => r()) }));
      if (heuristic.route === "apply_followups_then_review") {
        expect(routeOf(jev)).toEqual(routeOf(heuristic));
      } else {
        expect(ctx.riskItem || ctx.itemCount > MAX_LOCAL_FOLLOWUPS).toBe(false);
      }
      if (jev.route === "apply_followups_local") expect(heuristic.route).toBe("apply_followups_local");
    }
  });
});

// ---------------------------------------------------------------- trusted-channel shape of every result

describe("PolicyResult shape", () => {
  it("routes, reasons and sources are enums; signals are numbers, booleans and enum strings", () => {
    expect(results.length).toBeGreaterThan(200);
    const allowedStrings = new Set<string>([
      ...ROUTER_BIASES,
      ...CONNECTIONS,
      ...ROUTES,
      ...FAILURE_KINDS,
      ...PATH_CATEGORIES,
      ...SIZE_BUCKETS,
      "passed",
      "failed",
      "not_run",
      "chatgpt",
      "codex",
      "none",
    ]);
    for (const r of results) {
      expect(ROUTES).toContain(r.route);
      expect(REASON_CODES).toContain(r.reason);
      expect(["jev", "heuristic", "override", "rule"]).toContain(r.source);
      for (const [key, value] of Object.entries(r.signals)) {
        expect(POLICY_SIGNAL_IDS as readonly string[]).toContain(key);
        if (typeof value === "string") expect(allowedStrings.has(value), `${key}=${value}`).toBe(true);
        else if (Array.isArray(value)) for (const v of value) expect(allowedStrings.has(v), key).toBe(true);
        else if (typeof value === "number") expect(Number.isFinite(value), key).toBe(true);
        else expect(typeof value).toBe("boolean");
      }
      if (r.sayParams?.n !== undefined) expect(Number.isInteger(r.sayParams.n)).toBe(true);
      if (r.sayParams?.categoryZh !== undefined) {
        expect(["登录/权限相关代码", "支付相关代码", "数据库结构或迁移", "CI 配置", "Codex/ChatGPT 的配置文件", "安装脚本"]).toContain(
          r.sayParams.categoryZh
        );
      }
    }
  });

  function pointOf(r: PolicyResult): DecisionPoint {
    if ("tests" in r.signals) return "review_gate";
    if ("consecutive" in r.signals) return "failure";
    if ("itemCount" in r.signals) return "reply";
    return "intake";
  }

  it("every result renders a fixed next and say, with the params messages.ts requires", () => {
    const labels = new Set(Object.values(CATEGORY_LABEL_ZH));
    const seen = new Set<string>();
    for (const r of results) {
      const point = pointOf(r);
      seen.add(`${point}:${r.route}/${r.reason}`);
      const next = renderNext(r.route, r.reason, {
        taskId: "c2c_ab12",
        root: "/tmp/ws",
        c2c: 'node "/opt/c2c/bin/c2c.js"',
        n1: 3,
        point,
      });
      expect(next, `${point} ${r.route}/${r.reason}`).not.toBe(GENERIC_NEXT);
      const say = renderSay(r.route, r.reason, r.sayParams ?? {}, { withIntro: false, point });
      const countsAttempts =
        ["env_or_flaky_cap", "stuck_ask_user", "stuck_escalate_debug"].includes(r.reason) ||
        (point === "failure" && r.reason === "reconnect_consent");
      if (countsAttempts) expect(say).toContain(`${r.sayParams!.n} 次`);
      if (r.reason === "high_risk_paths") {
        expect(labels.has(r.sayParams!.categoryZh!)).toBe(true);
        expect(say).toContain(r.sayParams!.categoryZh!);
      }
      if (r.reason === "escalation_unavailable") expect(say === null).toBe(r.sayParams?.categoryZh === undefined);
    }
    // the tracked results cover every reason each decide* function can return
    for (const pair of [
      "intake:codex_solo/heuristic_default",
      "intake:codex_solo/not_coding",
      "intake:codex_solo/low_offload",
      "intake:codex_solo/workspace_busy",
      "intake:codex_solo/connection_unavailable",
      "intake:codex_then_review/review_band",
      "intake:codex_then_review/risk_floor",
      "intake:chatgpt_plan/plan_offload",
      "intake:ask_user/goal_unclear",
      "intake:ask_user/connection_consent",
      "failure:keep_fixing/first_failure",
      "failure:keep_fixing/below_cap",
      "failure:ask_user/needs_user",
      "failure:ask_user/env_or_flaky_cap",
      "failure:ask_user/stuck_ask_user",
      "failure:ask_user/reconnect_consent",
      "failure:escalate_chatgpt/stuck_in_loop",
      "failure:escalate_chatgpt/stuck_escalate_debug",
      "review_gate:continue_loop/in_loop",
      "review_gate:fix_first/tests_failed",
      "review_gate:close_local/nothing_to_review",
      "review_gate:close_local/committed",
      "review_gate:send_review/user_asked",
      "review_gate:send_review/intended_review",
      "review_gate:send_review/high_risk_paths",
      "review_gate:send_review/large_diff",
      "review_gate:close_local/small_safe",
      "review_gate:close_local/escalation_unavailable",
      "review_gate:ask_user/reconnect_consent",
      "review_gate:active_task/workspace_busy",
      "reply:close_local/followups_none",
      "reply:apply_followups_local/followups_minor",
      "reply:apply_followups_then_review/followups_too_many",
      "reply:apply_followups_then_review/followups_risky",
      "reply:apply_followups_then_review/followups_substantive",
    ]) {
      expect(seen.has(pair), pair).toBe(true);
    }
  });

  it("decisions are pure: the same input gives the same output", () => {
    const ctx = repeat(3);
    expect(decideFailure(ctx, fans("runtime_exception"))).toEqual(decideFailure(ctx, fans("runtime_exception")));
    expect(ctx).toEqual(repeat(3));
    const categories: PathCategory[] = ["auth_security"];
    decideReviewGate(rctx({ categories }));
    expect(categories).toEqual(["auth_security"]);
  });
});
