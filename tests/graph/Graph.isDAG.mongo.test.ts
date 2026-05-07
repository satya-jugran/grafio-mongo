import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { MongoStorageProvider } from '../../src/MongoStorageProvider';
import { runGraphIsDAGScenarios } from 'grafio/testing';

let mongoServer: MongoMemoryServer;
let client: MongoClient;
let provider: MongoStorageProvider;

runGraphIsDAGScenarios(
  async () => {
    mongoServer = await MongoMemoryServer.create();
    client = new MongoClient(mongoServer.getUri());
    await client.connect();
    provider = new MongoStorageProvider(client.db('test'), { graphId: 'default' });
    await provider.ensureIndexes();
    return provider;
  },
  async () => {},
  async () => {
    await client.close();
    await mongoServer.stop();
  }
);