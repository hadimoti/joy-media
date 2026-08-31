import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createThreeDResourceResolver } from './three-d-resource-resolver.js';
import { openThreeDSourceStore, sourceRefDisplayName, type ThreeDSourceStore } from './three-d-source-cache.js';
import type { ThreeDSceneStateV1 } from './three-d-render-layer.js';
import { CubeIcon, UploadIcon } from './icons.js';

export interface JoyCode3DRenderAsset {
  readonly assetId: string;
  readonly displayName: string;
  readonly blob: Blob;
  readonly scene: ThreeDSceneStateV1;
}

/** Dispose a loaded model and every GPU-owned geometry/material/texture once. */
export function disposeThreeDModel(model: THREE.Object3D): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();
  const visited = new Set<object>();
  const disposeTextures = (value: unknown, depth = 0): void => {
    if (depth > 4 || value === null || typeof value !== 'object') return;
    if (value instanceof THREE.Texture) {
      if (!disposedTextures.has(value)) {
        disposedTextures.add(value);
        value.dispose();
      }
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => disposeTextures(entry, depth + 1));
      return;
    }
    Object.values(value as Record<string, unknown>).forEach((entry) =>
      disposeTextures(entry, depth + 1),
    );
  };
  model.traverse((child) => {
    if (
      !(child instanceof THREE.Mesh) &&
      !(child instanceof THREE.Line) &&
      !(child instanceof THREE.Points)
    )
      return;
    const renderable = child as THREE.Mesh | THREE.Line | THREE.Points;
    if (renderable.geometry !== undefined && !disposedGeometries.has(renderable.geometry)) {
      disposedGeometries.add(renderable.geometry);
      renderable.geometry.dispose();
    }
    const materials =
      renderable.material instanceof THREE.Material ? [renderable.material] : renderable.material;
    if (!Array.isArray(materials)) return;
    materials.forEach((material) => {
      if (disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
      disposeTextures(material);
      material.dispose();
    });
  });
}

/** Remove only loaded model roots, preserving scene lights and grid helpers. */
export function clearThreeDModelRoots(
  scene: THREE.Scene,
  dispose: (model: THREE.Object3D) => void = disposeThreeDModel,
): number {
  const toRemove = scene.children.filter(
    (child) => !(child instanceof THREE.Light) && !(child instanceof THREE.GridHelper),
  );
  toRemove.forEach((child) => {
    scene.remove(child);
    dispose(child);
  });
  return toRemove.length;
}

function renderAssetId(): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  return `joycode-3d-${suffix}`;
}

