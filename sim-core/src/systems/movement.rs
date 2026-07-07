// sim-core/src/systems/movement.rs
// MovementSystem — integrates Velocity[] into Position[].
// Sequential: depends on PathfindingSystem output.

use crate::components::{Position, Velocity};

/// World boundary (wrap-around toroidal world).
const WORLD_SIZE: f32 = 200.0;

pub fn run(positions: &mut [Position], velocities: &[Velocity]) {
    debug_assert_eq!(positions.len(), velocities.len());

    for (pos, vel) in positions.iter_mut().zip(velocities.iter()) {
        pos.x = (pos.x + vel.dx).clamp(0.0, WORLD_SIZE);
        pos.y = (pos.y + vel.dy).max(0.0); // y never goes below ground
        pos.z = (pos.z + vel.dz).clamp(0.0, WORLD_SIZE);
    }
}
