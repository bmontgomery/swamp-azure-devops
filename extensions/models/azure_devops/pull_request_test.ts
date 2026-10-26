import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  AdoClient,
  AdoError,
  branchSlug,
  type FetchFn,
  findComment,
  fromRef,
  GlobalArgsSchema,
  MAX_RETRY_DELAY_MS,
  model,
  retryDelayMs,
  sleep,
  toPullRequest,
  toRef,
  toThread,
} from "./pull_request.ts";

const globalArgs = {
  organization: "org",
  project: "proj",
  repository: "repo",
  pat: "secret-pat",
  baseUrl: "https://dev.azure.com",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

Deno.test("branch helpers normalize refs and slugs", () => {
  assertEquals(toRef("feature/x"), "refs/heads/feature/x");
  assertEquals(toRef("refs/heads/feature/x"), "refs/heads/feature/x");
  assertEquals(fromRef("refs/heads/hotfix/y"), "hotfix/y");
  assertEquals(
    branchSlug("refs/heads/feature/AbCd1234-my change"),
    "feature-AbCd1234-my-change",
  );
});

Deno.test("AdoClient sends Basic PAT auth and api-version, never the PAT in the URL", async () => {
  let url = "";
  let auth = "";
  const stub: FetchFn = (u, init) => {
    url = u;
    auth = new Headers(init?.headers).get("Authorization") ?? "";
    return Promise.resolve(json({ value: [] }));
  };
  await new AdoClient(globalArgs, stub).request("GET", "/pullrequests", {
    a: "b",
  });
  assertEquals(
    url,
    "https://dev.azure.com/org/proj/_apis/git/repositories/repo/pullrequests?a=b&api-version=7.1",
  );
  assertEquals(auth, `Basic ${btoa(":secret-pat")}`);
  assertEquals(url.includes("secret-pat"), false);
});

Deno.test("AdoClient reports a sign-in page (bad PAT) clearly instead of parsing HTML", async () => {
  const stub: FetchFn = () =>
    Promise.resolve(
      new Response("<html>Sign in</html>", {
        status: 203,
        headers: { "Content-Type": "text/html" },
      }),
    );
  await assertRejects(
    () => new AdoClient(globalArgs, stub).request("GET", "/pullrequests"),
    Error,
    "check the token",
  );
});

Deno.test("AdoClient retries 429 then succeeds", async () => {
  let calls = 0;
  const stub: FetchFn = () => {
    calls++;
    return Promise.resolve(
      calls === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "1" } })
        : json({ ok: true }),
    );
  };
  assertEquals(
    (await new AdoClient(globalArgs, stub).request<{ ok: boolean }>(
      "GET",
      "/x",
    )).ok,
    true,
  );
  assertEquals(calls, 2);
});

const rawThread = {
  id: 7,
  status: "active",
  publishedDate: "t1",
  lastUpdatedDate: "t2",
  threadContext: { filePath: "/design/x.md", rightFileStart: { line: 12 } },
  comments: [
    {
      id: 1,
      parentCommentId: 0,
      author: { displayName: "Pat", uniqueName: "pat@example.com" },
      content: "Use the enum",
      publishedDate: "t1",
      commentType: "text",
    },
    {
      id: 2,
      parentCommentId: 1,
      content: "gone",
      publishedDate: "t2",
      isDeleted: true,
    },
  ],
};

Deno.test("toThread keeps location and drops deleted comments", () => {
  const t = toThread(rawThread);
  assertEquals(t.filePath, "/design/x.md");
  assertEquals(t.line, 12);
  assertEquals(t.comments.map((c) => c.id), [1]);
  assertEquals(t.comments[0].authorUniqueName, "pat@example.com");
});

