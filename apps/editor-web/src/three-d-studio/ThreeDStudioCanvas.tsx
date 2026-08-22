import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Scene3DDocumentV1, Scene3DObject } from '@joy-media/scene3d-core';
import type { BrowserAsset } from '../control-plane-client.js';
import { BrowserControlPlaneClient } from '../control-plane-client.js';
import { openOpfsOriginalAssetCache } from '../opfs-original-asset-cache.js';
import {
  disposeThreeObject,
  isSupported3DAsset,
  resolveRegistered3DAsset,
} from '../JoyCode3DViewer.js';

export function ThreeDStudioCanvas({
  document,
  assets = [],
  selectedObjectId,
  onSelect,
  resolveAsset,
}: {
  readonly document: Scene3DDocumentV1;
  readonly assets?: readonly BrowserAsset[];
  readonly selectedObjectId?: string;
  readonly onSelect: (objectId: string | undefined) => void;
  readonly resolveAsset?: (asset: BrowserAsset) => Promise<Blob>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef(selectedObjectId);
  selectedRef.current = selectedObjectId;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const assetKey = assets
    .filter(isSupported3DAsset)
    .map((asset) => `${asset.id}:${asset.sha256}:${asset.bytes}:${asset.descriptor.mimeType}`)
    .sort()
    .join('|');
  const objectsRef = useRef(new Map<string, THREE.Group>());
  const modelUrlsRef = useRef(new Set<string>());
  const loadSeqRef = useRef(0);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const clientRef = useRef<BrowserControlPlaneClient | null>(null);
  const [contextStatus, setContextStatus] = useState('');

  const fallbackResolver = useCallback(async (asset: BrowserAsset): Promise<Blob> => {
    const cache = await openOpfsOriginalAssetCache();
    const local = await cache.resolve({
      assetId: asset.id,
      sha256: asset.sha256,
      bytes: asset.bytes,
      mimeType: asset.descriptor.mimeType,
    });
    if (local.state === 'available-local') {
      try {
        return await (await fetch(local.url)).blob();
      } finally {
        local.revoke();
      }
    }
    if (clientRef.current === null) clientRef.current = new BrowserControlPlaneClient();
    return clientRef.current.sharedCloudOriginalBytes(asset.id);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(5, 4, 7);
    sceneRef.current = scene;
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.GridHelper(12, 24, 0x334155, 0x1e293b));
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...objectsRef.current.values()], true)[0];
      let current: THREE.Object3D | null = hit?.object ?? null;
      while (current !== null && typeof current.userData.sceneObjectId !== 'string')
        current = current.parent;
      onSelect(current === null ? undefined : (current.userData.sceneObjectId as string));
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setContextStatus('WebGL context lost — waiting for recovery…');
    };
    const onContextRestored = () => setContextStatus('WebGL context restored');
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            const width = Math.max(1, host.clientWidth);
            const height = Math.max(1, host.clientHeight);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
          });
    resize?.observe(host);
    return () => {
      ++loadSeqRef.current;
      cancelAnimationFrame(frame);
      resize?.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      controls.dispose();
      for (const object of objectsRef.current.values()) disposeThreeObject(object);
      objectsRef.current.clear();
      for (const url of modelUrlsRef.current) URL.revokeObjectURL(url);
      modelUrlsRef.current.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, [onSelect]);

  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (scene === null || camera === null) return;
    const requestId = ++loadSeqRef.current;
    for (const object of objectsRef.current.values()) {
      scene.remove(object);
      disposeThreeObject(object);
    }
    objectsRef.current.clear();
    for (const url of modelUrlsRef.current) URL.revokeObjectURL(url);
    modelUrlsRef.current.clear();
    scene.background = new THREE.Color(document.environment.backgroundColor);
    const activeCamera =
      document.activeCameraId === undefined ? undefined : document.objects[document.activeCameraId];
    if (activeCamera?.camera !== undefined) {
      camera.fov = activeCamera.camera.fieldOfViewDeg;
      camera.near = activeCamera.camera.near;
      camera.far = activeCamera.camera.far;
      camera.position.set(
        activeCamera.transform.position.x,
        activeCamera.transform.position.y,
        activeCamera.transform.position.z,
      );
      camera.rotation.set(
        activeCamera.transform.rotation.x,
        activeCamera.transform.rotation.y,
        activeCamera.transform.rotation.z,
      );
      camera.updateProjectionMatrix();
    }
    const groups = new Map<string, THREE.Group>();
    for (const object of Object.values(document.objects)) {
      const group = new THREE.Group();
      group.userData.sceneObjectId = object.id;
      group.position.set(
        object.transform.position.x,
        object.transform.position.y,
        object.transform.position.z,
      );
      group.rotation.set(
        object.transform.rotation.x,
        object.transform.rotation.y,
        object.transform.rotation.z,
      );
      group.scale.set(object.transform.scale.x, object.transform.scale.y, object.transform.scale.z);
      groups.set(object.id, group);
      objectsRef.current.set(object.id, group);
    }
    for (const object of Object.values(document.objects)) {
      const group = groups.get(object.id)!;
      const parent = object.parentId === undefined ? scene : (groups.get(object.parentId) ?? scene);
      parent.add(group);
      addObjectVisual(group, object, selectedRef.current === object.id, document.materials);
      if (object.kind === 'light' && object.light !== undefined) addSceneLight(group, object);
      if (object.kind === 'model' && object.assetId !== undefined) {
        const asset = assetsRef.current.find(
          (candidate) => candidate.id === object.assetId && isSupported3DAsset(candidate),
        );
        if (asset !== undefined) {
          void resolveRegistered3DAsset(asset, resolveAsset ?? fallbackResolver)
            .then((blob) => {
              if (requestId !== loadSeqRef.current) return;
              const url = URL.createObjectURL(blob);
              modelUrlsRef.current.add(url);
              new GLTFLoader().load(
                url,
                (gltf) => {
                  URL.revokeObjectURL(url);
                  modelUrlsRef.current.delete(url);
                  if (requestId !== loadSeqRef.current) {
                    disposeThreeObject(gltf.scene);
                    return;
                  }
                  while (group.children.length > 0) {
                    const child = group.children[0]!;
                    group.remove(child);
                    disposeThreeObject(child);
                  }
                  fitModelToViewport(gltf.scene);
                  applySceneMaterial(
                    gltf.scene,
                    object.materialId === undefined
                      ? undefined
                      : document.materials[object.materialId],
                  );
                  group.add(gltf.scene);
                },
                undefined,
                (error: unknown) => {
                  URL.revokeObjectURL(url);
                  modelUrlsRef.current.delete(url);
                  if (requestId === loadSeqRef.current)
                    setContextStatus(
                      `Unable to load ${object.name}: ${error instanceof Error ? error.message : 'invalid GLB/GLTF'}`,
                    );
                },
              );
            })
            .catch((error: unknown) => {
              if (requestId === loadSeqRef.current)
                setContextStatus(
                  `Unable to load ${object.name}: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }
      }
    }
    const previousAmbient = scene.getObjectByName('__scene_environment_ambient');
    if (previousAmbient !== undefined) {
      scene.remove(previousAmbient);
      disposeThreeObject(previousAmbient);
    }
    const ambient = new THREE.AmbientLight(0xffffff, document.environment.ambientIntensity);
    ambient.name = '__scene_environment_ambient';
    scene.add(ambient);
    return () => {
      ++loadSeqRef.current;
    };
  }, [assetKey, document, fallbackResolver, resolveAsset]);

  useEffect(() => {
    for (const [objectId, group] of objectsRef.current) {
      const selected = objectId === selectedObjectId;
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (!(
            material instanceof THREE.MeshStandardMaterial ||
            material instanceof THREE.MeshBasicMaterial
          ))
            continue;
          const baseColor =
            typeof material.userData.joyBaseColor === 'string'
              ? material.userData.joyBaseColor
              : '#38bdf8';
          material.color.set(selected ? 0xfbbf24 : baseColor);
        }
      });
    }
  }, [selectedObjectId]);

  return (
    <div
      ref={hostRef}
      className="three-d-studio-canvas"
      aria-label="3D viewport"
      data-selected-object={selectedObjectId ?? ''}
    >
      {contextStatus && (
        <span className="three-d-studio-context-status" role="status">
          {contextStatus}
        </span>
      )}
    </div>
  );
}

function addObjectVisual(
  group: THREE.Group,
  object: Scene3DObject,
  selected: boolean,
  materials: Scene3DDocumentV1['materials'],
): void {
  if (object.kind === 'camera')
    group.add(
      new THREE.Mesh(
        new THREE.ConeGeometry(0.25, 0.6, 4),
        new THREE.MeshBasicMaterial({ color: selected ? 0xfbbf24 : 0x8ecae6 }),
      ),
    );
  else if (object.kind === 'light')
    group.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(0.16),
        new THREE.MeshBasicMaterial({ color: selected ? 0xfbbf24 : 0xffd166 }),
      ),
    );
  else if (object.kind !== 'model')
    group.add(
      new THREE.Mesh(
        object.primitive === 'sphere'
          ? new THREE.SphereGeometry(0.7)
          : object.primitive === 'plane'
            ? new THREE.PlaneGeometry(1.4, 1.4)
            : new THREE.BoxGeometry(1.2, 1.2, 1.2),
        toThreeMaterial(materials[object.materialId ?? ''], selected),
      ),
    );
}

function addSceneLight(group: THREE.Group, object: Scene3DObject): void {
  const light = object.light!;
  const color = new THREE.Color(light.color);
  const node =
    light.kind === 'ambient'
      ? new THREE.AmbientLight(color, light.intensity)
      : light.kind === 'directional'
        ? new THREE.DirectionalLight(color, light.intensity)
        : light.kind === 'spot'
          ? new THREE.SpotLight(color, light.intensity)
          : new THREE.PointLight(color, light.intensity);
  group.add(node);
}

function toThreeMaterial(
  material: Scene3DDocumentV1['materials'][string] | undefined,
  selected: boolean,
): THREE.MeshStandardMaterial {
  const meshMaterial = new THREE.MeshStandardMaterial({
    color: selected ? 0xfbbf24 : (material?.color ?? '#38bdf8'),
    roughness: material?.roughness ?? 0.55,
    metalness: material?.metalness ?? 0.1,
    ...(material?.opacity === undefined
      ? {}
      : { opacity: material.opacity, transparent: material.opacity < 1 }),
  });
  meshMaterial.userData.joyBaseColor = material?.color ?? '#38bdf8';
  return meshMaterial;
}

function fitModelToViewport(model: THREE.Object3D): void {
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 1);
  const scale = 3 / maxDimension;
  model.scale.setScalar(scale);
  model.position.sub(center.multiplyScalar(scale));
  model.position.y += size.y * scale * 0.5;
}

function applySceneMaterial(
  object: THREE.Object3D,
  material: Scene3DDocumentV1['materials'][string] | undefined,
): void {
  if (material === undefined) return;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const current of materials) {
      if ('color' in current && current.color instanceof THREE.Color)
        current.color.set(material.color);
      if ('roughness' in current && typeof current.roughness === 'number')
        current.roughness = material.roughness;
      if ('metalness' in current && typeof current.metalness === 'number')
        current.metalness = material.metalness;
      current.userData.joyBaseColor = material.color;
    }
  });
}
