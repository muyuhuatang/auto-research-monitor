# Newsroom investigation — Port Meridian snow contracts — evidence report

*Generated 2026-10-28 17:43 UTC by Auto-Research Monitor.*

- **Nodes:** 28  
- **Edges:** 33  
- **Claims scored:** 3 (1 green, 1 yellow, 1 red)

---

## Conclusion

*No conclusion has been generated for this task yet.*

---

## Findings

Each finding clusters a set of results; its credibility is the mean of the distinct claims those results support.

| Finding | Credibility | Claims | Results |
|---|---|---|---|
| `CONC-001` Filed: Port Meridian's snow emergencies cost more and snowed less | 🟡 72% (yellow) | 2 | 2 |

---

## Claim credibility

### 🔴 Low credibility (1)

#### CLM-002: A former clerk says vendors were chosen before bids were opened

**Overall score**: 35.0%

> A former Public Works contracts clerk says she was told in advance of bid opening which vendor would receive a given winter award. The Ledger could not corroborate this account: no second witness came forward, the bid-opening sign-in sheets were withheld, and the ethics disclosures returned no responsive documents.

*How: the evidence supports 37% and the claim only asserts 0.35 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 76% [########..]
  - no upstream result, run node(s)
  - all 1 declared evidence id(s) are linked
  - **To improve:** add the missing upstream node type(s): result, run
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
- Pipeline Integrity: 57% [######....]
  - 4/7 chain links present: motivation, rq, hypothesis, experiment_design
  - broken links: artifact, run, result
  - **To improve:** complete the lineage by adding: artifact, run, result

### 🟡 Medium credibility (1)

#### CLM-003: About a fifth of snow emergencies were declared below the legal trigger

**Overall score**: 58.0%

> On the four winters the city released, 96 of 431 emergency declarations (22.3%) were filed on days when the state gauge recorded less than the 4.0 inches that Municipal Code § 14-330 requires; the median accumulation on those days was 1.8 inches. Two winters, including the heaviest in the period, were withheld, so this share cannot be projected across the full six-year window.

*How: the evidence supports 78% and the claim only asserts 0.58 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 1 declared evidence id(s) are linked
- Reproducibility: 30% [###.......]
  - RUN-003 (Manual double-entry pass: declarations vs snowfall) is missing git_commit, duration_seconds
  - **To improve:** add the missing run metadata on RUN-003
- Data Provenance: 85% [########..]
  - ART-005 (Emergency declaration log, winters 2019-25 (scanned)) is missing version
  - ART-006 records path, version and type
  - **To improve:** fill in the missing artifact fields on ART-005
- Statistical Validity: 70% [#######...]
  - claim quantifies its confidence (0.58)
  - 1/1 result(s) carry metrics
  - no result carries statistical_info
  - **To improve:** add p_value / confidence_interval / effect_size to the result(s)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

### 🟢 High credibility (1)

#### CLM-001: Port Meridian overpaid ~31% and concentrated the work in three vendors

**Overall score**: 85.0%

> Over six winters Port Meridian paid a median $1,551 per lane-mile-event for emergency snow clearing against a peer-city median of $1,180 — a 31.4% premium (95% CI 24.1-38.9%, p=0.0004), or roughly $4.8m in excess spending. Sixty-eight per cent of that emergency work went to three vendors. Every contract was double-coded by two reporters (kappa 0.93) and 98.8% were confirmed against the state contract registry.

*How: the evidence supports 100% and the claim only asserts 0.85 — calibrated, so the stated confidence stands.*

**Dimension scores:**

- Evidence Coverage: 100% [##########]
  - all five expected upstream node types are present
  - all 1 declared evidence id(s) are linked
- Reproducibility: 100% [##########]
  - RUN-001 records commit, environment and duration
- Data Provenance: 100% [##########]
  - ART-001 records path, version and type
  - ART-002 records path, version and type
  - ART-003 records path, version and type
  - ART-004 records path, version and type
- Statistical Validity: 100% [##########]
  - claim quantifies its confidence (0.85)
  - 1/1 result(s) carry metrics
  - 1 result(s) carry statistical_info (p-value / CI / effect size)
- Pipeline Integrity: 100% [##########]
  - 7/7 chain links present: motivation, rq, hypothesis, experiment_design, artifact, run, result

---

## How the edges got there

| Origin | Edges | What it means |
|---|---|---|
| `manual` | 31 | declared explicitly by an agent or the SDK |
| `convergence` | 2 | clustered into a finding by the convergence pass |

**2 of 33 edges were inferred rather than declared.** Credibility scores rest partly on these.

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
