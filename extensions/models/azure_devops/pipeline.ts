/**
 * Azure DevOps YAML pipelines for swamp. List pipelines, preview a run's
 * final YAML without running it, queue a run with runtime parameters, and
 * follow a run stage by stage, including stages waiting on an approval.
 *
 * Authenticate with a personal access token (Build: Read & Execute), usually
 * supplied from a vault: `pat: ${{ vault.get(default, ADO_PIPELINES_PAT) }}`.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  AdoError,
  AdoHttp,
  type BaseContext,
  ConnectionArgsSchema,
  type FetchFn,
  logRetries,
  projectUrl,
  type RetryListener,
  sleep,
} from "./_lib/client.ts";

export { AdoError, type FetchFn } from "./_lib/client.ts";

/** Most pipelines `list` reads in one call. */
export const MAX_PIPELINES = 1000;

/** Global arguments shared by every method. The token needs Build (Read & Execute). */
export const GlobalArgsSchema = ConnectionArgsSchema;

/** Resolved global argument type. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One pipeline in the project. */
export const PipelineSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  folder: z.string(),
  revision: z.number().int().nullable(),
  url: z.string().describe("Web URL of the pipeline."),
});

/** The project's pipelines (`pipelines`). */
export const PipelineListSchema = z.object({
  pipelines: z.array(PipelineSchema),
  truncated: z.boolean().describe(
    `True when the project has more than ${MAX_PIPELINES} pipelines and only the first ${MAX_PIPELINES} were read.`,
  ),
  listedAt: z.string(),
});

/** One stage of a run, from the build timeline. */
export const StageSchema = z.object({
  name: z.string(),
  identifier: z.string().nullable(),
  state: z.string().describe("pending, inProgress, or completed."),
  result: z.string().nullable().describe(
    "succeeded, succeededWithIssues, failed, canceled, skipped, or abandoned; null until completed.",
  ),
  startTime: z.string().nullable(),
  finishTime: z.string().nullable(),
  waitingForApproval: z.boolean().describe(
    "True while an approval check on this stage is waiting for someone.",
  ),
});

/** Stage type. */
export type Stage = z.infer<typeof StageSchema>;

/** A run snapshot (`run-<runId>`, and `latest-<pipelineId>` for the newest run queued). */
export const RunSchema = z.object({
  id: z.number().int(),
  name: z.string().describe("Run (build) number."),
  pipelineId: z.number().int(),
  pipelineName: z.string(),
  url: z.string().describe("Web URL of the run."),
  state: z.string().describe("unknown, inProgress, canceling, or completed."),
  result: z.string().nullable().describe(
    "succeeded, failed, or canceled; null until completed.",
  ),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  templateParameters: z.record(z.string(), z.string()),
  createdDate: z.string(),
  finishedDate: z.string().nullable(),
  stages: z.array(StageSchema),
  stagesIncluded: z.boolean().describe(
    'False when the timeline was not available yet; `stages` is then empty, not "no stages".',
  ),
  waitingForApproval: z.boolean().describe(
    "True while any stage waits on an approval.",
  ),
  fetchedAt: z.string(),
});

/** Run snapshot type. */
export type Run = z.infer<typeof RunSchema>;

/** A pipeline's most recent runs, newest first, without stages (`runs-<pipelineId>`). */
export const RunListSchema = z.object({
  pipelineId: z.number().int(),
  runs: z.array(RunSchema),
  listedAt: z.string(),
});

/** The final YAML a run would use (`preview-<pipelineId>`). */
export const PreviewSchema = z.object({
  pipelineId: z.number().int(),
  branch: z.string().nullable(),
  templateParameters: z.record(z.string(), z.string()),
  finalYaml: z.string(),
  previewedAt: z.string(),
});

/** Required fields of the responses the extension reads. */
const RawPipelineShape = z.object({ id: z.number(), name: z.string() });
const RawPipelineListShape = z.object({ value: z.array(RawPipelineShape) });
const RawRunShape = z.object({
  id: z.number(),
  state: z.string(),
  createdDate: z.string(),
});
const RawRunListShape = z.object({ value: z.array(RawRunShape) });
const RawPreviewShape = z.object({ finalYaml: z.string() });
const RawTimelineShape = z.object({
  records: z.array(z.object({ id: z.string(), type: z.string() })),
});

