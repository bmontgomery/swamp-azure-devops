import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  type FetchFn,
  isSettled,
  MAX_PIPELINES,
  model,
  PipelineClient,
  type RawTimelineRecord,
  runBody,
  stringifyParameters,
  toRun,
  toStages,
} from "./pipeline.ts";

const globalArgs = {
  organization: "org",
  project: "proj",
  pat: "secret-pat",
  baseUrl: "https://dev.azure.com",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/** Fake method context that records writes and stubs fetch. */
function fakeContext(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const writes: Array<{ spec: string; name: string; data: unknown }> = [];
  const stub: FetchFn = (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = new URL(url).pathname.replace("/org/proj/_apis", "");
    const key = `${init?.method ?? "GET"} ${path}`;
    if (!(key in responses)) return Promise.resolve(json({}, 404));
    return Promise.resolve(json(responses[key]));
  };
  const ctx = {
    globalArgs,
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    logger: { info: () => {}, warning: () => {} },
  };
  return { ctx, calls, writes, stub };
}

/** Run a method with fetch replaced by `stub`. */
async function withFetch<T>(stub: FetchFn, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const timeline: RawTimelineRecord[] = [
  {
    id: "s1",
    type: "Stage",
    name: "Build the apps",
    identifier: "Build",
    state: "completed",
    result: "succeeded",
    order: 1,
  },
  {
    id: "s3",
    type: "Stage",
    name: "Deploy the apps",
    identifier: "Deploy",
    state: "pending",
    order: 3,
  },
  {
    id: "s2",
    type: "Stage",
    name: "Upgrade Database",
    identifier: "Database",
    state: "pending",
    order: 2,
  },
  { id: "c2", parentId: "s2", type: "Checkpoint", state: "inProgress" },
  {
    id: "a2",
    parentId: "c2",
    type: "Checkpoint.Approval",
    state: "inProgress",
  },
];

Deno.test("toStages orders stages and flags the one waiting on an approval", () => {
  const stages = toStages(timeline);
  assertEquals(stages.map((s) => s.identifier), [
    "Build",
    "Database",
    "Deploy",
  ]);
  assertEquals(stages.map((s) => s.waitingForApproval), [false, true, false]);
  assertEquals(stages[0].result, "succeeded");
  assertEquals(stages[1].result, null);
});

Deno.test("a completed approval no longer marks the stage as waiting", () => {
  const done = timeline.map((r) =>
    r.id === "a2" ? { ...r, state: "completed", result: "succeeded" } : r
  );
  assertEquals(toStages(done).some((s) => s.waitingForApproval), false);
});

Deno.test("toRun maps branch, commit, parameters, and approval state", () => {
  const run = toRun(
    {
      id: 77,
      name: "20261026.3",
      state: "inProgress",
      createdDate: "2026-10-26T10:00:00Z",
      pipeline: { id: 5, name: "deploy" },
      templateParameters: { environment: "test", dryRun: false },
      resources: {
        repositories: {
          self: { refName: "refs/heads/master", version: "abc123" },
        },
      },
    },
    5,
    toStages(timeline),
    "https://fallback",
    "2026-10-26T10:01:00Z",
  );
  assertEquals(run.branch, "master");
  assertEquals(run.commit, "abc123");
  assertEquals(run.templateParameters, {
    environment: "test",
    dryRun: "false",
  });
  assertEquals(run.url, "https://fallback");
  assertEquals(run.result, null);
  assertEquals(run.waitingForApproval, true);
  assertEquals(run.stagesIncluded, true);
  assertEquals(isSettled(run), true);
});

Deno.test("toRun without a timeline says stages were not read", () => {
  const run = toRun(
    { id: 1, state: "inProgress", createdDate: "x" },
    5,
    null,
    "u",
    "t",
  );
  assertEquals(run.stagesIncluded, false);
  assertEquals(run.stages, []);
  assertEquals(isSettled(run), false);
});

Deno.test("stringifyParameters keeps strings and JSON-encodes the rest", () => {
  assertEquals(stringifyParameters({ a: "x", b: 2, c: ["y"] }), {
    a: "x",
    b: "2",
    c: '["y"]',
  });
  assertEquals(stringifyParameters(undefined), {});
});

Deno.test("runBody sends only what was given", () => {
  assertEquals(
    runBody({
      templateParameters: {},
      variables: {},
      stagesToSkip: [],
    }, false),
    { previewRun: false },
  );
  assertEquals(
    runBody({
      branch: "master",
      templateParameters: { environment: "test" },
      variables: { Verbose: "true" },
      stagesToSkip: ["Database"],
    }, true),
    {
      previewRun: true,
      resources: { repositories: { self: { refName: "refs/heads/master" } } },
      templateParameters: { environment: "test" },
      variables: { Verbose: { value: "true" } },
      stagesToSkip: ["Database"],
    },
  );
});

Deno.test("PipelineClient uses the project _apis root and web URLs", async () => {
  let url = "";
  const stub: FetchFn = (u) => {
    url = u;
    return Promise.resolve(json({ value: [] }));
  };
  const client = new PipelineClient(globalArgs, stub);
  await client.request("GET", "/pipelines");
  assertEquals(
    url,
    "https://dev.azure.com/org/proj/_apis/pipelines?api-version=7.1",
  );
  assertEquals(
    client.runUrl(9),
    "https://dev.azure.com/org/proj/_build/results?buildId=9",
  );
});

Deno.test("list filters by folder and writes one pipelines record", async () => {
  const f = fakeContext({
    "GET /pipelines": {
      value: [
        { id: 1, name: "ci", folder: "\\" },
        { id: 2, name: "deploy", folder: "\\Deploy", revision: 4 },
      ],
    },
  });
  await withFetch(
    f.stub,
    () => model.methods.list.execute({ folder: "\\Deploy" }, f.ctx),
  );
  assertEquals(f.writes.length, 1);
  assertEquals(f.writes[0].name, "pipelines");
  const data = f.writes[0].data as {
    pipelines: Array<{ id: number }>;
    truncated: boolean;
  };
  assertEquals(data.pipelines.map((p) => p.id), [2]);
  assertEquals(data.truncated, false);
});

Deno.test("list says when it hit the pipeline limit", async () => {
  const f = fakeContext({
    "GET /pipelines": {
      value: Array.from(
        { length: MAX_PIPELINES },
        (_, i) => ({ id: i + 1, name: `p${i}` }),
      ),
    },
  });
  await withFetch(f.stub, () => model.methods.list.execute({}, f.ctx));
  assertEquals((f.writes[0].data as { truncated: boolean }).truncated, true);
});

Deno.test("run queues once, reads the run, and writes run-<id> and latest-<pipeline>", async () => {
  const f = fakeContext({
    "POST /pipelines/5/runs": {
      id: 77,
      state: "inProgress",
      createdDate: "2026-10-26T10:00:00Z",
    },
    "GET /pipelines/5/runs/77": {
      id: 77,
      state: "completed",
      result: "succeeded",
      createdDate: "2026-10-26T10:00:00Z",
      finishedDate: "2026-10-26T10:20:00Z",
    },
    "GET /build/builds/77/timeline": { records: timeline.slice(0, 1) },
  });
  await withFetch(f.stub, () =>
    model.methods.run.execute({
      pipelineId: 5,
      branch: "master",
      templateParameters: { environment: "test" },
      variables: {},
      stagesToSkip: [],
      waitMinutes: 1,
      pollSeconds: 5,
    }, f.ctx));
  assertEquals(f.calls.filter((c) => c.method === "POST").length, 1);
  assertEquals(f.calls[0].body, {
    previewRun: false,
    resources: { repositories: { self: { refName: "refs/heads/master" } } },
    templateParameters: { environment: "test" },
  });
  // Recorded as soon as it is queued, then again once settled.
  assertEquals(f.writes.map((w) => w.name), [
    "run-77",
    "latest-5",
    "run-77",
    "latest-5",
  ]);
  assertEquals((f.writes[0].data as { state: string }).state, "inProgress");
  assertEquals((f.writes[2].data as { result: string }).result, "succeeded");
});

Deno.test("run keeps the queued run's id when following it fails", async () => {
  const f = fakeContext({
    "POST /pipelines/5/runs": {
      id: 79,
      state: "inProgress",
      createdDate: "2026-10-26T10:00:00Z",
    },
    // No GET responses: reading the run fails with 404.
  });
  const error = await assertRejects(() =>
    withFetch(f.stub, () =>
      model.methods.run.execute({
        pipelineId: 5,
        templateParameters: {},
        variables: {},
        stagesToSkip: [],
        waitMinutes: 0,
        pollSeconds: 5,
      }, f.ctx))
  );
  assertEquals(f.calls.filter((c) => c.method === "POST").length, 1);
  assertEquals(f.writes.map((w) => w.name), ["run-79", "latest-5"]);
  assertEquals(
    (error as Error).message.includes("Run 79 was queued"),
    true,
  );
});

Deno.test("getRun treats a missing timeline as not started, not an error", async () => {
  const f = fakeContext({
    "GET /pipelines/5/runs/78": {
      id: 78,
      state: "inProgress",
      createdDate: "2026-10-26T10:00:00Z",
    },
  });
  await withFetch(f.stub, () =>
    model.methods.getRun.execute({
      pipelineId: 5,
      runId: 78,
      waitMinutes: 0,
      pollSeconds: 30,
    }, f.ctx));
  const run = f.writes[0].data as { stagesIncluded: boolean };
  assertEquals(run.stagesIncluded, false);
});

Deno.test("preview posts previewRun and stores the final YAML", async () => {
  const f = fakeContext({
    "POST /pipelines/5/runs": { finalYaml: "stages:\n- stage: Build\n" },
  });
  await withFetch(f.stub, () =>
    model.methods.preview.execute({
      pipelineId: 5,
      templateParameters: { environment: "production" },
      variables: {},
      stagesToSkip: [],
    }, f.ctx));
  assertEquals((f.calls[0].body as { previewRun: boolean }).previewRun, true);
  assertEquals(f.writes[0].name, "preview-5");
});

Deno.test("listRuns keeps the newest runs with their parameters", async () => {
  const f = fakeContext({
    "GET /pipelines/5/runs": {
      value: [
        { id: 3, state: "completed", result: "succeeded", createdDate: "c" },
        {
          id: 9,
          state: "inProgress",
          createdDate: "d",
          templateParameters: { environment: "test" },
        },
        { id: 7, state: "completed", result: "failed", createdDate: "b" },
      ],
    },
  });
  await withFetch(
    f.stub,
    () => model.methods.listRuns.execute({ pipelineId: 5, top: 2 }, f.ctx),
  );
  assertEquals(f.writes[0].name, "runs-5");
  const data = f.writes[0].data as {
    runs: Array<{ id: number; templateParameters: Record<string, string> }>;
  };
  assertEquals(data.runs.map((r) => r.id), [9, 7]);
  assertEquals(data.runs[0].templateParameters, { environment: "test" });
});
