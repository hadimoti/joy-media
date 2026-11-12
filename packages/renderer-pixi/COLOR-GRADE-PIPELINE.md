# Color grade operation order

The preview and export color grade should use this same order:

1. Read the input RGB sample and preserve its alpha.
2. Apply exposure, then white balance (temperature and tint).
3. Apply lift, gamma, gain and offset, including each wheel's red, green, blue and master controls.
4. Apply contrast around the selected pivot, then shadows, highlights, blacks and whites.
5. Apply the RGB curve, followed by the red, green and blue curves. Curves are sampled from a 256-entry, shape-preserving monotone spline lookup table.
6. Apply the eight circular HSL bands using their centre, width and softness, then apply each band's hue shift, saturation and luminance.
7. Apply global saturation, vibrance and hue.
8. Mix the selected built-in look or custom 3D LUT by its intensity.
9. Apply soft clip and, when enabled, legal-range clipping.

Identity grades are detected before filter creation and before CPU pixel iteration.
