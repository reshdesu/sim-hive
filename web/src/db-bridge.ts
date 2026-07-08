/* ─────────────────────────────────────────────────────────────────────────── *
 * db-bridge.ts — DuckDB-Wasm + Apache Arrow IPC snapshot pipeline (P2)       *
 *                                                                             *
 * Architecture:                                                               *
 *   • DuckDB-Wasm runs in a Worker thread (non-blocking to render loop)       *
 *   • Every 60 ticks, JS reads raw Wasm memory pointers and builds an        *
 *     Apache Arrow RecordBatch from the live ECS component arrays             *
 *   • The RecordBatch is inserted via arrow_scan() into agent_snapshots       *
 *   • A MessageChannel posts queries back to the main thread asynchronously  *
 * ─────────────────────────────────────────────────────────────────────────── */

import * as duckdb from '@duckdb/duckdb-wasm'
import * as arrow from 'apache-arrow'
import { createSignal } from 'solid-js'

// ── DuckDB bundle (CDN — avoids copying large .wasm blobs into /public) ──────
const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule:   'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-mvp.wasm',
    mainWorker:   'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-browser-mvp.worker.js',
  },
  eh: {
    mainModule:   'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-eh.wasm',
    mainWorker:   'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-browser-eh.worker.js',
  },
}

// ── Singleton state ───────────────────────────────────────────────────────────
let _db:   duckdb.AsyncDuckDB | null = null
let _conn: duckdb.AsyncDuckDBConnection | null = null
let _initPromise: Promise<void> | null = null

// ── Reactive signals exposed to the UI ───────────────────────────────────────
export const [dbStatus,   setDbStatus]   = createSignal<'idle' | 'initializing' | 'ready' | 'error'>('idle')
export const [snapshotCount, setSnapshotCount] = createSignal(0)
export const [dbError,    setDbError]    = createSignal<string | null>(null)

// Historical vitals from DuckDB queries (last 60 snapshots)
export interface VitalRow { tick: number; meanHunger: number; meanEnergy: number; employed: number }
export const [vitalHistory, setVitalHistory] = createSignal<VitalRow[]>([])

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  if (_initPromise) return _initPromise
  _initPromise = _doInit()
  return _initPromise
}

