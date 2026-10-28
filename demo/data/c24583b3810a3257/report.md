# Agent Research Session - checkout-api p99 regression — evidence report

*Generated 2026-10-28 17:43 UTC by Auto-Research Monitor.*

- **Nodes:** 34  
- **Edges:** 54  
- **Claims scored:** 4 (2 green, 1 yellow, 1 red)

---

## Conclusion

*No conclusion has been generated for this task yet.*

---

## Findings

Each finding clusters a set of results; its credibility is the mean of the distinct claims those results support.

| Finding | Credibility | Claims | Results |
|---|---|---|---|
| `CON-001` Finding: an N+1 in the cart serializer, found and patched inside two hours | 🟢 88% (green) | 2 | 3 |

---

## Claim credibility

### 🔴 Low credibility (1)

#### CLM-001: Triage: regression is deploy-correlated

**Overall score**: 14.9%

> The latency regression was introduced by the v4.7.0 application deploy rather than by an infrastructure or database change, based on the 7-minute gap between rollout completion and the alert.

*How: the claim asserts 0.35 but its evidence supports only 18% — capped at what is supported and penalised for the 0.17 gap.*

**Dimension scores:**

- Evidence Coverage: 40% [####......]
  - no upstream experiment_design, hypothesis, result, rq, run node(s)
  - all 1 declared evidence id(s) are linked
  - **To improve:** add the missing upstream node type(s): experiment_design, hypothesis, result, rq, run
- Reproducibility: 0% [..........]
  - no RUN node is upstream of this claim, so nothing can be re-executed
  - **To improve:** record the execution as a RUN node and link it into this claim's chain
- Data Provenance: 0% [..........]
  - no ARTIFACT node is upstream — the data and code behind this claim are not tracked
  - **To improve:** add the dataset/script as an ARTIFACT node linked into the chain
- Statistical Validity: 30% [###.......]
  - claim quantifies its confidence (0.35)
  - no RESULT node upstream, so there are no numbers to check
  - **To improve:** attach the measured RESULT that this claim rests on
- Pipeline Integrity: 0% [..........]
  - 0/7 chain links present: none
  - broken links: motivation, rq, hypothesis, experiment_design, artifact, run, result
  - **To improve:** complete the lineage by adding: motivation, rq, hypothesis, experiment_design, artifact, run, result

### 🟡 Medium credibility (1)

#### CLM-002: H1 falsified: GC pressure is not the driver

**Overall score**: 48.0%

> Garbage collection accounts for 3.6ms of the 613ms p99 (0.6%), and GC pause time does not differ significantly between v4.6.3 and v4.7.0 (p=0.31). The 431ms regression is not explained by allocation pressure from the new serializer. Held provisionally: the instrumentation run covers a single 15-minute window at one traffic shape, and gen-2 behaviour under sustained load has not been observed.

*How: the evidence supports 100% and the claim only asserts 0.48 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 2 declared evidence id(s) are linked
- Reproducibility: 100% [##########]
  - RUN-002 records commit, environment and duration
  - RUN-003 records commit, environment and duration
- Data Provenance: 100% [##########]
  - ART-002 records path, version and type
  - ART-003 records path, version and type
  - ART-004 records path, version and type
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.48)
  - 2/2 result(s) carry metrics
  - 2 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

### 🟢 High credibility (2)

#### CLM-003: Root cause: PricingRule eager-load fires 43.6 queries per render

**Overall score**: 86.0%

> cart/serializers.py:118 in v4.7.0 dereferences `item.pricing_rule` inside the line-item loop. The relationship is lazy, so a median 41-item cart issues 41.7 extra SELECTs, raising per-request database wait to 437.5ms p99 -- 94% of the 431ms regression, and linear in cart size (r=0.93, p<1e-5). This, not serialization cost or GC, is the regression.

*How: the evidence supports 100% and the claim only asserts 0.86 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 3 declared evidence id(s) are linked
- Reproducibility: 100% [##########]
  - RUN-001 records commit, environment and duration
  - RUN-002 records commit, environment and duration
  - RUN-004 records commit, environment and duration
- Data Provenance: 100% [##########]
  - ART-001 records path, version and type
  - ART-002 records path, version and type
  - ART-003 records path, version and type
  - ART-004 records path, version and type
  - ART-005 records path, version and type
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.86)
  - 3/3 result(s) carry metrics
  - 3 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

#### CLM-004: RESOLVED: v4.7.1-rc2 restores p99 with identical totals

**Overall score**: 91.0%

> Batching PricingRule with a single selectinload returns queries per cart render to 2.1 and p99 to 176.3ms -- statistically indistinguishable from the pre-regression baseline of 182.4ms (bootstrap 95% CI [-14.7, +2.4]ms). A differential replay of all 12,000 settled orders from the incident window produced zero differences in order, tax or discount totals across 47 pricing rule paths. The regression is resolved and the fix is output-safe to ship.

*How: the evidence supports 100% and the claim only asserts 0.91 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 3 declared evidence id(s) are linked
- Reproducibility: 100% [##########]
  - RUN-001 records commit, environment and duration
  - RUN-005 records commit, environment and duration
  - RUN-006 records commit, environment and duration
- Data Provenance: 100% [##########]
  - ART-001 records path, version and type
  - ART-003 records path, version and type
  - ART-004 records path, version and type
  - ART-006 records path, version and type
  - ART-007 records path, version and type
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.91)
  - 3/3 result(s) carry metrics
  - 3 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

---

## How the edges got there

| Origin | Edges | What it means |
|---|---|---|
| `manual` | 51 | declared explicitly by an agent or the SDK |
| `convergence` | 3 | clustered into a finding by the convergence pass |

**3 of 54 edges were inferred rather than declared.** Credibility scores rest partly on these.

---

## Scoring Methodology

A claim's credibility is computed in two stages.

**Stage 1 — structural score.** Five dimensions of the claim's evidence chain, combined as a weighted sum:

- **Evidence Coverage** — weight 30%
- **Reproducibility** — weight 20%
- **Data Provenance** — weight 15%
- **Statistical Validity** — weight 20%
- **Pipeline Integrity** — weight 15%

**Stage 2 — confidence reconciliation.** The structural score is then reconciled with the claim's own stated `confidence`. Stated confidence is a *self-report*: it is evidence about the author, not about the world, so it can only ever lower the score — never raise it. Which of three branches applies depends on how the claim compares to what its evidence supports:

- **Calibrated or humble** (`confidence <= structural`) — the author does not claim more than they showed, so their own stated confidence stands as the score.
- **Overclaimed** (`confidence > structural`) — the score is capped at what the evidence supports and then reduced in proportion to the gap: `final = structural x (1 - 1.0 x (confidence - structural))`. A confident assertion with nothing under it scores near zero, which is the point.
- **No confidence stated** — the structural score is multiplied by 0.40. A claim that does not say how sure it is cannot score above 40%.

**Ratings.** Green at or above 0.72; yellow at or above 0.40; red below 0.40.

---

*Every number above is derived from this task's append-only event log; re-running the report on the same log reproduces it exactly.*
