# grafio-mongo

MongoDB storage backend for **grafio** — a graph database with native openCypher support and pluggable storage.

**Full documentation**: [https://satya-jugran.github.io/grafio](https://satya-jugran.github.io/grafio)

## Features

- **MongoDB Backend** — Persistent storage with the official `mongodb` driver (`>= 7.0.0`)
- **Multiple Graphs** — Isolated partitions via `graphId`
- **Native Cypher Support** — Query and mutate MongoDB-backed graphs with `graph.query(...)`
- **Scoped Property Indexes** — Label/type-scoped compound indexes and automatic Cypher `PlanCache` invalidation
- **Native Transactions** — Atomic multi-operation updates on replica sets and sharded clusters
- **Read-Through Caching** — Optional LRU / LFU / FIFO in-memory and Redis caching via `GraphManager`

## Installation

```bash
npm install grafio grafio-mongo mongodb
```

## Quick Start

```typescript
import { MongoClient } from 'mongodb';
import { MongoGraphFactory } from 'grafio-mongo';

const client = new MongoClient('mongodb://localhost:27017');
await client.connect();

const factory = new MongoGraphFactory(client.db('mydb'));
await factory.ensureIndexes();

const graph = factory.forGraph('my-graph');
const alice = await graph.addNode('Person', { name: 'Alice', age: 30 });
const nyc = await graph.addNode('City', { name: 'New York' });
await graph.addEdge(alice.id, nyc.id, 'LIVES_IN', { since: 2020 });

// Query using openCypher
const result = await graph.query(
  'MATCH (p:Person)-[r:LIVES_IN]->(c:City) WHERE p.age >= $minAge RETURN p.name AS person, c.name AS city, r.since AS since',
  { minAge: 25 },
);
console.log(result.rows);

await client.close();
```

## Optional Caching with `GraphManager`

```typescript
import { GraphManager, MongoGraphFactory } from 'grafio-mongo';

GraphManager.init({
  cache: {
    cacheStore: 'in-memory', // or 'redis' with redisUrl
    maxNodesCount: 10_000,
    maxEdgesCount: 20_000,
    evictionStrategy: 'LRU',
    preloadStrategy: 'recent',
  },
});

const factory = new MongoGraphFactory(db);
await factory.ensureIndexes();

const graph = factory.forGraph('my-graph');
await graph.warmCache();
```

## License

GPL 3.0
