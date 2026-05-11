# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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