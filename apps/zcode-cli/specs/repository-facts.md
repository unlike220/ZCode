# Repository Facts — Project Intelligence Phase 2

## Ownership and truth

Core Project Intelligence owns a disposable workspace index. Filesystem, Git,
compiler, tests and runtime observations remain canonical; facts are navigation
hints and must be verified by reading source before editing. Facts never contain
source contents or model summaries. Phase 1 state, Memory, sessions, ContextBuilder
and Dynamic Workflow retain their existing owners and schemas.

Contracts define runtime-validated records/tools; core derives facts through the
existing FileSystemPort and ExecutionPort. Node adapters execute IO. Parsing uses
the TypeScript compiler API already used in this workspace, declared directly as
a core dependency. A pure analyzer interface allows later languages without IO.

## Persistence and schema

Reuse resolveProjectIntelligenceRoot, including workspaceIdentity and path fallback:

```text
<cli-storage>/project-intelligence/projects/<existing-workspace-key>/
  state.json                         # unchanged Phase 1
  repository-facts.json               # independently versioned derived snapshot
  repository-facts-invalidation.json  # last observed mutation token
```

Snapshot schemaVersion 1 contains generation, indexedAt, provenance, files,
symbols, dependencies and summary. Provenance records Git HEAD/branch/dirty when
available, Git versus bounded filesystem enumeration, analyzer identity and the
mutation token observed when refresh began. Files use safe POSIX relative paths,
classification, language, byte size, available revision and analysis status.
Symbols have deterministic location-based IDs, name, kind, file, one-based start
and end locations, optional container and explicit export modifier information.
Dependencies retain source, raw specifier, kind, analyzer and only a known exact
relative target; no tsconfig/package resolution is invented. Test classification
uses filename/directory conventions; parsed imports provide framework indicators.
No source-to-test coverage relationship is inferred.

## Refresh, bounds and concurrency

```text
main project tool → per-workspace refresh admission → read snapshot/revision/token
  → Git candidates or bounded directory traversal → stat → bounded parse
  → stable sort → validate → atomic snapshot write → summary
repository-mutating tool → persist invalidation token → execute → persist token
read/turn projection → snapshot + current token → bounded lexical selection
```

Refresh is explicit, never per-turn. Main interactive/fork/workflow-parent sessions
use the same ownership gate as ProjectStateUpdate; children can read only.
Workspace root, not mutable shell cwd, determines scan scope. Git candidates are
tracked plus untracked nonignored files; tracked generated files may be retained
as metadata but are not parsed. Non-Git traversal skips dependency/build/VCS
directories, symlinks, and paths outside the workspace. Directory enumeration has
an optional port-level cap enforced by the Node adapter before materialization.

Limits: 2,000 files, 4,000 visited directories/entries per directory, depth 32,
256 KiB per parsed file, 16 MiB aggregate parsed input, 20,000 symbols and 20,000
dependencies, 16 MiB snapshot, 2 MiB Git output and 10 seconds per Git command.
Refresh tool timeout is 120 seconds; cancellation reaches IO and is checked between
files and before persistence. Oversized Git enumeration fails rather than using
an incomplete record. Partial scans explicitly report truncation and skipped files.

Same-process refreshes share a per-root promise queue; reads use atomic snapshots.
Existing filesystem revisions reject detected concurrent writes. As in Phase 1,
the current Node adapter revision check is not a cross-process transactional CAS:
simultaneous refreshes in separate processes can race. Derived facts are rebuildable;
generation is strictly increasing within serialized refreshes, not a global lock.
Invalidation is a separate atomic token so refresh cannot erase an intervening
mutation. Refresh captures the starting token; later token changes imply stale.
No remote ownership, lease or desktop/mobile delivery semantics change.

## Freshness and invalidation

Read states are `not_indexed`, `stale`, `unknown`. No `fresh` claim is made because
neither Git status nor a scan proves an atomic view against external edits.
Missing snapshot means not_indexed. A changed mutation token means stale; otherwise
the snapshot is unknown (observed at indexedAt, external edits unverified).
The executor uses existing resolved workspace-mutating capability flags before
and after execution, including failures/partial writes. Metadata tools are excluded.
Invalidation errors are logged and must not break ordinary tools; unknown remains
conservative. Background writes/external edits/hooks may outlive observations and
are never promised fresh. No watchers or full scans on reads/model requests.

## Retrieval, tools and context

RepositoryFactsRead accepts optional query, path prefix, kind and bounded limit
(default 20, maximum 50 total records). Rank deterministic lexical/path/symbol
matches, excluding generic question words; ties use stable persisted ordering.
Summary, provenance and freshness accompany selected facts; no-query reads return
a bounded preview. RepositoryFactsRefresh takes no model-supplied facts or paths,
writes only owned metadata, increments generation and returns summary/provenance.
Both use built-in permission, trace, cancellation, output budgets and schemas.

At the existing first-model-step projection, read existing facts and retrieve only
matches to current user input. Add at most 2,000 characters to the existing bounded
Project Intelligence reminder, within the total 6,000-character default. No relevant
facts means no facts section. Projection is turn-local, never durable conversation
history. Failure of either state or facts projection is independently logged so
the other continues. Facts are explicitly labeled uncertain/stale navigation hints.

## Failures

Missing snapshots do not create files. Corrupt/unsupported schema fails closed on
read and refresh; neither silently repairs it. Snapshot/scan IO errors propagate
as ordinary tool failures. Individual parse failures are counted and marked on
the file without losing other files; unsupported languages produce zero symbols.
Projection failure is logged and skips only that projection, never the model turn.

## Acceptance scenarios

Focused fixtures prove missing reads, deterministic relative file paths, no source
content persistence, Git ignored exclusions, bounded fallback, classification,
generation increments, same-workspace later-session reads and workspace isolation;
TS/JS AST symbols/dependencies and unsupported languages; real exact targets only;
test classification without coverage claims; relevant bounded filtering; unknown
and stale behavior; cancellation, corrupt/unsupported snapshots, per-file parser
errors and write failure; main/child registration; independent turn-local projection
and unchanged Phase 1 tests. Run required architecture, typecheck, lint and format
checks and report environmental/baseline failures accurately.

## Non-goals

Embeddings, vector databases, call graphs, LSP lifecycle, additional agent loops,
UI, watchers, automatic refresh, source-to-test mapping, memory replacement,
tsconfig alias resolution, unsupported-language regex symbols, cross-process locks.
