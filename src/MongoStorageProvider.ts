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
  IStorageProvider,
  IOrderBy,
  NodeData,
  ITransactionHandle,
  EdgeData,
  GraphData,
  StorageQueryOptions,
  isPrimitive
} from 'grafio';

/**
 * Property filter specification with support for recursive AND/OR chaining.
 * This type is defined locally because grafio may not yet export it.
 */
export interface QueryOptionsFilterProperty {
  key?: string;
  value?: unknown;
  op?: '=' | '<>' | '>' | '<' | '>=' | '<=' | 'CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH' | 'IN' | 'NOT_IN' | 'IS_NULL' | 'IS_NOT_NULL';
  AND?: QueryOptionsFilterProperty[];
  OR?: QueryOptionsFilterProperty[];
}

import {
  NodeAlreadyExistsError,
  EdgeAlreadyExistsError,
  NodeNotFoundError,
  EdgeNotFoundError,
  InvalidPropertyError,
  PropertyAlreadyExistsError,
  PropertyNotFoundError,
  GraphError
} from 'grafio/errors';

/**
 * Error thrown when attempting to create an index that already exists.
 */
export class IndexAlreadyExistsError extends GraphError {
  constructor(indexName: string) {
    super(`Index '${indexName}' already exists`);
    this.name = 'IndexAlreadyExistsError';
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
   * @default 'grafio_nodes'
   */
  nodesCollection?: string;

  /**
   * Name of the MongoDB collection for edges.
   * @default 'grafio_edges'
   */
  edgesCollection?: string;

  /**
   * Batch size for cursor-based iteration in getAllNodes() / getAllEdges().
   * Controls how many documents are fetched per MongoDB round-trip.
   * @default 1000
   */
  batchSize?: number;
}

/**
 * MongoDB-backed storage provider for `grafio`.
 *
 * ## Setup
 * ```typescript
 * import { MongoClient } from 'mongodb';
 * import { Graph } from 'grafio';
 * import { MongoStorageProvider } from 'grafio/storage/MongoStorageProvider';
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
 * Two collections are used (default names):
 *  - `grafio_nodes`  — one document per node
 *  - `grafio_edges`  — one document per edge
 *
 * ## Indexes
 * Call `ensureIndexes()` once on startup. It creates:
 *  - Unique compound index on `(graphId, id)` for both collections (fast id lookups)
 *  - Index on `(graphId, type)` for both collections (type filter queries)
 *  - Compound index on `(graphId, sourceId, type)` for outgoing adjacency queries
 *  - Compound index on `(graphId, targetId, type)` for incoming adjacency queries
 *
 * ## Thread safety
 * MongoDB operations are inherently safe for concurrent use.
 * However, a single `MongoStorageProvider` instance should not be shared
 * across multiple `Graph` instances simultaneously if you rely on
 * `importJSON()` atomicity — wrap it in a MongoDB session/transaction if needed.
 */
export class MongoStorageProvider implements IStorageProvider {
  private readonly _nodes: Collection<NodeDoc>;
  private readonly _edges: Collection<EdgeDoc>;
  private readonly _graphId: string;
  private readonly _batchSize: number;
  private readonly _client: MongoClient | null = null;

