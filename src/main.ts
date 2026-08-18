// ─── Punto de Entrada ───────────────────────────────────────────────
// Orquesta todos los sistemas del Gemelo Digital Industrial 3D.
//
// Arquitectura:
//   EventBus ←→ [Engine, WarehouseGrid, CameraController,
//                DataSimulator, Interaction, UIManager]
//
// Flujo de datos:
//   DataSimulator → warehouse:stock-updated → WarehouseGrid (3D) + UIManager (UI)
//   Interaction  → warehouse:slot-clicked  → CameraController (GSAP) + UIManager (tooltip)
//
// ✨ v2: Tooltip flotante con proyección 3D→2D + Bloom post-processing.
//        Ciclo de simulación: 30 segundos (notificaciones duran ~28s).

import './style.css';
import * as THREE from 'three';
import { EventBus } from './systems/EventBus.ts';
import { Engine } from './core/Engine.ts';
import { CameraController } from './core/CameraController.ts';
import { WarehouseGrid } from './systems/WarehouseGrid.ts';
import { DataSimulator } from './systems/DataSimulator.ts';
import { Interaction } from './systems/Interaction.ts';
import { UIManager } from './ui/UIManager.ts';

// ── Punto de montaje ────────────────────────────────────────────────
const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('No se encontró el elemento #app en el DOM.');
}

// ═════════════════════════════════════════════════════════════════════
// 1. INFRAESTRUCTURA
// ═════════════════════════════════════════════════════════════════════

const eventBus = new EventBus({ debug: false });

// ═════════════════════════════════════════════════════════════════════
// 2. MOTOR 3D + BLOOM
// ═════════════════════════════════════════════════════════════════════

const engine = new Engine(app, eventBus);

// ═════════════════════════════════════════════════════════════════════
// 3. ALMACÉN INDUSTRIAL
// ═════════════════════════════════════════════════════════════════════

const warehouse = new WarehouseGrid({
  aisles: 4,
  positionsPerRow: 8,
  levels: 4,
});
warehouse.addToScene(engine.scene);

console.log(
  `🏭 Almacén: ${warehouse.totalSlots} slots | ` +
  `${warehouse.config.aisles} pasillos × ` +
  `${warehouse.config.positionsPerRow} pos × ` +
  `${warehouse.config.levels} niveles`,
);

// ═════════════════════════════════════════════════════════════════════
// 4. RESOLVER DE POSICIÓN (compartido entre Cámara y UI)
// ═════════════════════════════════════════════════════════════════════

/**
 * Resuelve un instanceIndex a una posición en coordenadas mundo.
 * Usado por CameraController (vuelo GSAP) y UIManager (tooltip 3D→2D).
 */
const resolveSlotWorldPosition = (instanceIndex: number): THREE.Vector3 | null => {
  const matrix = new THREE.Matrix4();
  warehouse.instancedMesh.getMatrixAt(instanceIndex, matrix);
  const position = new THREE.Vector3();
  position.setFromMatrixPosition(matrix);
  position.applyMatrix4(warehouse.instancedMesh.matrixWorld);
  return position;
};

// ═════════════════════════════════════════════════════════════════════
// 5. CÁMARA
// ═════════════════════════════════════════════════════════════════════

const cameraController = new CameraController(
  engine.camera,
  engine.renderer.domElement,
  eventBus,
  {
    resolveSlotPosition: resolveSlotWorldPosition,
  },
);

// ═════════════════════════════════════════════════════════════════════
// 6. INTERACTIVIDAD
// ═════════════════════════════════════════════════════════════════════

const interaction = new Interaction(
  engine.camera,
  engine.renderer.domElement,
  eventBus,
);

interaction.register({
  mesh: warehouse.instancedMesh,
  resolver: (instanceIndex: number) => warehouse.getSlotByIndex(instanceIndex),
  onHover: (instanceIndex: number) => warehouse.setHover(instanceIndex),
  onUnhover: (instanceIndex: number) => warehouse.clearHover(instanceIndex),
  onClickEvent: 'warehouse:slot-clicked',
  onHoverEvent: 'warehouse:slot-hovered',
  onUnhoverEvent: 'warehouse:slot-unhovered',
});

// ═════════════════════════════════════════════════════════════════════
// 7. SIMULADOR DE DATOS (ciclo: 30 segundos)
// ═════════════════════════════════════════════════════════════════════

const slotIds = warehouse.slotData.map((s) => s.id);

const dataSimulator = new DataSimulator(eventBus, slotIds, {
  intervalMs: 30000,
  batchSize: 30,
});

// Conectar datos simulados → renderizado 3D
eventBus.on('warehouse:stock-updated', (updates) => {
  warehouse.batchUpdateSlots(updates);
});

// Conectar filtro de fila UI → almacén 3D
eventBus.on('ui:filter-row', ({ row }) => {
  warehouse.filterByRow(row);
});

console.log(
  `📡 Simulador: ${dataSimulator.isRunning ? 'activo' : 'pausado'} | ` +
  `cada 30s | ` +
  `${30} slots/tick`,
);

// ═════════════════════════════════════════════════════════════════════
// 8. UI DASHBOARD (tooltip flotante)
// ═════════════════════════════════════════════════════════════════════

const uiManager = new UIManager(
  eventBus,
  engine.camera,
  engine.renderer.domElement,
  resolveSlotWorldPosition,
);
uiManager.setTotalSlots(warehouse.totalSlots);

// Cerrar tooltip con tecla Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    eventBus.emit('ui:deselect-entity');
  }
});

// ═════════════════════════════════════════════════════════════════════
// 9. ARRANQUE
// ═════════════════════════════════════════════════════════════════════

engine.start();

eventBus.on('engine:ready', () => {
  console.log('✅ Gemelo Digital 3D operativo.');
  console.log('   🖱️  Arrastra para orbitar | Scroll para zoom');
  console.log('   👆 Click en bloque → vuelo de cámara + tooltip flotante');
  console.log('   📡 Simulador: 30s/ciclo | Bloom LED en alertas');
  console.log('   ⌨️  Escape = cerrar tooltip');
  console.log('   🖱️  Clic en vacío = cerrar tooltip');
});

// ═════════════════════════════════════════════════════════════════════
// 10. DEBUG (solo desarrollo)
// ═════════════════════════════════════════════════════════════════════

if (import.meta.env.DEV) {
  const win = window as unknown as Record<string, unknown>;
  win.__eventBus = eventBus;
  win.__engine = engine;
  win.__warehouse = warehouse;
  win.__cameraController = cameraController;
  win.__dataSimulator = dataSimulator;
  win.__uiManager = uiManager;
  win.__interaction = interaction;
}
