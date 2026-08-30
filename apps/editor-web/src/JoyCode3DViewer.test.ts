import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { clearThreeDModelRoots, disposeThreeDModel } from './JoyCode3DViewer.js';

describe('JoyCode3DViewer resource lifecycle', () => {
  it('disposes shared geometry, material, and textures once', () => {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.MeshBasicMaterial();
    const texture = new THREE.Texture();
    material.map = texture;
    const first = new THREE.Mesh(geometry, material);
    const second = new THREE.Mesh(geometry, material);
    const model = new THREE.Group();
    model.add(first, second);
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const textureDispose = vi.spyOn(texture, 'dispose');

    disposeThreeDModel(model);

    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
  });

  it('disposes line and points renderables', () => {
    const lineGeometry = new THREE.BufferGeometry();
    const pointsGeometry = new THREE.BufferGeometry();
    const lineMaterial = new THREE.LineBasicMaterial();
    const pointsMaterial = new THREE.PointsMaterial();
    const line = new THREE.Line(lineGeometry, lineMaterial);
    const points = new THREE.Points(pointsGeometry, pointsMaterial);
    const model = new THREE.Group();
    model.add(line, points);
    const lineGeometryDispose = vi.spyOn(lineGeometry, 'dispose');
    const pointsGeometryDispose = vi.spyOn(pointsGeometry, 'dispose');
    const lineMaterialDispose = vi.spyOn(lineMaterial, 'dispose');
    const pointsMaterialDispose = vi.spyOn(pointsMaterial, 'dispose');

    disposeThreeDModel(model);

    expect(lineGeometryDispose).toHaveBeenCalledTimes(1);
    expect(pointsGeometryDispose).toHaveBeenCalledTimes(1);
    expect(lineMaterialDispose).toHaveBeenCalledTimes(1);
    expect(pointsMaterialDispose).toHaveBeenCalledTimes(1);
  });

  it('removes loaded roots without detaching scene helpers', () => {
    const scene = new THREE.Scene();
    const model = new THREE.Group();
    const light = new THREE.AmbientLight();
    const grid = new THREE.GridHelper();
    scene.add(model, light, grid);
    const disposed: THREE.Object3D[] = [];

    expect(clearThreeDModelRoots(scene, (root) => disposed.push(root))).toBe(1);
    expect(disposed).toEqual([model]);
    expect(scene.children).toEqual([light, grid]);
  });
});
