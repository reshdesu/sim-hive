# Sim Hive 🐝

A high-performance, browser-based life simulation engine scaling up to 10,000+ autonomous agents. Built with a data-oriented design using a parallel Rust ECS compiled to WebAssembly, a zero-copy GPU memory bridge, and a rich PlayCanvas + SolidJS dashboard.

---

## 🚀 Technology Stack
* **Simulation Engine**: Parallel Entity Component System (ECS) in Rust, compiled to WebAssembly (`wasm-pack`).
* **3D Renderer**: PlayCanvas (WebGL2/WebGPU) with hardware-instanced rendering.
* **Analytics Database**: DuckDB-Wasm running Arrow IPC snapshot buffers (P2).
* **User Interface**: SolidJS dashboard with real-time reactive stats and vitals.
* **Workspace Manager**: `pnpm` workspaces (mono-repo).

---

## 🛠️ Repository Structure
```text
├── .agents/          # AI custom instructions & constraints (Workspace rules)
├── .githooks/        # Shared Git hooks (Secrets scanning, commit message validation)
├── sim-core/         # Rust ECS simulation engine
│   ├── src/
│   │   ├── components.rs   # Repr(C) aligned component buffers
│   │   ├── systems/        # Parallel needs decay, pathfinding, behavior FSM, movement
│   │   └── world.rs        # World container and Wasm memory exports
│   └── Cargo.toml
└── web/              # SolidJS + PlayCanvas frontend dashboard
    ├── src/
    │   ├── App.tsx         # SolidJS control panel, stats, and vitals sidebar
    │   ├── sim-bridge.ts   # PlayCanvas scene setup and Wasm memory rendering loop
    │   └── index.css       # Premium glassmorphic styling system
    └── package.json
```

---

## 🕹️ Color-to-Vitals Behavior Schema
Agent material colors match the UI dashboard's vitals bars 1-to-1:

| Behavior State | Color | Associated Vital | Action |
|---|---|---|---|
| **Wandering** | ⚪ Neon White | *Neutral* | Normal random walk & boundary steering |
| **Sleeping** | 🔵 Neon Sky Blue | Energy | Stationary sleep (energy recovers) |
| **Eating** | 🟠 Neon Orange | Hunger | Stationary eat (hunger recovers) |
| **Socializing** | 🟣 Neon Violet/Purple | Social | Seeks nearest neighbor; freezes to chat when close |
| **Washing** | 🟢 Neon Mint Green | Hygiene | Indoor wash state (hygiene recovers) |

---

## 🏁 Getting Started

### Prerequisites
* **Rust**: `rustup` toolchain with the `wasm32-unknown-unknown` target.
* **wasm-pack**: For compiling the Rust crate to WebAssembly (`cargo install wasm-pack`).
* **NodeJS**: `>=24`
* **pnpm**: `>=11`

### Installation
Clone the repository and install workspace dependencies:
```bash
pnpm install
```
*(This will automatically bind the shared Git hooks to your local setup).*

### Running Locally
To launch the Rust compiler and the Vite dev server concurrently:
```bash
pnpm dev
```
Open **[http://localhost:5173](http://localhost:5173)** in your browser.

---

## 🔒 Git Policy & Hooks
This repository enforces strict commit and security standards:
1. **Secrets Detection**: A pre-commit hook runs `gitleaks` on staged changes to block accidental credential leaks.
2. **Commit Naming (Conventional Commits)**: A commit-msg hook enforces standard Conventional Commits with **mandatory scopes**.
   * *Correct Format*: `feat(web): add vital bars` or `fix(wasm): resolve collision check`
   * *Incorrect Format*: `feat: add vital bars` (rejected due to missing scope) or `fixed things` (rejected)
