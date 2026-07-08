# Sim Hive — Architecture & Session Notes

> **Project:** High-Performance Browser-Based Life Simulation  
> **Author:** Senior Staff Data Analyst / Software Developer  
> **Last Updated:** 2026-07-06

---

## Project Vision

A high-fidelity, client-side-only life simulation game targeting visual and systemic fidelity beyond *The Sims 4*, built entirely on modern web standards. Treated as a **data-processing and visualization challenge**, not a traditional game engine project.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Logic Engine | Rust → Wasm (`wasm-pack`) |
| Rendering | WebGPU via **Babylon.js** or **PlayCanvas** |
| State / Persistence | **DuckDB-Wasm** (SQL source of truth) |
| UI | **SolidJS** (fine-grained reactive) |
| Architecture | **Data-Oriented Design (ECS)** |

---

## Vertical Slice: "Sim Hive" (Population Simulator)

A data-driven population simulation with **1,000+ autonomous agents** as the first playable milestone.

---

## 1. ECS Architecture

### Core Components (`#[repr(C)]` — SoA layout)

```rust
#[repr(C)]
pub struct Position  { pub x: f32, pub y: f32, pub z: f32, pub _pad: f32 }

#[repr(C)]
pub struct Velocity  { pub dx: f32, pub dy: f32, pub dz: f32, pub speed: f32 }

#[repr(C)]
pub struct Needs     { pub hunger: f32, pub energy: f32, pub social: f32, pub hygiene: f32 }

#[repr(C)]
pub struct AgentMeta {
    pub entity_id: u32,
    pub archetype_flags: u32, // bitfield: EMPLOYED | SOCIALIZING | IN_BUILDING
    pub age: u16,
    pub household_id: u16,
}
```

### System Execution Order (per tick)

```
Tick N:
├── [Input]      DuckDB event queue flush (async, non-blocking)
├── [Parallel]   NeedsDecaySystem      → writes Needs[]
├── [Parallel]   PathfindingSystem     → writes Velocity[]
├── [Sequential] BehaviorDecisionSystem → reads Needs[], writes AgentMeta flags
├── [Sequential] MovementSystem        → reads Velocity[], writes Position[]
└── [Output]     GPU buffer sync       → memcpy Position[] → SharedArrayBuffer
```

> `NeedsDecaySystem` and `PathfindingSystem` have zero shared writes — safe to parallelize via `rayon` (maps to SAB-backed worker threads in browser).

---

## 2. Wasm → WebGPU Zero-Copy Memory Bridge

### Buffer Layout

```
SharedArrayBuffer
  ├── Position[]   ← GPU hot (60 Hz), Wasm writes
  ├── AgentMeta[]  ← UI reactive, JS reads via SolidJS signals
  └── Needs[]      ← DuckDB snapshot source
         ↓ zero-copy bind
  GPUBuffer (mappedAtCreation: true, backed by SAB region)
```

### Key Implementation Notes

- Use `WebAssembly.Memory({ shared: true })` to back Wasm linear memory with a `SharedArrayBuffer`
- Expose `positions_ptr()` and `positions_byte_len()` from Wasm
- Wrap as `Float32Array(wasmMemory.buffer, ptr, len/4)` — no copy
- Pass view directly to `device.queue.writeBuffer()` — one DMA transfer, no GC
- Use **GPU instancing** (`hasThinInstances` in Babylon.js) for agents — 1 draw call for 1,000 agents

### Required HTTP Headers (for SharedArrayBuffer)

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## 3. DuckDB-Wasm Integration

### Two-Layer State Model

| Layer | Storage | Write Frequency | Purpose |
|---|---|---|---|
| Hot State | Wasm linear memory | 60 Hz | Simulation loop |
| Cold State | DuckDB-Wasm | ~1 Hz / on-event | Analytics, persistence, queries |

### Core Schema

```sql
CREATE TABLE agent_snapshots (
    tick        UINTEGER NOT NULL,
    entity_id   UINTEGER NOT NULL,
    x           FLOAT, y FLOAT,
    hunger      FLOAT, energy FLOAT,
    archetype   UINTEGER,
    PRIMARY KEY (tick, entity_id)
);

CREATE TABLE simulation_events (
    tick        UINTEGER,
    entity_id   UINTEGER,
    event_type  VARCHAR,
    payload     JSON
);

CREATE VIEW population_vitals AS
SELECT tick,
    AVG(hunger) AS mean_hunger,
    AVG(energy) AS mean_energy,
    COUNT(*) FILTER (WHERE archetype & 1 = 1) AS employed_count
FROM agent_snapshots GROUP BY tick;
```

### Snapshot Pattern

- Wasm exposes `snapshot_to_arrow(tick)` → Arrow IPC buffer
- JS inserts via `INSERT INTO agent_snapshots SELECT * FROM arrow_scan($1)`
- Runs every 60 ticks via `MessageChannel` (non-blocking to render loop)

---

## Build Roadmap

| Priority | Task | Status |
|---|---|---|
| P0 | Scaffold Rust crate (`wasm-pack`) with `#[repr(C)]` components | ⬜ Todo |
| P0 | Verify COEP/COOP headers for `SharedArrayBuffer` | ⬜ Todo |
| P1 | Archetype storage + basic movement system | ⬜ Todo |
| P1 | Wasm memory → WebGPU instanced draw call | ⬜ Todo |
| P2 | DuckDB-Wasm + Arrow IPC snapshot pipeline | ✅ Done |
| P3 | BehaviorDecisionSystem (needs → goal → action FSM) | ⬜ Todo |
| P4 | SolidJS UI layer (population dashboard, vitals) | ⬜ Todo |

---

## Session Resume Notes

- [x] Scaffold the Rust crate + `Cargo.toml` (Completed in P0)
- [x] Select Renderer: PlayCanvas (Completed in P0/P1)
- [x] Confirm hosting: Local Vite dev server with COOP/COEP headers (Completed in P0)
- [x] Direct WebGL2 context pre-allocation pass-through to PlayCanvas (Completed)
- [x] Color-to-Vitals Mapping:
  - **Wandering**: Neon Teal/Cyan (`#00ccff`)
  - **Sleeping** (Energy): Neon Sky Blue (`#1a9cff`)
  - **Eating** (Hunger): Neon Orange (`#f5853d`)
  - **Socializing** (Social): Neon Violet/Purple (`#bd63e8`)
- [x] Stateful behavior decay & satisfaction loop with freeze-on-sleep/eat (Completed in Rust/Wasm)

*Next Actions for the next session:*
- [ ] Upgrade rendering to PlayCanvas WebGPU mesh instancing (P1 performance milestone)
- [x] Integrate DuckDB-Wasm and Arrow IPC snapshots (P2 analytics milestone)

---

## References

- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview.html)
- [WebGPU Spec](https://gpuweb.github.io/gpuweb/)
- [Babylon.js Thin Instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances)
- [SolidJS](https://www.solidjs.com/)
- [arrow2 crate](https://docs.rs/arrow2/latest/arrow2/)
