// sim-core/src/components.rs
// Core ECS component types.
// All structs use #[repr(C)] + SoA layout so Position[] can be memory-mapped
// directly into a SharedArrayBuffer and zero-copy bound to a WebGPU buffer.

/// World-space position.  The `_pad` field keeps the struct 16-byte aligned
/// so each element occupies exactly one vec4 on the GPU.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Position {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub _pad: f32,
}

/// Current velocity / movement intent.
/// `speed` is the scalar magnitude cached to avoid recomputing it each tick.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Velocity {
    pub dx: f32,
    pub dy: f32,
    pub dz: f32,
    pub speed: f32,
}

/// Agent motivational needs (all normalised 0.0–1.0; lower = worse).
/// Decays over time; drives BehaviorDecisionSystem.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Needs {
    pub hunger: f32,
    pub energy: f32,
    pub social: f32,
    pub hygiene: f32,
}

impl Default for Needs {
    fn default() -> Self {
        // Agents start well-rested and fed
        Self { hunger: 0.9, energy: 0.9, social: 0.7, hygiene: 0.9 }
    }
}

/// Lightweight agent identity + state flags.
/// Stored in a separate array so the hot Position[] stays cache-clean.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct AgentMeta {
    pub entity_id: u32,
    /// Bitfield flags — see constants below.
    pub archetype_flags: u32,
    pub age: u16,
    pub household_id: u16,
}

/// Archetype flag constants (bit positions in `AgentMeta::archetype_flags`)
pub mod flags {
    pub const EMPLOYED: u32      = 1 << 0;
    pub const SOCIALIZING: u32   = 1 << 1;
    pub const IN_BUILDING: u32   = 1 << 2;
    pub const SLEEPING: u32      = 1 << 3;
    pub const EATING: u32        = 1 << 4;
}