Deno.test("toPullRequest labels votes and strips refs", () => {
  const pr = toPullRequest(
    {
      pullRequestId: 42,
      title: "T",
      status: "active",
      isDraft: true,
      sourceRefName: "refs/heads/feature/x",
      targetRefName: "refs/heads/master",
      creationDate: "c",
      reviewers: [
        { id: "r1", displayName: "Pat", vote: -5 },
        { id: "r2", displayName: "Sam", vote: 10, isRequired: true },
      ],
    },
    [rawThread, { ...rawThread, id: 8, isDeleted: true }],
    "https://x/pullrequest/42",
    "now",
  );
  assertEquals(pr.sourceBranch, "feature/x");
  assertEquals(pr.targetBranch, "master");
  assertEquals(pr.reviewers.map((r) => r.voteLabel), [
    "waitingForAuthor",
    "approved",
  ]);
  assertEquals(pr.threads.map((t) => t.id), [7]);
  assertEquals(pr.threadsIncluded, true);
  assertEquals(pr.closedDate, null);
  const bare = toPullRequest(
    { ...rawPr, reviewers: [] },
    null,
    "u",
    "now",
  );
  assertEquals(bare.threads, []);
  assertEquals(bare.threadsIncluded, false);
});

Deno.test("addComment fails rather than invent a comment id", async () => {
  await withFakeAdo({
    "POST /pullrequests/42/threads": () => ({ ...rawThread, comments: [] }),
  }, async () => {
    const { ctx, written } = fakeCtx();
    await assertRejects(
      () =>
        model.methods.addComment.execute({
          pullRequestId: 42,
          content: "Hello",
          status: "active",
        }, ctx),
      Error,
      "no comment id",
    );
    assertEquals(written.length, 0);
  });
});

