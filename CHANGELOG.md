# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [4.3.0] - 2026-11-26

### Updated to `grafio@^8.4.0`

- **Upgraded Core Dependency to `grafio@^8.4.0`:** Adds Cypher `SET n:Label` / `SET n:L1:L2`, `MERGE ... ON CREATE/MATCH SET n:Label`, `CypherSummary.labelsAdded`, and native `CypherQueryOptions.readOnly` with `ReadOnlyQueryError`. Refer to the [Grafio CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md) for full details.
- **Single-RTT `MongoStorageProvider.addNodeLabels()`:** Implemented `IStorageProvider.addNodeLabels()` using atomic `$addToSet: { labels: { $each: labels } }` with `updatedOn` timestamp update, transaction `ClientSession` support, and `NodeNotFoundError` enforcement.

## [4.2.0] - 2026-11-26

### Updated to `grafio@^8.2.0`

- **Upgraded Core Dependency to `grafio@^8.2.0`:** Brings postfix label and relationship-type predicates in Cypher expressions (`WHERE n:Preference OR n:Invariant`, `WHERE n:A|B`, `WHERE n:A:B`, `WHERE NOT n:Archived`, `WHERE r:TYPE_A|TYPE_B`) with native `NodeScanStep.types` (`{ $in: types }`) pushdown against MongoDB. Refer to the [Grafio CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md) for full details.

## [4.1.0] - 2026-11-20

### Tier 2 Batching & Server-Side Pushdown (`grafio@^8.1.0`)

- **Upgraded Core Dependency to `grafio@^8.1.0`:** Implemented the optional Tier 2 batch and pushdown capabilities introduced on `IStorageProvider` and re-exported `GroupedAggregateSpec`, `GroupedAggregateRequest`, and `GroupedAggregateRow`.
- **Batched Edge Adjacency & Deletion (`getEdgesBySources`, `getEdgesByTargets`, `deleteEdges`):**
  - Replaced `O(rows)` per-node edge fetches during multi-row Cypher joins and traversals with batched `$in` queries bounded by `_batchSize`, with `READ_PROJECTION` and per-endpoint `orderBy`/`limit` support.
  - Added `deleteEdges` using batched `deleteMany` so `removeNode(..., true)` removes all deduplicated incident edges in a single round-trip per chunk.
- **Server-Side Grouped Aggregation (`aggregateGrouped`):**
  - Pushed Cypher `MATCH ... RETURN key, count(...), sum(...), avg(...), min(...), max(...)` queries directly to a single MongoDB `$match -> $group` pipeline without streaming raw documents over TCP.
  - Preserved exact openCypher / `ClosureCompiler` parity for `undefined` vs `null` group keys, `NaN` exclusion, string/numeric `MIN`/`MAX`, and `AVG === 0` on empty groups.
- **Single-Query Shortest Path (`traverseShortestPath`):**
  - Executed unrestricted unweighted BFS `Graph.traverse` calls in a single MongoDB `$graphLookup` (`maxDepth: 5`) pipeline when paths fit within 6 hops or terminate early, returning `undefined` at the depth ceiling for transparent `grafio` batched BFS fallback on deeper graphs.

## [4.0.0] - 2026-11-19

### Breaking Changes
1. **Upgraded Core Dependency to `grafio@^8.0.0`:**
   - Implemented the `grafio@8.0.0` `IStorageProvider` contract in `MongoStorageProvider`.
   - Removed the deprecated `v7` granular property methods (`addProperty`, `updateProperty`, `deleteProperty`, `clearProperties`) and `PropertyAlreadyExistsError` / `PropertyNotFoundError` references in favor of unified `patchProperties`.
2. **Minimum Driver & Toolchain Requirements:**
   - Raised minimum `mongodb` driver dependency to `>= 7.0.0`.
   - Upgraded TypeScript to `^7.0.2` and migrated test/benchmark execution to `@swc/jest` + `tsx`.
   - Isolated production declaration builds (`tsconfig.json` `"types": []`) from Node/Jest ambient globals (`tsconfig.test.json`).
