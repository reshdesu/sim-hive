// sim-core/src/world.rs
// Owns all component arrays and exposes the JS-facing API.

use wasm_bindgen::prelude::*;
use crate::components::{Position, Velocity, Needs, AgentMeta, flags, Building, building_type};
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

    // WebGL-instanced matrix buffers
    state_matrices: Vec<Vec<f32>>,
    state_counts:   Vec<u32>,

    pub(crate) buildings: Vec<Building>,

    // Shared spatial grid for collision/proximity checks
    grid: Vec<Vec<usize>>,
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
                let hygiene = 0.5 + ((h >> 30) % 500) as f32 / 1000.0; // 0.5 to 1.0
                Needs { hunger, energy, social, hygiene }
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

        let state_matrices = vec![
            vec![0.0; n * 16], // Walk
            vec![0.0; n * 16], // Sleep
            vec![0.0; n * 16], // Eat
            vec![0.0; n * 16], // Social
            vec![0.0; n * 16], // Wash
        ];
        let state_counts = vec![0; 5];
        let grid = vec![Vec::with_capacity(16); 100 * 100];

        let mut buildings: Vec<Building> = Vec::new();
        let num_houses = (n as u16 / 4).max(1);
        let num_workplaces = (n / 50).max(1);
        let num_food = (n / 30).max(1);
        
        // Lay out buildings organically but prevent overlapping
        let mut add_buildings = |btype, w: f32, d: f32, count: u32| {
            for i in 0..count {
                for attempt in 0..10_000 {
                    let h = seed_hash((btype as u64) ^ (i as u64) ^ (attempt as u64) ^ 0xABCD);
                    let x = 15.0 + (h % 170) as f32;
                    let z = 15.0 + ((h >> 10) % 170) as f32;
                    
                    let mut overlap = false;
                    for b in &buildings {
                        let dx = (x - b.x).abs();
                        let dz = (z - b.z).abs();
                        // 0.5 buffer space between buildings to allow tight packing
                        if dx < (w + b.width) / 2.0 + 0.5 && dz < (d + b.depth) / 2.0 + 0.5 {
                            overlap = true;
                            break;
                        }
                    }
                    if !overlap {
                        buildings.push(Building { x, z, width: w, depth: d, building_type: btype });
                        break;
                    }
                }
            }
        };

        add_buildings(building_type::HOUSE, 4.0, 4.0, num_houses as u32);
        add_buildings(building_type::WORKPLACE, 10.0, 10.0, num_workplaces as u32);
        add_buildings(building_type::FOOD, 6.0, 6.0, num_food as u32);

        let mut world = Self {
            count,
            positions,
            velocities,
            needs,
            meta,
            tick: 0,
            state_matrices,
            state_counts,
            buildings,
            grid,
        };

        // Initialize first frame spatial structures and matrices
        world.rebuild_spatial_grid();
        world.update_state_matrices();
        world
    }

    pub fn tick(&mut self) -> u64 {
        systems::needs_decay::run(&mut self.needs);

        // Rebuild the shared spatial grid once per frame: allocation-free and O(N)
        self.rebuild_spatial_grid();

        systems::pathfinding::run(&self.positions, &self.meta, &mut self.velocities, &self.grid, &self.buildings, self.tick);
        systems::behavior::run(&mut self.needs, &mut self.meta, &self.positions, &self.grid, &self.buildings);
        systems::movement::run(&mut self.positions, &self.velocities);

        // Build flat transform matrices for GPU hardware instancing in Rust
        self.update_state_matrices();

        self.tick += 1;
        self.tick
    }

    /// Rebuild the shared spatial grid once per frame.
    /// Performs allocation-free grid construction.
    fn rebuild_spatial_grid(&mut self) {
        for cell in &mut self.grid {
            cell.clear();
        }

        const GRID_SIZE: usize = 100;
        const CELL_SIZE: f32 = 2.0;

        for (j, (pos, m)) in self.positions.iter().zip(self.meta.iter()).enumerate() {
            if (m.archetype_flags & flags::SLEEPING) != 0 { continue; }

            let cx = (pos.x / CELL_SIZE).max(0.0).min(99.9) as usize;
            let cz = (pos.z / CELL_SIZE).max(0.0).min(99.9) as usize;
            self.grid[cx + cz * GRID_SIZE].push(j);
        }
    }

    /// Rebuild flat transform matrices in memory for the 5 vital states.
    /// Eliminates JS matrix packing loop overhead, optimized with bounds-check free zip iterators.
    fn update_state_matrices(&mut self) {
        // Reset counts
        for c in self.state_counts.iter_mut() {
            *c = 0;
        }

        for (pos, m) in self.positions.iter().zip(self.meta.iter()) {
            let flags_i = m.archetype_flags;

            let mut state_idx = 0;
            if (flags_i & flags::SLEEPING) != 0 {
                state_idx = 1;
            } else if (flags_i & flags::EATING) != 0 {
                state_idx = 2;
            } else if (flags_i & flags::SOCIALIZING) != 0 {
                state_idx = 3;
            } else if (flags_i & flags::IN_BUILDING) != 0 {
                state_idx = 4;
            }

            let count = self.state_counts[state_idx] as usize;
            let offset = count * 16;
            
            let buf = &mut self.state_matrices[state_idx];
            
            // Set 4x4 column-major matrix representing translation (pos.x, pos.y, pos.z)
            // and scale (0.8, 1.6, 0.8) with identity rotation
            buf[offset] = 0.8;
            buf[offset + 1] = 0.0;
            buf[offset + 2] = 0.0;
            buf[offset + 3] = 0.0;

            buf[offset + 4] = 0.0;
            buf[offset + 5] = 1.6;
            buf[offset + 6] = 0.0;
            buf[offset + 7] = 0.0;

            buf[offset + 8] = 0.0;
            buf[offset + 9] = 0.0;
            buf[offset + 10] = 0.8;
            buf[offset + 11] = 0.0;

            buf[offset + 12] = pos.x;
            buf[offset + 13] = pos.y;
            buf[offset + 14] = pos.z;
            buf[offset + 15] = 1.0;

            self.state_counts[state_idx] += 1;
        }
    }

    /// Exposes a pointer to the matrix buffer of the given state index
    pub fn state_matrices_ptr(&self, state_idx: u32) -> *const f32 {
        self.state_matrices[state_idx as usize].as_ptr()
    }

    /// Exposes the active count of agents in the given state index
    pub fn state_count(&self, state_idx: u32) -> u32 {
        self.state_counts[state_idx as usize]
    }

    /// Returns a pointer into Wasm linear memory for the flat Position[].
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

    pub fn buildings_ptr(&self) -> *const Building {
        self.buildings.as_ptr()
    }

    pub fn buildings_count(&self) -> u32 {
        self.buildings.len() as u32
    }
}
