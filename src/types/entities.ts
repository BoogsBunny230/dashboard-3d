// ─── Tipos de Dominio ──────────────────────────────────────────────
// Representan el "qué" del gemelo digital, sin acoplarse a Three.js ni al DOM.
// Cada tipo modela una pieza del sistema industrial real.

// ─── Estados ───────────────────────────────────────────────────────

/** Estados posibles de un equipo industrial */
export const EquipmentStatus = {
  RUNNING: 'running',
  IDLE: 'idle',
  ERROR: 'error',
  MAINTENANCE: 'maintenance',
  OFFLINE: 'offline',
} as const;

export type EquipmentStatusType =
  (typeof EquipmentStatus)[keyof typeof EquipmentStatus];

/** Niveles de severidad para alertas */
export const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
} as const;

export type AlertSeverityType =
  (typeof AlertSeverity)[keyof typeof AlertSeverity];

/** Tipos de sensores disponibles en la planta */
export const SensorType = {
  TEMPERATURE: 'temperature',
  PRESSURE: 'pressure',
  VIBRATION: 'vibration',
  RPM: 'rpm',
  FILL_LEVEL: 'fill_level',
  POWER: 'power',
  FLOW_RATE: 'flow_rate',
  HUMIDITY: 'humidity',
} as const;

export type SensorTypeValue = (typeof SensorType)[keyof typeof SensorType];

/** Tipos de equipo del catálogo */
export const EquipmentType = {
  CONVEYOR_BELT: 'conveyor-belt',
  ROBOT_ARM: 'robot-arm',
  STORAGE_TANK: 'storage-tank',
  MACHINE_NODE: 'machine-node',
} as const;

export type EquipmentTypeValue =
  (typeof EquipmentType)[keyof typeof EquipmentType];

// ─── Entidades ─────────────────────────────────────────────────────

/** Un sensor IoT asociado a un equipo */
export interface Sensor {
  /** Identificador único del sensor */
  id: string;
  /** Tipo de medición */
  type: SensorTypeValue;
  /** Etiqueta descriptiva */
  label: string;
  /** Valor actual de la lectura */
  currentValue: number;
  /** Unidad de medida */
  unit: string;
  /** Umbral inferior (por debajo → warning) */
  minThreshold: number;
  /** Umbral superior (por encima → critical) */
  maxThreshold: number;
  /** Última actualización (timestamp Unix ms) */
  lastUpdated: number;
}

/** Un equipo/activo industrial en la planta */
export interface Equipment {
  /** Identificador único */
  id: string;
  /** Nombre descriptivo */
  name: string;
  /** Tipo de equipo */
  type: EquipmentTypeValue;
  /** Estado operativo actual */
  status: EquipmentStatusType;
  /** Posición en el mundo 3D */
  position: [x: number, y: number, z: number];
  /** Rotación en radianes */
  rotation: [x: number, y: number, z: number];
  /** Factor de escala uniforme */
  scale: number;
  /** Sensores asociados a este equipo */
  sensors: Sensor[];
  /** Metadatos extendidos (ej. marca, modelo, año) */
  metadata: Record<string, string | number>;
}

/** Lectura instantánea de todos los sensores — payload del data:updated */
export interface EquipmentReading {
  /** ID del equipo al que pertenece */
  equipmentId: string;
  /** Valores por sensor en este instante */
  readings: Array<{
    sensorId: string;
    value: number;
  }>;
  /** Timestamp de la lectura (Unix ms) */
  timestamp: number;
}

/** Una alerta generada por el sistema de monitoreo */
export interface Alert {
  /** Identificador único de la alerta */
  id: string;
  /** Severidad */
  severity: AlertSeverityType;
  /** Mensaje descriptivo */
  message: string;
  /** Equipo que originó la alerta */
  equipmentId: string;
  /** Sensor que disparó la alerta (opcional) */
  sensorId?: string;
  /** Timestamp de creación (Unix ms) */
  timestamp: number;
  /** Si fue reconocida por un operador */
  acknowledged: boolean;
}

/** Representa el estado global del gemelo digital */
export interface DigitalTwinState {
  /** Todos los equipos registrados */
  equipment: Equipment[];
  /** Lectura más reciente por equipo */
  latestReadings: Map<string, EquipmentReading>;
  /** Alertas activas (no reconocidas) */
  activeAlerts: Alert[];
  /** Historial de alertas (últimas N) */
  alertHistory: Alert[];
  /** Marca de tiempo de la última actualización */
  lastUpdateTimestamp: number;
}
