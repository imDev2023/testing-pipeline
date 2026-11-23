// Aviary's web app is a pure client of the API (PIPESCOPE-38): every panel reads through here.
import { ApiError, Refusal, type Failure } from "terminal-api/contract";
import type { z } from "zod";
import { API_URL } from "./config";

/** A read that failed, with the sentence to show: the API's own when it gave one. */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** A refusal from a strategy or the chain, decoded, with its raw error. */
    readonly failure: Failure | null = null,
    /** The program's log lines, when the refusal came from a simulation. */
    readonly logs: readonly string[] = [],
  ) {
    super(message);
  }
}

/** GETs `path` from the API and checks the answer against its contract. Answers with a body the contract accepts are returned even when not 2xx, as /health's 503 is. */
export async function getFromApi<T extends z.ZodType>(path: string, schema: T, init?: { acceptStatuses?: number[]; signal?: AbortSignal }): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { signal: init?.signal, cache: "no-store" });
  } catch {
    throw new ApiFailure("Aviary's API did not answer.", null);
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok || init?.acceptStatuses?.includes(response.status)) {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    throw new ApiFailure("Aviary's API answered with something this page does not understand.", response.status);
  }
  throw refusalOf(body, response.status);
}

/** An answer that is not 2xx as the failure to show: the API's own sentence, and the decoded failure when it gave one. */
function refusalOf(body: unknown, status: number): ApiFailure {
  const decoded = Refusal.safeParse(body);
  if (decoded.success) return new ApiFailure(decoded.data.error, status, decoded.data.failure, decoded.data.logs ?? []);
  const refusal = ApiError.safeParse(body);
  return new ApiFailure(refusal.success ? refusal.data.error : `Aviary's API answered ${status}.`, status);
}

/** POSTs `body` as JSON to `path` and checks the answer against its contract. */
export async function postToApi<T extends z.ZodType>(path: string, body: unknown, schema: T, init?: { signal?: AbortSignal }): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: init?.signal, cache: "no-store" });
  } catch {
    throw new ApiFailure("Aviary's API did not answer.", null);
  }
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok) throw refusalOf(answer, response.status);
  const parsed = schema.safeParse(answer);
  if (parsed.success) return parsed.data;
  throw new ApiFailure("Aviary's API answered with something this page does not understand.", response.status);
}
