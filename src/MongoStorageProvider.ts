import { MongoClient } from 'mongodb';
import type {
  ClientSession,
  Collection,
  Db,
  Document,
  Filter,
  WithId,
} from 'mongodb';

import {
  isPrimitive,
  type CreateIndexOptions,
  type EdgeData,
  type GraphData,
  type IndexMetadata,
  type IStorageProvider,
  type ITransactionHandle,
  type NodeData,
  type PropertyPatch,
  type StorageQueryOptions,
} from 'grafio';

import {
  EdgeAlreadyExistsError,
  EdgeNotFoundError,
  GraphError,
  InvalidPropertyError,
  NodeAlreadyExistsError,
  NodeNotFoundError,
} from 'grafio/errors';

type QueryOptionsFilterProperty = NonNullable<
  NonNullable<StorageQueryOptions['filter']>['properties']
>[number];
type AggregateResult = Awaited<ReturnType<IStorageProvider['aggregateNodeProperty']>>;
type ReadonlyNodeData = Awaited<ReturnType<IStorageProvider['getNodes']>>[number];
type ReadonlyEdgeData = Awaited<ReturnType<IStorageProvider['getEdges']>>[number];

/**
 * Error thrown when attempting to create an index that already exists.
 */
export class IndexAlreadyExistsError extends GraphError {
  constructor(indexName: string) {
    super(`Index '${indexName}' already exists`);
    this.name = 'IndexAlreadyExistsError';
    Object.setPrototypeOf(this, IndexAlreadyExistsError.prototype);
  }
}

/**
 * MongoDB document shape for nodes.
 * `id` — the node's own element id
 * `graphId` — the graph partition key this node belongs to
 */
interface NodeDoc extends Document {
  id: string;
  graphId: string;
  labels: string[];
  createdOn: number;
  updatedOn: number;
  properties: Record<string, unknown>;
}

/**
 * MongoDB document shape for edges.
 * `id` — the edge's own element id
 * `graphId` — the graph partition key this edge belongs to
 */
interface EdgeDoc extends Document {
  id: string;
  graphId: string;
  sourceId: string;
  targetId: string;
  type: string;
  createdOn: number;
  updatedOn: number;
  properties: Record<string, unknown>;
}

interface StoredIndexMeta {
  name: string;
  target: 'node' | 'edge';
  propertyKeys: string[];
  sortedSig: string;
  labelOrType?: string;
  mongoIndexNames: string[];
}

interface PartitionIndexState {
  epoch: number;
  loaded: boolean;
  entries: Map<string, StoredIndexMeta>;
}

const ID_ONLY_PROJECTION = Object.freeze({ _id: 0, id: 1 });
const READ_PROJECTION = Object.freeze({ _id: 0, graphId: 0 });
const DEFAULT_BULK_BATCH_SIZE = 5000;

const PARTITION_INDEX_CACHE = new WeakMap<Db, Map<string, PartitionIndexState>>();

/**
 * Configuration options for MongoStorageProvider.
 */
export interface MongoStorageProviderOptions {
  /**
   * Graph partition key. All nodes/edges stored by this provider belong to this graph.
   * @default 'default'
   */
  graphId?: string;

  /**
   * Name of the MongoDB collection for nodes.
   * @default 'grafiodb_nodes'
   */
  nodesCollection?: string;

  /**
   * Name of the MongoDB collection for edges.
   * @default 'grafiodb_edges'
   */
  edgesCollection?: string;

  /**
   * Batch size for cursor-based iteration and chunked bulk writes.
   * @default 1000
   */
  batchSize?: number;

  /**
   * Cache `grafio_index_metadata` and monotonic `indexEpoch` per `(Db, partition)` in memory.
   * Disable when external processes mutate MongoDB index metadata directly.
   * @default true
   */
  cacheIndexMetadata?: boolean;
}

/**
 * MongoDB-backed storage provider for `grafio`.
 *
 * ## Setup
 * ```typescript
 * import { MongoClient } from 'mongodb';
 * import { Graph } from 'grafio';
 * import { MongoStorageProvider } from 'grafio-mongo';
 *
 * const client = new MongoClient('mongodb://localhost:27017');
 * await client.connect();
 *
 * const provider = new MongoStorageProvider(client.db('mydb'));
 * await provider.ensureIndexes();
 *
 * const graph = new Graph(provider);
 * ```
 *
 * ## Collections
 * Three collections are used (default names):
 *  - `grafiodb_nodes`         — one document per node
 *  - `grafiodb_edges`         — one document per edge
 *  - `grafio_index_metadata`  — named/scoped property index definitions
 *
 * ## Indexes
 * Call `ensureIndexes()` once on startup. It creates:
 *  - Unique compound index on `(graphId, id)` for both collections (fast covered id lookups)
 *  - Index on `(graphId, labels)` for node label filter queries
 *  - Index on `(graphId, type)` for edge type filter queries
 *  - Compound index on `(graphId, sourceId, type)` for outgoing adjacency queries
 *  - Compound index on `(graphId, targetId, type)` for incoming adjacency queries
 *  - Unique compound index on `(graphId, name)` for `grafio_index_metadata`
 *
 * ## Thread safety
 * MongoDB operations are inherently safe for concurrent use.
 * Wrap multi-step graph mutations in a `GraphTransaction` on replica sets or sharded clusters.
 */
