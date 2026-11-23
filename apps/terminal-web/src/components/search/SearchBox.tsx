"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SearchResults } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { SEARCH_PAUSE_MS, SEARCH_RESULTS_PER_GROUP } from "@/config";
import { ROUTES } from "@/routes";
import { SearchHelp, SearchResultsView } from "./SearchResults";
import styles from "./SearchBox.module.css";

type Found = { query: string } & ({ status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; results: SearchResults });

/** One search through the API: the first SEARCH_RESULTS_PER_GROUP of each group. */
export const searchApi = (query: string, signal?: AbortSignal) => getFromApi(`/v1/search?q=${encodeURIComponent(query)}&limit=${SEARCH_RESULTS_PER_GROUP}`, SearchResults, { signal });

/**
 * The search box in the header of every page (docs/spec/pipescope-screens.md, Search; PIPESCOPE-81):
 * results appear beneath it as the reader types, SEARCH_PAUSE_MS after the last keystroke, and Enter
 * opens the search page, whose address holds the query. With nothing typed it says what can be
 * searched for, with three examples. Escape, a click elsewhere or a result picked closes it.
 */
export function SearchBox() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const onSearchPage = pathname === "/search";
  const [text, setText] = useState(() => (onSearchPage ? (params.get("q") ?? "") : ""));
  // Open on the page it was opened on: moving to another page closes it.
  const location = `${pathname}?${params.toString()}`;
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === location;
  const setOpen = (value: boolean) => setOpenOn(value ? location : null);
  const [found, setFound] = useState<Found | null>(null);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLFormElement>(null);
  const id = useId();
  const query = text.trim();

  // A search runs once the reader pauses; one typed over is dropped.
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setFound((last) => (last?.query === query && last.status === "loaded" ? last : { query, status: "loading" }));
      searchApi(query, controller.signal).then(
        (results) => setFound({ query, status: "loaded", results }),
        (e: unknown) => {
          if (!controller.signal.aborted) setFound({ query, status: "failed", message: e instanceof ApiFailure ? e.message : "Something went wrong." });
        },
      );
    }, SEARCH_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, attempt]);

  // A click or a focus outside closes it.
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpenOn(null);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!query) return;
    setOpen(false);
    router.push(ROUTES.search(query));
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  const close = () => setOpen(false);
  const current = found && found.query === query ? found : null;
  return (
    <form ref={root} role="search" action="/search" className={styles.search} onSubmit={submit} onKeyDown={keyDown}>
      <label htmlFor={`${id}-q`} className={styles.label}>
        Search
      </label>
      <input
        id={`${id}-q`}
        className={styles.input}
        type="search"
        name="q"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search strategies, markets and mints"
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        aria-controls={`${id}-results`}
        aria-expanded={open}
      />
      {open && (
        <section id={`${id}-results`} className={styles.popover} aria-label="Search results" aria-busy={current?.status === "loading" || (!!query && !current)}>
          {!query ? (
            <SearchHelp onPick={close} />
          ) : !current || current.status === "loading" ? (
            <p className={styles.note}>Searching…</p>
          ) : current.status === "failed" ? (
            <div className={styles.failed} role="alert">
              <p>Could not search. {current.message}</p>
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          ) : (
            <SearchResultsView results={current.results} heading="h3" onPick={close} />
          )}
        </section>
      )}
    </form>
  );
}
