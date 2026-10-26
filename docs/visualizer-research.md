# HOME visualizer — vizz.fm "Mesh Grid" research (2026-10-25)

Target: https://vizz.fm/app/?preset=Y29uZmlnLTE3ODUwMDc2NDY0NzItNDg1
Preset id (base64 of the `preset` param): config-1785007646472-485 = "Mesh Grid Variant #16"
(in the UI it shows as "Mesh Grid Variant #1" — display numbering only).

## Method
Static bundle analysis (REA-style, no runtime execution): all 37 script chunks of the app
page fetched with curl; visualizer registry + hook live in
/_next/static/chunks/9583-0b194b6148e96c8b.js (557 KB, minified).

Reproduce:
    curl -sL -A "Mozilla/5.0" "https://vizz.fm/app/" -o vizz.html
    grep -oE '/_next/static/chunks/[^"]*\.js' vizz.html | sort -u | while read p; do
      curl -s -A "Mozilla/5.0" "https://vizz.fm$p" -o "vizzchunks/$(basename $p)"; done
    grep -l "Mesh Grid" vizzchunks/*          # → 9583-0b194b6148e96c8b.js

## Findings (observations from the bundle)
- Registry: module 57202 — {id:"mesh-grid", name:"Mesh Grid",
  description:"3D grid surface that reacts to audio", renderer:"webgl",
  presetId:"config-1741367309222-608", variants:[... config-1785007646472-485 ...]}.
- Geometry: one PlaneGeometry(w, h, wSegs, hSegs)-style grid; a single shared
  BufferGeometry drives 4 passes: wireframe Mesh, transparent fill Mesh,
  Points dots, additive glow Points (custom vertexShader/fragmentShader pairs).
- Displacement: CPU-side each frame — the drawFrame hook receives
  {dt, dataArray, bufferLength} (analyser bytes, fftSize 16384) and writes
  position + a custom `frequency` attribute, then sets needsUpdate.
  The vertex shader then warps: circleShape/radialMix, spectrumSpiral+spiralTurns,
  meshBend, perlin noise (intensity/scale/speed), flowMix.
- Parameters are themselves audio-modulated via `controlModulations`
  (mode:"audio", source:"flux", e.g. perlinNoiseIntensity amount 2.8).
- Post chain (this preset): effectOrder ["gammaCorrection" hueSpeed .49] plus
  feedback (add blend, decay .52, zoom 1.01); background "starfield".

## Variant #16 parameter dump (verbatim from bundle)
visualizationType:"mesh-grid", backgroundColor:"#000000", fftSize:16384,
enablePostProcessing:true, effectOrder:["gammaCorrection"], cameraRotationY:4e-4,
backgroundType:"starfield", backgroundTwinkleSpeed:1.8, backgroundAudioReactivity:2.4,
backgroundPlasmaScale:3, backgroundPlasmaSpeed:.5, gridColor:"#000000", cellSize:1,
waveHeight:1.1, waveSpeed:.8, colorIntensity:2, dampeningFactor:0, jaggedness:0,
perlinNoiseIntensity:1.35, perlinNoiseSpeed:.93, meshBend:-12, circleShape:true,
radialMix:.25, flowMix:.6, spectrumSpiral:.72, spiralTurns:8, angleHueMix:.3,
fillOpacity:.1, fillReactivity:1, dotSize:1, dotReactivity:1, dotGlow:1,
feedback_enabled:true, feedback_decay:.52, feedback_blendMode:"add", feedback_zoom:1.01,
gammaCorrection_enabled:true, gammaCorrection_hueSpeed:.49, concentricTile_enabled:true,
concentricTile_scaleFactor:1.83, concentricTile_blend:.5, concentricTile_innerRings:0,
controlModulations: perlinNoiseIntensity{mode:audio, source:flux, amount:2.8},
radialMix{mode:audio, source:flux, amount:2.2, invert:true};
cameraState{position:{x:78.14,y:50.52,z:36.86}, target:{x:-0.745,y:-12.28,z:-2.660}}.

## Our port (telemetry, not audio)
speed → traveling crest amplitude + phase; gy → radial ring amplitude/sign
(accel out, brake in); gx → bank; ‖G‖ → perlin breathing + crimson g-hot lerp.
Concepts re-implemented from observation; no code or assets copied from the
proprietary minified bundle. Deliberately omitted: feedback/gammaCorrection post
chain, starfield, spiral/circle warps (GPU budget on the Tesla browser).
