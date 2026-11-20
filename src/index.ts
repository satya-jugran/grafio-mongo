// Re-export MongoDB implementations from grafio-mongo
export { MongoStorageProvider, IndexAlreadyExistsError } from './MongoStorageProvider';
export type { MongoStorageProviderOptions } from './MongoStorageProvider';
export { MongoGraphFactory } from './MongoGraphFactory';

// Re-export storage & caching types from grafio
export type {
  CreateIndexOptions,
  GroupedAggregateRequest,
  GroupedAggregateRow,
  GroupedAggregateSpec,
  IndexMetadata,
  PropertyPatch,
} from 'grafio';
export { GraphManager } from 'grafio';
export type { GraphManagerConfig, CacheConfig, CacheStats } from 'grafio';
export { CachedStorageProvider, CacheManager } from 'grafio';
export type { EvictionStrategy, PreloadStrategy, CacheStoreType } from 'grafio';
export { InMemoryCache } from 'grafio';
export type { ICacheProvider } from 'grafio';
