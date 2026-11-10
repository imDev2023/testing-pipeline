# Explainer samples (prototype, never merged)

Throwaway prototype for [Explainer samples for the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/15).
It answers one question: what Pipescope's explainer should say, in what tone and at what length, and whether it can be kept accurate.
The decisions it settled live in `docs/spec/pipescope-explainer.md` on `main`; this branch keeps the evidence.

## What is here

- `index.html`: the samples page, one self-contained file; open it in a browser.
  Five tabs: the four devnet strategies and a hostile-metadata fixture.
  The pill at the bottom (or the arrow keys) switches between three presentations: A short first, B sections, C ledger.
  The page also shows the facts panel, the validator's result and the exact model input and output for each sample.
- `prompt.md`: the system prompt and output schema production would send (`explainer-v0`).
- `data.js`: the evidence for each sample and the model output, written by hand in the session by following `prompt.md`; no model was called.
- `logic.js`: the validator production would run on every model output before showing it, and the author-text normaliser.
- `check.mjs`: runs the validator on every sample, as CI would on recorded outputs; the samples must pass and the fooled draft must fail.
- `devnet-facts-2026-11-09.md`: every chain fact behind the four samples, read on devnet on 2026-11-09 between 08:38 and 09:01 UTC (Helius free tier, read-only), with its source.
- `template.html`, `app.js`, `build.mjs`: the page's parts; `node build.mjs` rebuilds `index.html` from them.

## Run it

```sh
cd prototype/explainer-samples
node check.mjs      # validator on every sample
node build.mjs      # rebuild index.html after editing data.js, logic.js, app.js or template.html
open index.html
```

## Verdict (owner, 2026-11-10)

- Presentation A, short first: the summary, then the open questions, with the full list of points one click away.
- Tone and length right as written: a summary of at most 70 words, at most 14 one-sentence points and at most 6 unknowns, in neutral wording.
- Model: Claude Haiku 5.5.
- Paid calls: an approval queue; the owner approves pending explanations in one go.

## What it showed

- None of the four devnet strategies has metadata, an IDL or a verified build, so their samples rest on chain facts, observed transactions and read-only probes; that is what the explainer can honestly say about them today.
- The validator caught a real error in a hand-written sample: the outside builder's key shortened as `FWbh...vKrq` instead of `FWbh...vrKq`.
- The fooled draft (a model that obeyed the hostile metadata) fails 13 checks, and Pipescope's own detector still raises the AI-addressed notice when the model does not.
