# Contested replication - source panel effect — evidence report

*Generated 2026-10-28 17:43 UTC by Auto-Research Monitor.*

- **Nodes:** 23  
- **Edges:** 27  
- **Claims scored:** 4 (2 green, 1 yellow, 1 red)

---

## Conclusion

*No conclusion has been generated for this task yet.*

---

## Claim credibility

### 🔴 Low credibility (1)

#### CLM-B1: Team B: the source panel cuts wrong-answer acceptance by a third

**Overall score**: 19.3%

> The inline source panel reduces acceptance of incorrect answers by 11.4 percentage points (35.2% -> 23.8%), roughly a one-third reduction, and should be shipped to all surfaces immediately.

*How: no confidence stated, so the structural score 48% was multiplied by 0.40.*

**Dimension scores:**

- Evidence Coverage: 68% [#######...]
  - no upstream hypothesis node(s)
  - declared evidence not linked by an edge: DASH-4471
  - **To improve:** add the missing upstream node type(s): hypothesis; add supporting edge(s) from DASH-4471 to this claim
- Reproducibility: 20% [##........]
  - RUN-B1 (Team B: notebook re-run, 2026-04-16) is missing git_commit, environment/random_seed
  - **To improve:** add the missing run metadata on RUN-B1
- Data Provenance: 20% [##........]
  - ART-B1 (Team B: ad-hoc BI query result (never exported)) is missing path, version
  - **To improve:** fill in the missing artifact fields on ART-B1
- Statistical Validity: 40% [####......]
  - claim states no confidence value
  - 1/1 result(s) carry metrics
  - no result carries statistical_info
  - **To improve:** set a calibrated `confidence` on the claim; add p_value / confidence_interval / effect_size to the result(s)
- Pipeline Integrity: 86% [#########.]
  - 6/7 chain links present: motivation, rq, experiment_design, artifact, run, result
  - broken links: hypothesis
  - **To improve:** complete the lineage by adding: hypothesis

### 🟡 Medium credibility (1)

#### CLM-A3: Team A (exploratory): the effect is driven by salience, not by source quality

**Overall score**: 45.0%

> The reduction appears to come from the panel's mere presence interrupting the accept reflex, rather than from users reading the cited sources: acceptance fell about as much for sessions where no source link was opened.

*How: the evidence supports 100% and the claim only asserts 0.45 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 1 declared evidence id(s) are linked
- Reproducibility: 100% [##########]
  - RUN-A1 records commit, environment and duration
- Data Provenance: 100% [##########]
  - ART-A1 records path, version and type
  - ART-A2 records path, version and type
  - ART-A3 records path, version and type
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.45)
  - 1/1 result(s) carry metrics
  - 1 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

### 🟢 High credibility (2)

#### CLM-A1: Team A: the source panel reduces wrong-answer acceptance by ~2 pp

**Overall score**: 86.0%

> Showing retrieval sources inline reduces acceptance of incorrect assistant answers by 2.1 percentage points (34.1% -> 32.0%, 95% CI [-3.9, -0.3] pp, p = 0.031) over a 14-day exposure window.

*How: the evidence supports 100% and the claim only asserts 0.86 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 1 declared evidence id(s) are linked
- Reproducibility: 100% [##########]
  - RUN-A1 records commit, environment and duration
- Data Provenance: 100% [##########]
  - ART-A1 records path, version and type
  - ART-A2 records path, version and type
  - ART-A3 records path, version and type
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.86)
  - 1/1 result(s) carry metrics
  - 1 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

#### CLM-A2: Team A: Team B's large effect is a confounded release, not a panel effect

**Overall score**: 80.0%

> Team B's -11.4 pp figure is attributable to assistant model v4.2, which shipped two days into their observation window and accounts for -9.1 pp on its own. Controlling for model version leaves -1.8 pp (95% CI [-4.6, 1.0], p = 0.42), consistent with the randomised estimate of -2.1 pp. The panel works; it works about a fifth as well as claimed.

*How: the evidence supports 93% and the claim only asserts 0.80 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 2 declared evidence id(s) are linked
- Reproducibility: 73% [#######...]
  - RUN-A1 records commit, environment and duration
  - RUN-A2 records commit, environment and duration
  - RUN-B1 (Team B: notebook re-run, 2026-04-16) is missing git_commit, environment/random_seed
  - **To improve:** add the missing run metadata on RUN-B1
- Data Provenance: 87% [#########.]
  - ART-A1 records path, version and type
  - ART-A2 records path, version and type
  - ART-A3 records path, version and type
  - ART-A4 records path, version and type
  - ART-A5 records path, version and type
  - ART-B1 (Team B: ad-hoc BI query result (never exported)) is missing path, version
  - **To improve:** fill in the missing artifact fields on ART-B1
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.80)
  - 3/3 result(s) carry metrics
  - 2 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

---

## How the edges got there

| Origin | Edges | What it means |
|---|---|---|
| `manual` | 27 | declared explicitly by an agent or the SDK |

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
