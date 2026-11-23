// The explainer's rules module (EXPLAINER-21; docs/spec/pipescope-explainer.md, "One place for every
// value"): the one place its values live, imported by `terminal-api`, the approve command and the
// tests. This ticket (#119) brings the caps on author text; the banned terms, the length limits, the
// prompt version and the model's id join with the explainer jobs (#126).

/**
 * The most characters (Unicode code points) of each kind of author text Aviary keeps, after
 * control and text-direction characters are stripped (EXPLAINER-08): a strategy's or a token's name;
 * a description, which caps the strategy's own and every other description in it (the create form's,
 * an argument's); a label, which caps every label and tag; and a token's symbol (PIPESCOPE-122),
 * short enough to sit beside its short address in a table row.
 */
export const AUTHOR_TEXT_CAPS = { name: 64, description: 600, label: 64, symbol: 16 } as const;
