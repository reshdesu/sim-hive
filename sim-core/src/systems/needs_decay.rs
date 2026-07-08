// sim-core/src/systems/needs_decay.rs
// Decays all agent needs each tick.
// Has ZERO shared writes with pathfinding — safe to run in parallel via rayon.

use crate::components::Needs;

/// Per-tick decay rates (tuned for faster lifecycle testing).
const HUNGER_DECAY:  f32 = 0.0001;
const ENERGY_DECAY:  f32 = 0.00007;
const SOCIAL_DECAY:  f32 = 0.00013;
const HYGIENE_DECAY: f32 = 0.00003;

pub fn run(needs: &mut [Needs]) {
    for n in needs.iter_mut() {
        n.hunger  = (n.hunger  - HUNGER_DECAY).max(0.0);
        n.energy  = (n.energy  - ENERGY_DECAY).max(0.0);
        n.social  = (n.social  - SOCIAL_DECAY).max(0.0);
        n.hygiene = (n.hygiene - HYGIENE_DECAY).max(0.0);
    }
}
