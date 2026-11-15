// Dusk-industrial foundry yard: warm sand/concrete/rust under an amber accent, cool blue defenders vs ember-red attackers, green site markers.
export const PALETTE = {
  canvas: '#14161a',
  surface: '#1e2228',
  hairline: '#2c323a',
  ink: '#e9e6df',
  muted: '#98a0a8',
  accent: '#f0a830',
  sand: '#b99b6b',
  concrete: '#7d838c',
  rust: '#9a5a34',
  ct: '#3f8cff',
  t: '#e0533d',
  site: '#58b368',
  danger: '#d43d2a',
};

export function shade(name) {
  return PALETTE[name];
}
