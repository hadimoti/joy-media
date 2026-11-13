// Author: JOY Media contributors
// License: MIT
// Description: Fades the outgoing image up to white, then down into the incoming one
// Adapted from gl-transitions FadeColor.glsl (Author: gre, License: MIT); the colour is fixed here
// because the transition filter feeds float uniforms only.

uniform float colorPhase; // = 0.4

vec4 transition (vec2 uv) {
  vec4 dip = vec4(1.0, 1.0, 1.0, 1.0);
  return mix(
    mix(dip, getFromColor(uv), smoothstep(1.0 - colorPhase, 0.0, progress)),
    mix(dip, getToColor(uv), smoothstep(colorPhase, 1.0, progress)),
    progress
  );
}