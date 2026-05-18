# grafio-mongo

MongoDB storage backend for **grafio** — a graph database with pluggable storage architecture.

**Full documentation**: [https://satya-jugran.github.io/grafio](https://satya-jugran.github.io/grafio)

## Features

- **MongoDB Backend** — Persistent storage with MongoDB (>= 5.0.0)
- **Multiple Graphs** — via `graphId` partitioning
- **Native Transactions** — Atomic multi-operation updates
- **Optimized Indexes** — For nodes and edges

## Installation

```bash
npm install grafio-mongo
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
graph.addNode('Person', { name: 'Alice', age: 30 });
graph.addNode('City', { name: 'New York' });
graph.addEdge('LIVES_IN', 'alice', 'nyc', { since: 2020 });

await client.close();
```

## License

GPL 3.0