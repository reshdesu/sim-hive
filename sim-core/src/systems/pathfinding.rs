// sim-core/src/systems/pathfinding.rs
// Writes Velocity[] based on current Position[].
// Has ZERO shared writes with needs_decay — safe to run in parallel via rayon.
//
// P0 implementation: simple random-walk placeholder.
// P3 will replace with A* / flow-field over the world grid.

use crate::components::{Position, Velocity, AgentMeta, flags};

/// Step size per tick for the random walk.
const STEP: f32 = 0.05;

const WORLD_SIZE: f32 = 200.0;
const STEER_DIST: f32 = 15.0;

pub fn run(positions: &[Position], meta: &[AgentMeta], velocities: &mut [Velocity], tick: u64) {
    debug_assert_eq!(positions.len(), velocities.len());
    debug_assert_eq!(positions.len(), meta.len());

    for (i, vel) in velocities.iter_mut().enumerate() {
        let m = meta[i];
        
        // 1. Sleeping, Eating, or Washing (IN_BUILDING) agents freeze in place
        if (m.archetype_flags & (flags::SLEEPING | flags::EATING | flags::IN_BUILDING)) != 0 {
            vel.dx = 0.0;
            vel.dz = 0.0;
            vel.dy = 0.0;
            vel.speed = 0.0;
        } 
        // 2. Socializing agents seek their nearest conscious neighbor
        else if (m.archetype_flags & flags::SOCIALIZING) != 0 {
            let pos_i = positions[i];
            let mut nearest_idx = None;
            let mut min_dist_sq = f32::MAX;

            for j in 0..positions.len() {
                if i == j { continue; }
                // Seek only conscious (non-sleeping) agents
                if (meta[j].archetype_flags & flags::SLEEPING) != 0 { continue; }

                let dx = positions[j].x - pos_i.x;
                let dz = positions[j].z - pos_i.z;
                let dist_sq = dx * dx + dz * dz;
                if dist_sq < min_dist_sq {
                    min_dist_sq = dist_sq;
                    nearest_idx = Some(j);
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
                // No conscious agents to socialize with? fallback to normal movement
                vel.dx = 0.0;
                vel.dz = 0.0;
                vel.dy = 0.0;
                vel.speed = 0.0;
            }
        }
        // 3. Wandering agents perform normal random-walk / boundary avoidance
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
