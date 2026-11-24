import { Fragment } from "react";

/**
 * A sentence the API wrote, with the identifiers it marks in backticks ("Check `exit_sizes`: ...",
 * "calls `pipeline_market_info`") set as code, as the screens set every identifier.
 */
export function CodeText({ children }: { children: string }) {
  return (
    <>
      {children.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

/** What a check does, from its "Check `id`: what it does." sentence, without the check's id, which its plain name stands for. */
export function whatItDoes(about: string): string {
  const rest = about.replace(/^Check `[^`]+`:\s*/, "");
  return rest[0]!.toUpperCase() + rest.slice(1);
}
