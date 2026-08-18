// ─── Motor Three.js ────────────────────────────────────────────────
// Orquesta Scene, Camera, Renderer y el Game Loop.
//
// Responsabilidades:
//   - Crear y configurar el renderizador WebGL con sombras y antialiasing.
//   - Gestionar el ciclo requestAnimationFrame con control de pausa.
//   - Post-procesado: EffectComposer + UnrealBloomPass para glow industrial.
//   - Detectar pérdida de foco / cambio de pestaña para frenar el loop.
//   - Emitir eventos engine:ready y sim:tick vía EventBus.
//   - Reaccionar a resize del viewport para mantener el aspect ratio.
//
// ✨ BLOOM: UnrealBloomPass con threshold alto (0.65) para que solo
//    los slots naranjas/rojos (warning/error) emitan resplandor LED.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { EventBus } from '../systems/EventBus.ts';

// ─── Constantes ─────────────────────────────────────────────────────

/** Relación de aspecto inicial (se recalcula en resize). */
const DEFAULT_ASPECT = 16 / 9;

/** Campo de visión vertical de la cámara en grados. */
const CAMERA_FOV = 50;

/** Planos de recorte de la cámara. */
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 200;

/** Posición inicial de la cámara (vista isométrica elevada del almacén). */
const CAMERA_POSITION: [number, number, number] = [14, 10, 16];

/** Punto de mira inicial (centro del almacén). */
const CAMERA_TARGET: [number, number, number] = [0, 1.2, 0.2];

/** Color de fondo — Slate 900 de Tailwind. */
const BACKGROUND_COLOR = 0x0f172a;

/** Pixel ratio máximo (limita en pantallas retina 3x). */
const MAX_PIXEL_RATIO = 2;

/** Resolución del shadow map. */
const SHADOW_MAP_SIZE = 2048;

/** Intensidad de luz ambiental (evita negros absolutos). */
const AMBIENT_INTENSITY = 0.85;

/** Intensidad de luz direccional. */
const DIRECTIONAL_INTENSITY = 2.2;

/** Posición de la luz direccional (alto y angular). */
const DIRECTIONAL_POSITION: [number, number, number] = [10, 20, 5];

/** Tamaño de la cámara de sombras (área cubierta). */
const SHADOW_CAMERA_SIZE = 20;

// ─── Parámetros de Bloom ────────────────────────────────────────────

/** Luminancia mínima para activar bloom (solo colores brillantes). */
const BLOOM_THRESHOLD = 0.65;

/** Intensidad del resplandor. */
const BLOOM_STRENGTH = 1.2;

/** Radio de dispersión del bloom (más bajo = más tight). */
const BLOOM_RADIUS = 0.4;

// ─── Clase Engine ───────────────────────────────────────────────────

export class Engine {
  // ─── Propiedades públicas (solo lectura) ────────────────────────

  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly clock: THREE.Clock;

  // ─── Propiedades privadas ───────────────────────────────────────

  private readonly eventBus: EventBus;
  private readonly container: HTMLElement;

  /** Post-procesado: EffectComposer con bloom. */
  private composer: EffectComposer;

  private animationFrameId: number | null = null;
  private running = false;
  private elapsedTime = 0;

  /** Plano de suelo para recibir sombras. */
  private groundPlane: THREE.Mesh | null = null;

  /** Observer para cambios de tamaño del contenedor. */
  private resizeObserver: ResizeObserver | null = null;

  /** Handler vinculado al evento visibilitychange. */
  private boundVisibilityHandler: () => void;

  /** Handler vinculado al evento de resize de ventana (fallback). */
  private boundWindowResizeHandler: () => void;

  // ─── Constructor ────────────────────────────────────────────────

