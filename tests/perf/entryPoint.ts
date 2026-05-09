#!/usr/bin/env node
/**
 * grafio  ·  MongoDB Performance Test Runner
 *
 * Run with:
 *   npm run perf:mongodb
 *   npm run perf:mongodb:gc  (with accurate heap measurements)
 *
 * NOTE: MongoDB benchmarks use smaller scales since each operation
 *       involves network I/O. Adjust SCALES based on your hardware.
 */

import { MongoClient } from 'mongodb';
import { MongoGraphFactory } from '../../src/MongoGraphFactory';
// Import unified perf infrastructure from grafio
import {
  buildScenarios,           // Returns scenarios with mongodb iteration factors
  buildGraph,               // Creates test graph
  runScenario,              // Runs a single scenario
  printReport,              // Prints results table
  printScaleHeader,         // Prints scale header
  printSectionTitle,         // Prints section title
  ITERATION_FACTORS,         // Iteration multipliers
  GraphMeta                   // Type for graph metadata returned by buildGraph
} from 'grafio/testing/perf';

import { Graph, GraphManager } from 'grafio';

// ─── Scale Definitions ────────────────────────────────────────────────────────
// MongoDB provider: operations are more expensive due to network I/O.
// Use smaller scales to keep benchmarks practical.

interface ScaleConfig {
  label: string;
  nodeCount: number;
  edgesPerNode: number;
}

const SCALES: ScaleConfig[] = [
  { label: 'Small  (1k nodes)', nodeCount: 1_000, edgesPerNode: 3 },
  { label: 'Medium (5k nodes)', nodeCount: 5_000, edgesPerNode: 3 },
  { label: 'Large  (10k nodes)', nodeCount: 10_000, edgesPerNode: 3 },
];

// ─── MongoDB Configuration ────────────────────────────────────────────────────
// Default connection string. Override via MONGODB_URI env variable.

const DEFAULT_URI = 'mongodb://localhost:27017';
const DEFAULT_DB = 'grafio-perf';

interface MongoConfig {
  uri: string;
  dbName: string;
  graphId: string;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Parse configuration ───────────────────────────────────────────────
  const config: MongoConfig = {
    uri: process.env.MONGODB_URI || DEFAULT_URI,
    dbName: process.env.MONGODB_DB || DEFAULT_DB,
    graphId: process.env.MONGODB_GRAPH_ID || 'perf-benchmark',
  };

