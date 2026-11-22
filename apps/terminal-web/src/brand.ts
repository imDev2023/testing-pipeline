// The brand module (docs/spec/README.md, Names; PIPESCOPE-85): the public name, the address and the
// fee label, the only place in code that carries them. Code identifiers stay `terminal-*` (SUITE-24),
// so a rename changes this file alone.
export const BRAND = {
  name: "Aviary",
  address: "aviary.trade",
  feeLabel: "Aviary fee",
} as const;
