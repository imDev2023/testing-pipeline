// Aviary's web app is a pure client of the API (PIPESCOPE-38): every panel reads through here.
import { ApiError } from "terminal-api/contract";
import type { z } from "zod";
import { API_URL } from "./config";

/** A read that failed, with the sentence to show: the API's own when it gave one. */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number | null,
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
  const refusal = ApiError.safeParse(body);
  throw new ApiFailure(refusal.success ? refusal.data.error : `Aviary's API answered ${response.status}.`, response.status);
}
