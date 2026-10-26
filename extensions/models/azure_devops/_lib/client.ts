/**
 * Shared Azure DevOps REST client: PAT auth, JSON, retries with backoff, and
 * response shape checks. Used by every type in this extension.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Connection arguments every type shares. */
export const ConnectionArgsSchema = z.object({
  organization: z.string().min(1).describe(
    "Organization name (the `myorg` in dev.azure.com/myorg).",
  ),
  project: z.string().min(1).describe("Project name or id."),
  pat: z.string().min(1).meta({ sensitive: true }).describe(
    "Personal access token; the scopes each type needs are in the README.",
  ),
  baseUrl: z.string().url().default("https://dev.azure.com")
    .refine((u) => u.startsWith("https://"), {
      message: "baseUrl must use https; the token would be sent in clear text",
    })
    .describe("Service URL; change only for Azure DevOps Server."),
});

/** Resolved connection argument type. */
export type ConnectionArgs = z.infer<typeof ConnectionArgsSchema>;

/** Minimal fetch signature, so tests can inject a stub. */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const API_VERSION = "7.1";

/** The longest the client waits between retries, whatever `Retry-After` says. */
export const MAX_RETRY_DELAY_MS = 60_000;

/** Statuses worth retrying for reads and updates; creates (POST) retry only on 429. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** A failed Azure DevOps call. `status` is null for network errors. */
export class AdoError extends Error {
  /** Create an error for a failed call. */
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "AdoError";
  }
}

/** Called before each retry, so the caller can log it. */
export type RetryListener = (
  info: { method: string; path: string; reason: string; delayMs: number },
) => void;

/** Delay before retry `attempt` (0-based): `Retry-After` if given, else exponential; capped. */
export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
): number {
  const seconds = Number(retryAfter);
  const ms = seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_RETRY_DELAY_MS);
}

/** Wait `ms`, or reject as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `https://dev.azure.com/org/project`, each part URL-encoded. */
export function projectUrl(args: ConnectionArgs): string {
  return `${args.baseUrl.replace(/\/+$/, "")}/${
    encodeURIComponent(args.organization)
  }/${encodeURIComponent(args.project)}`;
}

/** REST client for every path under one root URL. */
export class AdoHttp {
  /** Create a client whose request paths are appended to `root`. */
  constructor(
    private readonly root: string,
    private readonly pat: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly maxRetries = 3,
    private readonly onRetry: RetryListener = () => {},
  ) {}

  /**
   * Call a path under the root with optional query and JSON body.
   * Reads and updates are retried on 429, 5xx, and network errors. Creates
   * (POST) are retried only on 429, which means the request was not applied,
   * so a retry never posts twice. With `shape`, the response is checked for
   * the fields the caller relies on.
   */
  async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
    signal?: AbortSignal,
    shape?: z.ZodType,
  ): Promise<T> {
    const url = new URL(`${this.root}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("api-version", API_VERSION);
    for (let attempt = 0;; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url.toString(), {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Basic ${btoa(`:${this.pat}`)}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (
          signal?.aborted || method === "POST" || attempt >= this.maxRetries
        ) {
          throw new AdoError(
            `Azure DevOps ${method} ${path} failed: network error: ${reason}`,
            null,
          );
        }
        await this.backoff(
          attempt,
          null,
          `network error: ${reason}`,
          method,
          path,
          signal,
        );
        continue;
      }
      const retryable = method === "POST"
        ? res.status === 429
        : RETRYABLE_STATUSES.has(res.status);
      if (retryable && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.backoff(
          attempt,
          res.headers.get("Retry-After"),
          `HTTP ${res.status}`,
          method,
          path,
          signal,
        );
        continue;
      }
      // A wrong or expired PAT gets a 203 sign-in page instead of a 401.
      const type = res.headers.get("Content-Type") ?? "";
      if (!res.ok || !type.includes("json")) {
        const text = (await res.text()).slice(0, 300);
        throw new AdoError(
          `Azure DevOps ${method} ${path} failed: ${res.status}${
            type.includes("json") ? "" : " (not JSON; check the token)"
          } ${text}`,
          res.status,
        );
      }
      const json = await res.json();
      if (shape) {
        const checked = shape.safeParse(json);
        if (!checked.success) {
          throw new AdoError(
            `Azure DevOps ${method} ${path} returned an unexpected response: ${
              checked.error.issues.slice(0, 3).map((i) =>
                `${i.path.join(".") || "(root)"}: ${i.message}`
              ).join("; ")
            }`,
            res.status,
          );
        }
      }
      return json as T;
    }
  }

  private async backoff(
    attempt: number,
    retryAfter: string | null,
    reason: string,
    method: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const delayMs = retryDelayMs(attempt, retryAfter);
    this.onRetry({ method, path, reason, delayMs });
    await sleep(delayMs, signal);
  }
}

/** The logger and signal every method context provides. */
export interface BaseContext {
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

/** Retry listener that logs each retry as a warning. */
export function logRetries(ctx: BaseContext): RetryListener {
  return (r) =>
    ctx.logger.warning(
      "Azure DevOps {method} {path} failed ({reason}); retrying in {delayMs} ms",
      r,
    );
}
