import { beforeAll, afterAll, beforeEach, describe, expect, it, test } from '@jest/globals';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

import { MongoGraphFactory } from '../../src/MongoGraphFactory';
import { runGraphFactoryScenarios } from 'grafio/testing';

let mongoServer: MongoMemoryServer;
let client: MongoClient;
let factory: MongoGraphFactory;

runGraphFactoryScenarios(
  async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    client = new MongoClient(uri);
    await client.connect();
    factory = new MongoGraphFactory(client.db('test'));
    await factory.ensureIndexes();
    return factory;
  },
  async () => { },
  async () => {
    await client.close();
    await mongoServer.stop();
  },
  async () => {
    describe('MongoGraphFactory', () => {

      it('should import graph data and return a Graph instance', async () => {
        const data = {
          nodes: [
            { id: 'n1', type: 'Person', properties: { name: 'Alice' } },
            { id: 'n2', type: 'Person', properties: { name: 'Bob' } },
          ],
          edges: [
            { id: 'e1', sourceId: 'n1', targetId: 'n2', type: 'KNOWS', properties: {} },
          ],
        };

        const graph = await factory.fromGraphData(data, 'import-test');

        const nodes = await graph.getNodes();
        expect(nodes).toHaveLength(2);
        expect(nodes[0].properties.name).toBe('Alice');
        expect(nodes[1].properties.name).toBe('Bob');

        const edges = await graph.getEdges();
        expect(edges).toHaveLength(1);
        expect(edges[0].type).toBe('KNOWS');
      });

      it('should use default graphId when not specified', async () => {
        const data = {
          nodes: [
            { id: 'n1', type: 'Person', properties: { name: 'Carol' } },
          ],
          edges: [],
        };

        const graph = await factory.fromGraphData(data);

        const nodes = await graph.getNodes();
        expect(nodes).toHaveLength(1);
        expect(nodes[0].properties.name).toBe('Carol');
      });

      it('should filter out data when graphId does not match', async () => {
        const data = {
          graphId: 'other-graph',
          nodes: [
            { id: 'n1', type: 'Person', properties: { name: 'ShouldNotImport' } },
          ],
          edges: [],
        };

        const graph = await factory.fromGraphData(data, 'my-graph');

        const nodes = await graph.getNodes();
        expect(nodes).toHaveLength(0);
      });

      it('should import data when graphId matches', async () => {
        const data = {
          graphId: 'my-graph',
          nodes: [
            { id: 'n1', type: 'Person', properties: { name: 'ShouldImport' } },
          ],
          edges: [],
        };

        const graph = await factory.fromGraphData(data, 'my-graph');

        const nodes = await graph.getNodes();
        expect(nodes).toHaveLength(1);
        expect(nodes[0].properties.name).toBe('ShouldImport');
      });
    });
  },
);