interface RawPipeline {
  id: number;
  name: string;
  folder?: string;
  revision?: number;
  _links?: { web?: { href?: string } };
}

interface RawRun {
  id: number;
  name?: string;
  state: string;
  result?: string;
  createdDate: string;
  finishedDate?: string;
  pipeline?: { id: number; name?: string };
  templateParameters?: Record<string, unknown>;
  resources?: {
    repositories?: { self?: { refName?: string; version?: string } };
  };
  _links?: { web?: { href?: string } };
}

/** A build timeline record (stage, phase, job, task, checkpoint, ...). */
export interface RawTimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name?: string;
  identifier?: string | null;
  state?: string;
  result?: string | null;
  startTime?: string | null;
  finishTime?: string | null;
  order?: number;
}

/** Azure DevOps pipelines REST client for one project. */
export class PipelineClient extends AdoHttp {
  private readonly webRoot: string;

  /** Create a client for one project. */
  constructor(
    args: GlobalArgs,
    fetchFn: FetchFn = fetch,
    maxRetries = 3,
    onRetry: RetryListener = () => {},
  ) {
    const project = projectUrl(args);
    super(`${project}/_apis`, args.pat, fetchFn, maxRetries, onRetry);
    this.webRoot = project;
  }

  /** Web URL a person opens to see a pipeline. */
  pipelineUrl(pipelineId: number): string {
    return `${this.webRoot}/_build?definitionId=${pipelineId}`;
  }

  /** Web URL a person opens to see a run. */
  runUrl(runId: number): string {
    return `${this.webRoot}/_build/results?buildId=${runId}`;
  }
}

