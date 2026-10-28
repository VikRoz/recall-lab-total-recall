# Recall Lab and verified memory for Sui data agents

28 October 2026

An agent choosing a data service needs more than a catalog. The catalog may say that a service supplies a required field, while a previous verified result shows that the field was missing. The useful question is whether the agent can recover that experience in a new session, apply it to the right task, and stop applying an old failure after a verified correction.

Recall Lab explores that question with controlled Sui data projections. Tatum supplies Mainnet checkpoint data. An owned projection deliberately omits or changes a field so that an ordinary verifier can identify the problem. Walrus Memory stores the observation and later corrections on Mainnet. A model receives the relevant verified experience alongside the task and catalog. The project also uses simple deterministic rules as a comparison.

The injected faults belong to the demo. They are not reports of real failures by Tatum or independent vendors. Two stored history examples are explicitly synthetic. All ten memory records were actually written to Mainnet and confirmed by independent clients using the same account.

## A fact that changed one decision

In the main task, the agent needs both digest and sequenceNumber. Atlas advertises those fields but its controlled projection omits digest. Without history, the current Llama 3.1 8B/V1 run selected Atlas and failed verification. With the verified failure in context, it selected Beacon and passed. The model declared the actual failure record, and the citation auditor classified that reference as supported.

We compared four conditions: no history, direct verified facts, the same facts restored from saved memory, and a deterministic selector. The scenario contains three related points: repeating the original task, changing the required fields, and using an explicitly repaired projection after a correction.

| Point | No history | Direct facts | Restored memory | Deterministic rules |
| --- | --- | --- | --- | --- |
| Repeat the required digest task | Atlas, fail | Beacon, pass | Beacon, pass | Beacon, pass |
| Digest is no longer required | Atlas, pass | Atlas, pass | Atlas, pass | Atlas, pass |
| After verified correction | Atlas, pass | Atlas, pass | Atlas, pass | Atlas, pass |

These are three known development points, not a statistical benchmark. Direct facts and restored memory produce identical requests and share the same answer. The irrelevant-field point also shares an answer across the three model conditions. Nine displayed branches therefore use five unique model calls.

The result supports a narrow observation: in this run, a verified fact changed a useful choice in the main task. It does not establish that an LLM outperforms a simple algorithm. The deterministic selector passed all three points too. An earlier 8B pilot selected the failing Atlas projection with and without memory; that negative result remains part of the evidence.

## Corrections without deleting history

Ten saved records form five parent and correction pairs. A correction supersedes its parent within the same scope, and only after its recorded cutoff. A fresh client verifies the expected blobs, record hashes and revision continuity before using the active facts.

The first Atlas correction was checked with a new independent client. Four additional pairs cover a missing field, a corrupted field, deliberately stale data and synthetic reference-version uncertainty. The source data and fault types remain visible in the demo.

A pass record does not repair service code. A local control using the old broken projection still fails or remains unknown even after the correction is in memory. That distinction keeps an optimistic memory from becoming an invented service guarantee.

## References and execution checks are separate

The model's declared memory IDs, the verifier's result and the controller's admission decision are separate outputs. Blocking an unsafe proposal does not turn the proposal into a successful model decision. The controller does not buy a substitute or make another model call.

After correction, the current model selected the repaired Atlas projection and cited the active correction record. The result passed, but the pass citation remains unverifiable under the current observation contract. We kept that limitation instead of changing the auditor to produce a better score.

## A reproducible view of saved evidence

The prepared demo presents saved real model responses, receipts and memory reads. It recomputes checks locally and labels the page as replay throughout. Viewing it makes no inference, Tatum, Walrus or payment calls. The page includes the ten records, five correction chains, raw responses, a JSON export and a package verifier.

The historical integrations and the five-call diagnostic used free or sponsored resources at zero additional spend. Service prices shown in the scenario are demo credits, not real financial savings.

Recall Lab demonstrates a bounded way to retain and revise verified experience across sessions. The useful result is inspectable memory and a decision that can be checked against it. General model reliability, cross-account portability and an advantage over deterministic rules remain open questions.
