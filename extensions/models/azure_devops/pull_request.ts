/**
 * Azure DevOps (Azure Repos) pull requests for swamp. Create or find a pull
 * request for a branch, read its status, reviewer votes, and comment threads,
 * publish a draft, and reply to or resolve review threads, so a workflow can
 * run a full review loop.
 *
 * Authenticate with a personal access token (Code: Read & Write), usually
 * supplied from a vault: `pat: ${{ vault.get(default, ADO_PAT) }}`.
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
} from "./_lib/client.ts";

export {
  AdoError,
  type FetchFn,
  MAX_RETRY_DELAY_MS,
  retryDelayMs,
  type RetryListener,
  sleep,
} from "./_lib/client.ts";

/** Global arguments shared by every method. The token needs Code (Read & Write). */
export const GlobalArgsSchema = ConnectionArgsSchema.extend({
  repository: z.string().min(1).describe("Repository name or id."),
});

/** Resolved global argument type. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Reviewer vote values and their meaning. */
export const VOTE_LABELS: Readonly<Record<number, string>> = {
  10: "approved",
  5: "approvedWithSuggestions",
  0: "noVote",
  [-5]: "waitingForAuthor",
  [-10]: "rejected",
};

/** A reviewer and their current vote. */
export const ReviewerSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  uniqueName: z.string().nullable(),
  vote: z.number().int(),
  voteLabel: z.string(),
  isRequired: z.boolean(),
});

/** One comment in a thread. `commentType` is `text` for people, `system` for ADO. */
export const CommentSchema = z.object({
  id: z.number().int(),
  parentCommentId: z.number().int(),
  authorName: z.string().nullable(),
  authorUniqueName: z.string().nullable(),
  content: z.string(),
  publishedDate: z.string(),
  commentType: z.string(),
});

/** A comment thread, optionally anchored to a file and line. */
export const ThreadSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  filePath: z.string().nullable(),
  line: z.number().int().nullable(),
  publishedDate: z.string(),
  lastUpdatedDate: z.string(),
  comments: z.array(CommentSchema),
});

/** Thread type. */
export type Thread = z.infer<typeof ThreadSchema>;

/** A pull request snapshot (`pr-<id>`). */
export const PullRequestSchema = z.object({
  id: z.number().int(),
  url: z.string().describe("Web URL of the pull request."),
  title: z.string(),
  description: z.string(),
  status: z.enum(["active", "completed", "abandoned", "notSet"]),
  isDraft: z.boolean(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  createdBy: z.string().nullable(),
  creationDate: z.string(),
  closedDate: z.string().nullable(),
  mergeStatus: z.string().nullable(),
  lastMergeSourceCommit: z.string().nullable(),
  lastMergeCommit: z.string().nullable(),
  reviewers: z.array(ReviewerSchema),
  threads: z.array(ThreadSchema),
  threadsIncluded: z.boolean().describe(
    'False when threads were not fetched; `threads` is then empty, not "no comments".',
  ),
  fetchedAt: z.string(),
});

/** Pull request snapshot type. */
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** Stable pointer from a source branch to its pull request (`branch-<slug>`). */
export const BranchRefSchema = z.object({
  sourceBranch: z.string(),
  targetBranch: z.string(),
  pullRequestId: z.number().int(),
  url: z.string(),
  created: z.boolean().describe(
    "False when an existing pull request was reused.",
  ),
  resolvedAt: z.string(),
});

/** A comment the bot posted or found (`comment-<threadId>-<commentId>`). */
export const PostedCommentSchema = z.object({
  pullRequestId: z.number().int(),
  threadId: z.number().int(),
  commentId: z.number().int(),
  content: z.string(),
  threadStatus: z.string(),
  existing: z.boolean().describe(
    "True when `skipIfContains` matched and nothing was posted.",
  ),
  postedAt: z.string(),
});

/** Thread statuses Azure DevOps accepts. */
export const ThreadStatusEnum = z.enum([
  "active",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
  "pending",
]);

/** Required fields of the responses the extension reads. */
const RawPullRequestShape = z.object({
  pullRequestId: z.number(),
  title: z.string(),
  status: z.string(),
  sourceRefName: z.string(),
  targetRefName: z.string(),
  creationDate: z.string(),
});
const RawPullRequestListShape = z.object({
  value: z.array(z.object({ pullRequestId: z.number() })),
});
const RawCommentShape = z.object({ id: z.number() });
const RawThreadShape = z.object({
  id: z.number(),
  publishedDate: z.string(),
  comments: z.array(RawCommentShape).optional(),
});
const RawThreadListShape = z.object({ value: z.array(RawThreadShape) });

/** Azure DevOps Git REST client for one repository. */
export class AdoClient extends AdoHttp {
  private readonly webRoot: string;

  /** Create a client for one repository. */
  constructor(
    args: GlobalArgs,
    fetchFn: FetchFn = fetch,
    maxRetries = 3,
    onRetry: RetryListener = () => {},
  ) {
    const project = projectUrl(args);
    const repo = encodeURIComponent(args.repository);
    super(
      `${project}/_apis/git/repositories/${repo}`,
      args.pat,
      fetchFn,
      maxRetries,
      onRetry,
    );
    this.webRoot = `${project}/_git/${repo}`;
  }

  /** Web URL a person opens to see a pull request. */
  webUrl(pullRequestId: number): string {
    return `${this.webRoot}/pullrequest/${pullRequestId}`;
  }
}

/** `feature/x` or `refs/heads/feature/x` → `refs/heads/feature/x`. */
export function toRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** `refs/heads/feature/x` → `feature/x`. */
export function fromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** Branch name made safe for a data instance name (`feature/x` → `feature-x`). */
export function branchSlug(branch: string): string {
  return fromRef(branch).replace(/[^A-Za-z0-9._-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

interface RawIdentity {
  id?: string;
  displayName?: string;
  uniqueName?: string;
}

interface RawPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  sourceRefName: string;
  targetRefName: string;
  createdBy?: RawIdentity;
  creationDate: string;
  closedDate?: string;
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
  reviewers?: Array<RawIdentity & { vote: number; isRequired?: boolean }>;
}

interface RawComment {
  id: number;
  parentCommentId?: number;
  author?: RawIdentity;
  content?: string;
  publishedDate: string;
  commentType?: string;
  isDeleted?: boolean;
}

interface RawThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  publishedDate: string;
  lastUpdatedDate: string;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number };
    leftFileStart?: { line: number };
  } | null;
  comments?: RawComment[];
}

