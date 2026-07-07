// sim-core/src/systems/pathfinding.rs
// Writes Velocity[] based on current Position[].
// Has ZERO shared writes with needs_decay — safe to run in parallel via rayon.
//
// P1 implementation: zero-copy Wasm-PlayCanvas hardware instancing.
// Uses a 2D spatial grid to optimize socializing proximity queries to O(N) complexity.
// Staggers pathfinding updates to run only once every 15 frames per agent, scaling to 100,000+ agents.

use crate::components::{Position, Velocity, AgentMeta, flags};

/// Step size per tick for the random walk.
const STEP: f32 = 0.05;

const WORLD_SIZE: f32 = 200.0;
const STEER_DIST: f32 = 15.0;

const GRID_SIZE: usize = 100; // Increased grid resolution for 100,000+ agents
const CELL_SIZE: f32 = 2.0;   // 2.0 units per cell over 200x200 space

pub fn run(positions: &[Position], meta: &[AgentMeta], velocities: &mut [Velocity], tick: u64) {
    debug_assert_eq!(positions.len(), velocities.len());
    debug_assert_eq!(positions.len(), meta.len());

    // 1. Build spatial grid index once per frame: O(N)
    let mut grid = vec![Vec::with_capacity(16); GRID_SIZE * GRID_SIZE];
    for j in 0..positions.len() {
        if (meta[j].archetype_flags & flags::SLEEPING) != 0 { continue; }
        
        let cx = (positions[j].x / CELL_SIZE).max(0.0).min(99.9) as usize;
        let cz = (positions[j].z / CELL_SIZE).max(0.0).min(99.9) as usize;
        grid[cx + cz * GRID_SIZE].push(j);
    }

    // 2. Compute velocities
    for (i, vel) in velocities.iter_mut().enumerate() {
        let m = meta[i];
        
        // A. Sleeping, Eating, or Washing (IN_BUILDING) agents freeze in place
        if (m.archetype_flags & (flags::SLEEPING | flags::EATING | flags::IN_BUILDING)) != 0 {
            vel.dx = 0.0;
            vel.dz = 0.0;
            vel.dy = 0.0;
            vel.speed = 0.0;
        } 
        // B. Socializing agents seek their nearest conscious neighbor in the spatial grid
        else if (m.archetype_flags & flags::SOCIALIZING) != 0 {
            // Only recalculate target path every 15 frames per agent to stagger CPU workload
            if (tick + i as u64) % 15 == 0 || vel.speed == 0.0 {
                let pos_i = positions[i];
                let cx_i = (pos_i.x / CELL_SIZE).max(0.0).min(99.9) as isize;
                let cz_i = (pos_i.z / CELL_SIZE).max(0.0).min(99.9) as isize;
                
                let mut nearest_idx = None;
                let mut min_dist_sq = f32::MAX;
                
                // Phase 1: Search in a 3x3 grid around agent (covering a 6x6 unit block)
                for dx_cell in -1..=1 {
                    for dz_cell in -1..=1 {
                        let cx = cx_i + dx_cell;
                        let cz = cz_i + dz_cell;
                        if cx >= 0 && cx < GRID_SIZE as isize && cz >= 0 && cz < GRID_SIZE as isize {
                            let cell_idx = (cx as usize) + (cz as usize) * GRID_SIZE;
                            for &j in &grid[cell_idx] {
                                if i == j { continue; }
                                let dx = positions[j].x - pos_i.x;
                                let dz = positions[j].z - pos_i.z;
                                let dist_sq = dx * dx + dz * dz;
                                if dist_sq < min_dist_sq {
                                    min_dist_sq = dist_sq;
                                    nearest_idx = Some(j);
                                }
                            }
                        }
                    }
                }
                
                // Phase 2: If no neighbor in 3x3 cells, check a wider 5x5 block (covering a 10x10 unit block)
                if nearest_idx.is_none() {
                    for dx_cell in -2..=2 {
                        for dz_cell in -2..=2 {
                            if dx_cell >= -1 && dx_cell <= 1 && dz_cell >= -1 && dz_cell <= 1 { continue; }
                            let cx = cx_i + dx_cell;
                            let cz = cz_i + dz_cell;
                            if cx >= 0 && cx < GRID_SIZE as isize && cz >= 0 && cz < GRID_SIZE as isize {
                                let cell_idx = (cx as usize) + (cz as usize) * GRID_SIZE;
                                for &j in &grid[cell_idx] {
                                    if i == j { continue; }
                                    let dx = positions[j].x - pos_i.x;
                                    let dz = positions[j].z - pos_i.z;
                                    let dist_sq = dx * dx + dz * dz;
                                    if dist_sq < min_dist_sq {
                                        min_dist_sq = dist_sq;
                                        nearest_idx = Some(j);
                                    }
                                }
                            }
                        }
                    }
                }

                if let Some(target_idx) = nearest_idx {
                    if min_dist_sq < 36.0 {
                        // Chatting range reached! Freeze and socialize.
                        vel.dx = 0.0;
                        vel.dz = 0.0;
                        vel.dy = 0.0;
                        vel.speed = 0.0;
                    } else {
                        // Walk directly towards target agent
                        let target_pos = positions[target_idx];
                        let dx = target_pos.x - pos_i.x;
                        let dz = target_pos.z - pos_i.z;
                        let angle = dz.atan2(dx);
                        vel.dx = angle.cos() * STEP;
                        vel.dz = angle.sin() * STEP;
                        vel.dy = 0.0;
                        vel.speed = STEP;
                    }
                } else {
                    // Fallback to normal random walk
                    let pos = positions[i];
                    let near_boundary = pos.x < STEER_DIST
                        || pos.x > (WORLD_SIZE - STEER_DIST)
                        || pos.z < STEER_DIST
                        || pos.z > (WORLD_SIZE - STEER_DIST);

                    let angle = if near_boundary {
                        let dx = 100.0 - pos.x;
                        let dz = 100.0 - pos.z;
                        dz.atan2(dx)
                    } else {
                        let change_tick = tick / 120;
                        let h = hash(i as u64 ^ change_tick);
                        (h as f32 / u64::MAX as f32) * std::f32::consts::TAU
                    };

                    vel.dx    = angle.cos() * STEP;
                    vel.dz    = angle.sin() * STEP;
                    vel.dy    = 0.0;
                    vel.speed = STEP;
                }
            } else {
                // Staggered frame: maintain current direction, but still apply boundary steering
                let pos = positions[i];
                let near_boundary = pos.x < STEER_DIST
                    || pos.x > (WORLD_SIZE - STEER_DIST)
                    || pos.z < STEER_DIST
                    || pos.z > (WORLD_SIZE - STEER_DIST);

                if near_boundary {
                    let dx = 100.0 - pos.x;
                    let dz = 100.0 - pos.z;
                    let angle = dz.atan2(dx);
                    vel.dx    = angle.cos() * STEP;
                    vel.dz    = angle.sin() * STEP;
                    vel.dy    = 0.0;
                    vel.speed = STEP;
                }
            }
        }
        // C. Wandering agents perform normal random-walk / boundary avoidance
        else {
            let pos = positions[i];
            
            // Check if agent is close to any boundary
            let near_boundary = pos.x < STEER_DIST
                || pos.x > (WORLD_SIZE - STEER_DIST)
                || pos.z < STEER_DIST
                || pos.z > (WORLD_SIZE - STEER_DIST);

            let angle = if near_boundary {
                // Steer back towards center of the map (100, 100)
                let dx = 100.0 - pos.x;
                let dz = 100.0 - pos.z;
                dz.atan2(dx)
            } else {
                // Change direction every 120 ticks (~2 seconds at 60fps)
                let change_tick = tick / 120;
                let h = hash(i as u64 ^ change_tick);
                (h as f32 / u64::MAX as f32) * std::f32::consts::TAU
            };

            vel.dx    = angle.cos() * STEP;
            vel.dz    = angle.sin() * STEP;
            vel.dy    = 0.0;
            vel.speed = STEP;
        }
    }
}

/// Lightweight integer hash (Murmur-inspired, no stdlib required in Wasm).
#[inline(always)]
fn hash(mut v: u64) -> u64 {
    v ^= v >> 30;
    v = v.wrapping_mul(0xbf58476d1ce4e5b9);
    v ^= v >> 27;
    v = v.wrapping_mul(0x94d049bb133111eb);
    v ^= v >> 31;
    v
}