Deno.test("reply without a status records the thread's real status", async () => {
  await withFakeAdo({
    "GET /pullrequests/42/threads/7": () => rawThread,
    "POST /pullrequests/42/threads/7/comments": () => ({
      id: 5,
      publishedDate: "t",
    }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await model.methods.reply.execute({
      pullRequestId: 42,
      threadId: 7,
      content: "Noted",
    }, ctx);
    assertEquals(calls.some((c) => c.method === "PATCH"), false);
    assertEquals(written[0].data.threadStatus, "active");
  });
});

Deno.test("findComment locates a marker across threads", () => {
  const threads = [
    toThread(rawThread),
    toThread({
      ...rawThread,
      id: 9,
      comments: [{
        id: 1,
        content: "x `bot-marker:v1`",
        publishedDate: "t",
      }],
    }),
  ];
  assertEquals(findComment(threads, "bot-marker:v1")?.thread.id, 9);
  assertEquals(findComment(threads, "nope"), null);
});

// ---- methods, run against a fake Azure DevOps via a stubbed global fetch ----

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

async function withFakeAdo(
  routes: Record<string, (call: Call) => unknown>,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = new URL(input);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/org/proj/_apis/git/repositories/repo", ""),
      query: url.searchParams,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    return Promise.resolve(
      route ? json(route(call)) : json({ message: "no route" }, 404),
    );
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function fakeCtx() {
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    written,
    ctx: {
      globalArgs,
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      logger: { info: () => {}, warning: () => {} },
    },
  };
}

const rawPr = {
  pullRequestId: 42,
  title: "T",
  status: "active",
  isDraft: true,
  sourceRefName: "refs/heads/feature/x",
  targetRefName: "refs/heads/master",
  creationDate: "c",
};

Deno.test("ensurePullRequest creates a draft when none exists", async () => {
  await withFakeAdo({
    "GET /pullrequests": () => ({ value: [] }),
    "POST /pullrequests": () => rawPr,
    "GET /pullrequests/42": () => rawPr,
    "GET /pullrequests/42/threads": () => ({ value: [] }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await model.methods.ensurePullRequest.execute({
      sourceBranch: "feature/x",
      targetBranch: "master",
      title: "T",
      description: "D",
      draft: true,
    }, ctx);
    const search = calls[0];
    assertEquals(
      search.query.get("searchCriteria.sourceRefName"),
      "refs/heads/feature/x",
    );
    assertEquals(search.query.get("searchCriteria.status"), "active");
    const post = calls.find((c) => c.method === "POST")!;
    assertEquals((post.body as { isDraft: boolean }).isDraft, true);
    assertEquals(written.map((w) => w.name), ["pr-42", "branch-feature-x"]);
    assertEquals(written[1].data.created, true);
    assertEquals(
      written[1].data.url,
      "https://dev.azure.com/org/proj/_git/repo/pullrequest/42",
    );
  });
});

Deno.test("ensurePullRequest reuses an open pull request instead of creating another", async () => {
  await withFakeAdo({
    "GET /pullrequests": () => ({ value: [rawPr] }),
    "GET /pullrequests/42": () => rawPr,
    "GET /pullrequests/42/threads": () => ({ value: [] }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await model.methods.ensurePullRequest.execute({
      sourceBranch: "feature/x",
      targetBranch: "master",
      title: "T",
      description: "",
      draft: true,
    }, ctx);
    assertEquals(calls.some((c) => c.method === "POST"), false);
    assertEquals(written[1].data.created, false);
  });
});

Deno.test("update publishes a draft and rejects an empty update", async () => {
  await withFakeAdo({
    "PATCH /pullrequests/42": () => ({ ...rawPr, isDraft: false }),
    "GET /pullrequests/42": () => ({ ...rawPr, isDraft: false }),
    "GET /pullrequests/42/threads": () => ({ value: [rawThread] }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await model.methods.update.execute(
      { pullRequestId: 42, draft: false },
      ctx,
    );
    assertEquals(calls[0].body, { isDraft: false });
    assertEquals(written[0].data.isDraft, false);
    // The snapshot replaces the latest pr-42, so it keeps the threads.
    assertEquals(written[0].data.threadsIncluded, true);
    assertEquals((written[0].data.threads as unknown[]).length, 1);
    await assertRejects(
      () => model.methods.update.execute({ pullRequestId: 42 }, ctx),
      Error,
      "Nothing to update",
    );
  });
});

Deno.test("addComment with skipIfContains finds the earlier comment instead of posting", async () => {
  await withFakeAdo({
    "GET /pullrequests/42": () => rawPr,
    "GET /pullrequests/42/threads": () => ({
      value: [{
        ...rawThread,
        id: 3,
        comments: [{
          id: 1,
          content: "Design ready `bot-marker:v1`",
          publishedDate: "t",
        }],
      }],
    }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await model.methods.addComment.execute({
      pullRequestId: 42,
      content: "Design ready `bot-marker:v1`",
      status: "closed",
      skipIfContains: "bot-marker:v1",
    }, ctx);
    assertEquals(calls.some((c) => c.method === "POST"), false);
    assertEquals(written[0].name, "comment-3-1");
    assertEquals(written[0].data.existing, true);
  });
});

Deno.test("reply posts to the thread, then marks it fixed", async () => {
  await withFakeAdo({
    "POST /pullrequests/42/threads/7/comments": () => ({
      id: 5,
      publishedDate: "t",
    }),
    "PATCH /pullrequests/42/threads/7": () => ({
      ...rawThread,
      status: "fixed",
    }),
  }, async (calls) => {
    const { ctx, written } = fakeCtx();
    await model.methods.reply.execute({
      pullRequestId: 42,
      threadId: 7,
      content: "Done in abc123",
      status: "fixed",
    }, ctx);
    assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
      "POST /pullrequests/42/threads/7/comments",
      "PATCH /pullrequests/42/threads/7",
    ]);
    assertEquals(
      (calls[0].body as { parentCommentId: number }).parentCommentId,
      1,
    );
    assertEquals(written[0].name, "comment-7-5");
    assertEquals(written[0].data.threadStatus, "fixed");
  });
});

// ---- retries, response checks, and races ----

const fast = { "Retry-After": "0.01" };

function sequence(...responses: Array<() => Response>): {
  stub: FetchFn;
  count: () => number;
} {
  let n = 0;
  return {
    stub: () =>
      Promise.resolve(responses[Math.min(n++, responses.length - 1)]()),
    count: () => n,
  };
}

Deno.test("reads retry on 5xx and network errors, and report each retry", async () => {
  let n = 0;
  const stub: FetchFn = () => {
    n++;
    if (n === 1) return Promise.reject(new TypeError("connection reset"));
    if (n === 2) {
      return Promise.resolve(new Response("", { status: 502, headers: fast }));
    }
    return Promise.resolve(json({ ok: true }));
  };
  const retries: string[] = [];
  const client = new AdoClient(
    globalArgs,
    stub,
    3,
    (r) => retries.push(r.reason),
  );
  assertEquals(
    (await client.request<{ ok: boolean }>("GET", "/x")).ok,
    true,
  );
  assertEquals(retries, ["network error: connection reset", "HTTP 502"]);
});

Deno.test("creates are retried only on 429, never after a 503 or a network error", async () => {
  const unavailable = sequence(
    () => new Response("busy", { status: 503, headers: fast }),
    () => json({ id: 1 }),
  );
  const error = await assertRejects(
    () =>
      new AdoClient(globalArgs, unavailable.stub).request("POST", "/x", {}, {}),
    AdoError,
  );
  assertEquals(error.status, 503);
  assertEquals(unavailable.count(), 1);

  let calls = 0;
  const offline: FetchFn = () => {
    calls++;
    return Promise.reject(new TypeError("offline"));
  };
  await assertRejects(
    () => new AdoClient(globalArgs, offline).request("POST", "/x", {}, {}),
    AdoError,
    "network error: offline",
  );
  assertEquals(calls, 1);

  const limited = sequence(
    () => new Response("", { status: 429, headers: fast }),
    () => json({ id: 1 }),
  );
  await new AdoClient(globalArgs, limited.stub).request("POST", "/x", {}, {});
  assertEquals(limited.count(), 2);
});

Deno.test("retry delays honor Retry-After but are capped", () => {
  assertEquals(retryDelayMs(0, "2"), 2000);
  assertEquals(retryDelayMs(2, null), 4000);
  assertEquals(retryDelayMs(0, "86400"), MAX_RETRY_DELAY_MS);
  assertEquals(retryDelayMs(10, null), MAX_RETRY_DELAY_MS);
});

Deno.test("a retry wait stops as soon as the run is cancelled", async () => {
  const controller = new AbortController();
  const waiting = sleep(MAX_RETRY_DELAY_MS, controller.signal);
  controller.abort(new Error("cancelled"));
  await assertRejects(() => waiting, Error, "cancelled");
});

Deno.test("an unexpected response shape fails with the field that is wrong", async () => {
  await withFakeAdo({
    "GET /pullrequests/42": () => ({ pullRequestId: "42" }),
    "GET /pullrequests/42/threads": () => ({ value: [] }),
  }, async () => {
    const { ctx } = fakeCtx();
    await assertRejects(
      () =>
        model.methods.get.execute(
          { pullRequestId: 42, includeThreads: true },
          ctx,
        ),
      AdoError,
      "unexpected response: pullRequestId",
    );
  });
});

Deno.test("ensurePullRequest reuses the PR another run created first (409)", async () => {
  let searches = 0;
  await withFakeAdo({
    "GET /pullrequests": () => ({ value: searches++ === 0 ? [] : [rawPr] }),
    "GET /pullrequests/42": () => rawPr,
    "GET /pullrequests/42/threads": () => ({ value: [] }),
  }, async () => {
    const original = globalThis.fetch;
    const faked = globalThis.fetch;
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(json({ message: "TF401179: active PR exists" }, 409))
        : faked(input, init)) as typeof fetch;
    try {
      const { ctx, written } = fakeCtx();
      await model.methods.ensurePullRequest.execute({
        sourceBranch: "feature/x",
        targetBranch: "master",
        title: "T",
        description: "",
        draft: true,
      }, ctx);
      assertEquals(written[1].data.pullRequestId, 42);
      assertEquals(written[1].data.created, false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("baseUrl must be https so the token is never sent in clear text", () => {
  assertEquals(
    GlobalArgsSchema.safeParse({
      ...globalArgs,
      baseUrl: "http://ado.example.com",
    })
      .success,
    false,
  );
  assertEquals(GlobalArgsSchema.safeParse(globalArgs).success, true);
});
