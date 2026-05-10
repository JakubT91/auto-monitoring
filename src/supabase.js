import { createClient } from '@supabase/supabase-js';

// Konfigurace z env proměnných (Vite je natáhne při buildu)
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseEnabled = !!(url && key);

export const supabase = supabaseEnabled
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// Storage wrapper s tříúrovňovým fallback:
//  1. Supabase (autentizovaný uživatel) → cloud sync mezi zařízeními
//  2. localStorage → lokální fallback (nepřihlášený uživatel nebo Supabase nedostupné)
//  3. window.storage → kompatibilita s Anthropic artefakty
export const storage = {
  async get(key) {
    if (supabaseEnabled) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data } = await supabase
            .from('user_data')
            .select('value')
            .eq('user_id', user.id)
            .eq('key', key)
            .maybeSingle();
          if (data) return { key, value: JSON.stringify(data.value) };
          return null;
        }
      } catch (e) { /* fallback */ }
    }
    if (typeof window !== 'undefined' && window.storage?.get) {
      try { return await window.storage.get(key); } catch (e) { /* fall through */ }
    }
    try {
      const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      return v != null ? { key, value: v } : null;
    } catch (e) { return null; }
  },

  async set(key, value) {
    if (supabaseEnabled) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          let parsed;
          try { parsed = JSON.parse(value); } catch { parsed = value; }
          await supabase
            .from('user_data')
            .upsert(
              { user_id: user.id, key, value: parsed, updated_at: new Date().toISOString() },
              { onConflict: 'user_id,key' }
            );
          return { key, value };
        }
      } catch (e) { /* fallback */ }
    }
    if (typeof window !== 'undefined' && window.storage?.set) {
      try { return await window.storage.set(key, value); } catch (e) { /* fall through */ }
    }
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
      return { key, value };
    } catch (e) { return null; }
  },
};
