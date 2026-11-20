import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type CommandStartedEvent, type Db } from 'mongodb';
import { Graph } from 'grafio';
import {
  EdgeAlreadyExistsError,
  EdgeNotFoundError,
  GraphError,
  InvalidPropertyError,
  NodeAlreadyExistsError,
  NodeNotFoundError,
} from 'grafio/errors';
import {
  CachedStorageProvider,
  CacheManager,
  GraphManager,
  InMemoryCache,
  IndexAlreadyExistsError,
  MongoGraphFactory,
  MongoStorageProvider,
} from '../../src';

describe('MongoStorageProvider v8 Contract & MongoDB Parity', () => {
  let mongoServer: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let provider: MongoStorageProvider;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    client = new MongoClient(mongoServer.getUri());
    await client.connect();
    db = client.db('test_provider_v8');
    provider = new MongoStorageProvider(db, { graphId: 'v8-contract' });
    await provider.ensureIndexes();
  });

  beforeEach(async () => {
    await provider.clear();
    GraphManager.reset();
  });

  afterAll(async () => {
    GraphManager.reset();
    await client.close();
    await mongoServer.stop();
  });

  describe('Exports, Constructor & ensureIndexes()', () => {
    it('re-exports public classes from package entrypoint', () => {
      expect(MongoStorageProvider).toBeDefined();
      expect(MongoGraphFactory).toBeDefined();
      expect(IndexAlreadyExistsError).toBeDefined();
      expect(GraphManager).toBeDefined();
      expect(CachedStorageProvider).toBeDefined();
      expect(CacheManager).toBeDefined();
      expect(InMemoryCache).toBeDefined();
    });

    it('rejects non-positive or non-integer batchSize values', () => {
      expect(() => new MongoStorageProvider(db, { batchSize: 0 })).toThrow();
      expect(() => new MongoStorageProvider(db, { batchSize: -5 })).toThrow();
      expect(() => new MongoStorageProvider(db, { batchSize: 1.5 })).toThrow();
    });

    it('creates streamlined indexes without redundant edge prefix indexes', async () => {
      const customNodes = 'custom_nodes_idx';
      const customEdges = 'custom_edges_idx';
      const custom = new MongoStorageProvider(db, {
        graphId: 'custom-idx',
        nodesCollection: customNodes,
        edgesCollection: customEdges,
      });
      await custom.ensureIndexes();

      const edgeIndexNames = (await db.collection(customEdges).indexes()).map((i) => i.name);
      expect(edgeIndexNames).toContain('edge_graph_id_unique');
      expect(edgeIndexNames).toContain('edge_graph_type');
      expect(edgeIndexNames).toContain('edge_graph_source_type');
      expect(edgeIndexNames).toContain('edge_graph_target_type');
      expect(edgeIndexNames).not.toContain('edge_graph_source');
      expect(edgeIndexNames).not.toContain('edge_graph_target');

      const nodeIndexNames = (await db.collection(customNodes).indexes()).map((i) => i.name);
      expect(nodeIndexNames).toContain('node_graph_id_unique');
      expect(nodeIndexNames).toContain('node_graph_labels');

      const metaIndexNames = (await db.collection('grafio_index_metadata').indexes()).map(
        (i) => i.name,
      );
      expect(metaIndexNames).toContain('index_meta_graph_name_unique');
    });

    it('reports supportsTransactions() as false on standalone MongoMemoryServer and on client-less Db', async () => {
      expect(provider.supportsTransactions()).toBe(false);

      const clientlessDb = {
        collection: (name: string) => db.collection(name),
      } as unknown as Db;
      const clientlessProvider = new MongoStorageProvider(clientlessDb, { graphId: 'no-client' });
      expect(clientlessProvider.supportsTransactions()).toBe(false);
      await expect(clientlessProvider.beginTransaction()).rejects.toThrow(
        'MongoDB client not available for transactions',
      );
    });
  });

  describe('Batch Insertions (insertNodes & insertEdges)', () => {
    it('handles empty arrays as no-ops', async () => {
      await expect(provider.insertNodes([])).resolves.toBeUndefined();
      await expect(provider.insertEdges([])).resolves.toBeUndefined();
      expect(await provider.getNodeCount()).toBe(0);
      expect(await provider.getEdgeCount()).toBe(0);
    });

    it('inserts nodes and edges in multi-chunk batches via Graph.addNodes/addEdges', async () => {
      const chunked = new MongoStorageProvider(db, { graphId: 'chunked-graph', batchSize: 2 });
      await chunked.ensureIndexes();
      const graph = new Graph(chunked);

      const nodes = await graph.addNodes([
        { labels: 'Person', properties: { name: 'N1' }, id: 'n1' },
        { labels: ['Person', 'Staff'], properties: { name: 'N2' }, id: 'n2' },
        { labels: 'Person', properties: { name: 'N3' }, id: 'n3' },
        { labels: 'Person', properties: { name: 'N4' }, id: 'n4' },
        { labels: 'Person', properties: { name: 'N5' }, id: 'n5' },
      ]);
      expect(nodes).toHaveLength(5);

      const edges = await graph.addEdges([
        { sourceId: 'n1', targetId: 'n2', type: 'KNOWS', id: 'e1', properties: { w: 1 } },
        { sourceId: 'n2', targetId: 'n3', type: 'KNOWS', id: 'e2', properties: { w: 2 } },
        { sourceId: 'n3', targetId: 'n4', type: 'KNOWS', id: 'e3', properties: { w: 3 } },
        { sourceId: 'n4', targetId: 'n5', type: 'KNOWS', id: 'e4', properties: { w: 4 } },
        { sourceId: 'n5', targetId: 'n1', type: 'KNOWS', id: 'e5' },
      ]);
      expect(edges).toHaveLength(5);
      expect(await chunked.getNodeCount()).toBe(5);
      expect(await chunked.getEdgeCount()).toBe(5);
      await chunked.clear();
    });

    it('rejects intra-batch and pre-existing duplicate IDs atomically without partial writes', async () => {
      const chunked = new MongoStorageProvider(db, { graphId: 'atomic-batch', batchSize: 2 });
      await chunked.ensureIndexes();

      await chunked.insertNode({ id: 'existing-node', labels: ['Item'], properties: {} });
      await chunked.insertEdge({
        id: 'existing-edge',
        sourceId: 'a',
        targetId: 'b',
        type: 'LINK',
        properties: {},
      });

      // Intra-batch duplicate node
      await expect(
        chunked.insertNodes([
          { id: 'dup-in-batch', labels: ['Item'], properties: {} },
          { id: 'dup-in-batch', labels: ['Item'], properties: {} },
        ]),
      ).rejects.toThrow(NodeAlreadyExistsError);
      expect(await chunked.hasNode('dup-in-batch')).toBe(false);

      // Pre-existing node in chunk 2 must fail before chunk 1 is written
      await expect(
        chunked.insertNodes([
          { id: 'fresh-1', labels: ['Item'], properties: {} },
          { id: 'fresh-2', labels: ['Item'], properties: {} },
          { id: 'existing-node', labels: ['Item'], properties: {} },
        ]),
      ).rejects.toThrow(NodeAlreadyExistsError);
      expect(await chunked.hasNode('fresh-1')).toBe(false);
      expect(await chunked.hasNode('fresh-2')).toBe(false);

      // Intra-batch duplicate edge
      await expect(
        chunked.insertEdges([
          { id: 'dup-edge', sourceId: 'x', targetId: 'y', type: 'REL', properties: {} },
          { id: 'dup-edge', sourceId: 'x', targetId: 'y', type: 'REL', properties: {} },
        ]),
      ).rejects.toThrow(EdgeAlreadyExistsError);
      expect(await chunked.hasEdge('dup-edge')).toBe(false);

      // Pre-existing edge in chunk 2 must fail before chunk 1 is written
      await expect(
        chunked.insertEdges([
          { id: 'fresh-e1', sourceId: 'x', targetId: 'y', type: 'REL', properties: {} },
          { id: 'fresh-e2', sourceId: 'x', targetId: 'y', type: 'REL', properties: {} },
          { id: 'existing-edge', sourceId: 'x', targetId: 'y', type: 'REL', properties: {} },
        ]),
      ).rejects.toThrow(EdgeAlreadyExistsError);
      expect(await chunked.hasEdge('fresh-e1')).toBe(false);

      // Dangling edges are allowed by raw insertEdges
      await chunked.insertEdges([
        { id: 'dangling-1', sourceId: 'later-1', targetId: 'later-2', type: 'LINK', properties: {} },
      ]);
      expect(await chunked.hasEdge('dangling-1')).toBe(true);

      await chunked.clear();
    });
  });

  describe('Unified patchProperties() & Single-RTT removeNodeLabels()', () => {
    it('supports merge, unset, undefined deletion, overlapping set/unset, and full replace on nodes and edges', async () => {
      await provider.insertNode({
        id: 'n1',
        labels: ['Person', 'Admin', 'Staff'],
        properties: { name: 'Alice', age: 30, temp: 'remove-me', keep: true },
      });
      await provider.insertNode({
        id: 'n2',
        labels: ['Person'],
        properties: { name: 'Bob' },
      });
      await provider.insertEdge({
        id: 'e1',
        sourceId: 'n1',
        targetId: 'n2',
        type: 'KNOWS',
        properties: { since: 2020, weight: 0.5, note: 'old' },
      });

      // Partial patch with set + unset + undefined + overlapping set/unset ('name' in both -> set wins)
      await provider.patchProperties('node', 'n1', {
        set: { name: 'Alicia', city: 'NYC', temp: undefined },
        unset: ['name', 'keep'],
      });
      const n1AfterPatch = await provider.getNode('n1');
      expect(n1AfterPatch?.properties).toEqual({ name: 'Alicia', age: 30, city: 'NYC' });

      // Empty patch still succeeds and updates timestamp
      await expect(provider.patchProperties('node', 'n1', {})).resolves.toBeUndefined();

      // Full replacement ignoring undefined values
      await provider.patchProperties('node', 'n1', {
        set: { role: 'owner', emptyUndef: undefined },
        replace: true,
      });
      expect((await provider.getNode('n1'))?.properties).toEqual({ role: 'owner' });

      // Edge partial patch and full replace
      await provider.patchProperties('edge', 'e1', {
        set: { since: 2025, strength: 'high', note: undefined },
        unset: ['weight'],
      });
      expect((await provider.getEdge('e1'))?.properties).toEqual({ since: 2025, strength: 'high' });

      await provider.patchProperties('edge', 'e1', {
        set: { verified: true },
        replace: true,
      });
      expect((await provider.getEdge('e1'))?.properties).toEqual({ verified: true });

      // Non-primitive rejection
      await expect(
        provider.patchProperties('node', 'n1', { set: { nested: { a: 1 } } }),
      ).rejects.toThrow(InvalidPropertyError);

      // Missing targets (replace & merge)
      await expect(
        provider.patchProperties('node', 'missing', { set: { a: 1 } }),
      ).rejects.toThrow(NodeNotFoundError);
      await expect(
        provider.patchProperties('node', 'missing', { set: { a: 1 }, replace: true }),
      ).rejects.toThrow(NodeNotFoundError);
      await expect(
        provider.patchProperties('edge', 'missing', { set: { a: 1 } }),
      ).rejects.toThrow(EdgeNotFoundError);
      await expect(
        provider.patchProperties('edge', 'missing', { set: { a: 1 }, replace: true }),
      ).rejects.toThrow(EdgeNotFoundError);

      // Single-RTT removeNodeLabels
      await provider.removeNodeLabels('n1', ['Admin', 'NonExistentLabel']);
      expect((await provider.getNode('n1'))?.labels).toEqual(['Person', 'Staff']);
      await expect(provider.removeNodeLabels('missing-node', ['Person'])).rejects.toThrow(
        NodeNotFoundError,
      );
    });
  });

  describe('Scoped & Compound Index Management, Epoch & PlanCache Invalidation', () => {
    it('supports labelOrType scoping, wildcard normalization, partition isolation, and indexEpoch tracking', async () => {
      const epoch0 = provider.indexEpoch;

      // Empty propertyKeys no-op
      await expect(provider.createIndex('empty', 'node', [])).resolves.toBeUndefined();
      expect(await provider.hasIndex('node', [])).toBe(false);

      // Scoped node index (:Person on email)
      await provider.createIndex('idx_person_email', 'node', ['email'], { labelOrType: 'Person' });
      const epoch1 = provider.indexEpoch;
      expect(epoch1).toBeGreaterThan(epoch0);

      expect(await provider.hasIndex('node', ['email'], 'Person')).toBe(true);
      expect(await provider.hasIndex('node', ['email'], 'Company')).toBe(false);
      expect(await provider.hasIndex('node', ['email'])).toBe(false);

      const meta = await provider.getIndex('idx_person_email');
      expect(meta).toEqual({
        name: 'idx_person_email',
        target: 'node',
        propertyKeys: ['email'],
        labelOrType: 'Person',
      });

      // Unscoped index coexists with scoped index on the same property key
      await provider.createIndex('idx_all_email', 'node', ['email'], { labelOrType: '*' });
      expect(await provider.hasIndex('node', ['email'])).toBe(true);
      expect(await provider.hasIndex('node', ['email'], 'Company')).toBe(true);
      const wildcardMeta = await provider.getIndex('idx_all_email');
      expect(wildcardMeta).toEqual({
        name: 'idx_all_email',
        target: 'node',
        propertyKeys: ['email'],
      });

      // Duplicate key-set check regardless of key order
      await provider.createIndex('idx_compound_edge', 'edge', ['weight', 'since'], {
        labelOrType: 'KNOWS',
      });
      await expect(
        provider.createIndex('idx_compound_edge_dup', 'edge', ['since', 'weight'], {
          labelOrType: 'KNOWS',
        }),
      ).rejects.toThrow(IndexAlreadyExistsError);
      expect(await provider.hasIndex('edge', ['since', 'weight'], 'KNOWS')).toBe(true);
      expect(await provider.hasIndex('edge', ['since', 'weight'], 'LIKES')).toBe(false);

      // Long index name (>96 chars) hashes safely and drops cleanly
      const longName = `very_long_index_name_${'x'.repeat(100)}`;
      await provider.createIndex(longName, 'node', ['country', 'city']);
      expect(await provider.getIndex(longName)).toBeDefined();
      await provider.deleteIndex(longName);
      expect(await provider.getIndex(longName)).toBeUndefined();

      // Partition isolation: second graphId creates the same index name on the same Db
      const secondPartition = new MongoStorageProvider(db, {
        graphId: 'v8-contract-other',
        cacheIndexMetadata: false,
      });
      await secondPartition.ensureIndexes();
      await expect(
        secondPartition.createIndex('idx_person_email', 'node', ['email'], { labelOrType: 'Person' }),
      ).resolves.toBeUndefined();
      expect(await secondPartition.hasIndex('node', ['email'], 'Person')).toBe(true);
      expect(await secondPartition.getIndexes()).toHaveLength(1);
      await secondPartition.deleteIndex('idx_person_email');
      await secondPartition.clear();

      // Legacy metadata document without mongoIndexNames drops gracefully
      await db.collection('grafio_index_metadata').insertOne({
        name: 'legacy_idx',
        graphId: 'v8-legacy',
        target: 'node',
        propertyKeys: ['tag'],
        createdOn: Date.now(),
      });
      const legacyProvider = new MongoStorageProvider(db, { graphId: 'v8-legacy' });
      expect(await legacyProvider.getIndex('legacy_idx')).toEqual({
        name: 'legacy_idx',
        target: 'node',
        propertyKeys: ['tag'],
      });
      await expect(legacyProvider.deleteIndex('legacy_idx')).resolves.toBeUndefined();
      await legacyProvider.clear();

      // Deleting non-existent index throws
      await expect(provider.deleteIndex('does-not-exist')).rejects.toThrow();

      // indexEpoch shared across MongoGraphFactory.forGraph instances invalidates Cypher PlanCache
      const factory = new MongoGraphFactory(db);
      const graphA = factory.forGraph('v8-contract');
      await graphA.addNode('Person', { name: 'Alice', email: 'alice@example.com' });
      const res1 = await graphA.query(
        "MATCH (p:Person { email: 'alice@example.com' }) RETURN p.name AS name",
      );
      expect(res1.rows[0].name).toBe('Alice');

      const graphB = factory.forGraph('v8-contract');
      const beforeMutateEpoch = graphA.indexEpoch;
      await graphB.createIndex('idx_person_name', 'node', ['name'], { labelOrType: 'Person' });
      expect(graphA.indexEpoch).toBeGreaterThan(beforeMutateEpoch);

      await graphA.clear();
      expect(graphA.indexEpoch).toBeGreaterThan(beforeMutateEpoch + 1);
    });
  });

  describe('Aggregations, Ordering, Portability & Hardened Filters', () => {
    it('computes distinct numeric aggregations while ignoring NaN and non-numeric values', async () => {
      await provider.insertNodes([
        { id: 'a', labels: ['Metric'], properties: { val: 10, group: 'g1' } },
        { id: 'b', labels: ['Metric'], properties: { val: 10, group: 'g1' } },
        { id: 'c', labels: ['Metric'], properties: { val: 20, group: 'g1' } },
        { id: 'd', labels: ['Metric'], properties: { val: Number.NaN, group: 'g1' } },
        { id: 'e', labels: ['Metric'], properties: { val: 'ignored', group: 'g1' } },
      ]);
      await provider.insertEdges([
        { id: 'e1', sourceId: 'a', targetId: 'b', type: 'SCORE', properties: { w: 5 } },
        { id: 'e2', sourceId: 'b', targetId: 'c', type: 'SCORE', properties: { w: 5 } },
        { id: 'e3', sourceId: 'c', targetId: 'd', type: 'SCORE', properties: { w: 15 } },
        { id: 'e4', sourceId: 'd', targetId: 'e', type: 'SCORE', properties: { w: Number.NaN } },
      ]);

      expect(await provider.aggregateNodeProperty('val')).toEqual({
        count: 3,
        sum: 40,
        avg: 40 / 3,
        min: 10,
        max: 20,
      });
      expect(await provider.aggregateNodeProperty('val', { distinct: true })).toEqual({
        count: 2,
        sum: 30,
        avg: 15,
        min: 10,
        max: 20,
      });
      expect(
        await provider.aggregateNodeProperty('val', {
          distinct: true,
          filter: { properties: [{ key: 'group', value: 'g1' }] },
        }),
      ).toEqual({
        count: 2,
        sum: 30,
        avg: 15,
        min: 10,
        max: 20,
      });
      expect(await provider.aggregateNodeProperty('missingKey')).toEqual({ count: 0 });

      expect(await provider.aggregateEdgeProperty('w', { distinct: true })).toEqual({
        count: 2,
        sum: 20,
        avg: 10,
        min: 5,
        max: 15,
      });
      expect(await provider.aggregateEdgeProperty('missingKey')).toEqual({ count: 0 });
    });

    it('handles getNodesByIds([]), orderBy, limit: 0, importJSON non-empty guard, and exportJSON', async () => {
      expect((await provider.getNodesByIds([])).size).toBe(0);

      await provider.insertNodes([
        { id: 'n1', labels: ['Item'], createdOn: 100, updatedOn: 300, properties: { score: 20 } },
        { id: 'n2', labels: ['Item'], createdOn: 200, updatedOn: 100, properties: { score: 10 } },
        { id: 'n3', labels: ['Item'], createdOn: 300, updatedOn: 200, properties: { score: 30 } },
      ]);

      const byIds = await provider.getNodesByIds(['n1', 'n3']);
      expect(Array.from(byIds.keys()).sort()).toEqual(['n1', 'n3']);

      expect(await provider.getNodes({ limit: 0 })).toEqual([]);
      const ordered = await provider.getNodes({
        orderBy: { field: 'createdOn', direction: 'desc' },
        limit: 2,
      });
      expect(ordered.map((n) => n.id)).toEqual(['n3', 'n2']);

      const orderedByProp = await provider.getNodes({
        orderBy: { field: 'score', direction: 'asc' },
      });
      expect(orderedByProp.map((n) => n.id)).toEqual(['n2', 'n1', 'n3']);

      const exported = await provider.exportJSON();
      expect(exported.graphId).toBe('v8-contract');
      expect(exported.nodes).toHaveLength(3);

      await expect(provider.importJSON(exported)).rejects.toThrow(GraphError);

      await provider.clear();
      await expect(provider.importJSON(exported)).resolves.toBeUndefined();
      expect(await provider.getNodeCount()).toBe(3);
    });

    it('enforces case-sensitive regex-escaped string filters, null equality, and null range guards', async () => {
      await provider.insertNodes([
        { id: 's1', labels: ['Text'], properties: { text: 'Alice a.b+c?', tag: null } },
        { id: 's2', labels: ['Text'], properties: { text: 'alice A.B+C?' } },
        { id: 's3', labels: ['Text'], properties: { text: 'aXbYcZ', score: 10 } },
      ]);

      // Case-sensitive CONTAINS + escaped regex metacharacters
      const containsLower = await provider.getNodes({
        filter: { properties: [{ key: 'text', value: 'a.b+c?', op: 'CONTAINS' }] },
      });
      expect(containsLower.map((n) => n.id)).toEqual(['s1']);

      // Case-sensitive STARTS_WITH and ENDS_WITH
      const startsUpper = await provider.getNodes({
        filter: { properties: [{ key: 'text', value: 'Ali', op: 'STARTS_WITH' }] },
      });
      expect(startsUpper.map((n) => n.id)).toEqual(['s1']);

      const endsExact = await provider.getNodes({
        filter: { properties: [{ key: 'text', value: 'c?', op: 'ENDS_WITH' }] },
      });
      expect(endsExact.map((n) => n.id)).toEqual(['s1']);

      // Non-string guards match zero nodes
      for (const op of ['CONTAINS', 'STARTS_WITH', 'ENDS_WITH'] as const) {
        const res = await provider.getNodes({
          filter: { properties: [{ key: 'text', value: null, op }] },
        });
        expect(res).toHaveLength(0);
      }

      // '=' with null matches explicit null property only, not missing properties
      const eqNull = await provider.getNodes({
        filter: { properties: [{ key: 'tag', value: null, op: '=' }] },
      });
      expect(eqNull.map((n) => n.id)).toEqual(['s1']);

      // Null/undefined range operators match zero nodes
      for (const op of ['>', '<', '>=', '<='] as const) {
        const res = await provider.getNodes({
          filter: { properties: [{ key: 'score', value: null, op }] },
        });
        expect(res).toHaveLength(0);
      }

      // Non-array IN / NOT_IN and combined AND + OR + key filter
      const combined = await provider.getNodes({
        filter: {
          properties: [
            {
              key: 'text',
              value: 'Alice',
              op: 'STARTS_WITH',
              AND: [{ key: 'text', value: 'a.b+c?', op: 'CONTAINS' }],
              OR: [{ key: 'tag', value: null, op: 'IS_NULL' }],
            },
          ],
        },
      });
      expect(combined.map((n) => n.id)).toEqual(['s1']);

      const scalarIn = await provider.getNodes({
        filter: { properties: [{ key: 'score', value: 10, op: 'IN' }] },
      });
      expect(scalarIn.map((n) => n.id)).toEqual(['s3']);
    });
  });

  describe('End-to-End Cypher Queries against MongoDB', () => {
    it('executes CREATE, MATCH, variable-length traversal, MERGE, SET, REMOVE, DETACH DELETE, DISTINCT aggregates, and index DDL', async () => {
      const graph = new Graph(provider);

      // CREATE nodes and edges via Cypher
      await graph.query(`
        CREATE
          (a:Person { name: 'Alice', city: 'NYC', score: 10, temp: 'x' }),
          (b:Person { name: 'Bob', city: 'NYC', score: 10 }),
          (c:Person { name: 'Carol', city: 'LA', score: 20 }),
          (a)-[:KNOWS { since: 2020 }]->(b),
          (b)-[:KNOWS { since: 2021 }]->(c)
      `);

      // MATCH with variable-length traversal
      const hops = await graph.query(`
        MATCH (a:Person { name: 'Alice' })-[:KNOWS*1..2]->(friend:Person)
        RETURN friend.name AS name
        ORDER BY name
      `);
      expect(hops.rows.map((r) => r.name)).toEqual(['Bob', 'Carol']);

      // MERGE, SET +=, SET =, REMOVE property & label
      await graph.query(`
        MERGE (d:Person { name: 'Carol' })
        ON MATCH SET d.merged = true
      `);
      const mergedCarol = await graph.query(
        "MATCH (c:Person { name: 'Carol' }) RETURN c.merged AS merged",
      );
      expect(mergedCarol.rows[0].merged).toBe(true);

      await graph.query(`
        MATCH (a:Person { name: 'Alice' })
        SET a += { role: 'lead' }
        REMOVE a.temp
      `);
      const afterSetPlus = await graph.query(
        "MATCH (a:Person { name: 'Alice' }) RETURN a.role AS role, a.temp AS temp, a.city AS city",
      );
      expect(afterSetPlus.rows[0]).toEqual({ role: 'lead', temp: undefined, city: 'NYC' });

      await graph.query(`
        MATCH (c:Person { name: 'Carol' })
        SET c = { name: 'Carol', city: 'LA', score: 20 }
      `);

      const tagNode = await graph.addNode(['Person', 'TempTag'], { name: 'TagNode' });
      await graph.query(`
        MATCH (a:Person { name: 'Alice' }), (t:TempTag { name: 'TagNode' })
        CREATE (a)-[:TAGGED]->(t)
      `);
      await graph.query(`
        MATCH (t:TempTag)
        REMOVE t:TempTag
      `);
      expect((await graph.getNode(tagNode.id))?.labels).toEqual(['Person']);

      // Storage-level & in-process DISTINCT aggregates
      const agg = await graph.query(`
        MATCH (p:Person)
        RETURN COUNT(DISTINCT p.score) AS scores, SUM(DISTINCT p.score) AS distinctScore
      `);
      expect(agg.rows[0]).toEqual({ scores: 2, distinctScore: 30 });

      const filteredCityAgg = await graph.query(`
        MATCH (p:Person)
        WHERE p.score > 0
        RETURN COUNT(DISTINCT p.city) AS cities
      `);
      expect(filteredCityAgg.rows[0]).toEqual({ cities: 2 });

      // Cypher index DDL
      await graph.query('CREATE INDEX idx_cypher_name FOR (p:Person) ON (p.name)');
      const shown = await graph.query('SHOW INDEXES');
      expect(shown.rows.some((r) => r.name === 'idx_cypher_name')).toBe(true);
      await graph.query('DROP INDEX idx_cypher_name');

      // DETACH DELETE
      await graph.query("MATCH (t { name: 'TagNode' }) DETACH DELETE t");
      const remaining = await graph.query('MATCH (p:Person) RETURN count(p) AS cnt');
      expect(remaining.rows[0].cnt).toBe(3);
    });
  });

  describe('Replica Set Transactions & Cypher Write Auto-Transactions', () => {
    let replSet: MongoMemoryReplSet;
    let rsClient: MongoClient;
    let rsProvider: MongoStorageProvider;

    beforeAll(async () => {
      replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      rsClient = new MongoClient(replSet.getUri());
      await rsClient.connect();
      rsProvider = new MongoStorageProvider(rsClient.db('test_rs'), { graphId: 'rs-v8' });
      await rsProvider.ensureIndexes();
    });

    beforeEach(async () => {
      await rsProvider.clear();
    });

    afterAll(async () => {
      await rsClient.close();
      await replSet.stop();
    });

    it('detects replica set topology in supportsTransactions() and supports Cypher + explicit GraphTransactions', async () => {
      expect(rsProvider.supportsTransactions()).toBe(true);
      const graph = new Graph(rsProvider);

      // Cypher write auto-transaction commit
      await graph.query("CREATE (a:Person { name: 'Alice' })-[:KNOWS]->(b:Person { name: 'Bob' })");
      const res = await graph.query('MATCH (n:Person) RETURN count(n) AS cnt');
      expect(res.rows[0].cnt).toBe(2);

      // Explicit GraphTransaction rollback
      const tx = graph.createTransaction();
      await tx.begin();
      await graph.query("CREATE (:Person { name: 'RolledBack' })", { transaction: tx });
      await tx.rollback();
      const afterRollback = await graph.query('MATCH (n:Person) RETURN count(n) AS cnt');
      expect(afterRollback.rows[0].cnt).toBe(2);

      // Direct session commit/rollback error guards
      const handle = await rsProvider.beginTransaction();
      await rsProvider.commitTransaction(handle);
      await expect(rsProvider.commitTransaction(handle)).rejects.toThrow(
        'No active transaction to commit',
      );
      await expect(rsProvider.rollbackTransaction(handle)).resolves.toBeUndefined();

      // Transactional isolation for aggregateGrouped
      const isoTx = await rsProvider.beginTransaction();
      await rsProvider.insertNode(
        { id: 'iso-1', labels: ['Metric'], properties: { group: 'tx', val: 50 } },
        isoTx,
      );
      const outsideRows = await rsProvider.aggregateGrouped({
        target: 'node',
        groupByKeys: ['group'],
        aggregates: [{ alias: 'total', fn: 'SUM', propertyKey: 'val' }],
        options: { filter: { types: ['Metric'] } },
      });
      expect(outsideRows).toEqual([]);

      const insideRows = await rsProvider.aggregateGrouped({
        target: 'node',
        groupByKeys: ['group'],
        aggregates: [{ alias: 'total', fn: 'SUM', propertyKey: 'val' }],
        options: { filter: { types: ['Metric'] }, transaction: isoTx },
      });
      expect(insideRows).toEqual([{ groupValues: ['tx'], aggValues: { total: 50 } }]);
      await rsProvider.rollbackTransaction(isoTx);
    });
  });

  describe('Tier 2 Batch & Server-Side Pushdown Capabilities', () => {
    it('batches getEdgesBySources, getEdgesByTargets, deleteEdges, and deduplicates self-loops', async () => {
      await provider.insertNodes([
        { id: 'a', labels: ['N'], properties: {} },
        { id: 'b', labels: ['N'], properties: {} },
        { id: 'c', labels: ['N'], properties: {} },
      ]);
      await provider.insertEdges([
        { id: 'e1', sourceId: 'a', targetId: 'b', type: 'KNOWS', properties: { w: 20 } },
        { id: 'e2', sourceId: 'a', targetId: 'c', type: 'KNOWS', properties: { w: 5 } },
        { id: 'e3', sourceId: 'a', targetId: 'b', type: 'LIKES', properties: { w: 1 } },
        { id: 'e4', sourceId: 'b', targetId: 'c', type: 'KNOWS', properties: {} },
      ]);

      expect((await provider.getEdgesBySources([])).size).toBe(0);
      const zeroLimit = await provider.getEdgesBySources(['a', 'b'], { limit: 0 });
      expect(zeroLimit.get('a')).toEqual([]);
      expect(zeroLimit.get('b')).toEqual([]);

      const srcSorted = await provider.getEdgesBySources(['a', 'c'], {
        filter: { types: ['KNOWS'] },
        orderBy: { field: 'w', direction: 'asc' },
        limit: 1,
      });
      expect(srcSorted.get('a')?.map((e) => e.id)).toEqual(['e2']);
      expect(srcSorted.get('c')).toEqual([]);

      const tgtSorted = await provider.getEdgesByTargets(['b', 'c'], {
        orderBy: { field: 'w', direction: 'desc' },
      });
      expect(tgtSorted.get('b')?.map((e) => e.id)).toEqual(['e1', 'e3']);
      // Undefined sort property comes first in descending order matching GraphIndex/CachedStorageProvider parity
      expect(tgtSorted.get('c')?.map((e) => e.id)).toEqual(['e4', 'e2']);

      // Batch delete & empty no-op
      await provider.deleteEdges([]);
      await provider.deleteEdges(['e3', 'e4', 'e3']);
      expect(await provider.hasEdge('e3')).toBe(false);
      expect(await provider.hasEdge('e4')).toBe(false);

      // Self-loop cascade delete exact count via Graph.removeNode
      const graph = new Graph(provider);
      const loopNode = await graph.addNode('N', { name: 'Loop' });
      await graph.addEdge(loopNode.id, loopNode.id, 'SELF');
      const res = await graph.removeNode(loopNode.id, true);
      expect(res).toEqual({ result: true, cascadeDeletedEdgesCount: 1 });
    });

    it('pushes aggregateGrouped cleanly with undefined vs null keys, NaN exclusion, empty AVG === 0, and edge grouping', async () => {
      await provider.insertNodes([
        { id: 'p1', labels: ['Person'], properties: { city: 'NYC', score: 10 } },
        { id: 'p2', labels: ['Person'], properties: { city: 'NYC', score: Number.NaN } },
        { id: 'p3', labels: ['Person'], properties: { city: null, score: 30 } },
        { id: 'p4', labels: ['Person'], properties: {} }, // city missing -> undefined
        { id: 'p5', labels: ['Person'], properties: { city: 'LA' } }, // missing score
      ]);
      await provider.insertEdges([
        { id: 'r1', sourceId: 'p1', targetId: 'p2', type: 'RATED', properties: { kind: 'A', val: 4 } },
        { id: 'r2', sourceId: 'p2', targetId: 'p3', type: 'RATED', properties: { kind: 'A', val: 6 } },
      ]);

      const rows = await provider.aggregateGrouped({
        target: 'node',
        groupByKeys: ['city'],
        aggregates: [
          { alias: 'cntAll', fn: 'COUNT' },
          { alias: 'cntScore', fn: 'COUNT', propertyKey: 'score' },
          { alias: 'sumScore', fn: 'SUM', propertyKey: 'score' },
          { alias: 'avgScore', fn: 'AVG', propertyKey: 'score' },
          { alias: 'minScore', fn: 'MIN', propertyKey: 'score' },
          { alias: 'maxScore', fn: 'MAX', propertyKey: 'score' },
        ],
        options: { filter: { types: ['Person'] } },
      });
      expect(rows).not.toBeNull();

      const byCity = new Map<unknown, Record<string, unknown>>(
        rows!.map((r) => [r.groupValues[0], r.aggValues]),
      );
      // Distinction between null and missing/undefined must match JavaScript ClosureCompiler semantics
      expect(byCity.get(undefined)).toEqual({
        cntAll: 1,
        cntScore: 0,
        sumScore: 0,
        avgScore: 0,
        minScore: null,
        maxScore: null,
      });
      expect(byCity.get(null)).toEqual({
        cntAll: 1,
        cntScore: 1,
        sumScore: 30,
        avgScore: 30,
        minScore: 30,
        maxScore: 30,
      });
      // NaN is counted by COUNT(score) in Cypher, excluded from SUM/AVG/MIN/MAX
      expect(byCity.get('NYC')).toEqual({
        cntAll: 2,
        cntScore: 2,
        sumScore: 10,
        avgScore: 10,
        minScore: 10,
        maxScore: 10,
      });
      expect(byCity.get('LA')).toEqual({
        cntAll: 1,
        cntScore: 0,
        sumScore: 0,
        avgScore: 0,
        minScore: null,
        maxScore: null,
      });

      // Edge-level grouping
      const edgeRows = await provider.aggregateGrouped({
        target: 'edge',
        groupByKeys: ['kind'],
        aggregates: [{ alias: 'avgVal', fn: 'AVG', propertyKey: 'val' }],
      });
      expect(edgeRows).toEqual([{ groupValues: ['A'], aggValues: { avgVal: 5 } }]);

      // distinct aggregate delegates fallback cleanly by returning null
      expect(
        await provider.aggregateGrouped({
          target: 'node',
          groupByKeys: ['city'],
          aggregates: [{ alias: 'c', fn: 'COUNT', propertyKey: 'score', distinct: true }],
        }),
      ).toBeNull();
    });

    it('executes traverseShortestPath via $graphLookup and falls back cleanly beyond 6 hops', async () => {
      const chainIds = Array.from({ length: 8 }, (_, i) => `c${i}`);
      await provider.insertNodes(
        chainIds.map((id) => ({ id, labels: ['Hop'], properties: {} })),
      );
      await provider.insertNode({ id: 'isolated', labels: ['Hop'], properties: {} });

      const chainEdges = chainIds.slice(0, -1).map((src, i) => ({
        id: `ce${i}`,
        sourceId: src,
        targetId: chainIds[i + 1]!,
        type: 'STEP',
        properties: {},
      }));
      await provider.insertEdges([
        ...chainEdges,
        { id: 'alt', sourceId: 'c0', targetId: 'c3', type: 'SHORTCUT', properties: {} },
      ]);

      expect(await provider.traverseShortestPath('missing', 'c0')).toBeNull();
      expect(await provider.traverseShortestPath('c0', 'c0')).toEqual(['c0']);
      expect(await provider.traverseShortestPath('c0', 'isolated')).toBeNull();

      // Shortest 2-hop via SHORTCUT vs 4-hop STEP-only
      expect(await provider.traverseShortestPath('c0', 'c3')).toEqual(['c0', 'c3']);
      expect(await provider.traverseShortestPath('c0', 'c3', ['STEP'])).toEqual([
        'c0',
        'c1',
        'c2',
        'c3',
      ]);

      // 6 hops (7 nodes: c0 -> c6) resolves directly inside $graphLookup maxDepth: 5
      expect(await provider.traverseShortestPath('c0', 'c6', ['STEP'])).toEqual(chainIds.slice(0, 7));

      // 7 hops (c0 -> c7) exceeds maxDepth: 5 -> returns undefined so Graph.traverse falls back cleanly
      expect(await provider.traverseShortestPath('c0', 'c7', ['STEP'])).toBeUndefined();
      const graph = new Graph(provider);
      expect(
        await graph.traverse('c0', 'c7', { method: 'bfs', edgeTypes: ['STEP'] }),
      ).toEqual([chainIds]);
    });

    it('collapses MongoDB commandStarted round-trips for multi-row Cypher joins, filtered COUNT, and grouped aggregates', async () => {
      const spyClient = new MongoClient(mongoServer.getUri(), { monitorCommands: true });
      await spyClient.connect();
      const commands: string[] = [];
      const onCmd = (ev: CommandStartedEvent) => {
        commands.push(ev.commandName);
      };
      spyClient.on('commandStarted', onCmd);

      try {
        const spyProvider = new MongoStorageProvider(spyClient.db('test_provider_v8_rtt'), {
          graphId: 'rtt-test',
        });
        await spyProvider.ensureIndexes();
        const graph = new Graph(spyProvider);

        // Seed 8 Users -> 8 Profiles with varying cities & scores
        const nodes = [];
        const edges = [];
        for (let i = 0; i < 8; i++) {
          nodes.push({
            id: `u${i}`,
            labels: ['User'],
            properties: { active: i % 2 === 0, city: i < 4 ? 'NYC' : 'SF', score: (i + 1) * 10 },
          });
          nodes.push({
            id: `p${i}`,
            labels: ['Profile'],
            properties: { bio: `bio-${i}` },
          });
          edges.push({
            id: `e${i}`,
            sourceId: `u${i}`,
            targetId: `p${i}`,
            type: 'HAS_PROFILE',
            properties: {},
          });
        }
        await spyProvider.insertNodes(nodes);
        await spyProvider.insertEdges(edges);
        // Pre-warm index metadata cache once so commandStarted assertions isolate query RTTs
        await spyProvider.getIndexes();

        // 1. Multi-row Cypher join executes in constant O(hops) commands, NOT O(rows)
        commands.length = 0;
        const joinRes = await graph.query(`
          MATCH (u:User)-[:HAS_PROFILE]->(p:Profile)
          RETURN u.city AS city, p.bio AS bio
        `);
        expect(joinRes.rows).toHaveLength(8);
        // 1 User scan + 1 getEdgesBySources batch + 1 getNodesByIds batch = 3 find commands
        expect(commands.length).toBeLessThanOrEqual(4);

        // 2. WHERE-filtered COUNT pushdown issues zero `find` commands (1 count/aggregate RTT)
        commands.length = 0;
        const countRes = await graph.query(`
          MATCH (u:User)
          WHERE u.active = true
          RETURN count(u) AS activeUsers
        `);
        expect(countRes.rows).toEqual([{ activeUsers: 4 }]);
        expect(commands).toHaveLength(1);
        expect(commands).not.toContain('find');

        // 3. Grouped Cypher aggregate pushdown executes in 1 `aggregate` command without transferring docs
        commands.length = 0;
        const aggRes = await graph.query(`
          MATCH (u:User)
          RETURN u.city AS city, count(u) AS c, sum(u.score) AS total, avg(u.score) AS mean
          ORDER BY city ASC
        `);
        expect(aggRes.rows).toEqual([
          { city: 'NYC', c: 4, total: 100, mean: 25 },
          { city: 'SF', c: 4, total: 260, mean: 65 },
        ]);
        expect(commands).toEqual(['aggregate']);
      } finally {
        spyClient.off('commandStarted', onCmd);
        await spyClient.close();
      }
    });
  });
});
