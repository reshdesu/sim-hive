// sim-core/src/lib.rs
// Entry point for the Sim Hive Wasm module.
// All public Wasm-exported functions live here; ECS logic is in sub-modules.

use wasm_bindgen::prelude::*;

pub mod components;
pub mod systems;
pub mod world;

// Re-export top-level API for JS consumers
pub use world::World;

/// Called once from JS to initialise the simulation.
/// `count` — number of agents to spawn.
#[wasm_bindgen]
pub fn init_simulation(count: u32) -> World {
    // Better panic messages in the browser console (dev builds)
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    World::new(count)
}