export class MongoStorageProvider implements IStorageProvider {
  private readonly _db: Db;
  private readonly _nodes: Collection<NodeDoc>;
  private readonly _edges: Collection<EdgeDoc>;
  private readonly _indexMeta: Collection<Document>;
  private readonly _graphId: string;
  private readonly _batchSize: number;
  private readonly _hasCustomBatchSize: boolean;
  private readonly _cacheIndexMetadata: boolean;
  private readonly _partitionKey: string;
  private readonly _client: MongoClient | null = null;

  /**
   * @param db   - An already-connected Mongo `Db` instance.
   * @param opts - Optional configuration including graphId (partition key).
   */
  constructor(db: Db, opts: MongoStorageProviderOptions = {}) {
    this._db = db;
    const nodesColl = opts.nodesCollection ?? 'grafiodb_nodes';
    const edgesColl = opts.edgesCollection ?? 'grafiodb_edges';

    this._nodes = db.collection<NodeDoc>(nodesColl);
    this._edges = db.collection<EdgeDoc>(edgesColl);
    this._indexMeta = db.collection<Document>('grafio_index_metadata');
    this._graphId = opts.graphId ?? 'default';

    if (opts.batchSize !== undefined && (!Number.isInteger(opts.batchSize) || opts.batchSize <= 0)) {
      throw new Error(`batchSize must be a positive integer, got: ${opts.batchSize}`);
    }
    this._hasCustomBatchSize = opts.batchSize !== undefined;
    this._batchSize = opts.batchSize ?? 1000;
    this._cacheIndexMetadata = opts.cacheIndexMetadata ?? true;
    this._partitionKey = `${nodesColl}|${edgesColl}|${this._graphId}`;

    if ('client' in db && db.client instanceof MongoClient) {
      this._client = db.client;
    }
  }

  /** Monotonic schema/index epoch counter incremented on createIndex/deleteIndex/clear. */
  get indexEpoch(): number {
    return this._getPartitionState().epoch;
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  /**
   * Creates all required MongoDB indexes.
   * Safe to call multiple times (MongoDB's `createIndex` is idempotent).
   *
   * Call once on application startup before performing any graph operations.
   */
  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this._nodes.createIndex({ graphId: 1, id: 1 }, { unique: true, name: 'node_graph_id_unique' }),
      this._nodes.createIndex({ graphId: 1, labels: 1 }, { name: 'node_graph_labels' }),
      this._edges.createIndex({ graphId: 1, id: 1 }, { unique: true, name: 'edge_graph_id_unique' }),
      this._edges.createIndex({ graphId: 1, type: 1 }, { name: 'edge_graph_type' }),
      this._edges.createIndex({ graphId: 1, sourceId: 1, type: 1 }, { name: 'edge_graph_source_type' }),
      this._edges.createIndex({ graphId: 1, targetId: 1, type: 1 }, { name: 'edge_graph_target_type' }),
      this._indexMeta.createIndex(
        { graphId: 1, name: 1 },
        { unique: true, name: 'index_meta_graph_name_unique' },
      ),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async clear(): Promise<void> {
    const indexes = await this.getIndexes();
    if (indexes.length > 0) {
      await Promise.all(indexes.map((index) => this.deleteIndex(index.name)));
    }

    await Promise.all([
      this._nodes.deleteMany({ graphId: this._graphId }),
      this._edges.deleteMany({ graphId: this._graphId }),
    ]);

    const state = this._getPartitionState();
    state.entries.clear();
    state.loaded = true;
    if (indexes.length === 0) {
      state.epoch++;
    }
  }

  // ---------------------------------------------------------------------------
  // Node mutations
  // ---------------------------------------------------------------------------

  async insertNode(node: NodeData, transaction?: ITransactionHandle): Promise<void> {
    const now = Date.now();
    if (node.createdOn === undefined) {
      node.createdOn = now;
    }
    if (node.updatedOn === undefined) {
      node.updatedOn = now;
    }

    const session = transaction?.context as ClientSession | undefined;
    try {
      await this._nodes.insertOne(
        {
          id: node.id,
          graphId: this._graphId,
          labels: [...node.labels],
          createdOn: node.createdOn,
          updatedOn: node.updatedOn,
          properties: node.properties,
        } as NodeDoc,
        { session },
      );
    } catch (e: unknown) {
      if (this._isDuplicateKeyError(e)) throw new NodeAlreadyExistsError(node.id);
      throw e;
    }
  }

  async insertNodes(nodes: readonly NodeData[], transaction?: ITransactionHandle): Promise<void> {
    if (nodes.length === 0) return;

    const seenIds = new Set<string>();
    const allIds: string[] = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const id = nodes[i].id;
      if (seenIds.has(id)) {
        throw new NodeAlreadyExistsError(id);
      }
      seenIds.add(id);
      allIds[i] = id;
    }

    const session = transaction?.context as ClientSession | undefined;
    for (let i = 0; i < allIds.length; i += this._batchSize) {
      const sliceIds = allIds.slice(i, i + this._batchSize);
      const existing = await this._nodes.findOne(
        { graphId: this._graphId, id: { $in: sliceIds } },
        { projection: ID_ONLY_PROJECTION, session },
      );
      if (existing) {
        throw new NodeAlreadyExistsError(existing.id as string);
      }
    }

    const now = Date.now();
    const docs: NodeDoc[] = nodes.map((n) => {
      if (n.createdOn === undefined) n.createdOn = now;
      if (n.updatedOn === undefined) n.updatedOn = now;
      return {
        id: n.id,
        graphId: this._graphId,
        labels: [...n.labels],
        createdOn: n.createdOn,
        updatedOn: n.updatedOn,
        properties: n.properties,
      };
    });

    for (let i = 0; i < docs.length; i += this._batchSize) {
      const chunk = docs.slice(i, i + this._batchSize);
      try {
        await this._nodes.insertMany(chunk, { ordered: true, session });
      } catch (e: unknown) {
        if (this._isDuplicateKeyError(e)) {
          throw new NodeAlreadyExistsError(this._extractDuplicateId(e) ?? chunk[0].id);
        }
        throw e;
      }
    }
  }