  constructor(container: HTMLElement, eventBus: EventBus) {
    this.container = container;
    this.eventBus = eventBus;

    // ── Renderer ──────────────────────────────────────────────────
    this.renderer = this.createRenderer();
    this.container.appendChild(this.renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────────
    this.scene = this.createScene();

    // ── Camera ────────────────────────────────────────────────────
    this.camera = this.createCamera();

    // ── Clock ─────────────────────────────────────────────────────
    this.clock = new THREE.Clock(false);

    // ── Iluminación ───────────────────────────────────────────────
    this.setupLighting();

    // ── Entorno base (suelo, grid) ────────────────────────────────
    this.setupEnvironment();

    // ── Post-procesado (Bloom) ────────────────────────────────────
    this.composer = this.createComposer();

    // ── Resize ────────────────────────────────────────────────────
    this.setupResizeHandling();
    this.boundWindowResizeHandler = this.handleWindowResize.bind(this);

    // ── Visibility ────────────────────────────────────────────────
    this.boundVisibilityHandler = this.handleVisibilityChange.bind(this);
    document.addEventListener(
      'visibilitychange',
      this.boundVisibilityHandler,
    );

    // ── Señal de ready ────────────────────────────────────────────
    this.eventBus.emit('engine:ready');
  }

  // ─── Control del Loop ──────────────────────────────────────────

  /** Inicia el game loop. Idempotente: si ya está corriendo, no hace nada. */
  start(): void {
    if (this.running) return;
    if (this.animationFrameId !== null) return;

    this.running = true;
    this.clock.start();
    this.animationFrameId = requestAnimationFrame(this.loop);
  }

  /** Pausa el game loop y detiene el reloj. */
  pause(): void {
    if (!this.running) return;

    this.running = false;
    this.clock.stop();

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /** Reanuda el game loop tras una pausa. */
  resume(): void {
    if (this.running) return;
    this.start();
  }

  /** Si el loop está corriendo actualmente. */
  get isRunning(): boolean {
    return this.running;
  }

  // ─── Destrucción ───────────────────────────────────────────────

  /**
   * Destruye completamente el motor: detiene el loop, limpia la escena,
   * desmonta listeners y libera el contexto WebGL.
   */
  dispose(): void {
    // Detener loop
    this.pause();

    // Visibility
    document.removeEventListener(
      'visibilitychange',
      this.boundVisibilityHandler,
    );

    // ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Window resize fallback
    window.removeEventListener('resize', this.boundWindowResizeHandler);

    // Limpiar escena
    if (this.groundPlane) {
      this.groundPlane.geometry.dispose();
      (this.groundPlane.material as THREE.Material).dispose();
      this.scene.remove(this.groundPlane);
      this.groundPlane = null;
    }

    // Liberar post-procesado (dispose de los render targets internos)
    this.composer.dispose();

    // Liberar WebGL
    this.renderer.dispose();

    // Desmontar canvas del DOM
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // ─── Construcción Interna ──────────────────────────────────────

  private createRenderer(): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });

    // Pixel ratio limitado para rendimiento en retina
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
    );

    // Tamaño inicial
    const { width, height } = this.getContainerSize();
    renderer.setSize(width, height); // updateStyle=true: canvas CSS = viewport

    // Color de fondo
    renderer.setClearColor(BACKGROUND_COLOR, 1);

