// sim-core/src/systems/behavior.rs
// BehaviorDecisionSystem — reads Needs[], writes AgentMeta flags.
// Sequential: depends on NeedsDecaySystem output.
//
// P1 implementation: zero-copy Wasm-PlayCanvas hardware instancing.
// Uses a 2D spatial grid to optimize socializing proximity queries to O(N) complexity.

use crate::components::{Needs, AgentMeta, Position, flags, Building, building_type};

const CRITICAL: f32 = 0.25;
const SATISFIED: f32 = 0.95;

const GRID_SIZE_X: usize = 150; // Widescreen 300x200
const GRID_SIZE_Z: usize = 100;
const CELL_SIZE: f32 = 2.0;

pub fn run(needs: &mut [Needs], meta: &mut [AgentMeta], positions: &[Position], grid: &[Vec<usize>], buildings: &[Building]) {
    debug_assert_eq!(needs.len(), meta.len());
    debug_assert_eq!(needs.len(), positions.len());

    let houses: Vec<&Building> = buildings.iter().filter(|b| b.building_type == building_type::HOUSE).collect();
    let foods: Vec<&Building> = buildings.iter().filter(|b| b.building_type == building_type::FOOD).collect();
    let workplaces: Vec<&Building> = buildings.iter().filter(|b| b.building_type == building_type::WORKPLACE).collect();

    // 1. Process behavior FSM
    for i in 0..needs.len() {
        let mut flags_i = meta[i].archetype_flags;

        // --- Priority Interrupts ---
        // If a vital survival need hits rock bottom (10%), drop everything else!
        if needs[i].energy < 0.1 && (flags_i & flags::SLEEPING) == 0 {
            flags_i &= !(flags::EATING | flags::SOCIALIZING | flags::IN_BUILDING);
            flags_i |= flags::SLEEPING;
        } else if needs[i].hunger < 0.1 && (flags_i & (flags::SLEEPING | flags::EATING)) == 0 {
            flags_i &= !(flags::SOCIALIZING | flags::IN_BUILDING);
            flags_i |= flags::EATING;
        }

        // If already sleeping, recover energy ONLY if near house
        if (flags_i & flags::SLEEPING) != 0 {
            if !houses.is_empty() {
                let target = houses[meta[i].household_id as usize % houses.len()];
                if is_near_building(positions[i], target) {
                    needs[i].energy = (needs[i].energy + 0.05).min(1.0);
                    if needs[i].energy >= SATISFIED {
                        flags_i &= !flags::SLEEPING;
                    }
                }
            }
        }
        // If already eating, satisfy hunger ONLY if near food source
        else if (flags_i & flags::EATING) != 0 {
            if !foods.is_empty() {
                let target = foods[i % foods.len()];
                if is_near_building(positions[i], target) {
                    needs[i].hunger = (needs[i].hunger + 0.05).min(1.0);
                    if needs[i].hunger >= SATISFIED {
                        flags_i &= !flags::EATING;
                    }
                }
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
                    if cx >= 0 && cx < GRID_SIZE_X as isize && cz >= 0 && cz < GRID_SIZE_Z as isize {
                        let cell_idx = (cx as usize) + (cz as usize) * GRID_SIZE_X;
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
                needs[i].social = (needs[i].social + 0.05).min(1.0);
                if needs[i].social >= SATISFIED {
                    flags_i &= !flags::SOCIALIZING;
                }
            } else {
                needs[i].social = (needs[i].social - 0.0001).max(0.0);
            }
        }
        // If already washing/cleaning, satisfy hygiene ONLY if near workplace
        else if (flags_i & flags::IN_BUILDING) != 0 {
            if !workplaces.is_empty() {
                let target = workplaces[i % workplaces.len()];
                if is_near_building(positions[i], target) {
                    needs[i].hygiene = (needs[i].hygiene + 0.05).min(1.0);
                    if needs[i].hygiene >= SATISFIED {
                        flags_i &= !flags::IN_BUILDING;
                    }
                }
            }
        }
        // Otherwise, pick a new goal if we have NO active goals!
        else if (flags_i & (flags::SLEEPING | flags::EATING | flags::SOCIALIZING | flags::IN_BUILDING)) == 0 {
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

fn is_near_building(pos: Position, target: &Building) -> bool {
    let dx = (pos.x - target.x).abs();
    let dz = (pos.z - target.z).abs();
    dx <= (target.width / 2.0) + 0.5 && dz <= (target.depth / 2.0) + 0.5
}