/** `feature/x` or `refs/heads/feature/x` → `refs/heads/feature/x`. */
function toRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** Template parameter values as strings, as Azure DevOps reports them. */
export function stringifyParameters(
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map((
      [k, v],
    ) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
}

/**
 * Stages from a build timeline, in order. A stage waits for approval while an
 * approval checkpoint under it is not completed.
 */
export function toStages(records: RawTimelineRecord[]): Stage[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const stageOf = (r: RawTimelineRecord): RawTimelineRecord | undefined => {
    let cur: RawTimelineRecord | undefined = r;
    for (let hops = 0; cur && hops < 10; hops++) {
      if (cur.type === "Stage") return cur;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return undefined;
  };
  const waiting = new Set<string>();
  for (const r of records) {
    if (r.type === "Checkpoint.Approval" && r.state !== "completed") {
      const stage = stageOf(r);
      if (stage) waiting.add(stage.id);
    }
  }
  return records
    .filter((r) => r.type === "Stage")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => ({
      name: r.name ?? r.identifier ?? r.id,
      identifier: r.identifier ?? null,
      state: r.state ?? "unknown",
      result: r.result ?? null,
      startTime: r.startTime ?? null,
      finishTime: r.finishTime ?? null,
      waitingForApproval: waiting.has(r.id),
    }));
}

/** Map a raw run (plus its stages) to the stored snapshot. */
export function toRun(
  run: RawRun,
  pipelineId: number,
  stages: Stage[] | null,
  url: string,
  fetchedAt: string,
): Run {
  const self = run.resources?.repositories?.self;
  return {
    id: run.id,
    name: run.name ?? String(run.id),
    pipelineId: run.pipeline?.id ?? pipelineId,
    pipelineName: run.pipeline?.name ?? "",
    url: run._links?.web?.href ?? url,
    state: run.state,
    result: run.result ?? null,
    branch: self?.refName?.replace(/^refs\/heads\//, "") ?? null,
    commit: self?.version ?? null,
    templateParameters: stringifyParameters(run.templateParameters),
    createdDate: run.createdDate,
    finishedDate: run.finishedDate ?? null,
    stages: stages ?? [],
    stagesIncluded: stages !== null,
    waitingForApproval: (stages ?? []).some((s) => s.waitingForApproval),
    fetchedAt,
  };
}

/** Load a run and its stages. Stages are null while the timeline doesn't exist yet. */
export async function fetchRun(
  client: PipelineClient,
  pipelineId: number,
  runId: number,
  signal?: AbortSignal,
): Promise<Run> {
  const [run, stages] = await Promise.all([
    client.request<RawRun>(
      "GET",
      `/pipelines/${pipelineId}/runs/${runId}`,
      {},
      undefined,
      signal,
      RawRunShape,
    ),
    client.request<{ records: RawTimelineRecord[] }>(
      "GET",
      `/build/builds/${runId}/timeline`,
      {},
      undefined,
      signal,
      RawTimelineShape,
    ).then((t) => toStages(t.records)).catch((error) => {
      // A run that hasn't started has no timeline yet (204 or 404).
      if (
        error instanceof AdoError &&
        (error.status === 204 || error.status === 404)
      ) {
        return null;
      }
      throw error;
    }),
  ]);
  return toRun(
    run,
    pipelineId,
    stages,
    client.runUrl(runId),
    new Date().toISOString(),
  );
}

/** True when a run needs nothing more from the caller: finished, or waiting on a person. */
export function isSettled(run: Run): boolean {
  return run.state === "completed" || run.waitingForApproval;
}

/**
 * Poll a run until it is settled or `waitMinutes` pass. With `waitMinutes`
 * 0 it reads the run once.
 */
export async function waitForRun(
  client: PipelineClient,
  pipelineId: number,
  runId: number,
  waitMinutes: number,
  pollSeconds: number,
  ctx: BaseContext,
): Promise<Run> {
  const deadline = Date.now() + waitMinutes * 60_000;
  let run = await fetchRun(client, pipelineId, runId, ctx.signal);
  while (!isSettled(run) && Date.now() < deadline) {
    ctx.logger.info("Run {runId} is {state}; checking again in {seconds} s", {
      runId,
      state: run.state,
      seconds: pollSeconds,
    });
    await sleep(
      Math.min(pollSeconds * 1000, Math.max(deadline - Date.now(), 0)),
      ctx.signal,
    );
    run = await fetchRun(client, pipelineId, runId, ctx.signal);
  }
  return run;
}

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

interface MethodContext extends BaseContext {
  globalArgs: GlobalArgs;
  writeResource: WriteResource;
}

type MethodResult = Promise<{ dataHandles: Array<{ name: string }> }>;

function clientFor(ctx: MethodContext): PipelineClient {
  return new PipelineClient(
    GlobalArgsSchema.parse(ctx.globalArgs),
    fetch,
    3,
    logRetries(ctx),
  );
}

function logRun(ctx: MethodContext, run: Run): void {
  const stages = run.stages.map((s) =>
    `${s.name}: ${
      s.waitingForApproval ? "waiting for approval" : s.result ?? s.state
    }`
  ).join(", ");
  ctx.logger.info("Run {runId} ({name}) is {state}{result}{stages}: {url}", {
    runId: run.id,
    name: run.name,
    state: run.state,
    result: run.result ? ` (${run.result})` : "",
    stages: stages ? `; ${stages}` : "",
    url: run.url,
  });
}

/** Body for a run or preview request. */
export function runBody(
  args: {
    branch?: string;
    templateParameters: Record<string, string>;
    variables: Record<string, string>;
    stagesToSkip: string[];
  },
  previewRun: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { previewRun };
  if (args.branch) {
    body.resources = {
      repositories: { self: { refName: toRef(args.branch) } },
    };
  }
  if (Object.keys(args.templateParameters).length > 0) {
    body.templateParameters = args.templateParameters;
  }
  if (Object.keys(args.variables).length > 0) {
    body.variables = Object.fromEntries(
      Object.entries(args.variables).map(([k, v]) => [k, { value: v }]),
    );
  }
  if (args.stagesToSkip.length > 0) body.stagesToSkip = args.stagesToSkip;
  return body;
}

const RunInputs = {
  pipelineId: z.number().int().positive(),
  branch: z.string().min(1).optional().describe(
    "Branch to run; the pipeline's default branch when omitted.",
  ),
  templateParameters: z.record(z.string(), z.string()).default({}).describe(
    "Runtime parameters (the YAML `parameters:` block), e.g. { environment: test }.",
  ),
  variables: z.record(z.string(), z.string()).default({}).describe(
    "Variables marked settable at queue time.",
  ),
  stagesToSkip: z.array(z.string().min(1)).default([]),
};

const WaitInputs = {
  waitMinutes: z.number().min(0).max(360).default(0).describe(
    "Keep checking until the run completes or waits on an approval, for at most this long; 0 reads it once.",
  ),
  pollSeconds: z.number().int().min(5).max(600).default(30),
};

interface RunArgs {
  pipelineId: number;
  branch?: string;
  templateParameters: Record<string, string>;
  variables: Record<string, string>;
  stagesToSkip: string[];
}

/** Model definition for `@bmonty/azure-devops/pipeline`. */
export const model = {
  type: "@bmonty/azure-devops/pipeline",
  version: "2026.10.27.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.27.1",
      description: "Version bump for the first publish; no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    pipelines: {
      description: "The project's pipelines (`pipelines`)",
      schema: PipelineListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    run: {
      description:
        "Run snapshot with stages and approvals (`run-<runId>`, `latest-<pipelineId>`)",
      schema: RunSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    runs: {
      description:
        "A pipeline's most recent runs, without stages (`runs-<pipelineId>`)",
      schema: RunListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    preview: {
      description: "Final YAML a run would use (`preview-<pipelineId>`)",
      schema: PreviewSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description: "List the project's pipelines, optionally in one folder",
      arguments: z.object({
        folder: z.string().min(1).optional().describe(
          "Only pipelines in this folder (e.g. `\\Deploy`).",
        ),
      }),
      execute: async (
        args: { folder?: string },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        ctx.logger.info("Listing pipelines{folder}", {
          folder: args.folder ? ` in ${args.folder}` : "",
        });
        const raw = await client.request<{ value: RawPipeline[] }>(
          "GET",
          "/pipelines",
          { "$top": String(MAX_PIPELINES) },
          undefined,
          ctx.signal,
          RawPipelineListShape,
        );
        const truncated = raw.value.length >= MAX_PIPELINES;
        if (truncated) {
          ctx.logger.warning(
            "Only the first {max} pipelines were read; narrow with folder",
            { max: MAX_PIPELINES },
          );
        }
        const pipelines = raw.value
          .filter((p) => !args.folder || p.folder === args.folder)
          .map((p) => ({
            id: p.id,
            name: p.name,
            folder: p.folder ?? "\\",
            revision: p.revision ?? null,
            url: p._links?.web?.href ?? client.pipelineUrl(p.id),
          }));
        ctx.logger.info("Found {count} pipeline(s)", {
          count: pipelines.length,
        });
        return {
          dataHandles: [
            await ctx.writeResource("pipelines", "pipelines", {
              pipelines,
              truncated,
              listedAt: new Date().toISOString(),
            }),
          ],
        };
      },
    },
    preview: {
      description:
        "Check parameters and return the final YAML a run would use, without running anything",
      arguments: z.object(RunInputs),
      execute: async (args: RunArgs, ctx: MethodContext): MethodResult => {
        const client = clientFor(ctx);
        ctx.logger.info("Previewing pipeline {id} with {params}", {
          id: args.pipelineId,
          params: JSON.stringify(args.templateParameters),
        });
        const preview = await client.request<{ finalYaml: string }>(
          "POST",
          `/pipelines/${args.pipelineId}/runs`,
          {},
          runBody(args, true),
          ctx.signal,
          RawPreviewShape,
        );
        ctx.logger.info("Preview of pipeline {id}: {lines} lines of YAML", {
          id: args.pipelineId,
          lines: preview.finalYaml.split("\n").length,
        });
        return {
          dataHandles: [
            await ctx.writeResource(
              "preview",
              `preview-${args.pipelineId}`,
              {
                pipelineId: args.pipelineId,
                branch: args.branch ?? null,
                templateParameters: args.templateParameters,
                finalYaml: preview.finalYaml,
                previewedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },
    run: {
      description:
        "Queue a pipeline run, optionally waiting until it completes or waits on an approval",
      arguments: z.object({ ...RunInputs, ...WaitInputs }),
      execute: async (
        args: RunArgs & { waitMinutes: number; pollSeconds: number },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        ctx.logger.info("Queuing pipeline {id}{branch} with {params}", {
          id: args.pipelineId,
          branch: args.branch ? ` on ${args.branch}` : "",
          params: JSON.stringify(args.templateParameters),
        });
        const queued = await client.request<RawRun>(
          "POST",
          `/pipelines/${args.pipelineId}/runs`,
          {},
          runBody(args, false),
          ctx.signal,
          RawRunShape,
        );
        const url = queued._links?.web?.href ?? client.runUrl(queued.id);
        ctx.logger.info("Queued run {runId}: {url}", { runId: queued.id, url });
        // Record the run before following it, so a failure while waiting
        // still leaves its id behind and a retry can read it instead of
        // queuing a second run.
        const write = (run: Run) =>
          Promise.all([
            ctx.writeResource("run", `run-${run.id}`, run),
            ctx.writeResource("run", `latest-${args.pipelineId}`, run),
          ]);
        await write(
          toRun(queued, args.pipelineId, null, url, new Date().toISOString()),
        );
        let run: Run;
        try {
          run = await waitForRun(
            client,
            args.pipelineId,
            queued.id,
            args.waitMinutes,
            args.pollSeconds,
            ctx,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Run ${queued.id} was queued (${url}) but following it failed: ${reason}. Read it with getRun instead of queuing it again.`,
          );
        }
        logRun(ctx, run);
        return { dataHandles: await write(run) };
      },
    },
    listRuns: {
      description:
        "List a pipeline's most recent runs, newest first (without stages)",
      arguments: z.object({
        pipelineId: z.number().int().positive(),
        top: z.number().int().min(1).max(100).default(10),
      }),
      execute: async (
        args: { pipelineId: number; top: number },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        ctx.logger.info("Listing the last {top} runs of pipeline {id}", {
          top: args.top,
          id: args.pipelineId,
        });
        const raw = await client.request<{ value: RawRun[] }>(
          "GET",
          `/pipelines/${args.pipelineId}/runs`,
          {},
          undefined,
          ctx.signal,
          RawRunListShape,
        );
        const fetchedAt = new Date().toISOString();
        const runs = raw.value
          .sort((a, b) => b.id - a.id)
          .slice(0, args.top)
          .map((r) =>
            toRun(r, args.pipelineId, null, client.runUrl(r.id), fetchedAt)
          );
        ctx.logger.info("Found {count} run(s); newest is {newest}", {
          count: runs.length,
          newest: runs[0]
            ? `${runs[0].id} (${runs[0].result ?? runs[0].state})`
            : "none",
        });
        return {
          dataHandles: [
            await ctx.writeResource("runs", `runs-${args.pipelineId}`, {
              pipelineId: args.pipelineId,
              runs,
              listedAt: fetchedAt,
            }),
          ],
        };
      },
    },
    getRun: {
      description:
        "Read a run's state, result, and stages, optionally waiting until it completes or waits on an approval",
      arguments: z.object({
        pipelineId: z.number().int().positive(),
        runId: z.number().int().positive(),
        ...WaitInputs,
      }),
      execute: async (
        args: {
          pipelineId: number;
          runId: number;
          waitMinutes: number;
          pollSeconds: number;
        },
        ctx: MethodContext,
      ): MethodResult => {
        ctx.logger.info("Reading run {runId} of pipeline {id}", {
          runId: args.runId,
          id: args.pipelineId,
        });
        const run = await waitForRun(
          clientFor(ctx),
          args.pipelineId,
          args.runId,
          args.waitMinutes,
          args.pollSeconds,
          ctx,
        );
        logRun(ctx, run);
        return {
          dataHandles: [await ctx.writeResource("run", `run-${run.id}`, run)],
        };
      },
    },
  },
};
