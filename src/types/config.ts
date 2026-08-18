// ─── Tipos de Configuración ────────────────────────────────────────
// Centraliza todos los parámetros configurables del proyecto.
// Ninguna lógica de negocio va aquí — solo valores por defecto y esquemas.

// ─── Escena ────────────────────────────────────────────────────────

export interface CameraConfig {
  /** Posición inicial en coordenadas mundo */
  position: [x: number, y: number, z: number];
  /** Punto al que mira la cámara */
  target: [x: number, y: number, z: number];
  /** Campo de visión vertical en grados */
  fov: number;
  /** Plano cercano de recorte */
  near: number;
  /** Plano lejano de recorte */
  far: number;
  /** Distancia mínima de zoom (orbital) */
  minDistance: number;
  /** Distancia máxima de zoom (orbital) */
  maxDistance: number;
  /** Ángulo polar mínimo en radianes (evita ir bajo el suelo) */
  minPolarAngle: number;
  /** Ángulo polar máximo en radianes */
  maxPolarAngle: number;
  /** Sensibilidad de rotación */
  rotateSpeed: number;
  /** Sensibilidad de zoom */
  zoomSpeed: number;
  /** Amortiguación (damping) para movimiento suave */
  dampingFactor: number;
}

export interface GroundGridConfig {
  /** Tamaño total del grid en unidades */
  size: number;
  /** Cantidad de divisiones */
  divisions: number;
  /** Color de la línea central */
  centerColor: number;
  /** Color de las líneas de la cuadrícula */
  gridColor: number;
}

export interface LightingConfig {
  /** Luz ambiental — iluminación base uniforme */
  ambient: {
    color: number;
    intensity: number;
  };
  /** Luz direccional principal (simula sol/techo) */
  directional: {
    color: number;
    intensity: number;
    position: [x: number, y: number, z: number];
    /** Proyecta sombras */
    castShadow: boolean;
    /** Resolución del shadow map */
    shadowMapSize: 512 | 1024 | 2048 | 4096;
  };
  /** Luces puntuales para acentos (ej. zonas de trabajo) */
  pointLights: Array<{
    color: number;
    intensity: number;
    position: [x: number, y: number, z: number];
    distance: number;
    decay: number;
  }>;
}

export interface SceneConfig {
  camera: CameraConfig;
  groundGrid: GroundGridConfig;
  lighting: LightingConfig;
  /** Color de fondo de la escena */
  backgroundColor: number;
  /** Modo de antialiasing */
  antialias: boolean;
  /** Factor de pixel ratio máximo (limita en pantallas retina) */
  maxPixelRatio: number;
}

// ─── Layout de Fábrica ─────────────────────────────────────────────

/** Posicionamiento de una entidad en el mundo */
export interface EntityPlacement {
  /** Identificador único */
  id: string;
  /** Tipo de equipo (clave del catálogo) */
  equipmentType: 'conveyor-belt' | 'robot-arm' | 'storage-tank' | 'machine-node';
  /** Posición en coordenadas mundo */
  position: [x: number, y: number, z: number];
  /** Rotación en radianes [x, y, z] */
  rotation: [x: number, y: number, z: number];
  /** Escala uniforme */
  scale: number;
  /** Etiqueta descriptiva para UI */
  label: string;
  /** Referencia a un blueprint/GLTF (opcional, para modelos externos) */
  modelPath?: string;
  /** Configuración específica del tipo */
  params: Record<string, number | string | boolean>;
}

export interface FactoryLayout {
  /** Nombre de la fábrica/línea */
  name: string;
  /** Lista de equipos en escena */
  equipment: EntityPlacement[];
}

// ─── Tema Visual ───────────────────────────────────────────────────

/** Mapa de colores según estado de equipo */
export type StatusColorMap = Record<
  string, // clave del estado: 'running' | 'idle' | 'error' | 'maintenance' | 'offline'
  {
    /** Color primario del estado (emisión/base) */
    primary: number;
    /** Color secundario (borde/outline) */
    secondary: number;
    /** Multiplicador de emisión (glow) */
    emissiveIntensity: number;
  }
>;

export interface ThemeConfig {
  /** Colores por estado de equipo */
  statusColors: StatusColorMap;
  /** Color de selección / highlight */
  selectionColor: number;
  /** Duración por defecto de animaciones en segundos */
  animationDuration: number;
  /** Función de easing por defecto (GSAP) */
  easing: string;
}

// ─── Simulación de Datos ───────────────────────────────────────────

export interface DataSimulationConfig {
  /** Intervalo de emisión en milisegundos */
  emitIntervalMs: number;
  /** Si es true, los datos varían en el tiempo; si no, son estáticos */
  dynamicMode: boolean;
  /** Semilla para reproducibilidad (opcional) */
  seed?: number;
}

// ─── Tipos de utilidad ─────────────────────────────────────────────

/** Valores por defecto tipados para scrapers de configuración */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