3. **Topology-Aware `supportsTransactions()`:**
   - `MongoStorageProvider.supportsTransactions()` now inspects the `MongoClient` topology and returns `false` on standalone `mongod` instances (and `true` on replica sets, `mongos` sharded clusters, and load-balanced clusters), preventing automatic Cypher write transactions from failing on standalone deployments.

### New Features
1. **Unified Atomic `patchProperties`:**
   - Single-round-trip `updateOne` handling partial merges (`set`), removals (`unset`), `undefined` key deletion, and full map replacement (`replace: true`) with `isPrimitive` validation.
2. **Atomic Batch Mutations (`insertNodes`, `insertEdges`):**
   - Chunked `insertMany` insertion with intra-batch duplicate detection and pre-flight duplicate checks across chunks, preserving `grafio@8.0.0`'s storage-level dangling-edge contract.
3. **Scoped & Compound Index Management + `indexEpoch`:**
   - Added `options?: CreateIndexOptions` (`labelOrType`) and `hasIndex(..., labelOrType)` scoping with `partialFilterExpression` isolation across graph partitions and label scopes.
   - Exposed monotonic `indexEpoch` shared across `MongoGraphFactory.forGraph()` instances for automatic `CypherEngine` `PlanCache` invalidation.
4. **Distinct Aggregations:**
   - `aggregateNodeProperty` and `aggregateEdgeProperty` now support `{ distinct: true }` and exclude `NaN` values for parity with `InMemoryStorageProvider`.

### Bug Fixes
1. **Node Property Index Field Fix:** Fixed `createIndex` indexing `type: 1` instead of `labels: 1` on node collections.
2. **openCypher Filter Parity:** Escaped regex metacharacters in `CONTAINS`, enforced case-sensitive `CONTAINS`/`STARTS_WITH`/`ENDS_WITH` matching, matched explicit `null` only on `= null`, and guarded null/undefined range comparisons (`>`, `<`, `>=`, `<=`).
3. **Dead Code Removal & Test Fixes:** Removed unused `_buildSimplePropertyFilter`, fixed `MongoGraphFactory.test.ts` `labels` fixtures, fixed `SocialGraph.mongo.test.ts` lazy provider binding so Facebook Social Graph scenarios run against MongoDB, and updated `tests/perf/entryPoint.ts` for `grafio@8.0.0`.

### Performance Improvements
1. **Covered Existence Checks (`{ _id: 0, id: 1 }`):** Eliminated WiredTiger document fetches in `hasNode`, `hasEdge`, batch duplicate pre-checks, and `importJSON` emptiness checks.
2. **Wire-Level Projection Stripping (`{ _id: 0, graphId: 0 }`):** Reduced BSON deserialization overhead and network payload size on node/edge reads and exports.
3. **In-Memory Index Metadata Cache (`WeakMap<Db, ...>`):** Eliminated repeated `grafio_index_metadata` round-trips during Cypher planning and `hasIndex`/`getIndex`/`getIndexes` calls (configurable via `cacheIndexMetadata`).
4. **Streamlined Edge Indexes & Single-RTT Operations:** Removed redundant `edge_graph_source` / `edge_graph_target` prefix indexes, collapsed `removeNodeLabels` to a single `updateOne`, short-circuited `getNodesByIds([])`, and parallelized `importJSON` / `exportJSON` streams.

## [3.15.0] - 2026-06-03
### ✨ New Features
1. **Updated to latest grafio v7.15.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md))

## [3.14.0] - 2026-06-01
### ✨ New Features
1. **Updated to latest grafio v7.14.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md))

## [3.13.1] - 2026-05-31
### 🐛 Bug Fixes
1. **`importJSON` now requires empty graph**
   - Throws `GraphError` if the target graph already contains any nodes
   - Prevents accidental data corruption when importing into an existing graph
   - Caller must call `clear()` before `importJSON()` on a non-empty graph

### ⚡ Performance
1. **Removed expensive edge source/target validation from `importJSON`**
   - Eliminated MongoDB query that checked if edges reference existing nodes
   - In-memory duplicate ID validation retained (O(n) Set-based, negligible cost)

## [3.13.0] - 2026-05-31
### ✨ New Features
1. **Updated to latest grafio v7.13.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md))

