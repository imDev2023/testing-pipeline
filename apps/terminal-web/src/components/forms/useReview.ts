"use client";

import { useCallback, useRef, useState } from "react";
import { ApiFailure } from "@/api";
import { confirmTransaction, failureOf, type Prepared, type ReviewState } from "./TransactionReview";

/**
 * A review's steps, as the trade box keeps them (docs/spec/pipescope-screens.md, Review and sign): each
 * review is one generation, and an answer for an earlier one (a build still on its way when a field
 * changed, or another wallet's) is thrown away, so only what is on screen can be signed. A change of
 * the form's values (`version`) or of the wallet leaves the review.
 */
export function useReview<P extends Prepared>({
  prepare,
  about,
  version,
  trader,
  onConfirmed,
}: {
  prepare: () => Promise<P>;
  about: { market?: string; strategy?: string };
  version: number;
  trader: string | null;
  onConfirmed?: (prepared: P, slot: number) => void;
}) {
  // A review belongs to the values and wallet it was built for: once either changes it is left, and
  // an answer still on its way for the earlier ones is kept under their key, so it is never shown.
  const key = `${version}:${trader ?? ""}`;
  const [held, setHeld] = useState<{ key: string; review: ReviewState<P> } | null>(null);
  const review = held && held.key === key ? held.review : null;
  const generation = useRef(0);
  const setReview = useCallback((next: ReviewState<P> | null | ((current: ReviewState<P> | null) => ReviewState<P> | null), at = key) =>
    setHeld((current) => {
      const before = current && current.key === at ? current.review : null;
      const value = typeof next === "function" ? next(before) : next;
      return value === null ? null : { key: at, review: value };
    }), [key]);

  const build = useCallback(
    async (rebuilt: boolean) => {
      const mine = ++generation.current;
      const at = key;
      setReview({ status: "building", rebuilt }, at);
      try {
        const prepared = await prepare();
        if (mine !== generation.current) return;
        setReview(prepared.simulation.ok && prepared.transaction ? { status: "ready", prepared, at: Date.now(), rebuilt, walletNote: null } : { status: "failed", prepared }, at);
      } catch (e) {
        if (mine === generation.current) setReview({ status: "error", message: failureOf(e), failure: e instanceof ApiFailure ? e.failure : null, logs: e instanceof ApiFailure ? e.logs : [] }, at);
      }
    },
    [prepare, key, setReview],
  );

  const settle = useCallback(
    async (prepared: P, signature: string) => {
      const mine = generation.current;
      const at = key;
      setReview({ status: "sent", prepared, signature }, at);
      try {
        const report = await confirmTransaction(signature, about);
        if (mine === generation.current) setReview({ status: "confirmed", prepared, signature, slot: report.slot }, at);
        onConfirmed?.(prepared, report.slot);
      } catch (e) {
        if (mine === generation.current) setReview({ status: "unsettled", prepared, signature, message: failureOf(e), failure: e instanceof ApiFailure ? e.failure : null }, at);
      }
    },
    [about, onConfirmed, key, setReview],
  );

  const leave = useCallback(() => {
    generation.current++;
    setReview(null);
  }, [setReview]);

  return {
    review,
    start: () => void build(false),
    handlers: {
      onBack: leave,
      onRebuild: () => void build(true),
      onSigning: () => setReview((r) => (r && r.status === "ready" ? { status: "signing", prepared: r.prepared, at: r.at } : r)),
      onDeclined: (note: string) => setReview((r) => (r && (r.status === "signing" || r.status === "ready") ? { status: "ready", prepared: r.prepared, at: r.at, rebuilt: false, walletNote: note } : r)),
      onSent: (prepared: P, signature: string) => void settle(prepared, signature),
    },
  };
}
