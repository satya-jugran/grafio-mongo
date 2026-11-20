#!/usr/bin/env node
/**
 * grafio  ·  MongoDB Performance Test Runner
 *
 * Run with:
 *   npm run perf
 *   npm run perf:gc  (with accurate heap measurements)
 *
 * NOTE: MongoDB benchmarks use smaller scales since each operation
 *       involves network I/O. Adjust SCALES based on your hardware.
 */

import { MongoClient } from 'mongodb';
import { MongoGraphFactory } from '../../src/MongoGraphFactory';
import {
  buildGraph,
  runScenario,
  printReport,
  printScaleHeader,
  printSectionTitle,
  GraphMeta,
  buildCommonScenariosCypher,
} from 'grafio/testing/perf';

import { Graph, GraphManager } from 'grafio';

interface ScaleConfig {
  label: string;
  nodeCount: number;
  edgesPerNode: number;
}

const SCALES: ScaleConfig[] = [
  { label: 'Small  (10k nodes)', nodeCount: 10_000, edgesPerNode: 3 },
  { label: 'Medium (50k nodes)', nodeCount: 50_000, edgesPerNode: 3 },
  { label: 'Large  (100k nodes)', nodeCount: 100_000, edgesPerNode: 3 },
];

const DEFAULT_URI = 'mongodb://mongodb:27017,mongodb2:27018,mongodb3:27019/?replicaSet=rs0';
const DEFAULT_DB = 'grafio-perf';

interface MongoConfig {
  uri: string;
  dbName: string;
  graphId: string;
}

async function main(): Promise<void> {
  const config: MongoConfig = {
    uri: process.env.MONGODB_URI || DEFAULT_URI,
    dbName: process.env.MONGODB_DB || DEFAULT_DB,
    graphId: process.env.MONGODB_GRAPH_ID || 'perf-benchmark',
  };

  GraphManager.init({
    cache: {
      cacheStore: 'in-memory',
      maxNodesCount: 100,
      maxEdgesCount: 300,
      preloadStrategy: 'all',
      evictionStrategy: 'LRU',
    },
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
    console.log('     e.g.: npm run perf:gc\n');
  } else {
    console.log('\n  ✓  GC available — heap measurements will be accurate.\n');
  }

  printSectionTitle('Connecting to MongoDB...');
  const client = new MongoClient(config.uri);
  await client.connect();
  const db = client.db(config.dbName);
  console.log('  ✓  Connected\n');

  const factory = new MongoGraphFactory(db);
  await factory.ensureIndexes();
  console.log('  ✓  Indexes ensured\n');

  for (const scale of SCALES) {
    printScaleHeader(scale.label);

    const clearGraph = factory.forGraph(config.graphId);
    await clearGraph.clear();

    printSectionTitle(`Building graph: ${scale.nodeCount.toLocaleString()} nodes @ ${scale.edgesPerNode} edges/node`);
    const buildStart = process.hrtime.bigint();

    const memMeta = await buildGraph(scale.nodeCount, scale.edgesPerNode, 42, config.graphId);

    const jsonData = await memMeta.graph.exportJSON();
    const mongoMeta = await importIntoMongo(factory, jsonData, memMeta, config.graphId);
    await GraphManager.getInstance().getCacheManager()?.invalidateAll();
    await mongoMeta.graph.warmCache();
    console.log('  ✓  Graph imported into MongoDB and cache warmed');

    const buildMs = Number(process.hrtime.bigint() - buildStart) / 1_000_000;

    console.log(`  ✓  Built: ${mongoMeta.nodeCount.toLocaleString()} nodes, ${mongoMeta.edgeCount.toLocaleString()} edges in ${buildMs.toFixed(0)} ms`);
    console.log(`  ✓  DAG subgraph: ${mongoMeta.dagNodeIds.length.toLocaleString()} nodes`);

    printSectionTitle('Running benchmark scenarios');

    const scenarios = buildCommonScenariosCypher(scale.nodeCount, 0.05);
    const results = [];

    for (const scenario of scenarios) {
      process.stdout.write(`     ${scenario.category.padEnd(16)} ${scenario.name.padEnd(30)} `);
      const result = await runScenario(scenario, mongoMeta);
      results.push(result);
      console.log(`✓  ${result.meanMs < 1 ? result.meanMs.toFixed(3) + ' ms/op' : result.meanMs.toFixed(2) + ' ms/op'}`);
    }

    console.log();
    printReport(results, mongoMeta.nodeCount, mongoMeta.edgeCount, 0, scale.label);

    const cacheManager = GraphManager.getInstance().getCacheManager();
    if (cacheManager) {
      const stats = await cacheManager.getStats();
      console.log(`Cache Hits: ${stats.hitCount.toLocaleString()} | Misses: ${stats.missCount.toLocaleString()}`);
      console.log(`Cache Evictions: ${stats.evictionCount.toLocaleString()}`);
      console.log(`Current Cache Size: Total Graphs: ${stats.totalGraphIds.toLocaleString()} | Total Nodes: ${stats.totalNodes.toLocaleString()} | Edges: ${stats.totalEdges.toLocaleString()}`);
    }

    await mongoMeta.graph.clear();
    if (typeof global.gc === 'function') global.gc();
  }

  printSectionTitle('Cleaning up...');
  const cleanupGraph = factory.forGraph(config.graphId);
  await cleanupGraph.clear();
  await client.close();
  console.log('  ✓  Done.\n');
}

async function importIntoMongo(
  factory: MongoGraphFactory,
  jsonData: Awaited<ReturnType<Graph['exportJSON']>>,
  memMeta: GraphMeta,
  graphId: string,
): Promise<GraphMeta> {
  const graph = await factory.fromGraphData(jsonData, graphId);
  await graph.createIndex('index_active', 'node', ['active']);

  return {
    ...memMeta,
    graph,
  };
}

main().catch((err) => {
  console.error('\n  ✗  Fatal error:', err);
  process.exit(1);
});