  GraphManager.init({
    cache: {
      maxNodesCount: 10000,
      maxEdgesCount: 50000,
      cacheStore: 'in-memory',
      evictionStrategy: 'LRU',
      preloadStrategy: 'all'
    }
  });

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║          grafio  ·  MongoDB Performance Test Suite                           ║');
  console.log('║          Benchmarks: Write · Read · Navigation · Traversal                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  console.log(`\n  MongoDB URI:  ${config.uri}`);
  console.log(`  Database:    ${config.dbName}`);
  console.log(`  Graph ID:    ${config.graphId}`);

  if (typeof global.gc !== 'function') {
    console.log('\n  ⚠  TIP: Run with --expose-gc for more accurate heap measurements.');
    console.log('     e.g.: npm run perf:mongodb:gc\n');
  } else {
    console.log('\n  ✓  GC available — heap measurements will be accurate.\n');
  }

  // ── 2. Connect to MongoDB ─────────────────────────────────────────────────
  printSectionTitle('Connecting to MongoDB...');
  const client = new MongoClient(config.uri);
  await client.connect();
  const db = client.db(config.dbName);
  console.log('  ✓  Connected\n');

  // ── 3. Create factory and ensure indexes ────────────────────────────────
  const factory = new MongoGraphFactory(db);
  await factory.ensureIndexes();
  console.log('  ✓  Indexes ensured\n');

  // ── 4. Cleanup any existing benchmark data ───────────────────────────────
  // We'll drop and recreate the graph collection before each scale

  for (const scale of SCALES) {
    printScaleHeader(scale.label);

    // ── 5. Clear any existing data for this graphId ────────────────────────
    const clearGraph = factory.forGraph(config.graphId);
    await clearGraph.clear();

    // ── 6. Build the baseline graph (timed) ────────────────────────────────
    printSectionTitle(`Building graph: ${scale.nodeCount.toLocaleString()} nodes @ ${scale.edgesPerNode} edges/node`);
    const buildStart = process.hrtime.bigint();

    // Build the in-memory graph first
    const memMeta = await buildGraph(scale.nodeCount, scale.edgesPerNode, 42, config.graphId);

    // Then export and import into MongoDB
    const jsonData = await memMeta.graph.exportJSON();
    const mongoMeta = await importIntoMongo(factory, jsonData, memMeta, config.graphId);
    GraphManager.getInstance().getCacheManager()?.invalidateAll(); // Clear cache to ensure fair benchmarking
    await mongoMeta.graph.warmCache();
    console.log('  ✓  Graph imported into MongoDB and cache warmed');

    const buildMs = Number(process.hrtime.bigint() - buildStart) / 1_000_000;

    console.log(`  ✓  Built: ${mongoMeta.nodeCount.toLocaleString()} nodes, ${mongoMeta.edgeCount.toLocaleString()} edges in ${buildMs.toFixed(0)} ms`);
    console.log(`  ✓  DAG subgraph: ${mongoMeta.dagNodeIds.length.toLocaleString()} nodes`);

    // ── 7. Run all benchmark scenarios ─────────────────────────────────────
    printSectionTitle('Running benchmark scenarios');

    const scenarios = buildScenarios('mongodb', scale.nodeCount);
    const results = [];

    for (const scenario of scenarios) {
      process.stdout.write(`     ${scenario.category.padEnd(16)} ${scenario.name.padEnd(30)} `);
      const result = await runScenario(scenario, mongoMeta);
      results.push(result);
      console.log(`✓  ${result.meanMs < 1 ? result.meanMs.toFixed(3) + ' ms/op' : result.meanMs.toFixed(2) + ' ms/op'}`);
    }

    // ── 8. Print results table ─────────────────────────────────────────────
    console.log();
    printReport(results, mongoMeta.nodeCount, mongoMeta.edgeCount, 0, scale.label);

    // Print cache stats if available
    const cacheManager = GraphManager.getInstance().getCacheManager();
    if (cacheManager) {
      const stats = await cacheManager.getStats();
      console.log(`Cache Hits: ${stats.hitCount.toLocaleString()} | Misses: ${stats.missCount.toLocaleString()}`);
      console.log(`Cache Evictions: ${stats.evictionCount.toLocaleString()}`);
      console.log(`Current Cache Size: Total Graphs: ${stats.totalGraphIds.toLocaleString()} | Total Nodes: ${stats.totalNodes.toLocaleString()} | Edges: ${stats.totalEdges.toLocaleString()}`);
    }

    // ── 9. Cleanup before next scale ───────────────────────────────────────
    await mongoMeta.graph.clear();
    if (typeof global.gc === 'function') global.gc();
  }

  // ── 10. Cleanup and disconnect ────────────────────────────────────────────
  printSectionTitle('Cleaning up...');
  const cleanupGraph = factory.forGraph(config.graphId);
  await cleanupGraph.clear();
  await client.close();
  console.log('  ✓  Done.\n');
}

/**
 * Imports graph data into MongoDB and returns a modified GraphMeta
 * where the graph points to the MongoDB-backed instance.
 */
async function importIntoMongo(
  factory: MongoGraphFactory,
  jsonData: Awaited<ReturnType<Graph['exportJSON']>>,
  memMeta: GraphMeta,
  graphId: string
): Promise<GraphMeta> {
  // Import the graph structure into MongoDB using factory method
  const graph = await factory.fromGraphData(jsonData, graphId);

  // Create indexes for benchmark query patterns
  await graph.createIndex('node', 'active');

  // Create a new GraphMeta with the MongoDB-backed graph
  return {
    ...memMeta,
    graph: graph,
    // Keep nodeIds and traversalPairs from the in-memory build
    // since they represent the same node IDs
  };
}

main().catch(err => {
  console.error('\n  ✗  Fatal error:', err);
  process.exit(1);
});