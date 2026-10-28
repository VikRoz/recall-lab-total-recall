# Recall Lab implementation

28 October 2026.

The operator runtime is Node.js with SQLite journals. Provider effects are reserved before execution, and uncertain outcomes stop the bounded plan. Tatum supplies latest and pinned Sui Mainnet checkpoint data. The verifier compares controlled projection fields against the saved reference. This uses one Tatum source, not an independent external oracle.

Walrus Memory stores observations and corrections. Memory loading validates expected blobs, record hashes, namespace completeness, revisions and cutoff before filtering facts for a task. A correction supersedes a parent within the same scope. The controller can block a known required-field failure for an owned projection; it does not silently replace the selected service or repeat a model call. Model citations and controller evidence are separate.

The browser demo is a static projection of saved evidence. Its build reuses the existing rehearsal and evaluator to check ten records, five correction chains and the model report. A new local process verifies saved inputs without writer credentials. That local process is not a new remote recall. The page carries a replay label and has CSP connect-src none, no external assets and no live endpoints.

`src/agent.ts`, `memory.ts`, `projection-policy.ts` and `citations.ts` implement the core contracts. `src/providers/` contains the provider adapters. `scripts/build-public-demo.ts` uses the original saved-evidence checks. `src/public-demo.ts` validates the projection, and `public-demo/` supplies the local interaction code and styles.

No Workers/D1 application deployment, user authentication, guest writes, wallet execution, real purchases or independent marketplace is implied. Exposing live endpoints would require a separate design and authorization; the static package does not provide that permission.
