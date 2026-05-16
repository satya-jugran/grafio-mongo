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
npm install grafio-mongo
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

## Cypher Query Language

MongoDB-backed graphs support read-only openCypher-compatible queries via the `CypherEngine`:

```typescript
import { Graph } from 'grafio';
import { CypherEngine } from 'grafio/cypher';

const graph = factory.forGraph('my-graph');

// Build your graph
const alice = await graph.addNode('Person', { name: 'Alice', age: 30 });
const bob   = await graph.addNode('Person', { name: 'Bob', age: 25 });
await graph.addEdge(alice.id, bob.id, 'KNOWS', { since: 2020 });

const engine = new CypherEngine(graph);

// Scan nodes by type
const result = await engine.query('MATCH (p:Person) RETURN p.name, p.age');

// Filter with WHERE
const adults = await engine.query(
  'MATCH (p:Person) WHERE p.age > 25 RETURN p.name'
);

// Follow relationships
const friends = await engine.query(
  'MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a.name, b.name'
);

// Multi-hop traversal
const network = await engine.query(
  'MATCH (a:Person)-[:KNOWS*1..2]->(b:Person) RETURN DISTINCT a.name, b.name'
);

// Parameterized queries
const byName = await engine.query(
  'MATCH (p:Person {name: $name}) RETURN p',
  { name: 'Alice' }
);

// Pagination
const page = await engine.query(
  'MATCH (p:Person) RETURN p ORDER BY p.age DESC SKIP 0 LIMIT 10'
);
```

### Supported Clauses

| Clause | Support | Notes |
|--------|---------|-------|
| `MATCH` | ✅ Read-only patterns | Typed/untyped nodes, directed edges, multi-label `(n:A\|B)`, inline property maps |
| `WHERE` | ✅ Full expressions | `AND`/`OR`/`NOT`, comparisons, `IN`, `NOT IN`, `IS NULL`, `IS NOT NULL` |
| `RETURN` | ✅ With `DISTINCT` | Property access, aliases with `AS` |
| `ORDER BY` | ✅ ASC/DESC | Default ASC when omitted |
| `SKIP` | ✅ Literal + `$param` | Evaluated at runtime |
| `LIMIT` | ✅ Literal + `$param` | Evaluated at runtime |
| `CREATE` / `DELETE` / `SET` / `REMOVE` / `MERGE` | ❌ Rejected | Validation gate prevents execution |

#### Aggregation Functions

```typescript
// Basic count
const total = await engine.query('MATCH (p:Person) RETURN COUNT(p) AS total');

// Group by with aggregation
const byCity = await engine.query(
  'MATCH (p:Person) RETURN p.city, COUNT(*) AS cnt ORDER BY cnt DESC'
);

// HAVING clause
const popular = await engine.query(
  'MATCH (p:Person) RETURN p.city, COUNT(*) AS cnt HAVING cnt > 1'
);

// Multiple aggregates
const stats = await engine.query(
  'MATCH (p:Person) RETURN MIN(p.age), MAX(p.age), AVG(p.age)'
);

// Named path variable
const paths = await engine.query(
  'MATCH p = (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN p'
);
```

#### Query Plan — Inspect Execution Steps

Use `getQueryPlan()` to inspect the logical execution plan for a query without running it:

```typescript
// Get query plan in JSON format (default)
const planJson = await engine.getQueryPlan('MATCH (p:Person) RETURN p.name');
// Returns: { plan: { steps: [...] } }

// Get in Text tree format
const planText = await engine.getQueryPlan('MATCH (p:Person)-[:KNOWS]->(b) RETURN p.name, b.name', undefined, 'text');
/*
NodeScanStep (Person)
  EdgeExpandStep (KNOWS, outgoing)
    ProjectStep [p.name, b.name]
*/

// Get in Mermaid flowchart format
const planMermaid = await engine.getQueryPlan('MATCH (p:Person)-[:KNOWS*1..2]->(b) RETURN p.name', undefined, 'mermaid');
/*
flowchart TD
    Step1[NodeScanStep Person]
    Step2[EdgeExpandStep KNOWS, 1..2 hops, outgoing]
    Step3[ProjectStep [p.name]]
    Step1 --> Step2
    Step2 --> Step3
*/
```