async function _doInit(): Promise<void> {
  try {
    setDbStatus('initializing')
    console.log('[db-bridge] Initialising DuckDB-Wasm…')

    const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES)

    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts('${bundle.mainWorker}');`], { type: 'application/javascript' })
    )
    const worker = new Worker(workerUrl)
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)

    _db = new duckdb.AsyncDuckDB(logger, worker)
    await _db.instantiate(bundle.mainModule)
    URL.revokeObjectURL(workerUrl)

    _conn = await _db.connect()

    // ── Create schema ─────────────────────────────────────────────────────────
    await _conn.query(`
      CREATE TABLE IF NOT EXISTS agent_snapshots (
          tick        UINTEGER NOT NULL,
          entity_id   UINTEGER NOT NULL,
          x           FLOAT,
          y           FLOAT,
          hunger      FLOAT,
          energy      FLOAT,
          social      FLOAT,
          hygiene     FLOAT,
          archetype   UINTEGER
      );

      CREATE TABLE IF NOT EXISTS simulation_events (
          tick        UINTEGER,
          entity_id   UINTEGER,
          event_type  VARCHAR,
          payload     VARCHAR
      );
    `)

    // population_vitals view — aggregates per tick
    await _conn.query(`
      CREATE OR REPLACE VIEW population_vitals AS
      SELECT
          tick,
          AVG(hunger)  AS mean_hunger,
          AVG(energy)  AS mean_energy,
          COUNT(*)     FILTER (WHERE archetype & 1 = 1) AS employed_count
      FROM agent_snapshots
      GROUP BY tick
      ORDER BY tick;
    `)

    setDbStatus('ready')
    console.log('[db-bridge] DuckDB-Wasm ready ✓')
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    setDbError(msg)
    setDbStatus('error')
    console.error('[db-bridge] Init failed:', e)
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Called every 60 ticks from sim-bridge. Reads raw Wasm memory pointers,
 * builds an Apache Arrow RecordBatch column-by-column, and bulk-inserts into
 * DuckDB via insertArrowTable(). Non-blocking — awaited outside the RAF loop.
 */
export async function snapshotTick(
  wasmMemory: WebAssembly.Memory,
  tick: number,
  agentCount: number,
  posPtr:     number,   // byte offset into wasmMemory for Position[]
  needsPtr:   number,   // byte offset into wasmMemory for Needs[]
  metaPtr:    number,   // byte offset into wasmMemory for AgentMeta[]
): Promise<void> {
  if (!_conn || dbStatus() !== 'ready') return

  // ── Decode raw Wasm memory into typed arrays ────────────────────────────────
  // Position: [x, y, z, _pad] → 4 × f32 = 16 bytes per agent
  const posF32  = new Float32Array(wasmMemory.buffer, posPtr,   agentCount * 4)
  // Needs:    [hunger, energy, social, hygiene] → 4 × f32 = 16 bytes per agent
  const needsF32 = new Float32Array(wasmMemory.buffer, needsPtr, agentCount * 4)
  // AgentMeta: [entity_id: u32, archetype_flags: u32, age: u16, household_id: u16] → 8 bytes per agent
  // We read as u32 pairs: index 0 = entity_id, index 1 = archetype_flags
  const metaU32 = new Uint32Array(wasmMemory.buffer, metaPtr, agentCount * 2)

  // ── Build per-column arrays ────────────────────────────────────────────────
  const ticks      = new Uint32Array(agentCount).fill(tick)
  const entityIds  = new Uint32Array(agentCount)
  const xs         = new Float32Array(agentCount)
  const ys         = new Float32Array(agentCount)
  const hungers    = new Float32Array(agentCount)
  const energies   = new Float32Array(agentCount)
  const socials    = new Float32Array(agentCount)
  const hygienes   = new Float32Array(agentCount)
  const archetypes = new Uint32Array(agentCount)

  for (let i = 0; i < agentCount; i++) {
    const pBase = i * 4   // Position stride (4 f32)
    const nBase = i * 4   // Needs stride (4 f32)
    const mBase = i * 2   // AgentMeta stride (2 u32)

    xs[i]         = posF32[pBase]
    ys[i]         = posF32[pBase + 2]  // z becomes y for 2D snapshot
    hungers[i]    = needsF32[nBase]
    energies[i]   = needsF32[nBase + 1]
    socials[i]    = needsF32[nBase + 2]
    hygienes[i]   = needsF32[nBase + 3]
    entityIds[i]  = metaU32[mBase]
    archetypes[i] = metaU32[mBase + 1]
  }

  // ── Build Apache Arrow RecordBatch ─────────────────────────────────────────
  const table = arrow.tableFromArrays({
    tick:       ticks,
    entity_id:  entityIds,
    x:          xs,
    y:          ys,
    hunger:     hungers,
    energy:     energies,
    social:     socials,
    hygiene:    hygienes,
    archetype:  archetypes,
  })

  // ── Insert into DuckDB ─────────────────────────────────────────────────────
  try {
    console.log(`[db-bridge] Constructing Arrow Table: agentCount=${agentCount}, tick=${tick}`);
    console.log(`[db-bridge] Arrow Table details: numRows=${table.numRows}, columns=${table.schema.fields.map((f: any) => f.name).join(', ')}`);
    
    // Serialize the Arrow Table to a binary IPC stream (Uint8Array)
    // This is 100% version-independent and avoids structured clone errors or symbol mismatches across the Web Worker boundary.
    const ipcStream = await arrow.RecordBatchStreamWriter.writeAll(table).toUint8Array();
    
    await _conn.insertArrowFromIPCStream(ipcStream, {
      name:   'agent_snapshots',
      create: false,
    });
    
    setSnapshotCount(c => c + 1)
    
    // Debug: Check table row count
    const countRes = await _conn.query(`SELECT COUNT(*)::BIGINT as cnt FROM agent_snapshots`);
    const countArr = countRes.toArray() as any[];
    const cntVal = countArr[0] ? (countArr[0].cnt !== undefined ? countArr[0].cnt : countArr[0][0]) : 0;
    console.log(`[db-bridge] Total rows in agent_snapshots:`, Number(cntVal));
  } catch (e: any) {
    console.warn('[db-bridge] Snapshot insert failed:', e?.message ?? e)
    return
  }

  // ── Refresh historical vitals (separate try so insert success is preserved) ─
  try {
    const result = await _conn.query(`
      SELECT
        tick,
        AVG(hunger)::FLOAT AS mean_hunger,
        AVG(energy)::FLOAT AS mean_energy,
        COUNT(*) FILTER (WHERE (archetype & 1) = 1) AS employed_count
      FROM agent_snapshots
      GROUP BY tick
      ORDER BY tick DESC
      LIMIT 60
    `)

    const resultArr = result.toArray();
    // Debug logging safely without JSON.stringify because DuckDB COUNT returns BigInt
    // console.log(`[db-bridge] Vitals query returned ${resultArr.length} rows`);

    const rows: VitalRow[] = resultArr.map((row: any) => ({
      tick:       Number(row.tick       ?? 0),
      meanHunger: Number(row.mean_hunger ?? 0),
      meanEnergy: Number(row.mean_energy ?? 0),
      employed:   Number(row.employed_count ?? 0),
    }));

    setVitalHistory(rows.reverse()) // chronological order
  } catch (e: any) {
    console.warn('[db-bridge] Vitals query failed:', e?.message ?? e)
  }
}

// ── Ad-hoc query ──────────────────────────────────────────────────────────────

export async function queryDb(sql: string): Promise<arrow.Table | null> {
  if (!_conn) return null
  try {
    return await (_conn.query(sql) as any)
  } catch (e: any) {
    console.error('[db-bridge] Query failed:', e?.message ?? e)
    return null
  }
}

// ── Teardown ──────────────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  if (_conn) { await _conn.close(); _conn = null }
  if (_db)   { await _db.terminate(); _db = null }
  _initPromise = null
  setDbStatus('idle')
}
