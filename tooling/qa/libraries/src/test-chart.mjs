/**
 * Known 4-quadrant test chart painter rendered into a browser <canvas>
 * (1920x1080 or scaled proportionally):
 *   - Top-left: Macbeth-inspired colour patches + skin tones + neutral gray ramp
 *   - Top-right: Continuous HSV rainbow + luminance spectrum gradient
 *   - Bottom-left: High-frequency fine lines (1px/2px grid + radial Siemens star)
 *   - Bottom-right: Detailed shaded portrait face (or real photo when provided)
 */
export function paintKnownTestChart(ctx, width, height, faceImage) {
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);

  ctx.save();
  ctx.fillStyle = '#14171c';
  ctx.fillRect(0, 0, width, height);

  drawColorPatchesQuadrant(ctx, 0, 0, halfW, halfH);
  drawGradientQuadrant(ctx, halfW, 0, width - halfW, halfH);
  drawFineLinesQuadrant(ctx, 0, halfH, halfW, height - halfH);
  drawFaceQuadrant(ctx, halfW, halfH, width - halfW, height - halfH, faceImage);

  // Crisp 2px quadrant dividers
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, Math.round(width / 960));
  ctx.beginPath();
  ctx.moveTo(halfW, 0);
  ctx.lineTo(halfW, height);
  ctx.moveTo(0, halfH);
  ctx.lineTo(width, halfH);
  ctx.stroke();

  ctx.restore();
}

const PATCH_COLORS = [
  '#735244',
  '#c29682',
  '#627a9d',
  '#576c43',
  '#8580b1',
  '#67bdaa',
  '#d67e2c',
  '#505ba6',
  '#c15a63',
  '#5e3c6c',
  '#9dbc40',
  '#e0a32e',
  '#383d96',
  '#469449',
  '#af363c',
  '#e7c71f',
  '#bb5695',
  '#0885a1',
  '#f3f3f2',
  '#c8c8c8',
  '#a0a0a0',
  '#7a7a79',
  '#555555',
  '#202020',
];

function drawColorPatchesQuadrant(ctx, qx, qy, qw, qh) {
  ctx.fillStyle = '#1b1d22';
  ctx.fillRect(qx, qy, qw, qh);

  const cols = 6;
  const rows = 4;
  const padX = Math.round(qw * 0.06);
  const padY = Math.round(qh * 0.08);
  const gap = Math.max(4, Math.round(qw * 0.015));
  const cellW = Math.floor((qw - padX * 2 - gap * (cols - 1)) / cols);
  const cellH = Math.floor((qh - padY * 2 - gap * (rows - 1)) / rows);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const color = PATCH_COLORS[row * cols + col];
      const x = qx + padX + col * (cellW + gap);
      const y = qy + padY + row * (cellH + gap);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, cellW, cellH);
    }
  }
}

function drawGradientQuadrant(ctx, qx, qy, qw, qh) {
  // Top 65%: Horizontal vivid rainbow hue sweep
  const rainbowH = Math.floor(qh * 0.65);
  const hueGrad = ctx.createLinearGradient(qx, qy, qx + qw, qy);
  const stops = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'];
  stops.forEach((hex, idx) => hueGrad.addColorStop(idx / (stops.length - 1), hex));
  ctx.fillStyle = hueGrad;
  ctx.fillRect(qx, qy, qw, rainbowH);

  // Vertical lightness overlay from bright top to deep shadow at bottom of rainbow band
  const valGrad = ctx.createLinearGradient(qx, qy, qx, qy + rainbowH);
  valGrad.addColorStop(0, 'rgba(255,255,255,0.55)');
  valGrad.addColorStop(0.45, 'rgba(255,255,255,0)');
  valGrad.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = valGrad;
  ctx.fillRect(qx, qy, qw, rainbowH);

  // Bottom 35%: Smooth black -> warm skin -> white luminance ramp + radial glow spot
  const lumaGrad = ctx.createLinearGradient(qx, qy, qx + qw, qy);
  lumaGrad.addColorStop(0, '#050505');
  lumaGrad.addColorStop(0.5, '#808080');
  lumaGrad.addColorStop(1, '#ffffff');
  ctx.fillStyle = lumaGrad;
  ctx.fillRect(qx, qy + rainbowH, qw, qh - rainbowH);
}