#### Execution Plan — Query Plan with Runtime Statistics

Use `execute()` with the `executionPlan` option to get the query plan enriched with per-step timing and row counts:

```typescript
const result = await engine.execute(
  'MATCH (p:Person)-[:KNOWS]->(b:Person) RETURN p.name, b.name',
  {},
  { executionPlan: { format: 'json' } }
);

// result.executionPlan contains the formatted plan with stats
// result.summary contains timing metadata
// result.summary.planExecutionStats contains per-step timing data

// Get execution plan in Text format with timing
const execText = await engine.execute(
  'MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN a.name',
  {},
  { executionPlan: { format: 'text' } }
);
console.log(execText.executionPlan);
/*
NodeScanStep Person (1ms, 33.3%, 2 rows)
  EdgeExpandStep KNOWS, outgoing (1ms, 33.3%, 5 rows)
    EdgeExpandStep KNOWS, outgoing (1ms, 33.3%, 3 rows)
      ProjectStep [a.name]
*/
```

Supported formats: `'json'`, `'text'`, `'mermaid'`

The execution plan includes:
- **timeMs**: Time spent in each step
- **percentageOfTotal**: Percentage of total query time
- **rowsOut**: Number of rows output by each step

### Variable-length Edge Syntax

| Syntax | Meaning |
|--------|---------|
| `[*]` | Unbounded (up to 100 hops) |
| `[*1..3]` | 1 to 3 hops (BFS by default) |
| `[*2]` | Exactly 2 hops |
| `[*..5]` | Up to 5 hops |

> **Strategy selection**: BFS is used by default for multi-hop expansion. When `LIMIT` is present, DFS is selected automatically for better early-result performance.

#### Property Filter Operators

The `filter.properties` option supports various comparison operators:

| Operator | Syntax | Description |
|----------|--------|-------------|
| `=` | `{ key: 'age', value: 30 }` | Equality (default) |
| `<>` | `{ key: 'age', value: 30, op: '<>' }` | Not equal |
| `>` | `{ key: 'age', value: 25, op: '>' }` | Greater than |
| `<` | `{ key: 'age', value: 25, op: '<' }` | Less than |
| `>=` | `{ key: 'age', value: 25, op: '>=' }` | Greater than or equal |
| `<=` | `{ key: 'age', value: 25, op: '<=' }` | Less than or equal |
| `CONTAINS` | `{ key: 'name', value: 'John', op: 'CONTAINS' }` | String contains |
| `STARTS_WITH` | `{ key: 'name', value: 'J', op: 'STARTS_WITH' }` | String prefix |
| `ENDS_WITH` | `{ key: 'name', value: 'n', op: 'ENDS_WITH' }` | String suffix |
| `IN` | `{ key: 'city', value: ['NYC', 'LA'], op: 'IN' }` | In array |
| `NOT_IN` | `{ key: 'city', value: ['SF', 'CHI'], op: 'NOT_IN' }` | Not in array |
| `IS_NULL` | `{ key: 'age', op: 'IS_NULL' }` | Is null |
| `IS_NOT_NULL` | `{ key: 'age', op: 'IS_NOT_NULL' }` | Is not null |

**AND/OR Chaining:**

```typescript
// AND chaining
const result = await graph.getNodes({
  filter: {
    AND: [
      { key: 'age', value: 25, op: '>' },
      { key: 'city', value: 'NYC' }
    ]
  }
});

// OR chaining
const result = await graph.getNodes({
  filter: {
    OR: [
      { key: 'city', value: 'NYC' },
      { key: 'city', value: 'LA' }
    ]
  }
});
```

## Graph Operations

All graph operations from grafio are available when using MongoDB storage. See the [grafio documentation](https://github.com/satyajugran/grafio) for the complete API reference.

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

// Property queries with operators
const adults = await graph.getNodes({ filter: { properties: [{ key: 'age', value: 25, op: '>' }] } });

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
