import { useCallback, useEffect, useState } from 'react';

// Per-browser preferences. Nothing here is secret; the API token lives only in the local server.
export type Image = 'standard' | 'vllm' | 'custom';
export type Theme = 'system' | 'light' | 'dark';
export type Prefs = {
  gpus: number; // default GPU count
  image: Image;
  customURL: string;
  notify: boolean; // desktop notification when a machine is ready
  sound: boolean; // soft key clicks and a chime when a machine is ready
  theme: Theme;
};

const KEY = 'hotaisle-ui:prefs';
const DEFAULTS: Prefs = { gpus: 1, image: 'standard', customURL: '', notify: false, sound: true, theme: 'system' };

function read(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

const listeners = new Set<(p: Prefs) => void>();
let current = read();

export const getPrefs = () => current;

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: keep it for this session */
  }
  listeners.forEach((l) => l(current));
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    return () => void listeners.delete(setP);
  }, []);
  return [p, useCallback(setPrefs, [])];
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
}

export const VLLM_URL = 'https://raw.githubusercontent.com/hotaisle/cloud-init-templates/master/vllm-docker.yaml';
export const IMAGES: Record<Image, { name: string; note: string }> = {
  standard: { name: 'Standard image', note: "Hot Aisle's default VM. Ready as soon as it boots." },
  vllm: { name: 'vLLM server', note: "Hot Aisle's cloud-init template starts vLLM in Docker. Takes a few extra minutes." },
  custom: { name: 'My cloud-init', note: 'Runs your user-data file on first boot. Takes a few extra minutes.' },
};