## [3.12.0] - 2026-05-30
### ✨ New Features
1. **Implemented `IStorageProvider.removeNodeLabels` in `MongoStorageProvider`**
   - Removes specified labels from a node's `labels` array using MongoDB's atomic `$pull` + `$in` operator in a single `updateOne` call.
   - Throws `NodeNotFoundError` if the node does not exist.
   - Labels in the argument not present on the node are silently ignored (consistent with `InMemoryStorageProvider` behaviour).
   - Fully supports optional transaction (`ClientSession`) passthrough.

## [3.11.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.11.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.10.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.10.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.9.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.9.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.8.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.8.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.7.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.7.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.6.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.6.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.5.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.5.1**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.4.0] - 2026-05-24
### ✨ New Features
1. **Updated to latest grafio v7.4.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.3.0] - 2026-05-20
### ✨ New Features
1. **Updated to latest grafio v7.3.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.2.0] - 2026-05-20
### ✨ New Features
1. **Updated to latest grafio v7.2.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.1.0] - 2026-05-17
### ✨ New Features
1. **Updated to latest grafio v7.1.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [3.0.0] - 2026-05-13

### ✨ New Features
1. **Updated to latest grafio v7.0.0**
   - Refer Grafio CHANGELOG for new features introduced ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

### 🚨 Breaking Changes
1. **`IStorageProvider` Interface Refactoring**
   - Refer Grafio CHANGELOG for breaking changes ([Grafio-CHANGELOG](https://github.com/satya-jugran/grafio/blob/main/CHANGELOG.md)) 

## [2.0.0] - 2026-05-11

### ✨ New Features

1. **Cypher Query Language Support**
   - Added read-only `CypherEngine` support via grafio 6.3.0
   - Execute openCypher-compatible queries against MongoDB-backed graphs
   - Supports `MATCH`, `WHERE`, `RETURN` (with `DISTINCT`), `ORDER BY`, `SKIP`, `LIMIT`
   - Pattern matching: typed/untyped nodes, directed edges, multi-label alternation, inline property maps
   - Variable-length edges: `[*1..3]`, `[*2]`, `[*]` with BFS/DFS traversal
   - Expressions: `AND`/`OR`/`NOT`, comparisons, arithmetic, `IN`, `NOT IN`, `IS NULL`, `IS NOT NULL`
   - Parameterized queries with `$name` placeholders
   - Import from `grafio/cypher` deep import path

2. **Promoted grafio and mongodb to dependencies**
   - Both `grafio` and `mongodb` are now hard dependencies (moved from peerDependencies)
   - Package cannot function without these core dependencies

## [1.2.0] - 2026-05-10

### ✨ New Features

1. **Total Node and Edge Count Methods**
   - Added `getTotalNodeCount()` for efficient node count queries
   - Added `getTotalEdgeCount()` for efficient edge count queries
   - Both methods support optional `graphId` parameter for partitioned counts

## [1.1.0] - 2026-05-08

### ✨ New Features

1. **IOrderBy Support for getAllNodes/getAllEdges**
   - `getAllNodes()` and `getAllEdges()` now accept optional `orderBy` parameter
   - Enables native MongoDB sorting before limiting for efficient queries
   - Supports ordering by `createdOn` or `updatedOn` fields in `asc` or `desc` order

2. **Caching Support via CachedStorageProvider**
   - Integrated `CachedStorageProvider` from grafio for improved read performance
   - `MongoGraphFactory` now supports `initCache()` configuration
   - Supports configurable cache settings: `maxNodesCount`, `maxEdgesCount`, `cacheStore`, `evictionStrategy`, `preloadStrategy`
   - `GraphManager` integration for centralized cache management
   - Exported caching types: `CacheConfig`, `CacheStats`, `EvictionStrategy`, `PreloadStrategy`, `CacheStoreType`, `ICacheProvider`
   - `InMemoryCache` provider available for in-memory caching

### 🐛 Bug Fixes

1. **Fixed importJSON Missing Timestamps**
   - `importJSON()` now correctly includes `createdOn` and `updatedOn` in bulk node/edge inserts
   - Previously timestamps were only set on individual operations, not during JSON import