/** Map a raw thread to the stored shape, dropping deleted comments. */
export function toThread(t: RawThread): Thread {
  return {
    id: t.id,
    status: t.status ?? "unknown",
    filePath: t.threadContext?.filePath ?? null,
    line: t.threadContext?.rightFileStart?.line ??
      t.threadContext?.leftFileStart?.line ?? null,
    publishedDate: t.publishedDate,
    lastUpdatedDate: t.lastUpdatedDate,
    comments: (t.comments ?? [])
      .filter((c) => !c.isDeleted)
      .map((c) => ({
        id: c.id,
        parentCommentId: c.parentCommentId ?? 0,
        authorName: c.author?.displayName ?? null,
        authorUniqueName: c.author?.uniqueName ?? null,
        content: c.content ?? "",
        publishedDate: c.publishedDate,
        commentType: c.commentType ?? "text",
      })),
  };
}

/** Map a raw pull request (plus threads) to the stored snapshot. */
export function toPullRequest(
  pr: RawPullRequest,
  threads: RawThread[] | null,
  url: string,
  fetchedAt: string,
): PullRequest {
  return {
    id: pr.pullRequestId,
    url,
    title: pr.title,
    description: pr.description ?? "",
    status: pr.status as PullRequest["status"],
    isDraft: pr.isDraft ?? false,
    sourceBranch: fromRef(pr.sourceRefName),
    targetBranch: fromRef(pr.targetRefName),
    createdBy: pr.createdBy?.displayName ?? null,
    creationDate: pr.creationDate,
    closedDate: pr.closedDate ?? null,
    mergeStatus: pr.mergeStatus ?? null,
    lastMergeSourceCommit: pr.lastMergeSourceCommit?.commitId ?? null,
    lastMergeCommit: pr.lastMergeCommit?.commitId ?? null,
    reviewers: (pr.reviewers ?? []).map((r) => ({
      id: r.id ?? "",
      displayName: r.displayName ?? "",
      uniqueName: r.uniqueName ?? null,
      vote: r.vote,
      voteLabel: VOTE_LABELS[r.vote] ?? String(r.vote),
      isRequired: r.isRequired ?? false,
    })),
    threads: (threads ?? []).filter((t) => !t.isDeleted).map(toThread),
    threadsIncluded: threads !== null,
    fetchedAt,
  };
}