  /**
   * @param db   - An already-connected Mongo `Db` instance.
   * @param opts - Optional configuration including graphId (partition key).
   */
  constructor(db: Db, opts: MongoStorageProviderOptions = {}) {
    const nodesColl = opts.nodesCollection ?? 'grafiodb_nodes';
    const edgesColl = opts.edgesCollection ?? 'grafiodb_edges';

    this._nodes = db.collection<NodeDoc>(nodesColl);
    this._edges = db.collection<EdgeDoc>(edgesColl);
    this._graphId = opts.graphId ?? 'default';
    if (opts.batchSize !== undefined && opts.batchSize <= 0) {
      throw new Error(`batchSize must be a positive integer, got: ${opts.batchSize}`);
    }
    this._batchSize = opts.batchSize ?? 1000;

    // Try to get the client from the db
    // MongoClient is needed to create sessions for transactions
    if ('client' in db && db.client instanceof MongoClient) {
      this._client = db.client;
    }
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  /**
   * Creates all required MongoDB indexes.
   * Safe to call multiple times (uses `{ background: true }` equivalent and
   * MongoDB's idempotent `createIndex` semantics).
   *
   * Call once on application startup before performing any graph operations.
   */
  async ensureIndexes(): Promise<void> {
    // Node indexes — compound unique index on (graphId, id) ensures element id uniqueness per graph
    await this._nodes.createIndex({ graphId: 1, id: 1 }, { unique: true, name: 'node_graph_id_unique' });
    await this._nodes.createIndex({ graphId: 1, labels: 1 }, { name: 'node_graph_labels' });

    // Edge indexes
    await this._edges.createIndex({ graphId: 1, id: 1 }, { unique: true, name: 'edge_graph_id_unique' });
    await this._edges.createIndex({ graphId: 1, type: 1 }, { name: 'edge_graph_type' });
    await this._edges.createIndex({ graphId: 1, sourceId: 1 }, { name: 'edge_graph_source' });
    await this._edges.createIndex({ graphId: 1, targetId: 1 }, { name: 'edge_graph_target' });
    await this._edges.createIndex({ graphId: 1, sourceId: 1, type: 1 }, { name: 'edge_graph_source_type' });
    await this._edges.createIndex({ graphId: 1, targetId: 1, type: 1 }, { name: 'edge_graph_target_type' });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async clear(): Promise<void> {
    // Delete all named indexes first
    const indexes = await this.getIndexes();
    await Promise.all(indexes.map(index => this.deleteIndex(index.name)));

    await Promise.all([
      this._nodes.deleteMany({ graphId: this._graphId }),
      this._edges.deleteMany({ graphId: this._graphId }),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Node mutations
  // ---------------------------------------------------------------------------

  async insertNode(node: NodeData, transaction?: ITransactionHandle): Promise<void> {
    const now = Date.now();
    // Set createdOn and updatedOn at node level if not already set
    if (node.createdOn === undefined) {
      node.createdOn = now;
    }
    if (node.updatedOn === undefined) {
      node.updatedOn = now;
    }

    const session = transaction?.context as ClientSession | undefined;
    try {
      await this._nodes.insertOne({
        id: node.id,
        graphId: this._graphId,
        labels: node.labels,
        createdOn: node.createdOn,
        updatedOn: node.updatedOn,
        properties: node.properties,
      } as NodeDoc, { session });
    } catch (e: unknown) {
      if (this._isDuplicateKeyError(e)) throw new NodeAlreadyExistsError(node.id);
      throw e;
    }
  }

  async deleteNode(id: string, transaction?: ITransactionHandle): Promise<void> {
    const session = transaction?.context as ClientSession | undefined;
    await this._nodes.deleteOne({ graphId: this._graphId, id }, { session });
  }

  // ---------------------------------------------------------------------------
  // Node queries
  // ---------------------------------------------------------------------------

  async hasNode(id: string, transaction?: ITransactionHandle): Promise<boolean> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._nodes.findOne(
      { graphId: this._graphId, id },
      { projection: { _id: 1 }, session },
    );
    return doc !== null;
  }

  async getNode(id: string, transaction?: ITransactionHandle): Promise<NodeData | undefined> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._nodes.findOne({ graphId: this._graphId, id }, { session });
    return doc ? this._docToNode(doc) : undefined;
  }

  async getNodesByIds(ids: string[], transaction?: ITransactionHandle): Promise<Map<string, NodeData>> {
    const session = transaction?.context as ClientSession | undefined;
    const cursor = this._nodes.find({ graphId: this._graphId, id: { $in: ids } }, { session });
    const nodes = new Map<string, NodeData>();
    for await (const doc of cursor) {
      nodes.set(doc.id, this._docToNode(doc));
    }
    return nodes;
  }

  async getNodeCount(options?: StorageQueryOptions): Promise<number> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const filter = this._buildNodeFilter(options);
    return this._nodes.countDocuments(filter, { session });
  }

  async aggregateNodeProperty(key: string, options?: StorageQueryOptions): Promise<{ count: number; sum?: number; avg?: number; min?: number; max?: number }> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const matchFilter = this._buildNodeFilter(options);

    // Properly combine with aggregate's own property existence filter
    const propFilter: Document = { $exists: true, $type: 'number' };
    if (matchFilter.$and) {
      matchFilter.$and.push({ [`properties.${key}`]: propFilter });
    } else {
      matchFilter[`properties.${key}`] = propFilter;
    }

    const pipeline: Document[] = [
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          sum: { $sum: `$properties.${key}` },
          avg: { $avg: `$properties.${key}` },
          min: { $min: `$properties.${key}` },
          max: { $max: `$properties.${key}` },
        },
      },
    ];

    interface AggregationResult extends Document {
      _id: null;
      count: number;
      sum: number;
      avg: number;
      min: number;
      max: number;
    }

