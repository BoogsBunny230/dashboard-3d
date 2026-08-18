// ─── Mapa de Eventos Tipados ────────────────────────────────────────
// Define CADA evento que fluye por el EventBus con su payload exacto.
// Esto garantiza que emit('entity:clicked', payload) falle en compilación
// si el payload no coincide con el tipo declarado aquí.

import type {
  Equipment,
  EquipmentReading,
  Alert,
  EquipmentStatusType,
} from './entities.ts';
import type { WarehouseSlotData, WarehouseStockUpdate } from '../systems/WarehouseGrid.ts';

// ─── Catálogo de Eventos ───────────────────────────────────────────

export interface EventMap {
  // ═══ Capa de Datos → Todos ═══
  /** Simulador emitió nuevas lecturas de sensores */
  'data:updated': EquipmentReading[];
  /** Una alerta fue generada */
  'alert:triggered': Alert;
  /** Una alerta fue reconocida por el operador */
  'alert:acknowledged': { alertId: string };
  /** Conectividad con la fuente de datos cambió */
  'data:connection-changed': { connected: boolean };

  // ═══ Capa 3D → UI ═══
  /** Usuario hizo clic en una entidad 3D (equipo) */
  'entity:clicked': { equipment: Equipment };
  /** Usuario hizo hover sobre una entidad 3D */
  'entity:hovered': { equipmentId: string };
  /** El cursor salió de una entidad */
  'entity:unhovered': { equipmentId: string };
  /** El motor 3D terminó de inicializarse */
  'engine:ready': void;
  /** FPS actual del loop de renderizado */
  'engine:fps': { fps: number };
  /** Una entidad 3D cambió su estado visual */
  'entity:visual-state-changed': {
    equipmentId: string;
    status: EquipmentStatusType;
  };

  // ═══ Almacén 3D → UI ═══
  /** Usuario hizo clic en un slot del almacén */
  'warehouse:slot-clicked': { slot: WarehouseSlotData };
  /** Usuario hizo hover sobre un slot del almacén */
  'warehouse:slot-hovered': { slotId: string };
  /** El cursor salió de un slot del almacén */
  'warehouse:slot-unhovered': { slotId: string };
  /** Simulador actualizó stock de slots del almacén */
  'warehouse:stock-updated': WarehouseStockUpdate[];

  // ═══ UI → Capa 3D ═══
  /** Operador seleccionó un equipo desde la UI */
  'ui:select-entity': { equipmentId: string };
  /** Operador canceló la selección */
  'ui:deselect-entity': void;
  /** Operador quiere centrar la cámara en un equipo */
  'ui:focus-entity': { equipmentId: string };
  /** Operador cambió la velocidad de simulación */
  'ui:time-scale': { scale: number };
  /** Operador pausó/reanudó la simulación */
  'ui:toggle-play': { playing: boolean };
  /** Operador cambió el modo de vista (planta, isométrico, libre) */
  'ui:view-mode': { mode: 'top-down' | 'isometric' | 'free-orbit' };
  /** Operador filtró por fila individual (0-7) o todas */
  'ui:filter-row': { row: number | 'all' };
  /** Operador solicita reiniciar la cámara a la vista global */
  'ui:reset-camera': void;

  // ═══ Control de Simulación ═══
  /** La simulación fue pausada */
  'sim:paused': void;
  /** La simulación fue reanudada */
  'sim:resumed': void;
  /** La velocidad de tiempo cambió */
  'sim:time-scale-changed': { scale: number };
  /** Tick del reloj de simulación (para animaciones sincronizadas) */
  'sim:tick': { deltaTime: number; elapsedTime: number };
}

// ─── Tipos de utilidad para el EventBus ────────────────────────────

/** Nombre válido de un evento */
export type EventName = keyof EventMap;

/** Payload de un evento específico */
export type EventPayload<E extends EventName> = EventMap[E];

/** Tipo de callback listener */
export type EventListener<E extends EventName> = (
  payload: EventPayload<E>,
) => void;

/** ID único para cada listener registrado (permite removerlo después) */
export type ListenerId = string;

/** Entrada en el registro de listeners */
export interface ListenerEntry<E extends EventName = EventName> {
  id: ListenerId;
  event: E;
  callback: EventListener<E>;
  once: boolean;
}
