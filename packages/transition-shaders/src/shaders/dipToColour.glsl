// Author: JOY Media contributors
// License: MIT
// Description: Fades the outgoing image to a chosen colour, then into the incoming one
// Adapted from gl-transitions FadeColor.glsl (Author: gre, License: MIT); the colour is three float
// uniforms (0 to 1) because the transition filter feeds float uniforms only.

uniform float colorR; // = 0.9
uniform float colorG; // = 0.4
uniform float colorB; // = 0.2
uniform float colorPhase; // = 0.4

vec4 transition (vec2 uv) {
  vec4 dip = vec4(clamp(vec3(colorR, colorG, colorB), 0.0, 1.0), 1.0);
  return mix(
    mix(dip, getFromColor(uv), smoothstep(1.0 - colorPhase, 0.0, progress)),
    mix(dip, getToColor(uv), smoothstep(colorPhase, 1.0, progress)),
    progress
  );
}