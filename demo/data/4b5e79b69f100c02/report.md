# Churn GBDT — clean split vs leaked split — evidence report

*Generated 2026-10-28 17:43 UTC by Auto-Research Monitor.*

- **Nodes:** 14  
- **Edges:** 14  
- **Claims scored:** 2 (1 green, 0 yellow, 1 red)

---

## Conclusion

*No conclusion has been generated for this task yet.*

---

## Claim credibility

### 🔴 Low credibility (1)

#### CLM-LEAK-001: Model reaches 0.994 AUC — near-perfect churn discrimination

**Overall score**: 27.1%

> The churn model achieves 0.994 AUC and 0.981 PR-AUC on the test partition, 9.6x lift in the top decile. This is near-perfect discrimination and the model is ready to ship to the retention workflow.

*How: no confidence stated, so the structural score 68% was multiplied by 0.40.*

**Dimension scores:**

- Evidence Coverage: 88% [#########.]
  - no upstream experiment_design node(s)
  - all 1 declared evidence id(s) are linked
  - **To improve:** add the missing upstream node type(s): experiment_design
- Reproducibility: 50% [#####.....]
  - RUN-LEAK-001 (Ad-hoc re-run — row-level split, holdout contaminated) is missing git_commit
  - **To improve:** add the missing run metadata on RUN-LEAK-001
- Data Provenance: 70% [#######...]
  - ART-SPLIT-LEAK-001 (merged_train_plus_holdout.parquet (ad-hoc notebook re-split)) is missing version
  - **To improve:** fill in the missing artifact fields on ART-SPLIT-LEAK-001
- Statistical Validity: 40% [####......]
  - claim states no confidence value
  - 1/1 result(s) carry metrics
  - no result carries statistical_info
  - **To improve:** set a calibrated `confidence` on the claim; add p_value / confidence_interval / effect_size to the result(s)
- Pipeline Integrity: 86% [#########.]
  - 6/7 chain links present: motivation, rq, hypothesis, artifact, run, result
  - broken links: experiment_design
  - **To improve:** complete the lineage by adding: experiment_design

### 🟢 High credibility (1)

#### CLM-CLEAN-001: GBDT beats the tenure heuristic by ~7 AUC points on unseen accounts

**Overall score**: 82.0%

> On 4,812 accounts the model never saw, the GBDT reaches 0.784 AUC against the tenure heuristic's 0.710 — a 0.074 gain, 95% CI [0.762, 0.806], p = 0.0004. That clears the 0.05 AUC bar in HYP-001 and is enough to reallocate save-offer budget by predicted risk.

*How: the evidence supports 100% and the claim only asserts 0.82 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 1 declared evidence id(s) are linked
- Reproducibility: 100% [##########]
  - RUN-CLEAN-001 records commit, environment and duration
- Data Provenance: 100% [##########]
  - ART-SPLIT-CLEAN-001 records path, version and type
  - ART-TRAIN-CODE-001 records path, version and type
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.82)
  - 1/1 result(s) carry metrics
  - 1 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

---

## How the edges got there

| Origin | Edges | What it means |
|---|---|---|
| `manual` | 14 | declared explicitly by an agent or the SDK |

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
