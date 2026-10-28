# Recall Lab

Verified experience for agents choosing controlled Sui data projections, using real Tatum Mainnet data and Walrus Memory Mainnet records.

- **Demo:** https://recall-lab-evidence-20261028.mightytoast34.chatgpt.site
- **Article:** https://recall-lab-evidence-20261028.mightytoast34.chatgpt.site/blog.html
- **License:** [MIT](LICENSE)

The website presents saved real responses and receipts with a permanent replay label. Viewing it makes no provider API calls. It is a controlled prototype, not an independent vendor marketplace or a live trading system.

## Reproduce without credentials

Use Node.js 22 with TypeScript stripping. The offline checks were run on 22.23.1; 22.23.4 or newer meets the documented optional SDK prerequisite. No dependency installation is needed for the saved-evidence build.

```sh
npm run build:published-site
node dist/published-site-v1/verify.mjs
npm test
npm run check
```

Open `dist/published-site-v1/index.html` for the demo and `blog.html` for the article. The package is self-contained. `build:public-demo` and `demo:rehearse` preserve earlier offline presentations. `node verify-source.mjs` checks the current source snapshot before edits; Git metadata and local runtime/dependency directories are excluded.

The pinned dependencies in package-lock.json are for optional provider SDK work. Without them, two SDK integration checks are explicitly skipped. Installing SDKs or making real provider calls requires separately authorized setup and quotas. Historical permits do not authorize more calls. `doctor` returns BLOCKED without live credentials, as expected.

## What was actually observed

Ten real Mainnet memory records form five observation/correction pairs. Independent clients of the same account previously verified blobs, record hashes, revisions and cutoff. Two history records are explicitly synthetic; the other faults are injected into owned projections of Tatum data, not real vendor failures.

The current Llama 3.1 8B/V1 diagnostic has three known points and four conditions:

| Point | No history | Direct facts | Restored memory | Rules |
| --- | --- | --- | --- | --- |
| Digest required | Atlas fail | Beacon pass | Beacon pass | Beacon pass |
| Digest no longer required | Atlas pass | Atlas pass | Atlas pass | Atlas pass |
| After correction | Atlas pass | Atlas pass | Atlas pass | Atlas pass |

Five unique calls supply nine logical branches. Direct facts/restored memory have identical requests and share answers. The main failure citation is supported; the correction pass citation is unverifiable. An earlier 8B pilot failed with and without memory. General LLM superiority, stability and cross-account portability are not established. Demo credits are not real payments or measured financial savings.

## Implementation and evidence

- `src/agent.ts`, `memory.ts`, `projection-policy.ts`, `citations.ts`: scoped facts, deterministic checks, admission and separate citation audit.
- `src/providers/`: actual adapters. The verified operator runtime uses Node and SQLite; the browser package has no backend.
- `evidence/`: saved public JSON including raw model responses, real memory receipts and the negative pilot.
- `scripts/build-published-site.ts`: reproducible static demo/article over the existing evaluator and fresh local evidence-verification process.
- `public-demo/BLOG.en.md`: approved article source.
- `test/`: tests; `dist/published-site-v1`: portable static artifacts and verifier.

See [architecture](docs/PUBLIC_ARCHITECTURE.md) and [results](docs/RESULTS.md). The model, raw verifier and controller traces remain separate. A guard block does not count as successful model reasoning. No automatic substitute, repeated model call or invented citation repairs a bad answer.

## Scope and disclosure

AI assistance was used for implementation, testing and documentation. Interface styles are authored and use system fonts; no external images or UI libraries are loaded. Third-party SDK dependencies keep their own licenses; their implementation is not bundled here.

Runtime credentials, databases/logs, operator host launchers and private infrastructure identifiers are excluded. `.env.example` contains empty fields only. No wallet signing, real purchases, Worker/D1 application, guest writes or general marketplace is claimed. Never reset a real attempt to obtain a preferred result. Submission links and an accepted hackathon application are separate from this repository.