    // Shadow map
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Tone mapping para una apariencia más cinematográfica
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    return renderer;
  }

  private createScene(): THREE.Scene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);

    // Fog sutil para profundidad atmosférica
    scene.fog = new THREE.Fog(
      BACKGROUND_COLOR,
      CAMERA_FAR * 0.6,
      CAMERA_FAR * 0.95,
    );

    return scene;
  }

  private createCamera(): THREE.PerspectiveCamera {
    const { width, height } = this.getContainerSize();
    const aspect = height > 0 ? width / height : DEFAULT_ASPECT;

    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      aspect,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    camera.position.set(...CAMERA_POSITION);
    camera.lookAt(...CAMERA_TARGET);

    return camera;
  }

  /** Crea el pipeline de post-procesado: RenderPass → UnrealBloomPass. */
  private createComposer(): EffectComposer {
    const { width, height } = this.getContainerSize();

    const composer = new EffectComposer(this.renderer);

    // Pass 1: renderizado base de la escena
    const renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(renderPass);

    // Pass 2: bloom a MITAD de resolución → reduce carga GPU ~4×
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width * 0.5, height * 0.5),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    composer.addPass(bloomPass);

    return composer;
  }

  private setupLighting(): void {
    // ── Luz ambiental (evita sombras completamente negras) ────────
    const ambient = new THREE.AmbientLight(
      0x334155, // Slate 700 — tinte frío sutil
      AMBIENT_INTENSITY,
    );
    this.scene.add(ambient);

    // ── Luz direccional principal (simula iluminación de techo industrial) ──
    const directional = new THREE.DirectionalLight(
      0xf8fafc, // Slate 50 — luz blanca cálida
      DIRECTIONAL_INTENSITY,
    );
    directional.position.set(...DIRECTIONAL_POSITION);
    directional.castShadow = true;

    // Configuración de sombras
    directional.shadow.mapSize.width = SHADOW_MAP_SIZE;
    directional.shadow.mapSize.height = SHADOW_MAP_SIZE;
    directional.shadow.camera.near = 0.5;
    directional.shadow.camera.far = 60;
    directional.shadow.camera.left = -SHADOW_CAMERA_SIZE;
    directional.shadow.camera.right = SHADOW_CAMERA_SIZE;
    directional.shadow.camera.top = SHADOW_CAMERA_SIZE;
    directional.shadow.camera.bottom = -SHADOW_CAMERA_SIZE;
    directional.shadow.bias = -0.0005;
    directional.shadow.normalBias = 0.02;

    this.scene.add(directional);

    // ── Luz de relleno (reduce contraste extremo en el lado opuesto) ──
    const fill = new THREE.DirectionalLight(
      0x64748b, // Slate 500
      0.6,
    );
    fill.position.set(-5, 3, -5);
    this.scene.add(fill);
  }

  /** Crea el entorno base permanente: suelo y grid de referencia. */
  private setupEnvironment(): void {
    // ── Plano de suelo ────────────────────────────────────────────
    const groundGeometry = new THREE.PlaneGeometry(30, 30);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x1e293b, // Slate 800
      roughness: 0.8,
      metalness: 0.2,
    });
    this.groundPlane = new THREE.Mesh(groundGeometry, groundMaterial);
    this.groundPlane.rotation.x = -Math.PI / 2; // Horizontal
    this.groundPlane.position.y = -0.5;
    this.groundPlane.receiveShadow = true;
    this.scene.add(this.groundPlane);

    // ── Grid helper (referencia visual de escala) ─────────────────
    const grid = new THREE.GridHelper(20, 20, 0x475569, 0x1e293b);
    grid.position.y = -0.49;
    this.scene.add(grid);
  }

  // ─── Resize ────────────────────────────────────────────────────

  private setupResizeHandling(): void {
    // Estrategia principal: ResizeObserver sobre el contenedor.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.handleResize();
      });
      this.resizeObserver.observe(this.container);
    }

    // Fallback: evento resize de ventana para cambios globales.
    window.addEventListener('resize', this.boundWindowResizeHandler, {
      passive: true,
    });
  }

  private handleResize(): void {
    const { width, height } = this.getContainerSize();
    if (width <= 0 || height <= 0) return;

    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private handleWindowResize(): void {
    if (this.resizeObserver) return;
    this.handleResize();
  }

  /** Obtiene el tamaño actual del viewport. */
  private getContainerSize(): { width: number; height: number } {
    // Primario: window.innerWidth/Height (tamaño real del viewport).
    // Fallback: container.clientWidth/Height.
    const width = window.innerWidth || this.container.clientWidth;
    const height = window.innerHeight || this.container.clientHeight;
    return { width, height };
  }

  // ─── Page Visibility ───────────────────────────────────────────

  private handleVisibilityChange(): void {
    if (document.hidden) {
      if (this.running) {
        this.pause();
        this._wasRunningBeforeHidden = true;
      }
    } else if (this._wasRunningBeforeHidden) {
      this._wasRunningBeforeHidden = false;
      this.resume();
    }
  }

  /** Flag para reanudar automáticamente al recuperar visibilidad. */
  private _wasRunningBeforeHidden = false;

  // ─── Game Loop ─────────────────────────────────────────────────

  /**
   * Loop de renderizado principal con post-procesado bloom.
   */
  private readonly loop = (): void => {
    if (!this.running) return;

    this.animationFrameId = requestAnimationFrame(this.loop);

    const rawDelta = this.clock.getDelta();
    const delta = Math.min(rawDelta, 0.1);
    this.elapsedTime += delta;

    // ── Tick de simulación ───────────────────────────────────────
    this.eventBus.emit('sim:tick', {
      deltaTime: delta,
      elapsedTime: this.elapsedTime,
    });

    // ── Render con post-procesado ────────────────────────────────
    this.composer.render();
  };
}