function drawFineLinesQuadrant(ctx, qx, qy, qw, qh) {
  ctx.fillStyle = '#0e1116';
  ctx.fillRect(qx, qy, qw, qh);

  // Left half: dense 1px/2px vertical & horizontal resolution bars
  const half = Math.floor(qw * 0.5);
  ctx.fillStyle = '#f2f5f9';
  for (let x = 8; x < half - 8; x += 4) {
    ctx.fillRect(qx + x, qy + 12, 1, Math.floor(qh * 0.44));
  }
  for (let y = Math.floor(qh * 0.52); y < qh - 12; y += 4) {
    ctx.fillRect(qx + 8, qy + y, half - 16, 1);
  }

  // Diagonal hatch pattern + concentric resolution target on right half
  const cx = qx + Math.floor(qw * 0.75);
  const cy = qy + Math.floor(qh * 0.5);
  const radius = Math.min(qw * 0.22, qh * 0.42);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  const spokes = 48;
  for (let i = 0; i < spokes; i += 1) {
    const a0 = (i * Math.PI * 2) / spokes;
    const a1 = ((i + 0.5) * Math.PI * 2) / spokes;
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#182230';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Sharp text line for edge/unsharp verification
  ctx.strokeStyle = '#ffbe3d';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(qx + 10, qy + 10, qw - 20, qh - 20);
}

function drawFaceQuadrant(ctx, qx, qy, qw, qh, faceImage) {
  if (faceImage) {
    // Cover-fit supplied portrait image into bottom-right quadrant
    const scale = Math.max(qw / faceImage.width, qh / faceImage.height);
    const dw = faceImage.width * scale;
    const dh = faceImage.height * scale;
    const dx = qx + (qw - dw) / 2;
    const dy = qy + (qh - dh) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(qx, qy, qw, qh);
    ctx.clip();
    ctx.drawImage(faceImage, dx, dy, dw, dh);
    ctx.restore();
    return;
  }

  // Fallback high-detail shaded studio portrait with realistic skin tones, eyes, hair, and backdrop
  const bg = ctx.createLinearGradient(qx, qy, qx + qw, qy + qh);
  bg.addColorStop(0, '#2a394a');
  bg.addColorStop(1, '#121a24');
  ctx.fillStyle = bg;
  ctx.fillRect(qx, qy, qw, qh);

  const cx = qx + qw * 0.5;
  const cy = qy + qh * 0.48;
  const r = Math.min(qw, qh) * 0.34;

  // Shoulders / jacket
  ctx.fillStyle = '#2d455e';
  ctx.beginPath();
  ctx.ellipse(cx, qy + qh * 0.98, r * 1.45, r * 0.9, 0, Math.PI, Math.PI * 2);
  ctx.fill();

  // Neck shadow
  ctx.fillStyle = '#c58b68';
  ctx.fillRect(cx - r * 0.24, cy + r * 0.72, r * 0.48, r * 0.55);

  // Back hair silhouette
  ctx.fillStyle = '#2b1d17';
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.14, r * 0.88, r * 1.05, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head with volumetric 3D skin-tone shading
  const skinGrad = ctx.createRadialGradient(
    cx - r * 0.22,
    cy - r * 0.25,
    r * 0.1,
    cx,
    cy,
    r * 0.95,
  );
  skinGrad.addColorStop(0, '#f4c5a3');
  skinGrad.addColorStop(0.55, '#dfa17a');
  skinGrad.addColorStop(1, '#a96c4d');
  ctx.fillStyle = skinGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.72, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair crown + side wave
  ctx.fillStyle = '#332018';
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.62, r * 0.76, r * 0.44, -0.08, Math.PI, Math.PI * 2);
  ctx.fill();

  // Eyebrows
  ctx.strokeStyle = '#3a241b';
  ctx.lineWidth = Math.max(3, r * 0.055);
  ctx.lineCap = 'round';
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + dir * r * 0.14, cy - r * 0.18);
    ctx.quadraticCurveTo(cx + dir * r * 0.28, cy - r * 0.26, cx + dir * r * 0.42, cy - r * 0.16);
    ctx.stroke();
  }

  // Eyes (sclera, iris, pupil, specular catchlight)
  for (const dir of [-1, 1]) {
    const ex = cx + dir * r * 0.27;
    const ey = cy - r * 0.06;
    ctx.fillStyle = '#fbfaf8';
    ctx.beginPath();
    ctx.ellipse(ex, ey, r * 0.13, r * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#476b56';
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.065, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#111111';
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.032, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex - r * 0.02, ey - r * 0.02, r * 0.015, 0, Math.PI * 2);
    ctx.fill();
  }

  // Cheek warmth
  for (const dir of [-1, 1]) {
    const cheek = ctx.createRadialGradient(
      cx + dir * r * 0.34,
      cy + r * 0.18,
      2,
      cx + dir * r * 0.34,
      cy + r * 0.18,
      r * 0.22,
    );
    cheek.addColorStop(0, 'rgba(218, 95, 88, 0.35)');
    cheek.addColorStop(1, 'rgba(218, 95, 88, 0)');
    ctx.fillStyle = cheek;
    ctx.beginPath();
    ctx.arc(cx + dir * r * 0.34, cy + r * 0.18, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nose bridge + shadow
  ctx.strokeStyle = 'rgba(130, 74, 52, 0.65)';
  ctx.lineWidth = Math.max(2, r * 0.035);
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.06);
  ctx.lineTo(cx - r * 0.04, cy + r * 0.22);
  ctx.quadraticCurveTo(cx, cy + r * 0.26, cx + r * 0.07, cy + r * 0.21);
  ctx.stroke();

  // Mouth / smile
  ctx.fillStyle = '#b95c5a';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.22, cy + r * 0.42);
  ctx.quadraticCurveTo(cx, cy + r * 0.36, cx + r * 0.22, cy + r * 0.42);
  ctx.quadraticCurveTo(cx, cy + r * 0.56, cx - r * 0.22, cy + r * 0.42);
  ctx.fill();
}
