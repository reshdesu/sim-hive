// sim-core/src/systems/behavior.rs
// BehaviorDecisionSystem — reads Needs[], writes AgentMeta flags.
// Sequential: depends on NeedsDecaySystem output.
//
// P1 implementation: zero-copy Wasm-PlayCanvas hardware instancing.
// Uses a 2D spatial grid to optimize socializing proximity queries to O(N) complexity.

use crate::components::{Needs, AgentMeta, Position, flags};

const CRITICAL: f32 = 0.25;
const SATISFIED: f32 = 0.95;

const GRID_SIZE: usize = 100; // Increased grid resolution for 100,000+ agents
const CELL_SIZE: f32 = 2.0;   // 2.0 units per cell over 200x200 space

pub fn run(needs: &mut [Needs], meta: &mut [AgentMeta], positions: &[Position]) {
    debug_assert_eq!(needs.len(), meta.len());
    debug_assert_eq!(needs.len(), positions.len());

    // 1. Build spatial grid index once per frame: O(N)
    let mut grid = vec![Vec::with_capacity(16); GRID_SIZE * GRID_SIZE];
    for j in 0..positions.len() {
        // Skip sleeping agents since others won't socialize with them
        if (meta[j].archetype_flags & flags::SLEEPING) != 0 { continue; }
        
        let cx = (positions[j].x / CELL_SIZE).max(0.0).min(99.9) as usize;
        let cz = (positions[j].z / CELL_SIZE).max(0.0).min(99.9) as usize;
        grid[cx + cz * GRID_SIZE].push(j);
    }

    // 2. Process behavior FSM
    for i in 0..needs.len() {
        let mut flags_i = meta[i].archetype_flags;

        // If already sleeping, recover energy
        if (flags_i & flags::SLEEPING) != 0 {
            needs[i].energy = (needs[i].energy + 0.005).min(1.0);
            if needs[i].energy >= SATISFIED {
                flags_i &= !flags::SLEEPING;
            }
        }
        // If already eating, satisfy hunger
        else if (flags_i & flags::EATING) != 0 {
            needs[i].hunger = (needs[i].hunger + 0.01).min(1.0);
            if needs[i].hunger >= SATISFIED {
                flags_i &= !flags::EATING;
            }
        }
        // If already socializing, satisfy social ONLY when near another conscious agent
        else if (flags_i & flags::SOCIALIZING) != 0 {
            let pos_i = positions[i];
            let cx_i = (pos_i.x / CELL_SIZE).max(0.0).min(99.9) as isize;
            let cz_i = (pos_i.z / CELL_SIZE).max(0.0).min(99.9) as isize;
            
            let mut near_someone = false;

            // Search in a 3x3 grid around agent for talking partners (local 6x6 unit block)
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
                            if dx * dx + dz * dz < 36.0 { // 6.0 units socializing threshold
                                near_someone = true;
                                break;
                            }
                        }
                    }
                    if near_someone { break; }
                }
                if near_someone { break; }
            }

            if near_someone {
                needs[i].social = (needs[i].social + 0.01).min(1.0);
                if needs[i].social >= SATISFIED {
                    flags_i &= !flags::SOCIALIZING;
                }
            } else {
                needs[i].social = (needs[i].social - 0.0001).max(0.0);
            }
        }
        // If already washing/cleaning, satisfy hygiene
        else if (flags_i & flags::IN_BUILDING) != 0 {
            needs[i].hygiene = (needs[i].hygiene + 0.015).min(1.0);
            if needs[i].hygiene >= SATISFIED {
                flags_i &= !flags::IN_BUILDING;
            }
        }
        // Otherwise, decay normally and enter sleep/eat/social/wash state when critical
        else {
            if needs[i].energy < CRITICAL {
                flags_i |= flags::SLEEPING;
            } else if needs[i].hunger < CRITICAL {
                flags_i |= flags::EATING;
            } else if needs[i].social < CRITICAL {
                flags_i |= flags::SOCIALIZING;
            } else if needs[i].hygiene < CRITICAL {
                flags_i |= flags::IN_BUILDING;
            }
        }

        // Commit updated flags back to the SoA meta buffer
        meta[i].archetype_flags = flags_i;
    }
}
