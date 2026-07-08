/* ─────────────────────────────────────────────────────────────────────────── *
 * App.tsx — Sim Hive root component                                            *
 * ─────────────────────────────────────────────────────────────────────────── */

import { createSignal, onCleanup, type Component } from 'solid-js'
import { simStats, isRunning, isInitializing, setIsInitializing, startSimulation, stopSimulation } from './sim-bridge'
import { dbStatus, snapshotCount, vitalHistory } from './db-bridge'

// ── Constants ────────────────────────────────────────────────────────────────
const AGENT_COUNT = 1024

const ROADMAP = [
  { priority: 'p1', label: 'Wasm memory → PlayCanvas instanced draw', done: true },
  { priority: 'p2', label: 'DuckDB-Wasm + Arrow IPC snapshot', done: true },
  { priority: 'p3', label: 'BehaviorDecisionSystem (FSM)', done: true },
  { priority: 'p4', label: 'Population dashboard (SolidJS)', done: true },
  { priority: 'p5', label: 'Buildings & Destinations (Spatial Zones)', done: false },
  { priority: 'p6', label: 'Agent Inspector (Raycasting & UI)', done: false },
  { priority: 'p7', label: 'Day / Night Cycle (Time-based logic)', done: false },
]

// ── App ───────────────────────────────────────────────────────────────────────
const App: Component = () => {
  let canvasRef!: HTMLCanvasElement

  const [agentInput, setAgentInput] = createSignal(AGENT_COUNT)
  const [wasmError, setWasmError] = createSignal<string | null>(null)

  // ── Wasm lifecycle ─────────────────────────────────────────────────────────
  async function handleStart() {
    try {
      await startSimulation(canvasRef, agentInput())
    } catch (e: any) {
      setIsInitializing(false)
      setWasmError(String(e?.message ?? e))
      console.error('[sim-hive] Wasm init failed:', e)
    }
  }

  function handleStop() {
    stopSimulation()
  }

  onCleanup(() => stopSimulation())

  // ── Derived display helpers ────────────────────────────────────────────────
  const stats = () => simStats()

  return (
    <div class="layout fade-in">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header class="header">
        <div class="header__logo">
          <div class="header__hexagon" aria-hidden="true" />
          <div>
            <div class="header__title">Sim Hive</div>
            <div class="header__subtitle">Population Simulator</div>
          </div>
        </div>

        <div class="header__spacer" />

        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'margin-right': '10px' }}>
          <label style={{ 'font-size': '0.72rem', color: 'var(--text-mid)' }}>
            Agents:
          </label>
          <input
            id="agent-count"
            type="number"
            min={64}
            max={8192}
            step={64}
            value={agentInput()}
            disabled={isRunning() || isInitializing()}
            onInput={(e) => setAgentInput(Number((e.target as HTMLInputElement).value))}
            style={{
              width: '72px',
              background: 'var(--bg-2)',
              border: '1px solid var(--glass-border)',
              'border-radius': 'var(--radius-sm)',
              color: 'var(--text-hi)',
              padding: '4px 8px',
              'font-family': 'var(--font-mono)',
              'font-size': '0.78rem',
            }}
          />

          {!isRunning()
            ? (
              <button id="btn-start" class="btn btn--primary" onClick={handleStart} disabled={isInitializing()} style={{ padding: '5px 12px', 'font-size': '0.75rem' }}>
                {isInitializing() ? '⏳ Init...' : '▶ Start'}
              </button>
            )
            : (
              <button id="btn-stop" class="btn btn--ghost" onClick={handleStop} style={{ padding: '5px 12px', 'font-size': '0.75rem' }}>
                ■ Stop
              </button>
            )
          }
        </div>

        <span class={`chip ${isRunning() ? 'chip--active' : ''}`}>
          <span class="chip__dot" />
          {isRunning() ? 'Simulating' : isInitializing() ? 'Allocating...' : 'Idle'}
        </span>

        <span class="chip">
          <span style={{ color: 'var(--primary)', 'font-size': '0.8em' }}>⬡</span>
          PlayCanvas
        </span>

        <span class="chip">
          <span style={{ color: 'var(--accent)', 'font-size': '0.8em' }}>⚡</span>
          Rust / Wasm
        </span>
      </header>

      {/* ── Canvas ──────────────────────────────────────────────────────── */}
      <main class="canvas-area" id="sim-viewport">
        <canvas
          ref={canvasRef!}
          class="sim-canvas"
          id="sim-canvas"
          aria-label="Simulation viewport"
        />

        {/* Visual overlays */}
        <div class="canvas-grid" aria-hidden="true" />
        <div class="canvas-scanlines" aria-hidden="true" />

        {/* Placeholder shown before sim starts */}
        {!isRunning() && (
          <div class="canvas-placeholder" aria-hidden="true">
            <div class="canvas-placeholder__hex" />
            <span class="canvas-placeholder__text">
              {wasmError()
                ? `⚠ ${wasmError()}`
                : isInitializing()
                  ? 'Allocating Wasm Memory...'
                  : 'Press Start to launch simulation'}
            </span>
          </div>
        )}

      </main>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside class="sidebar" aria-label="Simulation dashboard">

        {/* Live stats */}
        <section class="panel" aria-labelledby="panel-stats-title">
          <div id="panel-stats-title" class="panel__title">Live stats</div>
          <div class="stat-grid">
            <div class="stat-card">
              <div class="stat-card__label">Tick</div>
              <div class="stat-card__value stat-card__value--primary" id="stat-tick">
                {stats().tick.toLocaleString()}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-card__label">FPS</div>
              <div class="stat-card__value stat-card__value--accent" id="stat-fps">
                {stats().fps}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-card__label">Agents</div>
              <div class="stat-card__value" id="stat-agents">
                {stats().agentCount.toLocaleString()}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-card__label">Engine</div>
              <div class="stat-card__value" style={{ 'font-size': '0.72rem', color: 'var(--text-mid)' }}>
                Rust/Wasm
              </div>
            </div>
          </div>
        </section>

        {/* Population vitals */}
        <section class="panel" aria-labelledby="panel-vitals-title">
          <div id="panel-vitals-title" class="panel__title">Population vitals</div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Hunger</span>
              <span id="vital-hunger-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgHunger * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="hunger">
              <div class="vital-bar__fill vital-bar__fill--hunger" style={{ width: `${stats().avgHunger * 100}%` }} />
            </div>
          </div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Energy</span>
              <span id="vital-energy-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgEnergy * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="energy">
              <div class="vital-bar__fill vital-bar__fill--energy" style={{ width: `${stats().avgEnergy * 100}%` }} />
            </div>
          </div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Social</span>
              <span id="vital-social-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgSocial * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="social">
              <div class="vital-bar__fill vital-bar__fill--social" style={{ width: `${stats().avgSocial * 100}%` }} />
            </div>
          </div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Hygiene</span>
              <span id="vital-hygiene-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgHygiene * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="hygiene">
              <div class="vital-bar__fill vital-bar__fill--hygiene" style={{ width: `${stats().avgHygiene * 100}%` }} />
            </div>
          </div>

          <p style={{ 'font-size': '0.62rem', color: 'var(--text-lo)', 'margin-top': '8px' }}>
            Live aggregates via Wasm memory bridge
          </p>
        </section>

        {/* Stack info */}
        <section class="panel" aria-labelledby="panel-stack-title">
          <div id="panel-stack-title" class="panel__title">Tech stack</div>
          {[
            { label: 'Logic',      value: 'Rust → Wasm (wasm-pack)' },
            { label: 'Rendering',  value: 'PlayCanvas WebGPU' },
            { label: 'State',      value: 'DuckDB-Wasm ✓ active' },
            { label: 'UI',         value: 'SolidJS' },
            { label: 'Pattern',    value: 'ECS / Data-Oriented' },
          ].map(row => (
            <div style={{ display: 'flex', 'justify-content': 'space-between', padding: '5px 0', 'border-bottom': '1px solid var(--glass-border)', 'font-size': '0.72rem' }}>
              <span style={{ color: 'var(--text-lo)' }}>{row.label}</span>
              <span style={{ color: 'var(--text-mid)', 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>{row.value}</span>
            </div>
          ))}
        </section>

        {/* DuckDB Analytics */}
        <section class="panel" aria-labelledby="panel-db-title">
          <div id="panel-db-title" class="panel__title">
            DuckDB analytics
            <span style={{
              'margin-left': '8px',
              'font-size': '0.6rem',
              'font-family': 'var(--font-mono)',
              color: dbStatus() === 'ready' ? 'var(--accent)' : dbStatus() === 'error' ? '#f85149' : 'var(--text-lo)',
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}>
              {dbStatus()}
            </span>
          </div>

          <div style={{ display: 'flex', 'justify-content': 'space-between', 'margin-bottom': '8px' }}>
            <span style={{ 'font-size': '0.68rem', color: 'var(--text-lo)' }}>Snapshots ingested</span>
            <span id="db-snapshot-count" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.72rem', color: 'var(--text-mid)' }}>
              {snapshotCount().toLocaleString()}
            </span>
          </div>

          {/* Sparkline chart: hunger + energy over last N snapshots */}
          {vitalHistory().length > 1 && (
            <div style={{ 'margin-top': '6px' }}>
              <div style={{ 'font-size': '0.62rem', color: 'var(--text-lo)', 'margin-bottom': '4px' }}>Population vitals (last {vitalHistory().length} ticks)</div>
              <svg
                id="db-vitals-chart"
                width="100%"
                height="60"
                viewBox={`0 0 ${vitalHistory().length} 60`}
                preserveAspectRatio="none"
                style={{ display: 'block', 'border-radius': '4px', background: 'var(--bg-1)' }}
                aria-label="Historical vitals sparkline"
              >
                {/* Hunger line — orange */}
                <polyline
                  points={vitalHistory().map((r, i) => `${i},${(1 - r.meanHunger) * 58 + 1}`).join(' ')}
                  fill="none"
                  stroke="#f5853d"
                  stroke-width="0.8"
                  stroke-linejoin="round"
                />
                {/* Energy line — cyan */}
                <polyline
                  points={vitalHistory().map((r, i) => `${i},${(1 - r.meanEnergy) * 58 + 1}`).join(' ')}
                  fill="none"
                  stroke="#1a9cff"
                  stroke-width="0.8"
                  stroke-linejoin="round"
                />
              </svg>
              <div style={{ display: 'flex', gap: '10px', 'margin-top': '4px' }}>
                <span style={{ 'font-size': '0.58rem', color: '#f5853d' }}>■ Hunger</span>
                <span style={{ 'font-size': '0.58rem', color: '#1a9cff' }}>■ Energy</span>
              </div>
            </div>
          )}

          {vitalHistory().length <= 1 && dbStatus() === 'ready' && (
            <p style={{ 'font-size': '0.62rem', color: 'var(--text-lo)', 'margin-top': '4px' }}>Waiting for first snapshot…</p>
          )}
          {dbStatus() !== 'ready' && dbStatus() !== 'error' && (
            <p style={{ 'font-size': '0.62rem', color: 'var(--text-lo)', 'margin-top': '4px' }}>Initialises when simulation starts</p>
          )}
        </section>

        {/* Roadmap */}
        <section class="panel" aria-labelledby="panel-roadmap-title">
          <div id="panel-roadmap-title" class="panel__title">Build roadmap</div>
          {ROADMAP.map(item => (
            <div class="roadmap-item">
              <span class={`roadmap-item__badge roadmap-item__badge--${item.priority}`}>
                {item.priority.toUpperCase()}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              <span class={`roadmap-item__status roadmap-item__status--${item.done ? 'done' : 'todo'}`}>
                {item.done ? '✓' : '○'}
              </span>
            </div>
          ))}
        </section>

      </aside>
    </div>
  )
}

export default App
