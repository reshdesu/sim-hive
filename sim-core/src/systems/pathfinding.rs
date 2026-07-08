// sim-core/src/systems/pathfinding.rs
// Writes Velocity[] based on current Position[].
// Has ZERO shared writes with needs_decay — safe to run in parallel via rayon.
//
// P1 implementation: zero-copy Wasm-PlayCanvas hardware instancing.
// Uses a 2D spatial grid to optimize socializing proximity queries to O(N) complexity.
// Staggers pathfinding updates to run only once every 15 frames per agent, scaling to 100,000+ agents.

use crate::components::{Position, Velocity, AgentMeta, flags, Building, building_type};

/// Step size per tick for the random walk.
const STEP: f32 = 0.05;

const WORLD_SIZE_X: f32 = 300.0;
const WORLD_SIZE_Z: f32 = 200.0;
const STEER_DIST: f32 = 15.0;

const GRID_SIZE_X: usize = 150; // Widescreen 300x200
const GRID_SIZE_Z: usize = 100;
const CELL_SIZE: f32 = 2.0;   // 2.0 units per cell

pub fn run(positions: &[Position], meta: &[AgentMeta], velocities: &mut [Velocity], grid: &[Vec<usize>], buildings: &[Building], tick: u64) {
    debug_assert_eq!(positions.len(), velocities.len());
    debug_assert_eq!(positions.len(), meta.len());

    let houses: Vec<&Building> = buildings.iter().filter(|b| b.building_type == building_type::HOUSE).collect();
    let foods: Vec<&Building> = buildings.iter().filter(|b| b.building_type == building_type::FOOD).collect();
    let workplaces: Vec<&Building> = buildings.iter().filter(|b| b.building_type == building_type::WORKPLACE).collect();

    // 1. Compute velocities
    for (i, vel) in velocities.iter_mut().enumerate() {
        let m = meta[i];
        
        // A. Sleeping, Eating, or Washing (IN_BUILDING) agents pathfind to their POI
        if (m.archetype_flags & (flags::SLEEPING | flags::EATING | flags::IN_BUILDING)) != 0 {
            let target_building = if (m.archetype_flags & flags::SLEEPING) != 0 && !houses.is_empty() {
                Some(houses[m.household_id as usize % houses.len()])
            } else if (m.archetype_flags & flags::EATING) != 0 && !foods.is_empty() {
                Some(foods[i % foods.len()])
            } else if (m.archetype_flags & flags::IN_BUILDING) != 0 && !workplaces.is_empty() {
                Some(workplaces[i % workplaces.len()])
            } else {
                None
            };

            if let Some(target) = target_building {
                let dx = target.x - positions[i].x;
                let dz = target.z - positions[i].z;
                
                if dx.abs() <= (target.width / 2.0) + 0.5 && dz.abs() <= (target.depth / 2.0) + 0.5 {
                    vel.dx = 0.0;
                    vel.dz = 0.0;
                    vel.dy = 0.0;
                    vel.speed = 0.0;
                } else {
                    let angle = dz.atan2(dx);
                    let run_speed = STEP * 5.0; // Moderate sprint to keep vitals high
                    vel.dx = angle.cos() * run_speed;
                    vel.dz = angle.sin() * run_speed;
                    vel.dy = 0.0;
                    vel.speed = run_speed;
                }
            } else {
                vel.dx = 0.0;
                vel.dz = 0.0;
                vel.dy = 0.0;
                vel.speed = 0.0;
            }
        }
        // B. Socializing agents seek their nearest conscious neighbor in the spatial grid
        else if (m.archetype_flags & flags::SOCIALIZING) != 0 {
            // Only recalculate target path every 15 frames per agent to stagger CPU workload
            if (tick + i as u64) % 15 == 0 || vel.speed == 0.0 {
                let pos_i = positions[i];
                let cx_i = (pos_i.x / CELL_SIZE).max(0.0).min((GRID_SIZE_X - 1) as f32) as isize;
                let cz_i = (pos_i.z / CELL_SIZE).max(0.0).min((GRID_SIZE_Z - 1) as f32) as isize;
                
                let mut nearest_idx = None;
                let mut min_dist_sq = f32::MAX;
                
                // Phase 1: Search in a 3x3 grid around agent (covering a 6x6 unit block)
                for dx_cell in -1..=1 {
                    for dz_cell in -1..=1 {
                        let cx = cx_i + dx_cell;
                        let cz = cz_i + dz_cell;
                        if cx >= 0 && cx < GRID_SIZE_X as isize && cz >= 0 && cz < GRID_SIZE_Z as isize {
                            let cell_idx = (cx as usize) + (cz as usize) * GRID_SIZE_X;
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
                            if cx >= 0 && cx < GRID_SIZE_X as isize && cz >= 0 && cz < GRID_SIZE_Z as isize {
                                let cell_idx = (cx as usize) + (cz as usize) * GRID_SIZE_X;
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
                        let run_speed = STEP * 5.0;
                        vel.dx = angle.cos() * run_speed;
                        vel.dz = angle.sin() * run_speed;
                        vel.dy = 0.0;
                        vel.speed = run_speed;
                    }
                } else {
                    // Fallback to normal random walk
                    let pos = positions[i];
                    let near_boundary = pos.x < STEER_DIST
                        || pos.x > (WORLD_SIZE_X - STEER_DIST)
                        || pos.z < STEER_DIST
                        || pos.z > (WORLD_SIZE_Z - STEER_DIST);

                    let angle = if near_boundary {
                        let dx = 150.0 - pos.x;
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
                    || pos.x > (WORLD_SIZE_X - STEER_DIST)
                    || pos.z < STEER_DIST
                    || pos.z > (WORLD_SIZE_Z - STEER_DIST);

                if near_boundary {
                    let dx = 150.0 - pos.x;
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
                || pos.x > (WORLD_SIZE_X - STEER_DIST)
                || pos.z < STEER_DIST
                || pos.z > (WORLD_SIZE_Z - STEER_DIST);

            let angle = if near_boundary {
                // Steer back towards center of the map (150, 100)
                let dx = 150.0 - pos.x;
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

        // --- Smooth Repulsive Building Avoidance ---
        // If the agent is moving, ensure they flow around buildings without getting trapped in corners
        if vel.speed > 0.0 {
            // Find out if they have a target building they are ALLOWED to be inside
            let target_building = if (m.archetype_flags & flags::SLEEPING) != 0 && !houses.is_empty() {
                Some(houses[m.household_id as usize % houses.len()])
            } else if (m.archetype_flags & flags::EATING) != 0 && !foods.is_empty() {
                Some(foods[i % foods.len()])
            } else if (m.archetype_flags & flags::IN_BUILDING) != 0 && !workplaces.is_empty() {
                Some(workplaces[i % workplaces.len()])
            } else {
                None
            };
            
            let target_ptr = target_building.map(|b| b as *const Building).unwrap_or(std::ptr::null());
            
            let pos = positions[i];
            for b in buildings {
                // Don't repel from our own destination building
                if (b as *const Building) == target_ptr { continue; }
                
                let dx = pos.x - b.x;
                let dz = pos.z - b.z;
                
                // Approximate buildings as circles for smooth, fluid repulsion
                let b_radius = (b.width.max(b.depth) / 2.0) + 1.0;
                let dist_sq = dx * dx + dz * dz;
                
                if dist_sq < b_radius * b_radius {
                    let dist = dist_sq.sqrt().max(0.001);
                    // The closer they are to the center, the stronger the push!
                    let force = (b_radius - dist) / b_radius; 
                    let repel_strength = force * (STEP * 4.0);
                    
                    vel.dx += (dx / dist) * repel_strength;
                    vel.dz += (dz / dist) * repel_strength;
                }
            }
            
            // Cap their max speed so the repulsion doesn't launch them out of bounds
            let speed = (vel.dx * vel.dx + vel.dz * vel.dz).sqrt();
            let max_speed = STEP * 5.0;
            if speed > max_speed {
                vel.dx = (vel.dx / speed) * max_speed;
                vel.dz = (vel.dz / speed) * max_speed;
            }
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
