// sim-core/src/world.rs
// Owns all component arrays and exposes the JS-facing API.

use wasm_bindgen::prelude::*;
use crate::components::{Position, Velocity, Needs, AgentMeta, flags};
use crate::systems;

/// The top-level simulation container.
/// Holds one flat Vec per component type (Structure-of-Arrays).
#[wasm_bindgen]
pub struct World {
    pub(crate) count: u32,

    // SoA component arrays — same index == same entity
    pub(crate) positions:  Vec<Position>,
    pub(crate) velocities: Vec<Velocity>,
    pub(crate) needs:      Vec<Needs>,
    pub(crate) meta:       Vec<AgentMeta>,

    pub(crate) tick: u64,
}

#[wasm_bindgen]
impl World {
    /// Construct a world with `count` agents, spawned in a grid pattern.
    pub fn new(count: u32) -> Self {
        let n = count as usize;
        let side = (n as f32).sqrt().ceil() as u32;
        let spacing = 200.0 / (side + 1) as f32;

        let positions: Vec<Position> = (0..n)
            .map(|i| {
                let row = (i as u32) / side;
                let col = (i as u32) % side;
                Position {
                    x: (col + 1) as f32 * spacing,
                    y: 0.0,
                    z: (row + 1) as f32 * spacing,
                    _pad: 0.0,
                }
            })
            .collect();

        let velocities: Vec<Velocity> = vec![Velocity::default(); n];

        let needs: Vec<Needs> = (0..n)
            .map(|i| {
                let h = seed_hash(i as u64);
                let hunger = 0.6 + (h % 400) as f32 / 1000.0; // 0.6 to 1.0
                let energy = 0.6 + ((h >> 10) % 400) as f32 / 1000.0; // 0.6 to 1.0
                let social = 0.4 + ((h >> 20) % 500) as f32 / 1000.0; // 0.4 to 0.9
                Needs { hunger, energy, social, hygiene: 0.9 }
            })
            .collect();

        fn seed_hash(mut v: u64) -> u64 {
            v ^= v >> 30;
            v = v.wrapping_mul(0xbf58476d1ce4e5b9);
            v ^= v >> 27;
            v = v.wrapping_mul(0x94d049bb133111eb);
            v ^= v >> 31;
            v
        }

        let meta: Vec<AgentMeta> = (0..n)
            .map(|i| AgentMeta {
                entity_id: i as u32,
                archetype_flags: if i % 3 == 0 { flags::EMPLOYED } else { 0 },
                age: 18 + (i as u16 % 62),
                household_id: (i as u16 / 4),
            })
            .collect();

        Self { count, positions, velocities, needs, meta, tick: 0 }
    }

    /// Advance the simulation by one tick.
    /// Returns the current tick count (useful for JS scheduling).
    pub fn tick(&mut self) -> u64 {
        systems::needs_decay::run(&mut self.needs);
        systems::pathfinding::run(&self.positions, &self.meta, &mut self.velocities, self.tick);
        systems::behavior::run(&mut self.needs, &mut self.meta, &self.positions);
        systems::movement::run(&mut self.positions, &self.velocities);
        self.tick += 1;
        self.tick
    }

    /// Returns a pointer into Wasm linear memory for the flat Position[].
    /// The JS layer wraps this as: `new Float32Array(memory.buffer, ptr, len/4)`
    /// for zero-copy GPU buffer upload.
    pub fn positions_ptr(&self) -> *const f32 {
        self.positions.as_ptr() as *const f32
    }

    /// Byte length of the Position array (for the Float32Array view).
    pub fn positions_byte_len(&self) -> u32 {
        (self.positions.len() * std::mem::size_of::<Position>()) as u32
    }

    /// Snapshot the Needs array as a raw byte pointer (for DuckDB Arrow ingest).
    pub fn needs_ptr(&self) -> *const f32 {
        self.needs.as_ptr() as *const f32
    }

    pub fn needs_byte_len(&self) -> u32 {
        (self.needs.len() * std::mem::size_of::<Needs>()) as u32
    }

    /// Expose flat AgentMeta SoA pointer for JS flag decoding.
    pub fn meta_ptr(&self) -> *const u32 {
        self.meta.as_ptr() as *const u32
    }

    pub fn meta_byte_len(&self) -> u32 {
        (self.meta.len() * std::mem::size_of::<AgentMeta>()) as u32
    }

    /// Agent count (used by JS to size GPU buffers).
    pub fn agent_count(&self) -> u32 {
        self.count
    }

    /// Current simulation tick.
    pub fn current_tick(&self) -> u64 {
        self.tick
    }
}