  async deleteNode(id: string, transaction?: ITransactionHandle): Promise<void> {
    const session = transaction?.context as ClientSession | undefined;
    await this._nodes.deleteOne({ graphId: this._graphId, id }, { session });
  }

  /**
   * Removes the specified labels from a node's labels array in a single round-trip.
   * Labels in the argument that are not present on the node are silently ignored.
   * @throws NodeNotFoundError if the node does not exist
   */
  async removeNodeLabels(
    nodeId: string,
    labels: string[],
    transaction?: ITransactionHandle,
  ): Promise<void> {
    const session = transaction?.context as ClientSession | undefined;
    const result = await this._nodes.updateOne(
      { graphId: this._graphId, id: nodeId },
      {
        $pull: { labels: { $in: labels } },
        $set: { updatedOn: Date.now() },
      } as Document,
      { session },
    );

    if (result.matchedCount === 0) {
      throw new NodeNotFoundError(nodeId);
    }
  }

  // ---------------------------------------------------------------------------
  // Node queries
  // ---------------------------------------------------------------------------

  async hasNode(id: string, transaction?: ITransactionHandle): Promise<boolean> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._nodes.findOne(
      { graphId: this._graphId, id },
      { projection: ID_ONLY_PROJECTION, session },
    );
    return doc !== null;
  }

  async getNode(id: string, transaction?: ITransactionHandle): Promise<ReadonlyNodeData | undefined> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._nodes.findOne(
      { graphId: this._graphId, id },
      { projection: READ_PROJECTION, session },
    );
    return doc ? this._docToNode(doc) : undefined;
  }

  async getNodesByIds(
    ids: string[],
    transaction?: ITransactionHandle,
  ): Promise<Map<string, ReadonlyNodeData>> {
    if (ids.length === 0) {
      return new Map<string, ReadonlyNodeData>();
    }

    const session = transaction?.context as ClientSession | undefined;
    const cursor = this._nodes.find(
      { graphId: this._graphId, id: { $in: ids } },
      { projection: READ_PROJECTION, session },
    );
    const nodes = new Map<string, ReadonlyNodeData>();
    for await (const doc of cursor) {
      nodes.set(doc.id, this._docToNode(doc));
    }
    return nodes;
  }

  async getNodeCount(options?: StorageQueryOptions): Promise<number> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const filter = this._buildEntityFilter<NodeDoc>('labels', options);
    return this._nodes.countDocuments(filter, { session });
  }

  async aggregateNodeProperty(
    key: string,
    options?: StorageQueryOptions,
  ): Promise<AggregateResult> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const matchFilter = this._buildEntityFilter<NodeDoc>('labels', options);
    return this._aggregateProperty(this._nodes, matchFilter, key, options?.distinct, session);
  }

  async getNodes(options?: StorageQueryOptions): Promise<ReadonlyNodeData[]> {
    const filter = this._buildEntityFilter<NodeDoc>('labels', options);
    return this._executeListQuery(this._nodes, filter, (doc) => this._docToNode(doc), options);
  }

  // ---------------------------------------------------------------------------
  // Edge queries
  // ---------------------------------------------------------------------------

  async hasEdge(id: string, transaction?: ITransactionHandle): Promise<boolean> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._edges.findOne(
      { graphId: this._graphId, id },
      { projection: ID_ONLY_PROJECTION, session },
    );
    return doc !== null;
  }

  async getEdge(id: string, transaction?: ITransactionHandle): Promise<ReadonlyEdgeData | undefined> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._edges.findOne(
      { graphId: this._graphId, id },
      { projection: READ_PROJECTION, session },
    );
    return doc ? this._docToEdge(doc) : undefined;
  }

  async getEdgeCount(options?: StorageQueryOptions): Promise<number> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const filter = this._buildEntityFilter<EdgeDoc>('type', options);
    return this._edges.countDocuments(filter, { session });
  }

  async aggregateEdgeProperty(
    key: string,
    options?: StorageQueryOptions,
  ): Promise<AggregateResult> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const matchFilter = this._buildEntityFilter<EdgeDoc>('type', options);
    return this._aggregateProperty(this._edges, matchFilter, key, options?.distinct, session);
  }

  async getEdges(options?: StorageQueryOptions): Promise<ReadonlyEdgeData[]> {
    const filter = this._buildEntityFilter<EdgeDoc>('type', options);
    return this._executeListQuery(this._edges, filter, (doc) => this._docToEdge(doc), options);
  }

  async getEdgesBySource(
    nodeId: string,
    options?: StorageQueryOptions,
  ): Promise<ReadonlyEdgeData[]> {
    const filter = this._buildEntityFilter<EdgeDoc>('type', options, { sourceId: nodeId });
    return this._executeListQuery(this._edges, filter, (doc) => this._docToEdge(doc), options);
  }

  async getEdgesByTarget(
    nodeId: string,
    options?: StorageQueryOptions,
  ): Promise<ReadonlyEdgeData[]> {
    const filter = this._buildEntityFilter<EdgeDoc>('type', options, { targetId: nodeId });
    return this._executeListQuery(this._edges, filter, (doc) => this._docToEdge(doc), options);
  }

  // ---------------------------------------------------------------------------
  // Edge mutations
  // ---------------------------------------------------------------------------

  async insertEdge(edge: EdgeData, transaction?: ITransactionHandle): Promise<void> {
    const now = Date.now();
    if (edge.createdOn === undefined) {
      edge.createdOn = now;
    }
    if (edge.updatedOn === undefined) {
      edge.updatedOn = now;
    }

    const session = transaction?.context as ClientSession | undefined;
    try {
      await this._edges.insertOne(
        {
          id: edge.id,
          graphId: this._graphId,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          type: edge.type,
          createdOn: edge.createdOn,
          updatedOn: edge.updatedOn,
          properties: edge.properties,
        } as EdgeDoc,
        { session },
      );
    } catch (e: unknown) {
      if (this._isDuplicateKeyError(e)) throw new EdgeAlreadyExistsError(edge.id);
      throw e;
    }
  }

  async insertEdges(edges: readonly EdgeData[], transaction?: ITransactionHandle): Promise<void> {
    if (edges.length === 0) return;

    const seenIds = new Set<string>();
    const allIds: string[] = new Array(edges.length);
    for (let i = 0; i < edges.length; i++) {
      const id = edges[i].id;
      if (seenIds.has(id)) {
        throw new EdgeAlreadyExistsError(id);
      }
      seenIds.add(id);
      allIds[i] = id;
    }

    const session = transaction?.context as ClientSession | undefined;
    for (let i = 0; i < allIds.length; i += this._batchSize) {
      const sliceIds = allIds.slice(i, i + this._batchSize);
      const existing = await this._edges.findOne(
        { graphId: this._graphId, id: { $in: sliceIds } },
        { projection: ID_ONLY_PROJECTION, session },
      );
      if (existing) {
        throw new EdgeAlreadyExistsError(existing.id as string);
      }
    }

    const now = Date.now();
    const docs: EdgeDoc[] = edges.map((e) => {
      if (e.createdOn === undefined) e.createdOn = now;
      if (e.updatedOn === undefined) e.updatedOn = now;
      return {
        id: e.id,
        graphId: this._graphId,
        sourceId: e.sourceId,
        targetId: e.targetId,
        type: e.type,
        createdOn: e.createdOn,
        updatedOn: e.updatedOn,
        properties: e.properties,
      };
    });

    for (let i = 0; i < docs.length; i += this._batchSize) {
      const chunk = docs.slice(i, i + this._batchSize);
      try {
        await this._edges.insertMany(chunk, { ordered: true, session });
      } catch (e: unknown) {
        if (this._isDuplicateKeyError(e)) {
          throw new EdgeAlreadyExistsError(this._extractDuplicateId(e) ?? chunk[0].id);
        }
        throw e;
      }
    }
  }

  async deleteEdge(id: string, transaction?: ITransactionHandle): Promise<void> {
    const session = transaction?.context as ClientSession | undefined;
    await this._edges.deleteOne({ graphId: this._graphId, id }, { session });
  }

  // ---------------------------------------------------------------------------
  // Property mutations
  // ---------------------------------------------------------------------------

  /**
   * Patches properties on a node or edge atomically in a single round-trip.
   * @throws InvalidPropertyError if any value in `patch.set` is not a primitive
   * @throws NodeNotFoundError / EdgeNotFoundError if the target does not exist
   */
  async patchProperties(
    target: 'node' | 'edge',
    id: string,
    patch: PropertyPatch,
    transaction?: ITransactionHandle,
  ): Promise<void> {
    if (patch.set) {
      for (const [key, val] of Object.entries(patch.set)) {
        if (!isPrimitive(val)) {
          throw new InvalidPropertyError(key, val);
        }
      }
    }

    const session = transaction?.context as ClientSession | undefined;
    const collection = target === 'node' ? this._nodes : this._edges;
    const now = Date.now();

    if (patch.replace) {
      const nextProps: Record<string, unknown> = {};
      if (patch.set) {
        for (const [key, val] of Object.entries(patch.set)) {
          if (val !== undefined) {
            nextProps[key] = val;
          }
        }
      }
      const result = await collection.updateOne(
        { graphId: this._graphId, id },
        { $set: { properties: nextProps, updatedOn: now } },
        { session },
      );
      if (result.matchedCount === 0) {
        throw target === 'node' ? new NodeNotFoundError(id) : new EdgeNotFoundError(id);
      }
      return;
    }

    const setFields: Record<string, unknown> = { updatedOn: now };
    const unsetFields: Record<string, ''> = {};
    const setKeySet = new Set<string>();

    if (patch.set) {
      for (const [key, val] of Object.entries(patch.set)) {
        if (val === undefined) {
          unsetFields[`properties.${key}`] = '';
        } else {
          setFields[`properties.${key}`] = val;
          setKeySet.add(key);
        }
      }
    }

    if (patch.unset) {
      for (const key of patch.unset) {
        if (!setKeySet.has(key)) {
          unsetFields[`properties.${key}`] = '';
        }
      }
    }

    const updateDoc: Document = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
      updateDoc.$unset = unsetFields;
    }

    const result = await collection.updateOne(
      { graphId: this._graphId, id },
      updateDoc,
      { session },
    );
    if (result.matchedCount === 0) {
      throw target === 'node' ? new NodeNotFoundError(id) : new EdgeNotFoundError(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Data portability
  // ---------------------------------------------------------------------------

  async exportJSON(): Promise<GraphData> {
    const nodes: NodeData[] = [];
    const edges: EdgeData[] = [];

    const nodesCursor = this._nodes
      .find({ graphId: this._graphId }, { projection: READ_PROJECTION })
      .batchSize(this._batchSize);
    const edgesCursor = this._edges
      .find({ graphId: this._graphId }, { projection: READ_PROJECTION })
      .batchSize(this._batchSize);

    await Promise.all([
      (async () => {
        for await (const doc of nodesCursor) {
          nodes.push(this._docToNode(doc));
        }
      })(),
      (async () => {
        for await (const doc of edgesCursor) {
          edges.push(this._docToEdge(doc));
        }
      })(),
    ]);

    return {
      graphId: this._graphId,
      nodes,
      edges,
    };
  }

  /**
   * Imports graph data using concurrent chunked MongoDB `insertMany`.
   *
   * Requires the target graph to be empty. Throws GraphError if the graph
   * already contains any nodes or edges.
   */
  async importJSON(data: GraphData): Promise<void> {
    const [existingNode, existingEdge] = await Promise.all([
      this._nodes.findOne({ graphId: this._graphId }, { projection: ID_ONLY_PROJECTION }),
      this._edges.findOne({ graphId: this._graphId }, { projection: ID_ONLY_PROJECTION }),
    ]);

    if (existingNode || existingEdge) {
      throw new GraphError(
        `Graph with graphId '${this._graphId}' is not empty. Clear it first before importing.`,
      );
    }

    const nodeIdSet = new Set<string>();
    for (const n of data.nodes) {
      if (nodeIdSet.has(n.id)) throw new NodeAlreadyExistsError(n.id);
      nodeIdSet.add(n.id);
    }

    const edgeIdSet = new Set<string>();
    for (const e of data.edges) {
      if (edgeIdSet.has(e.id)) throw new EdgeAlreadyExistsError(e.id);
      edgeIdSet.add(e.id);
    }

    const bulkSize = this._hasCustomBatchSize
      ? this._batchSize
      : Math.max(this._batchSize, DEFAULT_BULK_BATCH_SIZE);
    const now = Date.now();
    const tasks: Promise<void>[] = [];

    if (data.nodes.length > 0) {
      const nodeDocs: NodeDoc[] = data.nodes.map((n) => ({
        id: n.id,
        graphId: this._graphId,
        labels: [...n.labels],
        createdOn: n.createdOn ?? now,
        updatedOn: n.updatedOn ?? now,
        properties: n.properties,
      }));
      tasks.push(
        (async () => {
          for (let i = 0; i < nodeDocs.length; i += bulkSize) {
            await this._nodes.insertMany(nodeDocs.slice(i, i + bulkSize), { ordered: false });
          }
        })(),
      );
    }

    if (data.edges.length > 0) {
      const edgeDocs: EdgeDoc[] = data.edges.map((e) => ({
        id: e.id,
        graphId: this._graphId,
        sourceId: e.sourceId,
        targetId: e.targetId,
        type: e.type,
        createdOn: e.createdOn ?? now,
        updatedOn: e.updatedOn ?? now,
        properties: e.properties,
      }));
      tasks.push(
        (async () => {
          for (let i = 0; i < edgeDocs.length; i += bulkSize) {
            await this._edges.insertMany(edgeDocs.slice(i, i + bulkSize), { ordered: false });
          }
        })(),
      );
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  // ---------------------------------------------------------------------------
  // Property Index Management
  // ---------------------------------------------------------------------------

  /**
   * Creates an index on node or edge properties (optionally scoped by label/type).
   */
  async createIndex(
    name: string,
    target: 'node' | 'edge',
    propertyKeys: string[],
    options?: CreateIndexOptions,
  ): Promise<void> {
    if (propertyKeys.length === 0) return;

    const labelOrType =
      options?.labelOrType && options.labelOrType !== '*' ? options.labelOrType : undefined;
    const sortedPropertyKeys = [...propertyKeys].sort();
    const sortedSig = sortedPropertyKeys.join('|');

    const entries = await this._loadIndexEntries();
    if (entries.has(name)) {
      throw new IndexAlreadyExistsError(name);
    }
    for (const existing of entries.values()) {
      if (
        existing.target === target &&
        existing.sortedSig === sortedSig &&
        existing.labelOrType === labelOrType
      ) {
        throw new IndexAlreadyExistsError(name);
      }
    }

    const propFields: Record<string, 1> = {};
    for (const propertyKey of sortedPropertyKeys) {
      propFields[`properties.${propertyKey}`] = 1;
    }

    const collection = target === 'node' ? this._nodes : this._edges;
    const scopeField = target === 'node' ? 'labels' : 'type';
    const mongoIndexNames: string[] = [];
    const indexSpecs: Array<{ keySpec: Record<string, 1>; idxName: string; pfe: Document }> = [];

    if (labelOrType === undefined) {
      const baseName = this._buildMongoIndexName(name, target, 'base', sortedPropertyKeys);
      const scopedName = this._buildMongoIndexName(name, target, 'scoped', sortedPropertyKeys);
      mongoIndexNames.push(baseName, scopedName);
      indexSpecs.push(
        {
          keySpec: { graphId: 1, ...propFields },
          idxName: baseName,
          pfe: { graphId: this._graphId },
        },
        {
          keySpec: { graphId: 1, [scopeField]: 1, ...propFields },
          idxName: scopedName,
          pfe: { graphId: this._graphId },
        },
      );
    } else {
      const scopedName = this._buildMongoIndexName(
        name,
        target,
        'scoped',
        sortedPropertyKeys,
        labelOrType,
      );
      mongoIndexNames.push(scopedName);
      indexSpecs.push({
        keySpec: { graphId: 1, [scopeField]: 1, ...propFields },
        idxName: scopedName,
        pfe: { graphId: this._graphId, [scopeField]: labelOrType },
      });
    }

    try {
      await this._indexMeta.insertOne({
        name,
        graphId: this._graphId,
        target,
        propertyKeys: sortedPropertyKeys,
        labelOrType: labelOrType ?? null,
        mongoIndexNames,
        createdOn: Date.now(),
      });
    } catch (e: unknown) {
      if (this._isDuplicateKeyError(e)) {
        throw new IndexAlreadyExistsError(name);
      }
      throw e;
    }

    try {
      await Promise.all(
        indexSpecs.map((spec) =>
          collection.createIndex(spec.keySpec, {
            name: spec.idxName,
            partialFilterExpression: spec.pfe,
          }),
        ),
      );
    } catch (e) {
      await this._indexMeta.deleteOne({ name, graphId: this._graphId }).catch(() => {});
      throw e;
    }

    const metaEntry: StoredIndexMeta = {
      name,
      target,
      propertyKeys: sortedPropertyKeys,
      sortedSig,
      ...(labelOrType !== undefined ? { labelOrType } : {}),
      mongoIndexNames,
    };

    const state = this._getPartitionState();
    state.entries.set(name, metaEntry);
    if (!this._cacheIndexMetadata) {
      state.loaded = false;
    }
    state.epoch++;
  }

  /**
   * Checks whether an index exists for node or edge properties (respecting label/type scoping).
   */
  async hasIndex(
    target: 'node' | 'edge',
    propertyKeys: string[],
    labelOrType?: string,
  ): Promise<boolean> {
    if (propertyKeys.length === 0) return false;

    const normalizedScope = labelOrType && labelOrType !== '*' ? labelOrType : undefined;
    const sortedSig = [...propertyKeys].sort().join('|');
    const entries = await this._loadIndexEntries();

    for (const entry of entries.values()) {
      if (entry.target !== target) continue;
      if (entry.labelOrType !== undefined && entry.labelOrType !== normalizedScope) continue;
      if (entry.sortedSig === sortedSig) {
        return true;
      }
    }

    return false;
  }

  /**
   * Retrieves metadata for a named index.
   */
  async getIndex(name: string): Promise<IndexMetadata | undefined> {
    const entries = await this._loadIndexEntries();
    const entry = entries.get(name);
    return entry ? this._toIndexMetadata(entry) : undefined;
  }

  /**
   * Deletes an index by name.
   */
  async deleteIndex(name: string): Promise<void> {
    const entries = await this._loadIndexEntries();
    const entry = entries.get(name);
    if (!entry) {
      throw new Error(`Index with name '${name}' does not exist`);
    }

    const collection = entry.target === 'node' ? this._nodes : this._edges;
    if (entry.mongoIndexNames.length > 0) {
      await Promise.all(
        entry.mongoIndexNames.map((mongoIdxName) =>
          collection.dropIndex(mongoIdxName).catch(() => {}),
        ),
      );
    } else {
      const legacyTarget = entry.target === 'node' ? 'node' : 'edge';
      await Promise.all(
        entry.propertyKeys.flatMap((propertyKey) => [
          collection.dropIndex(`${name}_${legacyTarget}_graphId_${propertyKey}`).catch(() => {}),
          collection.dropIndex(`${name}_${legacyTarget}_graphId_type_${propertyKey}`).catch(() => {}),
        ]),
      );
    }

    await this._indexMeta.deleteOne({ name, graphId: this._graphId });
    const state = this._getPartitionState();
    state.entries.delete(name);
    state.epoch++;
  }

  /**
   * Retrieves all indexes for this graph partition.
   */
  async getIndexes(): Promise<IndexMetadata[]> {
    const entries = await this._loadIndexEntries();
    const indexes: IndexMetadata[] = [];
    for (const entry of entries.values()) {
      indexes.push(this._toIndexMetadata(entry));
    }
    return indexes;
  }

  // ---------------------------------------------------------------------------
  // Transaction support
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the connected MongoDB deployment supports multi-document transactions
   * (replica sets, sharded `mongos` clusters, or load-balanced deployments; false for standalone `mongod`).
   */
  supportsTransactions(): boolean {
    if (!this._client) {
      return false;
    }

    const topologyDesc = (
      this._client as unknown as {
        topology?: {
          description?: {
            type?: string;
            servers?: Map<string, { type?: string }>;
          };
        };
      }
    ).topology?.description;

    if (!topologyDesc) {
      return true;
    }

    if (
      topologyDesc.type === 'ReplicaSetWithPrimary' ||
      topologyDesc.type === 'ReplicaSetNoPrimary' ||
      topologyDesc.type === 'Sharded' ||
      topologyDesc.type === 'LoadBalanced'
    ) {
      return true;
    }

    if (topologyDesc.type === 'Single' && topologyDesc.servers) {
      for (const server of topologyDesc.servers.values()) {
        if (
          server.type === 'RSPrimary' ||
          server.type === 'Mongos' ||
          server.type === 'LoadBalancer'
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Starts a new MongoDB transaction using a ClientSession.
   */
  async beginTransaction(): Promise<ITransactionHandle> {
    if (!this._client) {
      throw new Error(
        'MongoDB client not available for transactions. Ensure the Db instance has access to a MongoClient.',
      );
    }

    const session = this._client.startSession();
    session.startTransaction();

    return {
      id: `txn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      context: session,
    };
  }

  /**
   * Commits the MongoDB transaction.
   * @throws Error if no transaction is active
   */
  async commitTransaction(handle: ITransactionHandle): Promise<void> {
    const session = handle.context as ClientSession;
    if (!session.inTransaction()) {
      throw new Error('No active transaction to commit');
    }
    try {
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }
  }

  /**
   * Aborts the MongoDB transaction.
   */
  async rollbackTransaction(handle: ITransactionHandle): Promise<void> {
    const session = handle.context as ClientSession;
    if (session.inTransaction()) {
      try {
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
    } else {
      await session.endSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Private query, aggregation & filter helpers
  // ---------------------------------------------------------------------------

  private async _executeListQuery<TDoc extends Document, TOut>(
    collection: Collection<TDoc>,
    filter: Filter<TDoc>,
    mapper: (doc: WithId<TDoc>) => TOut,
    options?: StorageQueryOptions,
  ): Promise<TOut[]> {
    if (options?.limit === 0) {
      return [];
    }

    const session = options?.transaction?.context as ClientSession | undefined;
    const cursor = collection
      .find(filter, { projection: READ_PROJECTION, session })
      .batchSize(this._batchSize);

    if (options?.orderBy) {
      const { field, direction } = options.orderBy;
      const sortField =
        field === 'createdOn' || field === 'updatedOn' ? field : `properties.${field}`;
      cursor.sort(sortField, direction);
    }
    if (options?.limit !== undefined && options.limit > 0) {
      cursor.limit(options.limit);
    }

    const out: TOut[] = [];
    for await (const doc of cursor) {
      out.push(mapper(doc));
    }
    return out;
  }

  private async _aggregateProperty<TDoc extends Document>(
    collection: Collection<TDoc>,
    matchFilter: Filter<TDoc>,
    key: string,
    distinct?: boolean,
    session?: ClientSession,
  ): Promise<AggregateResult> {
    const propPath = `properties.${key}`;
    const propFilter: Document = { $exists: true, $type: 'number', $ne: NaN };
    const filterDoc = matchFilter as Document;

    if (Array.isArray(filterDoc.$and)) {
      filterDoc.$and.push({ [propPath]: propFilter });
    } else {
      filterDoc[propPath] = propFilter;
    }

    const pipeline: Document[] = [{ $match: filterDoc }];
    if (distinct) {
      pipeline.push({ $group: { _id: `$${propPath}` } });
    }

    const valueExpr = distinct ? '$_id' : `$${propPath}`;
    pipeline.push({
      $group: {
        _id: null,
        count: { $sum: 1 },
        sum: { $sum: valueExpr },
        avg: { $avg: valueExpr },
        min: { $min: valueExpr },
        max: { $max: valueExpr },
      },
    });

    interface AggregationResultDoc extends Document {
      _id: null;
      count: number;
      sum: number;
      avg: number;
      min: number;
      max: number;
    }

    const result = await collection
      .aggregate<AggregationResultDoc>(pipeline, { session })
      .next();

    if (!result) {
      return { count: 0 };
    }

    return {
      count: result.count,
      sum: result.sum,
      avg: result.avg,
      min: result.min,
      max: result.max,
    };
  }

  private _buildEntityFilter<TDoc extends Document>(
    typeField: 'labels' | 'type',
    options?: StorageQueryOptions,
    baseFilter: Filter<TDoc> = {} as Filter<TDoc>,
  ): Filter<TDoc> {
    const filter: Record<string, unknown> = { graphId: this._graphId, ...baseFilter };
    const andConditions: Document[] = [];

    if (options?.filter) {
      if (options.filter.types && options.filter.types.length > 0) {
        filter[typeField] = { $in: options.filter.types };
      }
      if (options.filter.properties && options.filter.properties.length > 0) {
        for (const prop of options.filter.properties) {
          const propFilter = this._buildPropertyFilter(prop);
          if (propFilter) {
            andConditions.push(propFilter);
          }
        }
      }
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    return filter as Filter<TDoc>;
  }

  private _buildPropertyFilter(prop: QueryOptionsFilterProperty): Document | undefined {
    const conditions: Document[] = [];

    if (prop.AND && prop.AND.length > 0) {
      const andFilters: Document[] = [];
      for (const subProp of prop.AND) {
        const subFilter = this._buildPropertyFilter(subProp);
        if (subFilter) {
          andFilters.push(subFilter);
        }
      }
      if (andFilters.length > 0) {
        conditions.push({ $and: andFilters });
      }
    }

    if (prop.OR && prop.OR.length > 0) {
      const orFilters: Document[] = [];
      for (const subProp of prop.OR) {
        const subFilter = this._buildPropertyFilter(subProp);
        if (subFilter) {
          orFilters.push(subFilter);
        }
      }
      if (orFilters.length > 0) {
        conditions.push({ $or: orFilters });
      }
    }

    if (prop.key !== undefined) {
      const op = prop.op ?? '=';
      const propPath = `properties.${prop.key}`;
      conditions.push(this._buildScalarOpFilter(propPath, op, prop.value));
    }

    if (conditions.length === 0) {
      return undefined;
    }
    return conditions.length === 1 ? conditions[0] : { $and: conditions };
  }

  private _buildScalarOpFilter(
    propPath: string,
    op: NonNullable<QueryOptionsFilterProperty['op']>,
    value: unknown,
  ): Document {
    switch (op) {
      case '=':
        return {
          [propPath]: value === null ? { $eq: null, $exists: true } : value,
        } as Document;
      case '<>':
        return { [propPath]: { $ne: value } } as Document;
      case '>':
      case '<':
      case '>=':
      case '<=': {
        if (value === null || value === undefined) {
          return { _id: { $exists: false } } as Document;
        }
        const mongoOp =
          op === '>' ? '$gt' : op === '<' ? '$lt' : op === '>=' ? '$gte' : '$lte';
        return { [propPath]: { [mongoOp]: value } } as Document;
      }
      case 'CONTAINS':
        return typeof value === 'string'
          ? ({ [propPath]: { $regex: this._escapeRegex(value) } } as Document)
          : ({ _id: { $exists: false } } as Document);
      case 'STARTS_WITH':
        return typeof value === 'string'
          ? ({ [propPath]: { $regex: `^${this._escapeRegex(value)}` } } as Document)
          : ({ _id: { $exists: false } } as Document);
      case 'ENDS_WITH':
        return typeof value === 'string'
          ? ({ [propPath]: { $regex: `${this._escapeRegex(value)}$` } } as Document)
          : ({ _id: { $exists: false } } as Document);
      case 'IN':
        return { [propPath]: { $in: Array.isArray(value) ? value : [value] } } as Document;
      case 'NOT_IN':
        return { [propPath]: { $nin: Array.isArray(value) ? value : [value] } } as Document;
      case 'IS_NULL':
        return { $or: [{ [propPath]: null }, { [propPath]: { $exists: false } }] } as Document;
      case 'IS_NOT_NULL':
        return {
          $and: [{ [propPath]: { $exists: true } }, { [propPath]: { $ne: null } }],
        } as Document;
    }
  }

  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------------------------------------------------------------------------
  // Private index cache & document helpers
  // ---------------------------------------------------------------------------

  private _getPartitionState(): PartitionIndexState {
    let dbMap = PARTITION_INDEX_CACHE.get(this._db);
    if (!dbMap) {
      dbMap = new Map<string, PartitionIndexState>();
      PARTITION_INDEX_CACHE.set(this._db, dbMap);
    }
    let state = dbMap.get(this._partitionKey);
    if (!state) {
      state = {
        epoch: 0,
        loaded: false,
        entries: new Map<string, StoredIndexMeta>(),
      };
      dbMap.set(this._partitionKey, state);
    }
    return state;
  }

  private async _loadIndexEntries(): Promise<Map<string, StoredIndexMeta>> {
    const state = this._getPartitionState();
    if (this._cacheIndexMetadata && state.loaded) {
      return state.entries;
    }

    const cursor = this._indexMeta.find(
      { graphId: this._graphId },
      { projection: { _id: 0 } },
    );
    const entries = new Map<string, StoredIndexMeta>();

    for await (const doc of cursor) {
      const propertyKeys = [...(doc.propertyKeys as string[])];
      const sortedSig = [...propertyKeys].sort().join('|');
      const labelOrType =
        typeof doc.labelOrType === 'string' && doc.labelOrType.length > 0
          ? doc.labelOrType
          : undefined;
      const mongoIndexNames = Array.isArray(doc.mongoIndexNames)
        ? (doc.mongoIndexNames as string[])
        : [];
      entries.set(doc.name as string, {
        name: doc.name as string,
        target: doc.target as 'node' | 'edge',
        propertyKeys,
        sortedSig,
        ...(labelOrType !== undefined ? { labelOrType } : {}),
        mongoIndexNames,
      });
    }

    if (this._cacheIndexMetadata) {
      state.entries = entries;
      state.loaded = true;
    }
    return entries;
  }

  private _toIndexMetadata(entry: StoredIndexMeta): IndexMetadata {
    return {
      name: entry.name,
      target: entry.target,
      propertyKeys: [...entry.propertyKeys],
      ...(entry.labelOrType !== undefined ? { labelOrType: entry.labelOrType } : {}),
    };
  }

  private _hashString(input: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(36)}_${h2.toString(36)}`;
  }

  private _buildMongoIndexName(
    name: string,
    target: 'node' | 'edge',
    kind: 'base' | 'scoped',
    sortedKeys: string[],
    labelOrType?: string,
  ): string {
    const scopePart = labelOrType ? `_${labelOrType}` : '';
    const raw = `${this._graphId}_${name}_${target}_${kind}${scopePart}_${sortedKeys.join('_')}`;
    if (raw.length <= 96) {
      return raw;
    }
    const prefix = name.slice(0, 24);
    return `idx_${prefix}_${target}_${kind}_${this._hashString(raw)}`;
  }

  private _docToNode(doc: WithId<NodeDoc>): NodeData {
    return {
      id: doc.id,
      labels: doc.labels,
      createdOn: doc.createdOn,
      updatedOn: doc.updatedOn,
      properties: doc.properties,
    };
  }

  private _docToEdge(doc: WithId<EdgeDoc>): EdgeData {
    return {
      id: doc.id,
      sourceId: doc.sourceId,
      targetId: doc.targetId,
      type: doc.type,
      createdOn: doc.createdOn,
      updatedOn: doc.updatedOn,
      properties: doc.properties,
    };
  }

  private _isDuplicateKeyError(e: unknown): boolean {
    return e instanceof Error && 'code' in e && (e as { code: number }).code === 11000;
  }

  private _extractDuplicateId(e: unknown): string | undefined {
    const errObj = e as {
      keyValue?: { id?: unknown };
      writeErrors?: Array<{ err?: { op?: { id?: unknown }; keyValue?: { id?: unknown } } }>;
    };
    if (typeof errObj?.keyValue?.id === 'string') {
      return errObj.keyValue.id;
    }
    const firstWriteErr = errObj?.writeErrors?.[0]?.err;
    if (typeof firstWriteErr?.op?.id === 'string') {
      return firstWriteErr.op.id;
    }
    if (typeof firstWriteErr?.keyValue?.id === 'string') {
      return firstWriteErr.keyValue.id;
    }
    return undefined;
  }
}
