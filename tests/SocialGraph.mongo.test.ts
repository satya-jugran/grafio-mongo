import { afterAll, beforeAll, beforeEach, describe } from '@jest/globals';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { MongoStorageProvider } from '../src/MongoStorageProvider';
import { runSocialGraphScenarios } from 'grafio/testing';

let mongoServer: MongoMemoryServer;
let client: MongoClient;
let provider: MongoStorageProvider;

const lazyProvider = new Proxy({} as MongoStorageProvider, {
  get(_target, prop) {
    if (!provider) {
      return undefined;
    }
    const value = Reflect.get(provider, prop, provider);
    return typeof value === 'function' ? value.bind(provider) : value;
  },
});

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

describe('Facebook Social Graph (MongoDB)', () => {
  runSocialGraphScenarios(lazyProvider);
});
