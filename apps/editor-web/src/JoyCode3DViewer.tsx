import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BrowserAsset, BrowserControlPlaneClient } from './control-plane-client.js';
import { BrowserControlPlaneClient as ControlPlaneClient } from './control-plane-client.js';
import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';

export const SUPPORTED_3D_MIME_TYPES = ['model/gltf-binary', 'model/gltf+json'] as const;
export type Supported3DMimeType = (typeof SUPPORTED_3D_MIME_TYPES)[number];

export function isSupported3DAsset(asset: Pick<BrowserAsset, 'kind' | 'descriptor'>): boolean {
  return (
    asset.kind === 'model' &&
    (SUPPORTED_3D_MIME_TYPES as readonly string[]).includes(asset.descriptor.mimeType)
  );
}

export function registered3DAssets(assets: readonly BrowserAsset[]): readonly BrowserAsset[] {
  return assets.filter(isSupported3DAsset);
}

export async function resolveRegistered3DAsset(
  asset: BrowserAsset,
  resolve: (asset: BrowserAsset) => Promise<Blob>,
): Promise<Blob> {
  if (!isSupported3DAsset(asset))
    throw new Error('Only registered GLB/GLTF assets can be previewed.');
  const blob = await resolve(asset);
  if (blob.size !== asset.bytes)
    throw new Error('3D asset integrity metadata does not match its bytes.');
  return blob;
}

/** Release GPU-owned geometry/material/texture resources when replacing a model. */
export function disposeThreeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

interface JoyCode3DViewerProps {
  readonly assets?: readonly BrowserAsset[];
  /** Injected in tests/hosts; production uses OPFS first and the authenticated private catalog. */
  readonly resolveAsset?: (asset: BrowserAsset) => Promise<Blob>;
}

interface ViewerResources {
  readonly container: HTMLDivElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly grid: THREE.GridHelper;
}

