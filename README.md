# grafio-mongo

MongoDB storage backend for [grafio](https://github.com/witspry/grafio) — a graph database with pluggable storage architecture.

## Overview

This package provides the MongoDB storage provider for grafio, extracted from the core project. It enables **persistent storage** for grafio graphs using MongoDB (>= 5.0.0), with optimized indexes for nodes and edges and native transaction support.

## Features

- **MongoDB Backend** — Optional MongoDB backend (>= 5.0.0) with optimized indexes for nodes and edges
- **Multiple Graph Support** — via `graphId` partitioning (isolated graphs in one MongoDB instance)
- **Pluggable Storage** — implements the `IStorageProvider` interface from grafio
- **Native Transactions** — MongoDB sessions for atomic multi-operation updates
- **Graph Factories** — `MongoGraphFactory` for controlled instance creation

## Installation

```bash
npm install grafio-mongo mongodb

# peer dependencies
npm install grafio
```

## Quick Start

```typescript
import { MongoClient } from 'mongodb';
import { MongoGraphFactory } from 'grafio-mongo';

// Connect to MongoDB
const client = new MongoClient('mongodb://localhost:27017');
await client.connect();

const factory = new MongoGraphFactory(client.db('mydb'));

// Create indexes once at startup (idempotent — safe to call every time)
await factory.ensureIndexes();

// Get a graph scoped to a named partition
const graph = factory.forGraph('my-graph');

// Add nodes and edges
const alice = await graph.addNode('Person', { name: 'Alice' });
const bob   = await graph.addNode('Person', { name: 'Bob' });
await graph.addEdge(alice.id, bob.id, 'KNOWS');

// Navigate the graph
const path = await graph.traverse(alice.id, bob.id, { edgeTypes: ['KNOWS'] });

// Caller manages the MongoClient lifecycle
await client.close();
```

## MongoGraphFactory

Factory class for creating MongoDB-backed Graph instances:

```typescript
import { MongoGraphFactory } from 'grafio-mongo';

const factory = new MongoGraphFactory(db);
await factory.ensureIndexes();

const graph = factory.forGraph('my-graph');
// or with custom options
const graph2 = factory.forGraph('custom-graph', {
  nodesCollection: 'my_nodes',  // default: 'sgdb_nodes'
  edgesCollection: 'my_edges',  // default: 'sgdb_edges'
});
```

### Factory Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nodesCollection` | `string` | `'sgdb_nodes'` | Collection name for nodes |
| `edgesCollection` | `string` | `'sgdb_edges'` | Collection name for edges |

## Direct MongoStorageProvider Usage

For fine-grained control over collection names and graph partitioning:

```typescript
import { MongoClient } from 'mongodb';
import { Graph, MongoStorageProvider } from 'grafio-mongo';

const client = new MongoClient('mongodb://localhost:27017');
await client.connect();

const provider = new MongoStorageProvider(client.db('mydb'), {
  graphId: 'my-graph',          // default: 'default' — partitions data by graph id
  nodesCollection: 'my_nodes',  // default: 'sgdb_nodes'
  edgesCollection: 'my_edges',  // default: 'sgdb_edges'
});

await provider.ensureIndexes();

const graph = new Graph(provider);
```

## Indexes

The `ensureIndexes()` method creates the following indexes for optimized queries:

### Nodes Collection

| Index | Purpose |
|-------|---------|
| `{ graphId: 1, id: 1 }` unique | Fast node id lookups within a graph partition |
| `{ graphId: 1, type: 1 }` | `getNodesByType()` within a graph partition |
| `{ graphId: 1, properties: 1 }` | Property value lookups within a graph partition |

### Edges Collection

| Index | Purpose |
|-------|---------|
| `{ graphId: 1, id: 1 }` unique | Fast edge id lookups within a graph partition |
| `{ graphId: 1, type: 1 }` | `getEdgesByType()` within a graph partition |
| `{ graphId: 1, sourceId: 1, type: 1 }` | Outgoing adjacency queries |
| `{ graphId: 1, targetId: 1, type: 1 }` | Incoming adjacency queries |

## Transactions

MongoDB storage provider supports native transactions via MongoDB sessions:

```typescript
import { Graph, GraphTransaction } from 'grafio';

const graph = factory.forGraph('my-graph');
const txn = graph.createTransaction();
await txn.begin();

try {
  const alice = await graph.addNode('Person', { name: 'Alice' }, txn);
  const bob = await graph.addNode('Person', { name: 'Bob' }, txn);
  await graph.addEdge(alice.id, bob.id, 'KNOWS', {}, txn);
  await txn.commit();
} catch (error) {
  if (txn.isActive()) {
    await txn.rollback();
  }
  throw error;
}
```

**Note:** MongoDB storage provider requires a replica set for transaction support.

### Transaction Lifecycle

- `begin()` — starts a new transaction
- `commit()` — applies all changes atomically (throws if transaction failed)
- `rollback()` — discards all changes
- `isFailed()` — returns true if a storage operation failed within the transaction
- `isActive()` — returns true if transaction is active and not failed

## Graph Operations

All graph operations from grafio are available when using MongoDB storage. See the [grafio documentation](https://github.com/witspry/grafio) for the complete API reference.

### Example Operations

```typescript
const graph = factory.forGraph('my-graph');

// Node operations
const alice = await graph.addNode('Person', { name: 'Alice', age: 30 });
const bob = await graph.addNode('Person', { name: 'Bob' });
await graph.addEdge(alice.id, bob.id, 'KNOWS');

// Navigation
const parents = await graph.getParents(bob.id);
const children = await graph.getChildren(alice.id);

// Traversal
const path = await graph.traverse(alice.id, bob.id, { method: 'bfs' });

// Type filtering
const allPersons = await graph.getNodesByType('Person');

// Property queries
const adults = await graph.getNodesByProperty('age', 30);

// DAG check and topological sort
const isDag = await graph.isDAG();
const order = await graph.topologicalSort();

// Export/Import
const data = await graph.exportJSON();
await Graph.importJSON(data, new MongoStorageProvider(db, { graphId: 'restored' }));
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## Testing

The test suite runs against the MongoDB backend using `mongodb-memory-server` for integration testing.

### Test Structure

- `tests/graph/*.mongo.test.ts` — Graph operations via MongoDB provider
- `tests/EducationGraph.mongo.test.ts` — Education domain graph via MongoDB
- `tests/SocialGraph.mongo.test.ts` — Social network graph via MongoDB
- `tests/storage/MongoGraphFactory.test.ts` — Factory lifecycle tests
- `tests/storage/MongoStorageProvider.test.ts` — Provider unit tests
