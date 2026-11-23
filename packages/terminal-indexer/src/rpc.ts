// One JSON-RPC call to the Solana RPC. The RPC's URL carries its key, so no error made here ever
// quotes the URL: it names the method and what went wrong.

/** A refusal from the RPC, or an answer that was not one. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code: number | null = null,
  ) {
    super(`RPC ${method} failed: ${message}`);
  }

  /** The RPC has no such method, as an RPC without Helius's own methods says of them. */
  get methodMissing(): boolean {
    return this.code === -32601;
  }
}

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal });
  } catch (e) {
    throw new RpcError(method, `no answer (${e instanceof Error ? e.name : typeof e})`);
  }
  if (!response.ok) throw new RpcError(method, `HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { result?: T; error?: { code?: number; message?: string } } | null;
  if (!body) throw new RpcError(method, "an answer that is not JSON");
  if (body.error) throw new RpcError(method, body.error.message ?? "refused", body.error.code ?? null);
  return body.result as T;
}
