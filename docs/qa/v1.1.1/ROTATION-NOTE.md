# Release note: rotation is now drawn (v1.1.1, T-M05a)

**What changed.** Every element has had a Rotation value in the Inspector for a
long time, but the picture ignored it: the Monitor and the export always drew
the element straight. From v1.1.1 the rotation is drawn, in the Monitor and in
the export alike, and the Monitor's selection box has a rotate handle.

**What this means for older projects.**

- A project where no element was ever given a rotation (Rotation 0, the
  default) looks and exports exactly as before, frame for frame.
- A project where an element has a Rotation other than 0 saved in it (typed in
  the Inspector, animated with keyframes, set by an expression or a motion
  preset, or inherited from a parent) now shows that element turned by
  that amount, about its centre. Before v1.1.1 the same project showed and
  exported it straight. Re-exporting such a project gives a different video
  from the one exported with an earlier version.
- Nothing is changed in the project file. To get the old look back, set the
  element's Rotation to 0 in the Inspector (or remove its rotation keyframes).
- Flipping an element by dragging a handle past the opposite side is not in
  v1.1.1: the box stops at its smallest size (scale 0.01) instead of flipping.

**Short version for the release notes.** "Rotation now works: an element's
Rotation value is drawn in the Monitor and in exports. Projects that had a
rotation saved but saw no effect will now show it; set Rotation to 0 to keep
the old look."
