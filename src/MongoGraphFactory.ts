import type { Db } from 'mongodb';
import {
  MongoStorageProvider,
  type MongoStorageProviderOptions,
} from './MongoStorageProvider';
import { Graph, GraphData, IGraphFactory, GraphManager, CachedStorageProvider, type IStorageProvider } from 'grafio';
/**
 * Factory options for MongoGraphFactory — omits graphId since that is set per-call.
 */
type MongoGraphFactoryOptions = Omit<MongoStorageProviderOptions, 'graphId'>;

/**
 * MongoDB-backed factory for `Graph` instances.
 *
 * Holds the long-lived `Db` connection reference. `forGraph(graphId)` returns a
 * lightweight `Graph` scoped to the given partition — no new I/O resources are
 * created on each call (Collection handles are stateless).
 *
 * Call `ensureIndexes()` once at application startup before any graph operations.
 *
 * @example
 * const factory = new MongoGraphFactory(db);
 * await factory.ensureIndexes();
 *
 * const graph = factory.forGraph('user-123');
 * await graph.addNode('Person', { name: 'Alice' });
 *
 * @example With caching enabled:
 * const factory = new MongoGraphFactory(db);
 * factory.initCache({
 *   maxNodesCount: 10000,
 *   maxEdgesCount: 20000,
 *   cacheStore: 'in-memory',
 *   evictionStrategy: 'LRU',
 *   preloadStrategy: 'recent',
 *   timestampProperty: 'createdAt',
 * });
 * await factory.ensureIndexes();
 *
 * const graph = factory.forGraph('user-123');
 * // All reads/writes go through CachedStorageProvider
 */
export class MongoGraphFactory implements IGraphFactory {
  private readonly _db: Db;
  private readonly _opts: MongoGraphFactoryOptions;

  /**
   * @param db   - An already-connected Mongo `Db` instance. The factory does not
   *               manage the connection lifecycle — that is the consumer's responsibility.
   * @param opts - Optional collection name overrides (no graphId here — that is
   *               set per-call in `forGraph`).
   */
  constructor(db: Db, opts: MongoGraphFactoryOptions = {}) {
    this._db = db;
    this._opts = opts;
  }

  /**
   * Creates all required MongoDB indexes.
   *
   * Call ONCE at application startup before any graph operations.
   * Safe to call multiple times (MongoDB's `createIndex` is idempotent).
   */
  async ensureIndexes(): Promise<void> {
    const probe = new MongoStorageProvider(this._db, { ...this._opts, graphId: 'default' });
    await probe.ensureIndexes();
  }

  /**
   * Returns a `Graph` instance scoped to the given `graphId`.
   *
   * Cheap to call — creates only stateless `Collection` references, no I/O.
   * Each returned `Graph` operates on its own isolated partition of the same
   * MongoDB collections.
   *
   * If `initCache()` was called, the Graph will use CachedStorageProvider
   * for improved read performance.
   *
   * @param graphId - Defaults to `"default"` when omitted.
   */
  forGraph(graphId: string = 'default'): Graph {
    const mongoProvider = new MongoStorageProvider(this._db, { ...this._opts, graphId });
    const provider = this._wrapWithCacheIfEnabled(mongoProvider, graphId);
    return new Graph(provider);
  }

  /**
   * Creates a Graph instance and imports the given graph data into it.
   * Convenience method that combines forGraph() + importJSON().
   *
   * @param data - The GraphData to import
   * @param graphId - Graph partition ID (defaults to 'default')
   * @returns A Graph instance with the imported data
   */
  async fromGraphData(data: GraphData, graphId: string = 'default'): Promise<Graph> {
    const mongoProvider = new MongoStorageProvider(this._db, { ...this._opts, graphId });
    const provider = this._wrapWithCacheIfEnabled(mongoProvider, graphId);

    // Filter data to only import nodes/edges that belong to this graphId
    // If data.graphId is set and doesn't match, skip (data is from different partition)
    // If data.graphId is not set, import all (backward compatible for legacy data)
    const filteredData: GraphData = {
      graphId,
      nodes: data.graphId === undefined || data.graphId === graphId ? data.nodes : [],
      edges: data.graphId === undefined || data.graphId === graphId ? data.edges : [],
    };

    const graph = new Graph(provider);
    await Graph.importJSON(filteredData, provider);
    return graph;
  }

  /**
   * Wraps the given MongoStorageProvider with CachedStorageProvider if caching is enabled
   * via GraphManager configuration. Returns the original provider if caching is disabled.
   */
  private _wrapWithCacheIfEnabled(
    mongoProvider: MongoStorageProvider,
    graphId: string
  ): IStorageProvider {
    if (!GraphManager.isInitialized()) {
      return mongoProvider;
    }

    const manager = GraphManager.getInstance();
    const cacheManager = manager.getCacheManager();
    if (!cacheManager) {
      return mongoProvider;
    }

    const cacheConfig = manager.getConfig()?.cache;
    if (!cacheConfig) {
      return mongoProvider;
    }

    return new CachedStorageProvider(
      mongoProvider,
      graphId,
      cacheManager,
      cacheConfig
    );
  }
}