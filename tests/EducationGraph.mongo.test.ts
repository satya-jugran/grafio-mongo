import { afterAll, beforeAll, beforeEach, describe } from '@jest/globals';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { Graph } from 'grafio';
import { MongoStorageProvider } from 'grafio';
import { educationGraphData, runEducationGraphScenarios } from 'grafio/testing';

let mongoServer: MongoMemoryServer;
let client: MongoClient;
let provider: MongoStorageProvider;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  client = new MongoClient(mongoServer.getUri());
  await client.connect();
  provider = new MongoStorageProvider(client.db('test'), { graphId: 'default' });
  await provider.ensureIndexes();
});

beforeEach(async () => {
  await provider.clear();
});

afterAll(async () => {
  await client.close();
  await mongoServer.stop();
});

describe('Education Graph (MongoDB)', () => {
  runEducationGraphScenarios(async () => {
    return await Graph.importJSON(educationGraphData, provider);
  });
});