export function JoyCode3DViewer({
  onAddToTimeline,
  savedScene,
  sourceStore,
}: {
  readonly onAddToTimeline?: (asset: JoyCode3DRenderAsset) => Promise<void>;
  readonly savedScene?: ThreeDSceneStateV1;
  readonly sourceStore?: ThreeDSourceStore;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameRef = useRef<number | undefined>(undefined);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const loadSeqRef = useRef(0);
  const contextLostHandlerRef = useRef<((event: Event) => void) | undefined>(undefined);
  const contextRestoredHandlerRef = useRef<(() => void) | undefined>(undefined);
  const resourceResolverRef = useRef<{ readonly revokeAll: () => void } | null>(null);
  const [status, setStatus] = useState('Ready — drag to orbit, scroll to zoom');
  const [fileList, setFileList] = useState<readonly string[]>([]);
  const [sourceRefs, setSourceRefs] = useState<readonly string[]>([]);
  const [currentModelName, setCurrentModelName] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [persistingSources, setPersistingSources] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sceneIdRef = useRef(savedScene?.sceneId ?? `scene-${Date.now().toString(36)}`);

  const disposeModel = useCallback(disposeThreeDModel, []);

  const clearScene = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // Remove only model roots. Traversing and removing every mesh separately
    // can double-dispose child resources and accidentally detach scene helpers.
    clearThreeDModelRoots(scene, disposeModel);
  }, [disposeModel]);

  const initScene = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151515);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, width / Math.max(1, height), 0.1, 1000);
    camera.position.set(3, 2, 5);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.5, 0);
    controls.update();
    controlsRef.current = controls;

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 8, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const grid = new THREE.GridHelper(10, 20, 0x555555, 0x2a2a2a);
    scene.add(grid);

    setStatus('Scene ready — load a GLB/GLTF file to preview');

    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    resizeObserverRef.current = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          camera.aspect = w / Math.max(1, h);
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    resizeObserverRef.current.observe(container);

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (animFrameRef.current !== undefined) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = undefined;
      }
      setStatus('WebGL context lost — attempting recovery...');
    };
    const handleContextRestored = () => {
      setStatus('WebGL context restored — reinitializing...');
      animate();
    };
    contextLostHandlerRef.current = handleContextLost;
    contextRestoredHandlerRef.current = handleContextRestored;
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);
  }, []);

  useEffect(() => {
    initScene();
    return () => {
      if (animFrameRef.current !== undefined) cancelAnimationFrame(animFrameRef.current);
      loadSeqRef.current += 1;
      resourceResolverRef.current?.revokeAll();
      resourceResolverRef.current = null;
      resizeObserverRef.current?.disconnect();
      const canvas = rendererRef.current?.domElement;
      if (canvas && contextLostHandlerRef.current) {
        canvas.removeEventListener('webglcontextlost', contextLostHandlerRef.current);
      }
      if (canvas && contextRestoredHandlerRef.current) {
        canvas.removeEventListener('webglcontextrestored', contextRestoredHandlerRef.current);
      }
      controlsRef.current?.dispose();
      rendererRef.current?.dispose();
      clearScene();
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      rendererRef.current = null;
      contextLostHandlerRef.current = undefined;
      contextRestoredHandlerRef.current = undefined;
    };
  }, [initScene, clearScene]);

  useEffect(() => {
    if (savedScene === undefined) return;
    let cancelled = false;
    void (async () => {
      if (savedScene.sourceRefs.length === 0) {
        setStatus('Saved 3D scene has no local source files — import the GLB/GLTF again to recover it.');
        return;
      }
      const store = sourceStore ?? await openThreeDSourceStore();
      const blobs = await Promise.all(savedScene.sourceRefs.map((ref) => store.get(ref)));
      if (cancelled) return;
      if (blobs.some((blob) => blob === undefined)) {
        setStatus('Saved 3D scene needs its source files — import the GLB/GLTF again to recover it.');
        return;
      }
      const files = blobs.map((blob, index) => new File([blob!], sourceRefDisplayName(savedScene.sourceRefs[index]!), { type: blob!.type || 'application/octet-stream' }));
      const modelFile = files.find((file) => /\.(?:glb|gltf)$/i.test(file.name)) ?? files[0];
      if (modelFile === undefined || sceneRef.current === null || cameraRef.current === null) return;
      try {
        const resources = createThreeDResourceResolver(files);
        const loader = new GLTFLoader();
        loader.manager.setURLModifier(resources.resolve);
        const gltf = await loader.parseAsync(await modelFile.arrayBuffer(), '');
        if (cancelled) return;
        const model = gltf.scene;
        model.userData.joyThreeDModel = true;
        sceneRef.current.add(model);
        model.position.set(...savedScene.model.position);
        model.rotation.set(...savedScene.model.rotation);
        model.scale.set(...savedScene.model.scale);
        cameraRef.current.position.set(...savedScene.camera.position);
        controlsRef.current?.target.set(...savedScene.camera.target);
        controlsRef.current?.update();
        setSourceRefs(savedScene.sourceRefs);
        setFileList(files.map((file) => file.name));
        setCurrentModelName(modelFile.name);
        setStatus(`Restored: ${modelFile.name}`);
        resources.revokeAll();
      } catch (error) {
        setStatus(`Saved 3D scene could not be restored: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [savedScene, sourceStore]);

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      const file = files.find((candidate) => /\.(?:glb|gltf)$/i.test(candidate.name)) ?? files[0];
      if (!file) return;
      const requestId = ++loadSeqRef.current;
      resourceResolverRef.current?.revokeAll();
      const resources = createThreeDResourceResolver(files);
      resourceResolverRef.current = resources;
      setCurrentModelName(undefined);
      setStatus(
        files.length > 1
          ? `Loading ${file.name} with ${files.length - 1} resource file(s)…`
          : `Loading ${file.name}…`,
      );

      const sceneId = sceneIdRef.current;
      setPersistingSources(true);
      void (async () => {
        try {
          const store = sourceStore ?? await openThreeDSourceStore();
          const refs = await store.put(sceneId, files);
          setSourceRefs(refs);
        } catch {
          setSourceRefs([]);
          setStatus('Model loaded for this session only; local source persistence is unavailable.');
        } finally {
          setPersistingSources(false);
        }
      })();

      clearScene();

      const loader = new GLTFLoader();
      loader.manager.setURLModifier(resources.resolve);
      void (async () => {
        try {
          const gltf = await loader.parseAsync(await file.arrayBuffer(), '');
          if (requestId !== loadSeqRef.current) return;
          const model = gltf.scene;
          model.userData.joyThreeDModel = true;
          const box = new THREE.Box3().setFromObject(model);
          if (box.isEmpty()) throw new Error('the model contains no renderable geometry');
          model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z, 1);
          const scale = 3 / maxDim;
          model.scale.setScalar(scale);
          model.position.sub(center.multiplyScalar(scale));
          model.position.y += size.y * scale * 0.5;
          sceneRef.current?.add(model);
          setFileList((prev) => [...prev, file.name]);
          setCurrentModelName(file.name);
          setStatus(`Loaded: ${file.name}`);
        } catch (err: unknown) {
          if (requestId !== loadSeqRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(`Error loading ${file.name}: ${msg}`);
        } finally {
          resources.revokeAll();
          if (resourceResolverRef.current === resources) resourceResolverRef.current = null;
        }
      })();

      event.target.value = '';
    },
    [clearScene],
  );

  const addCurrentView = useCallback(async () => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (
      renderer === null ||
      scene === null ||
      camera === null ||
      currentModelName === undefined ||
      persistingSources ||
      onAddToTimeline === undefined
    ) {
      return;
    }

    setAdding(true);
    try {
      renderer.render(scene, camera);
      const blob = await new Promise<Blob>((resolve, reject) => {
        renderer.domElement.toBlob((value) => {
          if (value === null) reject(new Error('The 3D render could not be captured.'));
          else resolve(value);
        }, 'image/png');
      });
      const baseName = currentModelName.replace(/\.(?:glb|gltf)$/i, '');
      await onAddToTimeline({
        assetId: renderAssetId(),
        displayName: `${baseName} · 3D Render`,
        blob,
        scene: { ...captureSceneState(scene, camera, controlsRef.current, sourceRefs), sceneId: sceneIdRef.current },
      });
      setStatus(`Added ${baseName} to the timeline`);
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAdding(false);
    }
  }, [currentModelName, onAddToTimeline, persistingSources, sourceRefs]);

  return (
    <div className="joy-code-3d">
      <div className="joy-code-3d-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Import 3D model"
          title="Import GLB/GLTF"
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Add current 3D view to timeline"
          title="Add current 3D view to timeline"
          disabled={currentModelName === undefined || onAddToTimeline === undefined || adding || persistingSources}
          onClick={() => void addCurrentView()}
        >
          <CubeIcon />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".glb,.gltf,.bin,image/*"
          multiple
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleFileSelect}
        />
        <span className="joy-code-3d-status">{adding ? 'Adding 3D render…' : status}</span>
      </div>
      <div ref={containerRef} className="joy-code-3d-viewport" />
      {fileList.length > 0 && (
        <div className="joy-code-3d-footer">{fileList.length} model(s) loaded</div>
      )}
    </div>
  );
}

function captureSceneState(
  scene: THREE.Scene,
  camera: THREE.Camera,
  controls: OrbitControls | null,
  sourceRefs: readonly string[],
): ThreeDSceneStateV1 {
  const model = scene.children.find((child) => child.userData.joyThreeDModel === true) ?? scene;
  const position = (value: THREE.Vector3) => [value.x, value.y, value.z] as const;
  const rotation = [model.rotation.x, model.rotation.y, model.rotation.z] as const;
  const materialColors: string[] = [];
  let lightIntensity = 1;
  let lightColor = '#ffffff';
  scene.traverse((child) => {
    if (child instanceof THREE.Light) {
      lightIntensity = child.intensity;
      lightColor = `#${child.color.getHexString()}`;
    }
  });
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if ('color' in material && material.color instanceof THREE.Color)
        materialColors.push(`#${material.color.getHexString()}`);
    }
  });
  return {
    version: 1,
    sceneId: `scene-${Date.now().toString(36)}`,
    sourceRefs: [...sourceRefs],
    camera: { position: position(camera.position), target: position(controls?.target ?? new THREE.Vector3()) },
    model: { position: position(model.position), rotation, scale: position(model.scale) },
    light: { intensity: lightIntensity, color: lightColor },
    material: { colors: materialColors },
  };
}
