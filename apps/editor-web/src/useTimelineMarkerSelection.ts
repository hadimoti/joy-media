/**
 * Marker pin selection for Timeline / Dual Lens Time View.
 * × shows only while selected; clears on outside click or after 5s idle.
 */

import { useCallback, useEffect, useState } from 'react';
import { isEditableTarget } from './keyboard-shortcuts.js';

const REMOVE_AFFORDANCE_MS = 5_000;

export function useTimelineMarkerSelection(
  markers: readonly { readonly id: string }[],
  options: {
    /** When true (clip selection active), drop marker selection. */
    readonly clipSelected?: boolean;
    readonly onRemoveMarker?: (id: string) => void;
  } = {},
) {
  const { clipSelected = false, onRemoveMarker } = options;
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | undefined>(undefined);

  const selectMarker = useCallback((id: string) => {
    setSelectedMarkerId(id);
  }, []);

  const removeMarker = useCallback(
    (id: string) => {
      onRemoveMarker?.(id);
      setSelectedMarkerId(undefined);
    },
    [onRemoveMarker],
  );

  useEffect(() => {
    if (clipSelected) setSelectedMarkerId(undefined);
  }, [clipSelected]);

  useEffect(() => {
    if (
      selectedMarkerId !== undefined &&
      !markers.some((marker) => marker.id === selectedMarkerId)
    ) {
      setSelectedMarkerId(undefined);
    }
  }, [markers, selectedMarkerId]);

  useEffect(() => {
    if (selectedMarkerId === undefined) return;
    const timer = window.setTimeout(() => {
      setSelectedMarkerId(undefined);
    }, REMOVE_AFFORDANCE_MS);
    return () => window.clearTimeout(timer);
  }, [selectedMarkerId]);

  useEffect(() => {
    if (selectedMarkerId === undefined) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        setSelectedMarkerId(undefined);
        return;
      }
      if (target.closest('.timeline-marker.is-selected') !== null) return;
      setSelectedMarkerId(undefined);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [selectedMarkerId]);

  useEffect(() => {
    if (selectedMarkerId === undefined || onRemoveMarker === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault();
      event.stopPropagation();
      onRemoveMarker(selectedMarkerId);
      setSelectedMarkerId(undefined);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [selectedMarkerId, onRemoveMarker]);

  return {
    selectedMarkerId,
    selectMarker,
    removeMarker,
  };
}
