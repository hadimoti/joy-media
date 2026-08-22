import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Scene3DDocumentV1 } from '@joy-media/scene3d-core';

export function ThreeDStudioCanvas({
  document,
  selectedObjectId,
  onSelect,
}: {
  readonly document: Scene3DDocumentV1;
  readonly selectedObjectId?: string;
  readonly onSelect: (objectId: string | undefined) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef(selectedObjectId);
  selectedRef.current = selectedObjectId;
  const objectsRef = useRef(new Map<string, THREE.Object3D>());
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(5, 4, 7);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    sceneRef.current = scene;
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(4, 6, 4);
    scene.add(key, new THREE.GridHelper(12, 24, 0x334155, 0x1e293b));
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...objectsRef.current.values()], true)[0];
      const id = hit?.object.userData.sceneObjectId;
      onSelect(typeof id === 'string' ? id : undefined);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
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
      cancelAnimationFrame(frame);
      resize?.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      controls.dispose();
      for (const object of objectsRef.current.values()) disposeObject(object);
      objectsRef.current.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
    };
  }, [onSelect]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null) return;
    for (const object of objectsRef.current.values()) {
      scene.remove(object);
      disposeObject(object);
    }
    objectsRef.current.clear();
    for (const object of Object.values(document.objects)) {
      const mesh =
        object.kind === 'light'
          ? new THREE.Mesh(
              new THREE.SphereGeometry(0.16),
              new THREE.MeshBasicMaterial({ color: 0xffd166 }),
            )
          : object.kind === 'camera'
            ? new THREE.Mesh(
                new THREE.ConeGeometry(0.25, 0.6, 4),
                new THREE.MeshBasicMaterial({ color: 0x8ecae6 }),
              )
            : new THREE.Mesh(
                object.primitive === 'sphere'
                  ? new THREE.SphereGeometry(0.7)
                  : object.primitive === 'plane'
                    ? new THREE.PlaneGeometry(1.4, 1.4)
                    : new THREE.BoxGeometry(1.2, 1.2, 1.2),
                new THREE.MeshStandardMaterial({
                  color:
                    object.id === selectedRef.current
                      ? 0xfbbf24
                      : object.kind === 'model'
                        ? 0x7c3aed
                        : 0x38bdf8,
                  roughness: 0.55,
                  metalness: 0.1,
                }),
              );
      mesh.userData.sceneObjectId = object.id;
      mesh.position.set(
        object.transform.position.x,
        object.transform.position.y,
        object.transform.position.z,
      );
      mesh.rotation.set(
        object.transform.rotation.x,
        object.transform.rotation.y,
        object.transform.rotation.z,
      );
      mesh.scale.set(object.transform.scale.x, object.transform.scale.y, object.transform.scale.z);
      scene.add(mesh);
      objectsRef.current.set(object.id, mesh);
    }
  }, [document, selectedObjectId]);

  return (
    <div
      ref={hostRef}
      className="three-d-studio-canvas"
      aria-label="3D viewport"
      data-selected-object={selectedObjectId ?? ''}
    />
  );
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    for (const material of Array.isArray(child.material) ? child.material : [child.material])
      material.dispose();
  });
}