/** Load a pull request and, optionally, its threads. */
export async function fetchPullRequest(
  client: AdoClient,
  pullRequestId: number,
  includeThreads: boolean,
  signal?: AbortSignal,
): Promise<PullRequest> {
  const [pr, threads] = await Promise.all([
    client.request<RawPullRequest>(
      "GET",
      `/pullrequests/${pullRequestId}`,
      {},
      undefined,
      signal,
      RawPullRequestShape,
    ),
    includeThreads
      ? client.request<{ value: RawThread[] }>(
        "GET",
        `/pullrequests/${pullRequestId}/threads`,
        {},
        undefined,
        signal,
        RawThreadListShape,
      ).then((r) => r.value)
      : Promise.resolve(null),
  ]);
  return toPullRequest(
    pr,
    threads,
    client.webUrl(pullRequestId),
    new Date().toISOString(),
  );
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

function clientFor(ctx: MethodContext): AdoClient {
  return new AdoClient(
    GlobalArgsSchema.parse(ctx.globalArgs),
    fetch,
    3,
    logRetries(ctx),
  );
}

/** The open pull request from `source` to `target`, if there is one. */
async function findActivePullRequest(
  client: AdoClient,
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const found = await client.request<{ value: RawPullRequest[] }>(
    "GET",
    "/pullrequests",
    {
      "searchCriteria.sourceRefName": toRef(source),
      "searchCriteria.targetRefName": toRef(target),
      "searchCriteria.status": "active",
    },
    undefined,
    signal,
    RawPullRequestListShape,
  );
  return found.value[0]?.pullRequestId;
}

async function writeSnapshot(
  ctx: MethodContext,
  pr: PullRequest,
): Promise<{ name: string }> {
  return await ctx.writeResource("pullRequest", `pr-${pr.id}`, pr);
}

/** Find a comment containing `marker` in any thread. */
export function findComment(
  threads: Thread[],
  marker: string,
): { thread: Thread; commentId: number } | null {
  for (const thread of threads) {
    const hit = thread.comments.find((c) => c.content.includes(marker));
    if (hit) return { thread, commentId: hit.id };
  }
  return null;
}

/** Model definition for `@bmonty/azure-devops/pull-request`. */
export const model = {
  type: "@bmonty/azure-devops/pull-request",
  version: "2026.10.27.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.27.1",
      description:
        "Connection settings moved to a shared module; no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    pullRequest: {
      description:
        "Pull request snapshot with reviewers and threads (`pr-<id>`)",
      schema: PullRequestSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    branchRef: {
      description: "Pull request for a source branch (`branch-<slug>`)",
      schema: BranchRefSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    comment: {
      description:
        "A comment posted or found (`comment-<threadId>-<commentId>`)",
      schema: PostedCommentSchema,
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    ensurePullRequest: {
      description:
        "Return the open pull request from a branch to a target, creating it (draft by default) if none exists",
      arguments: z.object({
        sourceBranch: z.string().min(1).describe("Branch with the changes."),
        targetBranch: z.string().min(1).describe("Branch to merge into."),
        title: z.string().min(1).max(400),
        description: z.string().max(4000).default(""),
        draft: z.boolean().default(true),
      }),
      execute: async (
        args: {
          sourceBranch: string;
          targetBranch: string;
          title: string;
          description: string;
          draft: boolean;
        },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        ctx.logger.info("Finding pull request {source} -> {target}", {
          source: args.sourceBranch,
          target: args.targetBranch,
        });
        let id = await findActivePullRequest(
          client,
          args.sourceBranch,
          args.targetBranch,
          ctx.signal,
        );
        let created = id === undefined;
        if (created) {
          try {
            const pr = await client.request<RawPullRequest>(
              "POST",
              "/pullrequests",
              {},
              {
                sourceRefName: toRef(args.sourceBranch),
                targetRefName: toRef(args.targetBranch),
                title: args.title,
                description: args.description,
                isDraft: args.draft,
              },
              ctx.signal,
              RawPullRequestShape,
            );
            id = pr.pullRequestId;
          } catch (error) {
            // Another run created it between the search and the create.
            if (!(error instanceof AdoError) || error.status !== 409) {
              throw error;
            }
            id = await findActivePullRequest(
              client,
              args.sourceBranch,
              args.targetBranch,
              ctx.signal,
            );
            if (id === undefined) throw error;
            created = false;
          }
        }
        const pr = await fetchPullRequest(client, id!, true, ctx.signal);
        ctx.logger.info("Pull request {id} {action}: {url}", {
          id: pr.id,
          action: created ? "created" : "reused",
          url: pr.url,
        });
        return {
          dataHandles: [
            await writeSnapshot(ctx, pr),
            await ctx.writeResource(
              "branchRef",
              `branch-${branchSlug(args.sourceBranch)}`,
              {
                sourceBranch: fromRef(args.sourceBranch),
                targetBranch: fromRef(args.targetBranch),
                pullRequestId: pr.id,
                url: pr.url,
                created,
                resolvedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },
    get: {
      description:
        "Read a pull request's status, draft flag, reviewer votes, and comment threads",
      arguments: z.object({
        pullRequestId: z.number().int().positive(),
        includeThreads: z.boolean().default(true),
      }),
      execute: async (
        args: { pullRequestId: number; includeThreads: boolean },
        ctx: MethodContext,
      ): MethodResult => {
        ctx.logger.info("Reading pull request {id}", {
          id: args.pullRequestId,
        });
        const pr = await fetchPullRequest(
          clientFor(ctx),
          args.pullRequestId,
          args.includeThreads,
          ctx.signal,
        );
        ctx.logger.info(
          "Pull request {id} is {status}{draft}: {reviewers} reviewer(s), {threads} thread(s)",
          {
            id: pr.id,
            status: pr.status,
            draft: pr.isDraft ? " (draft)" : "",
            reviewers: pr.reviewers.length,
            threads: pr.threadsIncluded ? pr.threads.length : "unread",
          },
        );
        return { dataHandles: [await writeSnapshot(ctx, pr)] };
      },
    },
    update: {
      description:
        "Publish a draft (draft: false), return it to draft, or change the title or description",
      arguments: z.object({
        pullRequestId: z.number().int().positive(),
        draft: z.boolean().optional(),
        title: z.string().min(1).max(400).optional(),
        description: z.string().max(4000).optional(),
      }),
      execute: async (
        args: {
          pullRequestId: number;
          draft?: boolean;
          title?: string;
          description?: string;
        },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        const patch: Record<string, unknown> = {};
        if (args.draft !== undefined) patch.isDraft = args.draft;
        if (args.title !== undefined) patch.title = args.title;
        if (args.description !== undefined) {
          patch.description = args.description;
        }
        if (Object.keys(patch).length === 0) {
          throw new Error(
            "Nothing to update: give draft, title, or description",
          );
        }
        ctx.logger.info("Updating pull request {id}: {fields}", {
          id: args.pullRequestId,
          fields: Object.keys(patch).join(", "),
        });
        await client.request(
          "PATCH",
          `/pullrequests/${args.pullRequestId}`,
          {},
          patch,
          ctx.signal,
        );
        // Threads too: this snapshot replaces the latest `pr-<id>`.
        const pr = await fetchPullRequest(
          client,
          args.pullRequestId,
          true,
          ctx.signal,
        );
        ctx.logger.info("Updated pull request {id}{draft}", {
          id: pr.id,
          draft: pr.isDraft ? " (draft)" : "",
        });
        return { dataHandles: [await writeSnapshot(ctx, pr)] };
      },
    },
    addComment: {
      description:
        "Start a new comment thread on the pull request (markdown), optionally skipped if a marker is already present",
      arguments: z.object({
        pullRequestId: z.number().int().positive(),
        content: z.string().min(1).max(150000),
        status: ThreadStatusEnum.default("active").describe(
          "Thread status; use `closed` for informational comments.",
        ),
        skipIfContains: z.string().min(1).optional().describe(
          "Don't post if any existing comment contains this text; makes the call safe to retry.",
        ),
      }),
      execute: async (
        args: {
          pullRequestId: number;
          content: string;
          status: z.infer<typeof ThreadStatusEnum>;
          skipIfContains?: string;
        },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        let found: ReturnType<typeof findComment> = null;
        if (args.skipIfContains) {
          const pr = await fetchPullRequest(
            client,
            args.pullRequestId,
            true,
            ctx.signal,
          );
          found = findComment(pr.threads, args.skipIfContains);
        }
        let threadId: number;
        let commentId: number;
        let status: string;
        if (found) {
          threadId = found.thread.id;
          commentId = found.commentId;
          status = found.thread.status;
        } else {
          const thread = await client.request<RawThread>(
            "POST",
            `/pullrequests/${args.pullRequestId}/threads`,
            {},
            {
              comments: [{
                parentCommentId: 0,
                content: args.content,
                commentType: 1,
              }],
              status: args.status,
            },
            ctx.signal,
            RawThreadShape,
          );
          const first = thread.comments?.[0]?.id;
          if (first === undefined) {
            throw new Error(
              `Created thread ${thread.id} on pull request ${args.pullRequestId}, but the response has no comment id`,
            );
          }
          threadId = thread.id;
          commentId = first;
          status = thread.status ?? args.status;
        }
        ctx.logger.info(
          "{action} comment {commentId} in thread {threadId} on pull request {id}",
          {
            action: found ? "Found existing" : "Posted",
            commentId,
            threadId,
            id: args.pullRequestId,
          },
        );
        return {
          dataHandles: [
            await ctx.writeResource(
              "comment",
              `comment-${threadId}-${commentId}`,
              {
                pullRequestId: args.pullRequestId,
                threadId,
                commentId,
                content: args.content,
                threadStatus: status,
                existing: found !== null,
                postedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },
    reply: {
      description:
        "Reply to a comment thread and optionally set its status (e.g. fixed)",
      arguments: z.object({
        pullRequestId: z.number().int().positive(),
        threadId: z.number().int().positive(),
        content: z.string().min(1).max(150000),
        status: ThreadStatusEnum.optional().describe(
          "Set the thread status after replying (e.g. `fixed` once addressed).",
        ),
        skipIfContains: z.string().min(1).optional().describe(
          "Don't post if a comment in this thread already contains this text.",
        ),
      }),
      execute: async (
        args: {
          pullRequestId: number;
          threadId: number;
          content: string;
          status?: z.infer<typeof ThreadStatusEnum>;
          skipIfContains?: string;
        },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        const base =
          `/pullrequests/${args.pullRequestId}/threads/${args.threadId}`;
        let commentId: number | undefined;
        // The thread is needed for the marker check and, when the status is
        // left alone, to record the thread's real status.
        const thread = args.skipIfContains || !args.status
          ? toThread(
            await client.request<RawThread>(
              "GET",
              base,
              {},
              undefined,
              ctx.signal,
              RawThreadShape,
            ),
          )
          : null;
        if (args.skipIfContains && thread) {
          const marker = args.skipIfContains;
          commentId = thread.comments.find((c) => c.content.includes(marker))
            ?.id;
        }
        const existing = commentId !== undefined;
        if (!existing) {
          const posted = await client.request<RawComment>(
            "POST",
            `${base}/comments`,
            {},
            { content: args.content, parentCommentId: 1, commentType: 1 },
            ctx.signal,
            RawCommentShape,
          );
          commentId = posted.id;
        }
        let status = thread?.status ?? "unknown";
        if (args.status) {
          const updated = await client.request<RawThread>(
            "PATCH",
            base,
            {},
            { status: args.status },
            ctx.signal,
            RawCommentShape,
          );
          status = updated.status ?? args.status;
        }
        ctx.logger.info(
          "{action} reply {commentId} in thread {threadId} on pull request {id}; thread is {status}",
          {
            action: existing ? "Found existing" : "Posted",
            commentId,
            threadId: args.threadId,
            id: args.pullRequestId,
            status,
          },
        );
        return {
          dataHandles: [
            await ctx.writeResource(
              "comment",
              `comment-${args.threadId}-${commentId}`,
              {
                pullRequestId: args.pullRequestId,
                threadId: args.threadId,
                commentId: commentId!,
                content: args.content,
                threadStatus: status,
                existing,
                postedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },
    setThreadStatus: {
      description: "Set a comment thread's status (active, fixed, closed, ...)",
      arguments: z.object({
        pullRequestId: z.number().int().positive(),
        threadId: z.number().int().positive(),
        status: ThreadStatusEnum,
      }),
      execute: async (
        args: {
          pullRequestId: number;
          threadId: number;
          status: z.infer<typeof ThreadStatusEnum>;
        },
        ctx: MethodContext,
      ): MethodResult => {
        const client = clientFor(ctx);
        await client.request(
          "PATCH",
          `/pullrequests/${args.pullRequestId}/threads/${args.threadId}`,
          {},
          { status: args.status },
          ctx.signal,
        );
        const pr = await fetchPullRequest(
          client,
          args.pullRequestId,
          true,
          ctx.signal,
        );
        ctx.logger.info(
          "Set thread {threadId} on pull request {id} to {status}",
          {
            threadId: args.threadId,
            id: args.pullRequestId,
            status: args.status,
          },
        );
        return { dataHandles: [await writeSnapshot(ctx, pr)] };
      },
    },
  },
};
