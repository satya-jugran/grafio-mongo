# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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