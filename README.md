# @bmonty/azure-devops

A [swamp](https://github.com/swamp-club/swamp) extension for Azure DevOps, with
two types:

- `@bmonty/azure-devops/pull-request` runs a pull request review loop from swamp
  workflows: create or find a draft pull request for a branch, read reviewer
  votes and every comment thread, publish the draft, and reply to or resolve
  threads. Typical use: an automated agent pushes a branch, opens a draft PR,
  and responds to review feedback until a human approves.
- `@bmonty/azure-devops/pipeline` queues YAML pipeline runs with runtime
  parameters and follows them stage by stage, stopping when a stage waits on an
  approval. See [Pipelines](#pipelines).

Contributions of other Azure DevOps types (work items, ...) are welcome under
the same package.

## Installation

```sh
swamp extension pull @bmonty/azure-devops
```

## Setup

Create a personal access token with **Code (Read & Write)** scope, store it in a
vault, and create a behavior for your repository. Comments and replies are
attributed to the token's owner, so consider a dedicated account.

```sh
swamp vault put default ADO_PAT
swamp behavior create @bmonty/azure-devops/pull-request my-repo-prs
```

```yaml
# models/@bmonty/azure-devops/pull-request/my-repo-prs.yaml
globalArguments:
  organization: myorg
  project: MyProject
  repository: my-repo
  pat: ${{ vault.get(default, ADO_PAT) }}
```

## Methods

| Method              | Arguments                                                                           | Writes                                 |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| `ensurePullRequest` | `sourceBranch`, `targetBranch`, `title`, `description?`, `draft?` (default `true`)  | `pr-<id>`, `branch-<sourceBranchSlug>` |
| `get`               | `pullRequestId`, `includeThreads?` (default `true`)                                 | `pr-<id>`                              |
| `update`            | `pullRequestId`, `draft?`, `title?`, `description?`                                 | `pr-<id>`                              |
| `addComment`        | `pullRequestId`, `content`, `status?` (default `active`), `skipIfContains?`         | `comment-<threadId>-<commentId>`       |
| `reply`             | `pullRequestId`, `threadId`, `content`, `status?` (e.g. `fixed`), `skipIfContains?` | `comment-<threadId>-<commentId>`       |
| `setThreadStatus`   | `pullRequestId`, `threadId`, `status`                                               | `pr-<id>`                              |

`ensurePullRequest` reuses the open pull request from the same source to the
same target instead of creating a second one, and `branch-<slug>` gives
workflows a stable name to find its id:

```
data.latest("my-repo-prs", "branch-feature-my-change").attributes.pullRequestId
data.latest("my-repo-prs", "pr-42").attributes.reviewers
```

The `pr-<id>` snapshot includes each reviewer's `vote` and a readable
`voteLabel` (`approved`, `approvedWithSuggestions`, `noVote`,
`waitingForAuthor`, `rejected`), the PR `status` (`active`, `completed`,
`abandoned`), `isDraft`, and every non-deleted thread with its file, line,
status, and comments. Comments have `commentType` `text` (people) or `system`
(Azure DevOps events such as votes and pushes). `get` with
`includeThreads: false` writes an empty `threads` list with
`threadsIncluded: false`, so check that flag before treating it as "no
comments".

## Pipelines

`@bmonty/azure-devops/pipeline` lists YAML pipelines, previews a run, queues a
run with runtime parameters, and follows it stage by stage. Typical use: a
deploy workflow (or a chat bot) runs a pipeline with
`templateParameters: { environment: test }` and reports when it finishes or
stops at an approval.

Create a personal access token with **Build (Read & Execute)** scope. Runs are
requested as the token's owner, who needs permission to queue the pipeline.

```yaml
# models/@bmonty/azure-devops/pipeline/my-deploys.yaml
globalArguments:
  organization: myorg
  project: MyProject
  pat: ${{ vault.get(default, ADO_PIPELINES_PAT) }}
```

| Method     | Arguments                                                                                                     | Writes                               |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `list`     | `folder?`                                                                                                     | `pipelines`                          |
| `preview`  | `pipelineId`, `branch?`, `templateParameters?`, `variables?`, `stagesToSkip?`                                 | `preview-<pipelineId>`               |
| `run`      | `pipelineId`, `branch?`, `templateParameters?`, `variables?`, `stagesToSkip?`, `waitMinutes?`, `pollSeconds?` | `run-<runId>`, `latest-<pipelineId>` |
| `listRuns` | `pipelineId`, `top?` (default 10)                                                                             | `runs-<pipelineId>`                  |
| `getRun`   | `pipelineId`, `runId`, `waitMinutes?`, `pollSeconds?`                                                         | `run-<runId>`                        |

`preview` returns the final YAML without running anything, so it checks
parameter values safely. With `waitMinutes`, `run` and `getRun` keep checking
until the run completes or a stage waits on an approval, whichever comes first;
the snapshot then has `state`, `result`, every stage with its result, and
`waitingForApproval`. Approvals stay in Azure DevOps: gate production
environments with an approval check there, and a run queued from swamp stops at
it like any other run.

```
data.latest("my-deploys", "latest-12").attributes.result
data.latest("my-deploys", "latest-12").attributes.waitingForApproval
```

Each call to `run` queues a new run. The run is recorded (`run-<runId>`,
`latest-<pipelineId>`) as soon as it is queued, so if following it fails, the
error names the run and `latest-<pipelineId>` still points at it: read it with
`getRun` rather than retrying `run`, which would queue a second one.

`list` reads up to 1000 pipelines; `truncated` is true when there may be more.

## Behavior notes

- The token is sent as HTTP Basic auth, never in URLs.
- A wrong or expired token makes Azure DevOps return a sign-in page instead of
  an error; this is reported as a failure that says to check the token.
- Reads and updates are retried on HTTP 429, 5xx, and network errors, honoring
  `Retry-After` (capped at 60 seconds) or backing off exponentially; each retry
  is logged as a warning. Creates (new pull requests, comments, replies) are
  retried only on 429, so a retry never posts twice.
- Responses are checked for the fields the extension relies on; an unexpected
  shape fails with the field that was wrong.
- `baseUrl` must use https.
- If two runs create the same pull request at once, the second reuses the first
  one's pull request instead of failing.
- `skipIfContains` on `addComment` and `reply` makes posting safe to retry.

## Development

```sh
deno test extensions/models/azure_devops/
swamp extension source add /path/to/swamp-azure-devops
```

## License

MIT. See [LICENSE](LICENSE).