    const result = await this._nodes.aggregate<AggregationResult>(pipeline, { session }).next();

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

  async getNodes(options?: StorageQueryOptions): Promise<NodeData[]> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const filter = this._buildNodeFilter(options);
    const nodes: NodeData[] = [];
    const cursor = this._nodes.find(filter, { session }).batchSize(this._batchSize);

    if (options?.orderBy) {
      const { field, direction } = options.orderBy;
      const sortField = field === 'createdOn' || field === 'updatedOn' ? field : `properties.${field}`;
      cursor.sort(sortField, direction);
    }
    if (options?.limit) {
      cursor.limit(options.limit);
    }

    for await (const doc of cursor) {
      nodes.push(this._docToNode(doc));
    }
    return nodes;
  }

  // ---------------------------------------------------------------------------
  // Edge queries
  // ---------------------------------------------------------------------------

  async hasEdge(id: string, transaction?: ITransactionHandle): Promise<boolean> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._edges.findOne(
      { graphId: this._graphId, id },
      { projection: { _id: 1 }, session },
    );
    return doc !== null;
  }

  async getEdge(id: string, transaction?: ITransactionHandle): Promise<EdgeData | undefined> {
    const session = transaction?.context as ClientSession | undefined;
    const doc = await this._edges.findOne({ graphId: this._graphId, id }, { session });
    return doc ? this._docToEdge(doc) : undefined;
  }

  async getEdgeCount(options?: StorageQueryOptions): Promise<number> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const filter = this._buildEdgeFilter(options);
    return this._edges.countDocuments(filter, { session });
  }

  async aggregateEdgeProperty(key: string, options?: StorageQueryOptions): Promise<{ count: number; sum?: number; avg?: number; min?: number; max?: number }> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const matchFilter = this._buildEdgeFilter(options);

    // Properly combine with aggregate's own property existence filter
    const propFilter: Document = { $exists: true, $type: 'number' };
    if (matchFilter.$and) {
      matchFilter.$and.push({ [`properties.${key}`]: propFilter });
    } else {
      matchFilter[`properties.${key}`] = propFilter;
    }

    const pipeline: Document[] = [
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          sum: { $sum: `$properties.${key}` },
          avg: { $avg: `$properties.${key}` },
          min: { $min: `$properties.${key}` },
          max: { $max: `$properties.${key}` },
        },
      },
    ];

    interface AggregationResult extends Document {
      _id: null;
      count: number;
      sum: number;
      avg: number;
      min: number;
      max: number;
    }

    const result = await this._edges.aggregate<AggregationResult>(pipeline, { session }).next();

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

  async getEdges(options?: StorageQueryOptions): Promise<EdgeData[]> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const filter = this._buildEdgeFilter(options);
    const edges: EdgeData[] = [];
    const cursor = this._edges.find(filter, { session }).batchSize(this._batchSize);

    if (options?.orderBy) {
      const { field, direction } = options.orderBy;
      const sortField = field === 'createdOn' || field === 'updatedOn' ? field : `properties.${field}`;
      cursor.sort(sortField, direction);
    }
    if (options?.limit) {
      cursor.limit(options.limit);
    }

    for await (const doc of cursor) {
      edges.push(this._docToEdge(doc));
    }
    return edges;
  }

  async getEdgesBySource(nodeId: string, options?: StorageQueryOptions): Promise<EdgeData[]> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const baseFilter = { graphId: this._graphId, sourceId: nodeId };
    const filter = this._buildEdgeFilter(options, baseFilter);
    const edges: EdgeData[] = [];
    const cursor = this._edges.find(filter, { session }).batchSize(this._batchSize);

    if (options?.orderBy) {
      const { field, direction } = options.orderBy;
      const sortField = field === 'createdOn' || field === 'updatedOn' ? field : `properties.${field}`;
      cursor.sort(sortField, direction);
    }
    if (options?.limit) {
      cursor.limit(options.limit);
    }

    for await (const doc of cursor) {
      edges.push(this._docToEdge(doc));
    }
    return edges;
  }

  async getEdgesByTarget(nodeId: string, options?: StorageQueryOptions): Promise<EdgeData[]> {
    const session = options?.transaction?.context as ClientSession | undefined;
    const baseFilter = { graphId: this._graphId, targetId: nodeId };
    const filter = this._buildEdgeFilter(options, baseFilter);
    const edges: EdgeData[] = [];
    const cursor = this._edges.find(filter, { session }).batchSize(this._batchSize);

    if (options?.orderBy) {
      const { field, direction } = options.orderBy;
      const sortField = field === 'createdOn' || field === 'updatedOn' ? field : `properties.${field}`;
      cursor.sort(sortField, direction);
    }
    if (options?.limit) {
      cursor.limit(options.limit);
    }

    for await (const doc of cursor) {
      edges.push(this._docToEdge(doc));
    }
    return edges;
  }

  // ---------------------------------------------------------------------------
  // Edge mutations
  // ---------------------------------------------------------------------------

  async insertEdge(edge: EdgeData, transaction?: ITransactionHandle): Promise<void> {
    const now = Date.now();
    // Set createdOn and updatedOn at edge level if not already set
    if (edge.createdOn === undefined) {
      edge.createdOn = now;
    }
    if (edge.updatedOn === undefined) {
      edge.updatedOn = now;
    }

    const session = transaction?.context as ClientSession | undefined;
    try {
      await this._edges.insertOne({
        id: edge.id,
        graphId: this._graphId,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        type: edge.type,
        createdOn: edge.createdOn,
        updatedOn: edge.updatedOn,
        properties: edge.properties,
      } as EdgeDoc, { session });
    } catch (e: unknown) {
      if (this._isDuplicateKeyError(e)) throw new EdgeAlreadyExistsError(edge.id);
      throw e;
    }
  }

  async deleteEdge(id: string, transaction?: ITransactionHandle): Promise<void> {
    const session = transaction?.context as ClientSession | undefined;
    await this._edges.deleteOne({ graphId: this._graphId, id }, { session });
  }

  // ---------------------------------------------------------------------------
  // Data portability
  // ---------------------------------------------------------------------------

  async exportJSON(): Promise<GraphData> {
    const nodes: NodeData[] = [];
    const edges: EdgeData[] = [];

    const nodesCursor = this._nodes.find({ graphId: this._graphId }).batchSize(this._batchSize);
    for await (const doc of nodesCursor) {
      nodes.push(this._docToNode(doc));
    }

    const edgesCursor = this._edges.find({ graphId: this._graphId }).batchSize(this._batchSize);
    for await (const doc of edgesCursor) {
      edges.push(this._docToEdge(doc));
    }

    return {
      graphId: this._graphId,
      nodes,
      edges,
    };
  }

  /**
   * Imports graph data using MongoDB `insertMany` for efficiency.
   *
   * Validates referential integrity before writing:
   *  - Duplicate node ids → NodeAlreadyExistsError
   *  - Duplicate edge ids → EdgeAlreadyExistsError
   *  - Edge referencing missing node → NodeNotFoundError
   */
  async importJSON(data: GraphData): Promise<void> {
    // ---- Validate duplicate ids in the payload itself ----
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

    // ---- Check for existing ids in the database under this graphId (parallel) ----
    const nodeIds = data.nodes.map(n => n.id);
    const edgeIds = data.edges.map(e => e.id);

    const [conflictNode, conflictEdge] = await Promise.all([
      data.nodes.length > 0
        ? this._nodes.findOne({ graphId: this._graphId, id: { $in: nodeIds } })
        : Promise.resolve(null),
      data.edges.length > 0
        ? this._edges.findOne({ graphId: this._graphId, id: { $in: edgeIds } })
        : Promise.resolve(null),
    ]);
    if (conflictNode) throw new NodeAlreadyExistsError(conflictNode.id);
    if (conflictEdge) throw new EdgeAlreadyExistsError(conflictEdge.id);

    // ---- Validate edge source/target references ----
    // Only load the node ids actually referenced by incoming edges (avoids loading all nodes)
    const referencedIds = [...nodeIdSet]; // ids from incoming nodes already added above
    for (const e of data.edges) {
      referencedIds.push(e.sourceId, e.targetId);
    }
    const uniqueReferencedIds = [...new Set(referencedIds)];
    const existingIdSet = new Set(
      await this._nodes
        .find({ graphId: this._graphId, id: { $in: uniqueReferencedIds } }, { projection: { id: 1 } })
        .toArray()
        .then(docs => docs.map(d => d.id))
    );

    for (const id of nodeIdSet) existingIdSet.add(id);

    for (const e of data.edges) {
      if (!existingIdSet.has(e.sourceId)) throw new NodeNotFoundError(e.sourceId);
      if (!existingIdSet.has(e.targetId)) throw new NodeNotFoundError(e.targetId);
    }

    // ---- Bulk insert (batched) ----
    if (data.nodes.length > 0) {
      const nodeDocs = data.nodes.map(n => ({
        id: n.id,
        graphId: this._graphId,
        labels: n.labels,
        createdOn: n.createdOn ?? Date.now(),
        updatedOn: n.updatedOn ?? Date.now(),
        properties: n.properties,
      } as NodeDoc));
      for (let i = 0; i < nodeDocs.length; i += this._batchSize) {
        await this._nodes.insertMany(nodeDocs.slice(i, i + this._batchSize));
      }
    }
    if (data.edges.length > 0) {
      const edgeDocs = data.edges.map(e => ({
        id: e.id,
        graphId: this._graphId,
        sourceId: e.sourceId,
        targetId: e.targetId,
        type: e.type,
        createdOn: e.createdOn ?? Date.now(),
        updatedOn: e.updatedOn ?? Date.now(),
        properties: e.properties,
      } as EdgeDoc));
      for (let i = 0; i < edgeDocs.length; i += this._batchSize) {
        await this._edges.insertMany(edgeDocs.slice(i, i + this._batchSize));
      }
    }
  }

  /**
   * Creates indexes on node or edge properties.
   *
   * @param name - The name identifier for this index
   * @param target - Either 'node' or 'edge'
   * @param propertyKeys - The property names to index
   */
  async createIndex(name: string, target: 'node' | 'edge', propertyKeys: string[]): Promise<void> {
    // Sort propertyKeys for consistent index naming
    const sortedPropertyKeys = [...propertyKeys].sort();

    // Check if index with this name already exists
    const metadataCollection = this._nodes.db.collection('grafio_index_metadata');
    const existing = await metadataCollection.findOne({ name, graphId: this._graphId });
    if (existing) {
      throw new IndexAlreadyExistsError(name);
    }

    // Store metadata for this named index
    await metadataCollection.insertOne({
      name,
      graphId: this._graphId,
      target,
      propertyKeys: sortedPropertyKeys,
      createdOn: Date.now()
    });

    for (const propertyKey of sortedPropertyKeys) {
      if (target === 'node') {
        // Always lead with graphId to support partitioned queries efficiently
        const indexFields: Record<string, 1> = { graphId: 1, [`properties.${propertyKey}`]: 1 };

        await this._nodes.createIndex(indexFields, {
          name: `${name}_node_graphId_${propertyKey}`,
          background: true
        });
        await this._nodes.createIndex({ ...indexFields, type: 1 }, {
          name: `${name}_node_graphId_type_${propertyKey}`,
          background: true
        });
      } else {
        // Always lead with graphId to support partitioned queries efficiently
        const indexFields: Record<string, 1> = { graphId: 1, [`properties.${propertyKey}`]: 1 };

        await this._edges.createIndex(indexFields, {
          name: `${name}_edge_graphId_${propertyKey}`,
          background: true
        });
        await this._edges.createIndex({ ...indexFields, type: 1 }, {
          name: `${name}_edge_graphId_type_${propertyKey}`,
          background: true
        });
      }
    }
  }

  /**
   * Checks whether an index exists for node or edge properties.
   *
   * @param target - Either 'node' or 'edge'
   * @param propertyKeys - The property names to check
   */
  async hasIndex(target: 'node' | 'edge', propertyKeys: string[]): Promise<boolean> {
    const sortedPropertyKeys = [...propertyKeys].sort();

    // Find all indexes for this target
    const metadataCollection = this._nodes.db.collection('grafio_index_metadata');
    const cursor = metadataCollection.find({ graphId: this._graphId, target });

    for await (const metadata of cursor) {
      const indexPropertyKeys = metadata.propertyKeys as string[];
      const sortedIndexPropertyKeys = [...indexPropertyKeys].sort();

      // Check if this index contains all the requested propertyKeys
      const hasAllKeys = sortedPropertyKeys.every(key => sortedIndexPropertyKeys.includes(key));
      if (hasAllKeys) {
        return true;
      }
    }

    return false;
  }

  /**
   * Retrieves metadata for a named index.
   *
   * @param name - The name of the index
   */
  async getIndex(name: string): Promise<{ name: string; target: 'node' | 'edge'; propertyKeys: string[] } | undefined> {
    const metadataCollection = this._nodes.db.collection('grafio_index_metadata');
    const metadata = await metadataCollection.findOne({ name, graphId: this._graphId });

    if (!metadata) {
      return undefined;
    }

    return {
      name: metadata.name as string,
      target: metadata.target as 'node' | 'edge',
      propertyKeys: metadata.propertyKeys as string[]
    };
  }

  /**
   * Deletes an index by name.
   *
   * @param name - The name of the index to delete
   */
  async deleteIndex(name: string): Promise<void> {
    const metadataCollection = this._nodes.db.collection('grafio_index_metadata');
    const metadata = await metadataCollection.findOne({ name, graphId: this._graphId });

    if (!metadata) {
      throw new Error(`Index with name '${name}' does not exist`);
    }

    const target = metadata.target as 'node' | 'edge';
    const propertyKeys = metadata.propertyKeys as string[];
    const collection = target === 'node' ? this._nodes : this._edges;

    // Delete all MongoDB indexes associated with this named index
    for (const propertyKey of propertyKeys) {
      try {
        await collection.dropIndex(`${name}_${target === 'node' ? 'node' : 'edge'}_graphId_${propertyKey}`);
      } catch {
        // Index may not exist, ignore
      }
      try {
        await collection.dropIndex(`${name}_${target === 'node' ? 'node' : 'edge'}_graphId_type_${propertyKey}`);
      } catch {
        // Index may not exist, ignore
      }
    }

    // Delete metadata
    await metadataCollection.deleteOne({ name, graphId: this._graphId });
  }

  /**
   * Retrieves all indexes.
   */
  async getIndexes(): Promise<{ name: string; target: 'node' | 'edge'; propertyKeys: string[] }[]> {
    const metadataCollection = this._nodes.db.collection('grafio_index_metadata');
    const cursor = metadataCollection.find({ graphId: this._graphId });

    const indexes: { name: string; target: 'node' | 'edge'; propertyKeys: string[] }[] = [];
    for await (const metadata of cursor) {
      indexes.push({
        name: metadata.name as string,
        target: metadata.target as 'node' | 'edge',
        propertyKeys: metadata.propertyKeys as string[]
      });
    }

    return indexes;
  }

  // ---------------------------------------------------------------------------
  // Property mutations
  // ---------------------------------------------------------------------------

  /**
   * Adds a property to a node or edge. Fails if the property key already exists.
   * @throws NodeNotFoundError/EdgeNotFoundError if the target doesn't exist
   * @throws PropertyAlreadyExistsError if the property key already exists
   * @throws InvalidPropertyError if the value is not a primitive
   */
  async addProperty(target: 'node' | 'edge', id: string, key: string, value: unknown, transaction?: ITransactionHandle): Promise<void> {
    if (!isPrimitive(value)) {
      throw new InvalidPropertyError(key, value);
    }

    const session = transaction?.context as ClientSession | undefined;
    const collection = target === 'node' ? this._nodes : this._edges;

    // Atomic: only succeeds if the property does NOT already exist
    const result = await collection.updateOne(
      { graphId: this._graphId, id, [`properties.${key}`]: { $exists: false } },
      { $set: { [`properties.${key}`]: value, updatedOn: Date.now() } },
      { session }
    );

    if (result.matchedCount === 0) {
      // Check if record exists to differentiate between "record missing" vs "property exists"
      const record = target === 'node' ? await this.getNode(id, transaction) : await this.getEdge(id, transaction);
      if (!record) {
        throw target === 'node' ? new NodeNotFoundError(id) : new EdgeNotFoundError(id);
      }
      throw new PropertyAlreadyExistsError(target, id, key);
    }
  }

  /**
   * Updates an existing property on a node or edge. Fails if the property doesn't exist.
   * @throws NodeNotFoundError/EdgeNotFoundError if the target doesn't exist
   * @throws PropertyNotFoundError if the property key doesn't exist
   * @throws InvalidPropertyError if the value is not a primitive
   */
  async updateProperty(target: 'node' | 'edge', id: string, key: string, value: unknown, transaction?: ITransactionHandle): Promise<void> {
    if (!isPrimitive(value)) {
      throw new InvalidPropertyError(key, value);
    }

    const session = transaction?.context as ClientSession | undefined;
    const collection = target === 'node' ? this._nodes : this._edges;

    // Atomic update: only succeeds if the property already exists
    const result = await collection.updateOne(
      { graphId: this._graphId, id, [`properties.${key}`]: { $exists: true } },
      { $set: { [`properties.${key}`]: value, updatedOn: Date.now() } },
      { session }
    );

    if (result.matchedCount === 0) {
      // Determine whether it was the record or the property that didn't exist
      const record = target === 'node' ? await this.getNode(id, transaction) : await this.getEdge(id, transaction);
      if (!record) {
        throw target === 'node' ? new NodeNotFoundError(id) : new EdgeNotFoundError(id);
      }
      throw new PropertyNotFoundError(target, id, key);
    }
  }

  /**
   * Deletes a property from a node or edge.
   * @throws NodeNotFoundError/EdgeNotFoundError if the target doesn't exist
   */
  async deleteProperty(target: 'node' | 'edge', id: string, key: string, transaction?: ITransactionHandle): Promise<void> {
    const session = transaction?.context as ClientSession | undefined;
    const collection = target === 'node' ? this._nodes : this._edges;
    const record = target === 'node' ? await this.getNode(id, transaction) : await this.getEdge(id, transaction);

    if (!record) {
      if (target === 'node') {
        throw new NodeNotFoundError(id);
      } else {
        throw new EdgeNotFoundError(id);
      }
    }

    await collection.updateOne(
      { graphId: this._graphId, id },
      { $unset: { [`properties.${key}`]: '' }, $set: { updatedOn: Date.now() } },
      { session }
    );
  }

  /**
   * Clears all properties from a node or edge.
   * @throws NodeNotFoundError/EdgeNotFoundError if the target doesn't exist
   */
  async clearProperties(target: 'node' | 'edge', id: string, transaction?: ITransactionHandle): Promise<void> {
    const session = transaction?.context as ClientSession | undefined;
    const collection = target === 'node' ? this._nodes : this._edges;
    const record = target === 'node' ? await this.getNode(id, transaction) : await this.getEdge(id, transaction);

    if (!record) {
      if (target === 'node') {
        throw new NodeNotFoundError(id);
      } else {
        throw new EdgeNotFoundError(id);
      }
    }

    const updateObj: Record<string, unknown> = {};
    for (const key of Object.keys(record.properties)) {
      updateObj[`properties.${key}`] = '';
    }

    if (Object.keys(updateObj).length > 0) {
      await collection.updateOne(
        { graphId: this._graphId, id },
        { $unset: updateObj },
        { session }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Transaction support
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the MongoDB client supports transactions.
   * Requires MongoDB 4.0+ and a replica set or sharded cluster.
   */
  supportsTransactions(): boolean {
    return this._client !== null;
  }

  /**
   * Starts a new MongoDB transaction using a ClientSession.
   * Note: MongoDB transactions require a replica set. This will start a transaction
   * on the session, but actual atomicity requires passing the session to all operations.
   */
  async beginTransaction(): Promise<ITransactionHandle> {
    if (!this._client) {
      throw new Error('MongoDB client not available for transactions. Ensure the Db instance has access to a MongoClient.');
    }

    const session = this._client.startSession();
    session.startTransaction(); // Start the transaction on the session

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
      session.endSession();
    }
  }

  /**
   * Aborts the MongoDB transaction.
   * This is safe to call even if there's no active transaction (will be a no-op after session ends).
   */
  async rollbackTransaction(handle: ITransactionHandle): Promise<void> {
    const session = handle.context as ClientSession;
    if (session.inTransaction()) {
      try {
        await session.abortTransaction();
      } finally {
        session.endSession();
      }
    } else {
      session.endSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Filter builders
  // ---------------------------------------------------------------------------

  /**
   * Builds a MongoDB filter for node queries from StorageQueryOptions.
   */
  private _buildNodeFilter(options?: StorageQueryOptions, baseFilter: Filter<NodeDoc> = {}): Filter<NodeDoc> {
    const filter: Filter<NodeDoc> = { graphId: this._graphId, ...baseFilter };
    const andConditions: Document[] = [];

    if (options?.filter) {
      if (options.filter.types && options.filter.types.length > 0) {
        filter.labels = { $in: options.filter.types };
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

    // Combine all property filters with $and at top level
    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    return filter;
  }

  /**
   * Builds a MongoDB filter for edge queries from StorageQueryOptions.
   */
  private _buildEdgeFilter(options?: StorageQueryOptions, baseFilter: Filter<EdgeDoc> = {}): Filter<EdgeDoc> {
    const filter: Filter<EdgeDoc> = { graphId: this._graphId, ...baseFilter };
    const andConditions: Document[] = [];

    if (options?.filter) {
      if (options.filter.types && options.filter.types.length > 0) {
        filter.type = { $in: options.filter.types };
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

    // Combine all property filters with $and at top level
    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    return filter;
  }

  /**
   * Builds a MongoDB filter expression for a property filter specification.
   * Supports recursive AND/OR chaining via QueryOptionsFilterProperty.
   */
  private _buildPropertyFilter(prop: QueryOptionsFilterProperty): Document | undefined {
    // Handle AND - ALL conditions must match
    if (prop.AND && prop.AND.length > 0) {
      const andFilters: Document[] = [];
      for (const subProp of prop.AND) {
        const subFilter = this._buildPropertyFilter(subProp);
        if (subFilter) {
          andFilters.push(subFilter);
        }
      }
      if (andFilters.length > 0) {
        return { $and: andFilters };
      }
      return undefined;
    }

    // Handle OR - ANY condition must match
    if (prop.OR && prop.OR.length > 0) {
      const orFilters: Document[] = [];
      for (const subProp of prop.OR) {
        const subFilter = this._buildPropertyFilter(subProp);
        if (subFilter) {
          orFilters.push(subFilter);
        }
      }
      if (orFilters.length > 0) {
        return { $or: orFilters };
      }
      return undefined;
    }

    // Base case: single property filter with operator
    // If key is not provided, this is a structural filter (AND/OR only) - no property filter needed
    if (prop.key === undefined) {
      return undefined;
    }

    const op = prop.op ?? '=';
    const propPath = `properties.${prop.key}`;

    switch (op) {
      case '=':
        return { [propPath]: prop.value } as Document;
      case '<>':
        return { [propPath]: { $ne: prop.value } } as Document;
      case '>':
        return { [propPath]: { $gt: prop.value } } as Document;
      case '<':
        return { [propPath]: { $lt: prop.value } } as Document;
      case '>=':
        return { [propPath]: { $gte: prop.value } } as Document;
      case '<=':
        return { [propPath]: { $lte: prop.value } } as Document;
      case 'CONTAINS':
        return { [propPath]: { $regex: String(prop.value), $options: 'i' } } as Document;
      case 'STARTS_WITH':
        return { [propPath]: { $regex: `^${this._escapeRegex(String(prop.value))}`, $options: 'i' } } as Document;
      case 'ENDS_WITH':
        return { [propPath]: { $regex: `${this._escapeRegex(String(prop.value))}$`, $options: 'i' } } as Document;
      case 'IN':
        return { [propPath]: { $in: Array.isArray(prop.value) ? prop.value : [prop.value] } } as Document;
      case 'NOT_IN':
        return { [propPath]: { $nin: Array.isArray(prop.value) ? prop.value : [prop.value] } } as Document;
      case 'IS_NULL':
        // IS_NULL should match both: field doesn't exist OR field value is null
        return { $or: [{ [propPath]: null }, { [propPath]: { $exists: false } }] } as Document;
      case 'IS_NOT_NULL':
        // IS_NOT_NULL should match: field exists AND value is not null
        return { $and: [{ [propPath]: { $exists: true } }, { [propPath]: { $ne: null } }] } as Document;
      default:
        return { [propPath]: prop.value } as Document;
    }
  }

  /**
   * Builds a MongoDB filter for a simple property (key + operator, no AND/OR).
   * Returns the filter value directly applicable to properties.key field.
   */
  private _buildSimplePropertyFilter(prop: QueryOptionsFilterProperty): unknown {
    if (prop.key === undefined) {
      return undefined;
    }

    const op = prop.op ?? '=';
    switch (op) {
      case '=':
        return prop.value;
      case '<>':
        return { $ne: prop.value };
      case '>':
        return { $gt: prop.value };
      case '<':
        return { $lt: prop.value };
      case '>=':
        return { $gte: prop.value };
      case '<=':
        return { $lte: prop.value };
      case 'CONTAINS':
        return { $regex: String(prop.value), $options: 'i' };
      case 'STARTS_WITH':
        return { $regex: `^${this._escapeRegex(String(prop.value))}`, $options: 'i' };
      case 'ENDS_WITH':
        return { $regex: `${this._escapeRegex(String(prop.value))}$`, $options: 'i' };
      case 'IN':
        return { $in: Array.isArray(prop.value) ? prop.value : [prop.value] };
      case 'NOT_IN':
        return { $nin: Array.isArray(prop.value) ? prop.value : [prop.value] };
      case 'IS_NULL':
        return { $or: [{ [prop.key]: null }, { [prop.key]: { $exists: false } }] };
      case 'IS_NOT_NULL':
        return { $and: [{ [prop.key]: { $exists: true } }, { [prop.key]: { $ne: null } }] };
      default:
        return prop.value;
    }
  }

  /**
   * Escapes special regex characters in a string.
   */
  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
}
