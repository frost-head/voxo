// Friendly personas for Kokoro's voice ids, so the picker reads "Bella (US) · Warm & conversational" rather than "af_bella".
// The first letter of an id is the language, the second the gender (f/m). Unknown ids fall back to a readable name.

export const PERSONAS = {
  af_heart: { name: 'Heart', accent: 'US', trait: 'Warm & expressive', pick: true },
  af_bella: { name: 'Bella', accent: 'US', trait: 'Warm & conversational' },
  af_nicole: { name: 'Nicole', accent: 'US', trait: 'Soft & intimate' },
  af_sarah: { name: 'Sarah', accent: 'US', trait: 'Clear & friendly' },
  af_sky: { name: 'Sky', accent: 'US', trait: 'Bright & airy' },
  af_kore: { name: 'Kore', accent: 'US', trait: 'Calm & grounded' },
  bf_emma: { name: 'Emma', accent: 'UK', trait: 'Polished & articulate' },
  bf_isabella: { name: 'Isabella', accent: 'UK', trait: 'Gentle & refined' },
  am_adam: { name: 'Adam', accent: 'US', trait: 'Steady & neutral' },
  am_michael: { name: 'Michael', accent: 'US', trait: 'Confident & clear' },
  am_fenrir: { name: 'Fenrir', accent: 'US', trait: 'Deep & authoritative' },
  am_puck: { name: 'Puck', accent: 'US', trait: 'Light & playful' },
  bm_george: { name: 'George', accent: 'UK', trait: 'Classic broadcaster' },
  bm_fable: { name: 'Fable', accent: 'UK', trait: 'Storyteller' },
  ef_dora: { name: 'Dora', accent: 'ES', trait: 'Warm & natural' },
  em_alex: { name: 'Alex', accent: 'ES', trait: 'Easygoing' },
  em_santa: { name: 'Santa', accent: 'ES', trait: 'Deep & calm' },
  ff_siwis: { name: 'Siwis', accent: 'FR', trait: 'Smooth & elegant' },
  hf_alpha: { name: 'Alpha', accent: 'HI', trait: 'Clear & bright' },
  hf_beta: { name: 'Beta', accent: 'HI', trait: 'Soft & warm' },
  hm_omega: { name: 'Omega', accent: 'HI', trait: 'Steady & clear' },
  hm_psi: { name: 'Psi', accent: 'HI', trait: 'Deep & measured' },
  if_sara: { name: 'Sara', accent: 'IT', trait: 'Lively & warm' },
  im_nicola: { name: 'Nicola', accent: 'IT', trait: 'Rich & expressive' },
  pf_dora: { name: 'Dora', accent: 'BR', trait: 'Friendly & natural' },
  pm_alex: { name: 'Alex', accent: 'BR', trait: 'Relaxed & clear' },
  pm_santa: { name: 'Santa', accent: 'BR', trait: 'Deep & calm' },
};

export function persona(voice) {
  const known = PERSONAS[voice.name];
  if (known) return { ...known, gender: voice.name[1] === 'm' ? 'Male' : 'Female' };
  const raw = voice.name.slice(3).replace(/^./, (c) => c.toUpperCase());
  return { name: raw, accent: '', trait: voice.desc || '', gender: voice.name[1] === 'm' ? 'Male' : 'Female' };
}

/** "Bella (US) · Warm & conversational" */
export function personaLabel(voice) {
  const p = persona(voice);
  return `${p.name}${p.accent ? ` (${p.accent})` : ''} · ${p.trait}`;
}