export function JoyCode3DViewer({ assets = [], resolveAsset }: JoyCode3DViewerProps) {
  const models = useMemo(() => registered3DAssets(assets), [assets]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | undefined>(models[0]?.id);
  const [status, setStatus] = useState('Select a registered GLB/GLTF asset');
  const [sceneReady, setSceneReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resourcesRef = useRef<ViewerResources | null>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const animFrameRef = useRef<number | undefined>(undefined);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const loadSeqRef = useRef(0);
  const loadUrlRef = useRef<string | undefined>(undefined);
  const defaultClientRef = useRef<BrowserControlPlaneClient | null>(null);

  useEffect(() => {
    if (selectedAssetId !== undefined && models.some((asset) => asset.id === selectedAssetId))
      return;
    setSelectedAssetId(models[0]?.id);
  }, [models, selectedAssetId]);

  const disposeObject = useCallback(disposeThreeObject, []);

  const clearModel = useCallback(() => {
    const model = modelRef.current;
    if (model === null) return;
    resourcesRef.current?.scene.remove(model);
    disposeObject(model);
    modelRef.current = null;
  }, [disposeObject]);

  const stopAnimation = useCallback(() => {
    if (animFrameRef.current !== undefined) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || resourcesRef.current !== null) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111827);
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(3, 2, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.5, 0);
    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    const directional = new THREE.DirectionalLight(0xffffff, 1.1);
    directional.position.set(5, 8, 5);
    directional.castShadow = true;
    scene.add(ambient, directional);
    const grid = new THREE.GridHelper(10, 20, 0x4b5563, 0x273449);
    scene.add(grid);
    const resources: ViewerResources = { container, scene, camera, renderer, controls, grid };
    resourcesRef.current = resources;

    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const nextWidth = entry.contentRect.width;
              const nextHeight = entry.contentRect.height;
              if (nextWidth <= 0 || nextHeight <= 0) continue;
              camera.aspect = nextWidth / nextHeight;
              camera.updateProjectionMatrix();
              renderer.setSize(nextWidth, nextHeight);
            }
          });
    resizeObserver?.observe(container);
    resizeObserverRef.current = resizeObserver ?? null;
    const onContextLost = (event: Event) => {
      event.preventDefault();
      stopAnimation();
      setStatus('WebGL context lost — waiting for recovery…');
    };
    const onContextRestored = () => {
      setStatus('WebGL context restored — resuming preview…');
      animate();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
    controls.update();
    setSceneReady(true);
    return () => {
      ++loadSeqRef.current;
      if (loadUrlRef.current !== undefined) {
        URL.revokeObjectURL(loadUrlRef.current);
        loadUrlRef.current = undefined;
      }
      clearModel();
      stopAnimation();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      resourcesRef.current = null;
      setSceneReady(false);
    };
  }, [clearModel, stopAnimation]);

  const fallbackResolver = useCallback(async (asset: BrowserAsset): Promise<Blob> => {
    const cache = await openOpfsOriginalAssetCache();
    const local = await cache.get(asset.id);
    if (local !== undefined) return local;
    if (defaultClientRef.current === null) defaultClientRef.current = new ControlPlaneClient();
    return defaultClientRef.current.sharedCloudOriginalBytes(asset.id);
  }, []);

  useEffect(() => {
    if (!sceneReady || selectedAssetId === undefined) return;
    const asset = models.find((candidate) => candidate.id === selectedAssetId);
    if (asset === undefined) return;
    const requestId = ++loadSeqRef.current;
    const loader = new GLTFLoader();
    clearModel();
    setStatus(`Loading ${asset.displayName}…`);
    void resolveRegistered3DAsset(asset, resolveAsset ?? fallbackResolver)
      .then((blob) => {
        if (requestId !== loadSeqRef.current) return;
        const url = URL.createObjectURL(blob);
        loadUrlRef.current = url;
        loader.load(
          url,
          (gltf) => {
            URL.revokeObjectURL(url);
            if (loadUrlRef.current === url) loadUrlRef.current = undefined;
            if (requestId !== loadSeqRef.current) {
              disposeObject(gltf.scene);
              return;
            }
            const model = gltf.scene;
            model.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });
            const bounds = new THREE.Box3().setFromObject(model);
            const size = bounds.getSize(new THREE.Vector3());
            const center = bounds.getCenter(new THREE.Vector3());
            const maxDimension = Math.max(size.x, size.y, size.z, 1);
            const scale = 3 / maxDimension;
            model.scale.setScalar(scale);
            model.position.sub(center.multiplyScalar(scale));
            model.position.y += size.y * scale * 0.5;
            resourcesRef.current?.scene.add(model);
            modelRef.current = model;
            setStatus(`Loaded ${asset.displayName}`);
          },
          (progress) => {
            if (requestId !== loadSeqRef.current) return;
            const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
            setStatus(`Loading ${asset.displayName}… ${Math.round(ratio * 100)}%`);
          },
          (error: unknown) => {
            URL.revokeObjectURL(url);
            if (loadUrlRef.current === url) loadUrlRef.current = undefined;
            if (requestId === loadSeqRef.current)
              setStatus(
                `Unable to preview ${asset.displayName}: ${error instanceof Error ? error.message : 'invalid GLB/GLTF'}`,
              );
          },
        );
      })
      .catch((error: unknown) => {
        if (requestId === loadSeqRef.current)
          setStatus(
            `Unable to load ${asset.displayName}: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return () => {
      if (requestId !== loadSeqRef.current) return;
      ++loadSeqRef.current;
      if (loadUrlRef.current !== undefined) {
        URL.revokeObjectURL(loadUrlRef.current);
        loadUrlRef.current = undefined;
      }
    };
  }, [
    clearModel,
    disposeObject,
    fallbackResolver,
    models,
    resolveAsset,
    sceneReady,
    selectedAssetId,
  ]);

  if (models.length === 0) {
    return (
      <div className="joy-code-3d joy-code-3d--empty" role="status">
        <strong>No registered 3D assets</strong>
        <span>Import a GLB or GLTF through Assets first, then open this preview.</span>
      </div>
    );
  }

  return (
    <div
      className="joy-code-3d"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--joy-border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span>3D asset</span>
          <select
            aria-label="Registered 3D asset"
            value={selectedAssetId ?? ''}
            onChange={(event) => setSelectedAssetId(event.target.value || undefined)}
          >
            {models.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.displayName}
              </option>
            ))}
          </select>
        </label>
        <span
          style={{ display: 'block', marginTop: 6, fontSize: 12, color: 'var(--joy-text-muted)' }}
        >
          {status}
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, cursor: 'grab' }} />
    </div>
  );
}
