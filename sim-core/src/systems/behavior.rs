// sim-core/src/systems/behavior.rs
// BehaviorDecisionSystem — reads Needs[], writes AgentMeta flags.
// Sequential: depends on NeedsDecaySystem output.
//
// P0: simple threshold FSM.
// P3 will expand to goal → action tree.

use crate::components::{Needs, AgentMeta, Position, flags};

const CRITICAL: f32 = 0.25;
const SATISFIED: f32 = 0.95;

pub fn run(needs: &mut [Needs], meta: &mut [AgentMeta], positions: &[Position]) {
    debug_assert_eq!(needs.len(), meta.len());
    debug_assert_eq!(needs.len(), positions.len());

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
            let mut near_someone = false;

            for j in 0..positions.len() {
                if i == j { continue; }
                // Safe read-only access (no mutable borrow active on meta)
                if (meta[j].archetype_flags & flags::SLEEPING) != 0 { continue; }

                let dx = pos_i.x - positions[j].x;
                let dz = pos_i.z - positions[j].z;
                if dx * dx + dz * dz < 36.0 { // 6.0 units socializing threshold
                    near_someone = true;
                    break;
                }
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
