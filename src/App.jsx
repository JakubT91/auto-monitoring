import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Fuel, Car, Truck, Plus, Minus, Trash2, Users,
  AlertTriangle, RefreshCw, Wrench, Calendar,
  ShieldCheck, BadgeCheck, Receipt, Edit3,
  X, Check, Gauge, MapPin, Coins, Route, Link2,
  Sparkles, ArrowRightLeft,
  Save, BarChart3, Download, Filter, ChevronRight, Inbox, LogOut,
  Settings, Bell, AlertCircle
} from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { supabase, supabaseEnabled, storage } from './supabase.js';

/* ============================================================
   KONSTANTY
============================================================ */

// Bez defaultních vozidel - každý uživatel začíná s prázdným parkem
// a vytváří si vozidla sám přes "Přidat vozidlo" v Kalkulátoru / Vozidlech.
const DEFAULT_VEHICLES = [];

const FALLBACK_EUR_RATE = 24.50;

const DOC_TYPES = [
  { key: 'stk',       label: 'STK',                Icon: Wrench       },
  { key: 'insurance', label: 'Pojištění',          Icon: ShieldCheck  },
  { key: 'vignette',  label: 'Dálniční známka',    Icon: BadgeCheck   },
];

/* Pravidla pro expiraci:
   STK Toyota:        +4 roky
   STK ostatní auta:  +2 roky
   STK vozík:         +4 roky   (uloženo přímo v stkYears)
   Pojištění:         +1 rok    (vše)
   Dálniční známka:   +1 rok                                          */
function yearsFor(vehicle, docType) {
  if (docType === 'stk') return vehicle.stkYears ?? 2;
  return 1; // insurance + vignette
}

function calcExpiration(fromDate, vehicle, docType) {
  if (!fromDate) return null;
  const d = new Date(fromDate);
  if (isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + yearsFor(vehicle, docType));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Vygeneruje unikátní slug-id z názvu vozidla (bez diakritiky, lower-case)
function generateVehicleId(name, existingIds) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[áàâ]/g, 'a').replace(/[éèê]/g, 'e').replace(/[íìî]/g, 'i')
    .replace(/[óòô]/g, 'o').replace(/[úùû]/g, 'u').replace(/[ýỳŷ]/g, 'y')
    .replace(/[čć]/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/[ňń]/g, 'n')
    .replace(/[ř]/g, 'r').replace(/ď/g, 'd').replace(/ť/g, 't').replace(/ľ/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return 'vozidlo-' + Date.now().toString(36);
  let id = base;
  let i = 2;
  while (existingIds.includes(id)) { id = `${base}-${i}`; i++; }
  return id;
}

// Přičte n let k ISO datumu (YYYY-MM-DD), zachová lokální časovou zónu při formátování
function addYearsISO(isoDate, years) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + years);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Vozík nemá dálniční známku
function docsForVehicle(vehicle) {
  if (vehicle.type === 'trailer') return DOC_TYPES.filter((d) => d.key !== 'vignette');
  return DOC_TYPES;
}

/* ============================================================
   FORMÁTOVÁNÍ
============================================================ */

const formatCZK = (value, digits = 0) => {
  if (!isFinite(value)) return '— Kč';
  return new Intl.NumberFormat('cs-CZ', {
    style: 'currency', currency: 'CZK',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const formatNumber = (value, digits = 1) => {
  if (!isFinite(value)) return '—';
  return new Intl.NumberFormat('cs-CZ', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const formatDate = (s) => {
  if (!s) return null;
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
};

// Dnešní datum v lokálním časovém pásmu jako YYYY-MM-DD
const todayISODate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// "Toyota 8.5.2026" – výchozí název cesty z vybraného vozidla a aktuálního datumu
const buildDefaultTripName = (vehicles, vehicleId) => {
  const v = vehicles.find((x) => x.id === vehicleId);
  const d = new Date();
  return `${v?.name || 'Cesta'} ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
};

// Kontrola, zda název vypadá jako výchozí (= "Vozidlo dd.mm.yyyy") –
// pokud ano, můžeme ho při změně vozidla bezpečně přepsat.
const isDefaultLikeTripName = (vehicles, name) => {
  if (!name) return true;
  return vehicles.some(
    (v) => name.startsWith(`${v.name} `) && /\d+\.\d+\.\d+\s*$/.test(name)
  );
};

const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
};

// Spočítá kalendářní rozdíl ve formátu { months, days } mezi dvěma daty.
// Dva roky a tři dny = { months: 24, days: 3 }. Další zaokrouhlování dělají formátovače.
const monthsAndDays = (fromISO, toISO) => {
  const from = new Date(fromISO);
  const to   = new Date(toISO);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  let days   = to.getDate() - from.getDate();

  if (days < 0) {
    months -= 1;
    // počet dnů v předchozím měsíci vůči "to"
    const prevMonthDays = new Date(to.getFullYear(), to.getMonth(), 0).getDate();
    days += prevMonthDays;
  }

  return { months: Math.max(0, months), days: Math.max(0, days) };
};

// Naformátuje "kolik zbývá" – preferuje měsíce a dny, nebo roky a měsíce
const formatRemaining = ({ months, days }) => {
  if (months >= 12) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    return m > 0 ? `${y} r ${m} m` : `${y} r`;
  }
  if (months > 0) {
    return days > 0 ? `${months} m ${days} d` : `${months} m`;
  }
  return `${days} d`;
};

// Status z konkrétního "do" data (počítá tón i lidsky čitelný popisek měsíce/dny)
const statusFromDate = (toDate) => {
  if (!toDate) return { tone: 'gray', label: 'Nenastaveno' };
  const days = daysUntil(toDate);
  if (days === null) return { tone: 'gray', label: 'Nenastaveno' };

  // Tón (barva) – stejné prahy jako dříve
  let tone;
  if (days < 0)       tone = 'red';
  else if (days < 14) tone = 'red';
  else if (days < 30) tone = 'amber';
  else if (days < 60) tone = 'yellow';
  else                tone = 'emerald';

  // Popisek
  let label;
  if (days === 0) {
    label = 'Vyprší dnes';
  } else if (days < 0) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const md = monthsAndDays(toDate, today.toISOString().slice(0, 10));
    label = `Propadlo · ${formatRemaining(md)}`;
  } else {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const md = monthsAndDays(today.toISOString().slice(0, 10), toDate);
    label = `Zbývá ${formatRemaining(md)}`;
  }

  return { tone, label };
};

const toneClasses = {
  red:     { bg: 'bg-red-500/15',     text: 'text-red-400',     dot: 'bg-red-500',     ring: 'ring-red-500/40'    },
  amber:   { bg: 'bg-amber-500/15',   text: 'text-amber-400',   dot: 'bg-amber-500',   ring: 'ring-amber-500/40'  },
  yellow:  { bg: 'bg-yellow-500/15',  text: 'text-yellow-300',  dot: 'bg-yellow-400',  ring: 'ring-yellow-500/40' },
  emerald: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-500', ring: 'ring-emerald-500/40'},
  gray:    { bg: 'bg-stone-700/40',   text: 'text-stone-400',   dot: 'bg-stone-500',   ring: 'ring-stone-600/40'  },
};

/* ============================================================
   NUMERICKÝ INPUT (mobilně přívětivý)
============================================================ */

function NumberField({ value, onChange, placeholder, suffix, prefix, step = 'any', className = '' }) {
  return (
    <div className={`relative flex items-center bg-stone-800/60 border border-stone-700 rounded-xl focus-within:border-amber-500/70 focus-within:ring-2 focus-within:ring-amber-500/20 transition ${className}`}>
      {prefix && (
        <span className="pl-3 text-stone-400 text-sm font-medium select-none">{prefix}</span>
      )}
      <input
        type="number"
        inputMode="decimal"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono w-full bg-transparent px-3 py-3 text-stone-100 text-lg outline-none placeholder:text-stone-600"
      />
      {suffix && (
        <span className="pr-3 text-stone-400 text-sm font-medium select-none whitespace-nowrap">{suffix}</span>
      )}
    </div>
  );
}

/* ============================================================
   SEGMENTOVANÝ PŘEPÍNAČ
============================================================ */

function Segmented({ options, value, onChange, size = 'md' }) {
  const sizeClass = size === 'sm' ? 'text-xs py-1.5 px-2' : 'text-sm py-2 px-3';
  return (
    <div className="inline-flex bg-stone-800/60 border border-stone-700 rounded-xl p-1 gap-1">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`${sizeClass} rounded-lg font-semibold transition-all ${
              active
                ? 'bg-amber-500 text-stone-950 shadow shadow-amber-500/30'
                : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   ROOT — auth gate (Supabase)
============================================================ */

export default function App() {
  // Bez Supabase (např. lokálně bez .env) — pustíme aplikaci přímo, storage si poradí.
  if (!supabaseEnabled) return <CestakApp authUser={null} />;

  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setUser(session?.user || null);
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setUser(session?.user || null);
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, []);

  if (!authReady) return <LoadingScreen />;
  if (!user)      return <AuthScreen />;
  return <CestakApp authUser={user} />;
}

/* ============================================================
   HLAVNÍ APLIKACE
============================================================ */

function CestakApp({ authUser }) {
  const [tab, setTab] = useState('trip');

  /* --- Kurz EUR --- */
  const [eurRate, setEurRate] = useState(FALLBACK_EUR_RATE);
  const [rateMeta, setRateMeta] = useState({ status: 'loading', date: null, manual: false });
  const [showRateEdit, setShowRateEdit] = useState(false);
  const [rateInput, setRateInput] = useState('');

  /* --- Stav cesty --- */
  const [participants, setParticipants] = useState(1);
  const [activeVehicleId, setActiveVehicleId] = useState(null); // null dokud user nepřidá vozidlo
  const [items, setItems] = useState(() => [
    { id: 1, type: 'segment', date: todayISODate(), kmBefore: '', kmAfter: '', litersRefueled: '', fuelPrice: '', currency: 'CZK', fuelType: 'gasoline' }
  ]);
  const [savedTrips, setSavedTrips] = useState([]); // archív uložených cest
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showAddCalcVehicle, setShowAddCalcVehicle] = useState(false);
  const [hydrated, setHydrated] = useState(false); // nahrání z storage proběhlo

  const MAX_ITEMS = 20;

  /* --- Data vozidel (STK / pojištění / známka) --- */
  const [vehiclesData, setVehiclesData] = useState({});
  const [editing, setEditing] = useState(null); // { vehicleId, docType }

  /* --- Vozidla + notifikace (per-user) --- */
  const [vehicles, setVehicles] = useState(DEFAULT_VEHICLES);
  const [notificationSettings, setNotificationSettings] = useState({
    enabled: true,
    email: '', // prázdné = použít přihlašovací e-mail
    daysBefore: [30, 7],
    docTypes: { stk: true, insurance: true, vignette: true },
  });

  const [tripName, setTripName] = useState('');

  /* ----------- Načtení EUR kurzu ČNB ----------- */

  const loadEurRate = useCallback(async (force = false) => {
    setRateMeta((m) => ({ ...m, status: 'loading' }));

    // Cache
    if (!force) {
      try {
        const cached = await storage.get('eur-rate-cache');
        if (cached) {
          const data = JSON.parse(cached.value);
          const age = Date.now() - data.timestamp;
          if (age < 12 * 3600 * 1000) {
            setEurRate(data.rate);
            setRateMeta({ status: data.manual ? 'manual' : 'success', date: data.date, manual: data.manual });
            return;
          }
        }
      } catch (e) { /* žádný cache */ }
    }

    // Fetch ČNB
    try {
      const res = await fetch('https://api.cnb.cz/cnbapi/exrates/daily?lang=EN');
      if (res.ok) {
        const data = await res.json();
        const eur = data.rates?.find((r) => r.currencyCode === 'EUR');
        if (eur && eur.amount) {
          const rate = eur.rate / eur.amount;
          setEurRate(rate);
          setRateMeta({ status: 'success', date: eur.validFor, manual: false });
          try {
            await storage.set('eur-rate-cache', JSON.stringify({
              rate, date: eur.validFor, timestamp: Date.now(), manual: false
            }));
          } catch (e) {}
          return;
        }
      }
      setRateMeta({ status: 'error', date: null, manual: false });
    } catch (e) {
      setRateMeta({ status: 'error', date: null, manual: false });
    }
  }, []);

  useEffect(() => { loadEurRate(); }, [loadEurRate]);

  /* ----------- Načtení dat vozidel + current trip + saved trips ----------- */

  useEffect(() => {
    (async () => {
      try {
        const r = await storage.get('vehicles-data');
        if (r) setVehiclesData(JSON.parse(r.value));
      } catch (e) { /* nic uloženo */ }

      // ADMIN: dynamický seznam vozidel
      try {
        const r = await storage.get('vehicles-list');
        if (r) {
          const arr = JSON.parse(r.value);
          if (Array.isArray(arr) && arr.length > 0) setVehicles(arr);
        }
      } catch (e) { /* default zůstává */ }

      // ADMIN: notifikační nastavení
      try {
        const r = await storage.get('notification-settings');
        if (r) {
          const s = JSON.parse(r.value);
          if (s && typeof s === 'object') {
            setNotificationSettings((prev) => ({ ...prev, ...s }));
          }
        }
      } catch (e) { /* default zůstává */ }

      try {
        const r = await storage.get('current-trip');
        if (r) {
          const data = JSON.parse(r.value);
          if (Array.isArray(data.items) && data.items.length > 0) setItems(data.items);
          if (typeof data.tripName === 'string') setTripName(data.tripName);
          if (typeof data.participants === 'number') setParticipants(data.participants);
          if (typeof data.activeVehicleId === 'string') setActiveVehicleId(data.activeVehicleId);
        }
      } catch (e) { /* nic uloženo */ }

      try {
        const r = await storage.get('saved-trips');
        if (r) {
          const arr = JSON.parse(r.value);
          if (Array.isArray(arr)) setSavedTrips(arr);
        }
      } catch (e) { /* nic uloženo */ }

      setHydrated(true);
    })();
  }, []);

  // Auto-save current trip do storage (po hydrataci)
  useEffect(() => {
    if (!hydrated) return;
    const data = { items, tripName, participants, activeVehicleId };
    storage.set('current-trip', JSON.stringify(data)).catch(() => {});
  }, [items, tripName, participants, activeVehicleId, hydrated]);

  // Auto-save saved trips do storage
  useEffect(() => {
    if (!hydrated) return;
    storage.set('saved-trips', JSON.stringify(savedTrips)).catch(() => {});
  }, [savedTrips, hydrated]);

  // ADMIN: auto-save seznamu vozidel
  useEffect(() => {
    if (!hydrated) return;
    storage.set('vehicles-list', JSON.stringify(vehicles)).catch(() => {});
  }, [vehicles, hydrated]);

  // ADMIN: auto-save notifikačních nastavení
  useEffect(() => {
    if (!hydrated) return;
    storage.set('notification-settings', JSON.stringify(notificationSettings)).catch(() => {});
  }, [notificationSettings, hydrated]);

  const saveVehiclesData = useCallback(async (data) => {
    setVehiclesData(data);
    try {
      await storage.set('vehicles-data', JSON.stringify(data));
    } catch (e) {}
  }, []);

  /* ----------- Přidávání nových vozidel ----------- */

  // Z Kalkulátoru: jméno + počáteční tachometr + palivo.
  // Auto-vytvoří i v Vozidlech s prázdnými termíny (uživatel je vyplní později).
  const addCalcVehicle = ({ name, initialKm, defaultFuel }) => {
    const id = generateVehicleId(name, vehicles.map((v) => v.id));
    const newVeh = {
      id,
      name: name.trim(),
      type: 'car',
      defaultFuel,
      initialKm: parseFloat(initialKm) || 0,
      inCalculator: true,
      hasVignette: true,
      stkYears: 2,
    };
    setVehicles((prev) => [...prev, newVeh]);
    setVehiclesData((prev) => ({ ...prev, [id]: prev[id] || {} }));
    setActiveVehicleId(id);
    return id;
  };

  // Z Vozidel (auto): pouze tracking, počáteční datumy předvyplněné.
  const addTrackingVehicle = ({ name, defaultFuel, hasVignette, stkYears, initialStk, initialInsurance, initialVignette }) => {
    const id = generateVehicleId(name, vehicles.map((v) => v.id));
    const newVeh = {
      id,
      name: name.trim(),
      type: 'car',
      defaultFuel,
      inCalculator: false,
      hasVignette,
      stkYears: parseInt(stkYears, 10),
    };
    setVehicles((prev) => [...prev, newVeh]);
    const docs = {};
    if (initialStk) docs.stk = { dateFrom: initialStk, dateTo: addYearsISO(initialStk, parseInt(stkYears, 10)) };
    if (initialInsurance) docs.insurance = { dateFrom: initialInsurance, dateTo: addYearsISO(initialInsurance, 1) };
    if (hasVignette && initialVignette) docs.vignette = { dateFrom: initialVignette, dateTo: addYearsISO(initialVignette, 1) };
    saveVehiclesData({ ...vehiclesData, [id]: docs });
    return id;
  };

  // Z Vozidel (vozík): pouze tracking, bez paliva, bez dálničky.
  const addTrailer = ({ name, stkYears, initialStk, initialInsurance }) => {
    const id = generateVehicleId(name, vehicles.map((v) => v.id));
    const newVeh = {
      id,
      name: name.trim(),
      type: 'trailer',
      inCalculator: false,
      hasVignette: false,
      stkYears: parseInt(stkYears, 10),
    };
    setVehicles((prev) => [...prev, newVeh]);
    const docs = {};
    if (initialStk) docs.stk = { dateFrom: initialStk, dateTo: addYearsISO(initialStk, parseInt(stkYears, 10)) };
    if (initialInsurance) docs.insurance = { dateFrom: initialInsurance, dateTo: addYearsISO(initialInsurance, 1) };
    saveVehiclesData({ ...vehiclesData, [id]: docs });
    return id;
  };

  // Smaže vozidlo (i jeho doklady)
  const deleteVehicle = (id) => {
    setVehicles((prev) => prev.filter((v) => v.id !== id));
    const next = { ...vehiclesData };
    delete next[id];
    saveVehiclesData(next);
    if (activeVehicleId === id) {
      const remaining = vehicles.filter((v) => v.id !== id && v.inCalculator);
      setActiveVehicleId(remaining[0]?.id || null);
    }
  };

  // Po hydrataci, pokud existuje aspoň jedno vozidlo v kalkulátoru a aktivní není nastaveno, vyber první
  useEffect(() => {
    if (!hydrated) return;
    if (activeVehicleId === null) {
      const first = vehicles.find((v) => v.inCalculator);
      if (first) setActiveVehicleId(first.id);
    }
  }, [hydrated, vehicles, activeVehicleId]);

  /* ----------- Úprava výchozí spotřeby při změně vozidla ----------- */

  // Najde poslední známý stav tachometru daného vozidla z archivu cest
  // (poslední kmAfter z chronologicky nejnovějšího segmentu této vozidla),
  // nebo vrátí initialKm vozidla, pokud žádné historické cesty nejsou.
  const lastKnownKmFor = (vehicleId) => {
    const v = vehicles.find((x) => x.id === vehicleId);
    if (!v) return '';
    let bestDate = '';
    let bestKm = NaN;
    for (const trip of savedTrips) {
      if (trip.vehicleId !== vehicleId) continue;
      for (const it of trip.items) {
        if (it.type !== 'segment') continue;
        const km = parseFloat(it.kmAfter);
        if (!isFinite(km)) continue;
        if (it.date >= bestDate) { bestDate = it.date || ''; bestKm = km; }
      }
    }
    if (isFinite(bestKm)) return String(bestKm);
    if (v.initialKm != null && v.initialKm !== '') return String(v.initialKm);
    return '';
  };

  const applyVehicleDefault = (vehicleId) => {
    const v = vehicles.find((x) => x.id === vehicleId);
    setActiveVehicleId(vehicleId);
    if (!v) return;
    const startKm = lastKnownKmFor(vehicleId);
    setItems((arr) =>
      arr.map((it, idx) => ({
        ...it,
        fuelType: v.defaultFuel || it.fuelType,
        // u prvního úseku doplň kmBefore z historie / initial odometer (jen když je prázdný)
        kmBefore: (idx === 0 && it.type === 'segment' && (it.kmBefore === '' || it.kmBefore == null))
          ? startKm
          : it.kmBefore,
      }))
    );
    // Automaticky aktualizuj název cesty, pokud má výchozí podobu „Vozidlo D.M.YYYY"
    setTripName((prev) => isDefaultLikeTripName(vehicles, prev) ? buildDefaultTripName(vehicles, vehicleId) : prev);
  };

  /* ----------- Operace nad položkami cesty ----------- */

  // Najde poslední úsek v poli (pro odvození kmAfter pro mezitankování / nový úsek)
  const lastSegment = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === 'segment') return items[i];
    }
    return null;
  })();

  const hasAnySegment = lastSegment !== null;

  const addSegment = () => {
    if (items.length >= MAX_ITEMS) return;
    const v = vehicles.find((x) => x.id === activeVehicleId);
    const last = items[items.length - 1];
    setItems([
      ...items,
      {
        id: Date.now(),
        type: 'segment',
        date: last?.date || todayISODate(), // dědí datum z předchozí položky (typicky stejný den)
        kmBefore: '', // u 2+ úseků se odvozuje z předchozího úseku ve výpočtu, není editovatelný
        kmAfter: '',
        litersRefueled: '',
        fuelPrice: '',
        currency: last?.currency || 'CZK',
        fuelType: v?.defaultFuel || 'gasoline', // palivo fixní podle vozidla
      },
    ]);
  };

  const addMezi = () => {
    if (items.length >= MAX_ITEMS) return;
    if (!hasAnySegment) return; // mezitankování má smysl jen po existujícím úseku
    const v = vehicles.find((x) => x.id === activeVehicleId);
    const last = items[items.length - 1];
    setItems([
      ...items,
      {
        id: Date.now(),
        type: 'mezi',
        date: last?.date || todayISODate(),
        litersRefueled: '',
        fuelPrice: '',
        currency: last?.currency || 'CZK',
        fuelType: v?.defaultFuel || 'gasoline', // palivo fixní podle vozidla
      },
    ]);
  };

  const updateItem = (id, patch) => {
    setItems((arr) => arr.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const removeItem = (id) => {
    setItems((arr) => {
      const next = arr.filter((it) => it.id !== id);
      // Vždy musí zůstat alespoň jeden úsek
      if (!next.some((x) => x.type === 'segment')) return arr;
      return next;
    });
  };

  const resetTrip = () => {
    const v = vehicles.find((x) => x.id === activeVehicleId);
    setTripName(buildDefaultTripName(vehicles, activeVehicleId));
    setItems([{
      id: Date.now(),
      type: 'segment',
      date: todayISODate(),
      kmBefore: '', kmAfter: '',
      litersRefueled: '', fuelPrice: '', currency: 'CZK',
      fuelType: v?.defaultFuel || 'gasoline',
    }]);
  };

  // Uložení aktuální cesty do archivu, reset rozpracované
  const saveTripToArchive = (name) => {
    const finalName = (name || tripName || '').trim() || `Cesta ${formatDate(todayISODate())}`;
    const validItems = items.filter((it) => {
      if (it.type === 'segment') {
        const before = parseFloat(it.kmBefore);
        const after  = parseFloat(it.kmAfter);
        return isFinite(after) && (isFinite(before) || it !== items[0]) && parseFloat(it.litersRefueled) > 0 && parseFloat(it.fuelPrice) > 0;
      }
      return parseFloat(it.litersRefueled) > 0 && parseFloat(it.fuelPrice) > 0;
    });
    if (validItems.length === 0) return false;

    const trip = {
      id: Date.now(),
      name: finalName,
      savedAt: Date.now(),
      vehicleId: activeVehicleId,
      participants,
      items: items, // ukládáme všechny (i částečně neplatné)
    };
    setSavedTrips((arr) => [...arr, trip]);
    resetTrip();
    return true;
  };

  const deleteSavedTrip = (id) => {
    setSavedTrips((arr) => arr.filter((t) => t.id !== id));
  };

  // Načíst uloženou cestu zpět do kalkulátoru pro úpravu nebo duplikaci
  const reopenTrip = (trip) => {
    if (!trip) return;
    // Regenerujeme IDs aby nedošlo ke kolizi s aktuálními
    const cloned = trip.items.map((it, i) => ({ ...it, id: Date.now() + i }));
    setItems(cloned);
    setTripName(trip.name);
    if (typeof trip.participants === 'number') setParticipants(trip.participants);
    if (trip.vehicleId) setActiveVehicleId(trip.vehicleId);
    setTab('trip');
  };

  /* ----------- Výpočty ----------- */

  const computed = useMemo(() => {
    let prevSegmentKmAfter = NaN; // kmAfter posledního úseku
    let segmentNumber = 0;        // pořadové číslo úseku (1, 2, 3…)
    let pendingMeziLiters = 0;    // litry z mezitankování od posledního úseku

    const itemCalcs = items.map((item) => {
      if (item.type === 'segment') {
        segmentNumber += 1;
        const isFirst = segmentNumber === 1;

        const ownKmBefore     = parseFloat(item.kmBefore);
        const effectiveBefore = isFirst ? ownKmBefore : prevSegmentKmAfter;
        const kmAfterNum      = parseFloat(item.kmAfter);
        const liters          = parseFloat(item.litersRefueled) || 0;
        const price           = parseFloat(item.fuelPrice)      || 0;

        const hasBefore     = isFinite(effectiveBefore);
        const hasAfter      = isFinite(kmAfterNum);
        const distance      = hasBefore && hasAfter ? Math.max(0, kmAfterNum - effectiveBefore) : 0;
        const odometerError = hasBefore && hasAfter && kmAfterNum < effectiveBefore;

        // Spotřeba úseku zahrnuje i všechna mezitankování, která v rámci úseku proběhla
        // (od konce předchozího úseku do konce tohoto úseku jsou všechny doplněné litry zde).
        const effectiveLiters = liters + pendingMeziLiters;
        const consumption = distance > 0 && effectiveLiters > 0 ? (effectiveLiters / distance) * 100 : 0;

        const costNative = liters * price;
        const costCZK    = item.currency === 'EUR' ? costNative * eurRate : costNative;

        const calc = {
          ...item,
          segNumber:    segmentNumber,
          isFirst,
          kmBeforeNum:  hasBefore ? effectiveBefore : null,
          kmAfterNum:   hasAfter  ? kmAfterNum     : null,
          distance, liters, price, consumption, effectiveLiters,
          pendingMeziLiters,
          costNative, costCZK,
          odometerError,
          valid: distance > 0 && liters > 0 && price > 0 && !odometerError,
        };

        // Po úseku resetujeme čekající mezi a aktualizujeme kmAfter
        prevSegmentKmAfter = isFinite(kmAfterNum) ? kmAfterNum : prevSegmentKmAfter;
        pendingMeziLiters = 0;

        return calc;
      } else {
        // Mezitankování
        const liters = parseFloat(item.litersRefueled) || 0;
        const price  = parseFloat(item.fuelPrice)      || 0;

        const costNative = liters * price;
        const costCZK    = item.currency === 'EUR' ? costNative * eurRate : costNative;

        // Pozice odvozená z posledního úseku (pokud je)
        const kmAt = isFinite(prevSegmentKmAfter) ? prevSegmentKmAfter : null;

        // Naplňujeme čekající mezi-litry, které se promítnou do dalšího úseku
        pendingMeziLiters += liters;

        return {
          ...item,
          afterSegmentNumber: segmentNumber, // za kterým úsekem se vyskytuje
          kmAt,
          liters, price,
          costNative, costCZK,
          valid: liters > 0 && price > 0,
        };
      }
    });

    // Souhrny
    const segmentCalcs = itemCalcs.filter((c) => c.type === 'segment');
    const totalKm     = segmentCalcs.reduce((a, s) => a + s.distance, 0);
    const totalLiters = itemCalcs.reduce((a, c) => a + c.liters, 0);
    const totalCZK    = itemCalcs.reduce((a, c) => a + c.costCZK, 0);
    const avgConsumption = totalKm > 0 ? (totalLiters / totalKm) * 100 : 0;
    const perPerson      = participants > 0 ? totalCZK / participants : totalCZK;

    return { itemCalcs, totalKm, totalLiters, totalCZK, perPerson, avgConsumption };
  }, [items, eurRate, participants]);

  /* ----------- Render ----------- */

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 font-body relative">
      {/* Fonty + drobnosti */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        .font-body    { font-family: 'DM Sans', system-ui, sans-serif; }
        .font-display { font-family: 'Bebas Neue', 'Arial Narrow', sans-serif; letter-spacing: 0.04em; }
        .font-mono    { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        input[type="number"]::-webkit-outer-spin-button,
        input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type="number"] { -moz-appearance: textfield; }
        input[type="date"] {
          color-scheme: dark;
        }
        .bg-grid {
          background-image:
            radial-gradient(circle at 25% 0%, rgba(245, 158, 11, 0.08), transparent 40%),
            radial-gradient(circle at 80% 30%, rgba(245, 158, 11, 0.04), transparent 40%);
        }
        @keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .anim-fadein { animation: fadein 0.25s ease-out; }
      `}</style>

      <div className="bg-grid min-h-screen pb-32">
        {/* HEADER */}
        <header className="sticky top-0 z-30 bg-stone-950/85 backdrop-blur border-b border-stone-800">
          <div className="max-w-xl mx-auto px-4 pt-4 pb-3">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
                  <Fuel className="w-5 h-5 text-stone-950" strokeWidth={2.5} />
                </div>
                <div className="leading-none">
                  <div className="font-display text-xl text-stone-100">AUTO MONITORING</div>
                  <div className="text-xs uppercase tracking-widest text-stone-500">palivo · vozidla</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <RateBadge rateMeta={rateMeta} eurRate={eurRate} onClick={() => setShowRateEdit(true)} />
                {supabaseEnabled && authUser && (
                  <button
                    onClick={async () => {
                      if (confirm('Odhlásit se?')) await supabase.auth.signOut();
                    }}
                    className="w-9 h-9 rounded-xl bg-stone-800 hover:bg-stone-700 active:scale-95 flex items-center justify-center text-stone-400 hover:text-stone-200 transition"
                    aria-label="Odhlásit"
                    title={authUser.email || 'Odhlásit'}
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* TABS */}
            <div className="grid grid-cols-3 gap-1 bg-stone-900/80 border border-stone-800 rounded-xl p-1">
              {[
                { id: 'trip',     label: 'Kalkulátor', Icon: Route     },
                { id: 'stats',    label: 'Přehled',    Icon: BarChart3 },
                { id: 'vehicles', label: 'Vozidla',    Icon: Car       },
              ].map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                    tab === id
                      ? 'bg-stone-100 text-stone-950 shadow-sm'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* CONTENT */}
        <main className="max-w-xl mx-auto px-4 pt-5">
          {tab === 'trip' && (
            <TripView
              vehicles={vehicles}
              participants={participants}
              setParticipants={setParticipants}
              activeVehicleId={activeVehicleId}
              applyVehicleDefault={applyVehicleDefault}
              tripName={tripName}
              setTripName={setTripName}
              items={items}
              addSegment={addSegment}
              addMezi={addMezi}
              updateItem={updateItem}
              removeItem={removeItem}
              resetTrip={resetTrip}
              computed={computed}
              eurRate={eurRate}
              maxItems={MAX_ITEMS}
              hasAnySegment={hasAnySegment}
              onSaveTrip={() => setShowSaveModal(true)}
              onAddVehicle={() => setShowAddCalcVehicle(true)}
              lastSavedTrip={savedTrips.length > 0 ? savedTrips[savedTrips.length - 1] : null}
              onContinueLastTrip={() => {
                if (savedTrips.length > 0) reopenTrip(savedTrips[savedTrips.length - 1]);
              }}
            />
          )}
          {tab === 'stats' && (
            <StatsView
              vehicles={vehicles}
              savedTrips={savedTrips}
              deleteSavedTrip={deleteSavedTrip}
              reopenTrip={reopenTrip}
              eurRate={eurRate}
            />
          )}
          {tab === 'vehicles' && (
            <VehiclesView
              vehicles={vehicles}
              setVehicles={setVehicles}
              vehiclesData={vehiclesData}
              setVehiclesData={setVehiclesData}
              saveVehiclesData={saveVehiclesData}
              notificationSettings={notificationSettings}
              setNotificationSettings={setNotificationSettings}
              authUser={authUser}
              onEdit={setEditing}
            />
          )}
        </main>
      </div>

      {/* SOUHRN – fixní spodní lišta na záložce Kalkulátor */}
      {tab === 'trip' && (
        <SummaryBar computed={computed} participants={participants} setParticipants={setParticipants} />
      )}

      {/* MODAL – uložení cesty */}
      {showSaveModal && (
        <SaveTripModal
          vehicles={vehicles}
          tripName={tripName}
          setTripName={setTripName}
          activeVehicleId={activeVehicleId}
          onClose={() => setShowSaveModal(false)}
          onSave={(name) => {
            const ok = saveTripToArchive(name);
            setShowSaveModal(false);
            if (ok) {
              resetTrip();   // kalkulátor se vyčistí, příště začínáme od nuly
              setTab('stats');
            }
          }}
        />
      )}

      {/* MODAL – editace dokumentu */}
      {editing && (
        <EditDocModal
          editing={editing}
          vehicles={vehicles}
          vehiclesData={vehiclesData}
          saveVehiclesData={saveVehiclesData}
          onClose={() => setEditing(null)}
        />
      )}

      {/* MODAL – přidat vozidlo z kalkulátoru */}
      {showAddCalcVehicle && (
        <AddCalcVehicleModal
          existingIds={vehicles.map((v) => v.id)}
          onCancel={() => setShowAddCalcVehicle(false)}
          onConfirm={(data) => {
            addCalcVehicle(data);
            setShowAddCalcVehicle(false);
          }}
        />
      )}

      {/* MODAL – ruční kurz */}
      {showRateEdit && (
        <RateModal
          rate={eurRate}
          rateMeta={rateMeta}
          rateInput={rateInput}
          setRateInput={setRateInput}
          onClose={() => setShowRateEdit(false)}
          onSave={async (val) => {
            const num = parseFloat(val);
            if (isFinite(num) && num > 0) {
              setEurRate(num);
              setRateMeta({ status: 'manual', date: new Date().toISOString().slice(0, 10), manual: true });
              try {
                await storage.set('eur-rate-cache', JSON.stringify({
                  rate: num, date: new Date().toISOString().slice(0, 10), timestamp: Date.now(), manual: true
                }));
              } catch (e) {}
            }
            setShowRateEdit(false);
          }}
          onRefresh={() => { loadEurRate(true); setShowRateEdit(false); }}
        />
      )}
    </div>
  );
}

/* ============================================================
   KURZ – odznáček v hlavičce
============================================================ */

function RateBadge({ rateMeta, eurRate, onClick }) {
  const tone =
    rateMeta.status === 'loading' ? 'gray' :
    rateMeta.status === 'manual'  ? 'amber' :
    rateMeta.status === 'success' ? 'emerald' : 'red';
  const t = toneClasses[tone];

  const label =
    rateMeta.status === 'loading' ? 'Načítám…' :
    rateMeta.status === 'error'   ? 'Záložní' :
    rateMeta.status === 'manual'  ? 'Ručně' : 'ČNB';

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 ${t.bg} ${t.text} border border-current/20 rounded-xl px-3 py-2 text-xs font-semibold transition active:scale-95`}
    >
      <ArrowRightLeft className="w-3.5 h-3.5" />
      <span className="font-mono text-sm">€ {formatNumber(eurRate, 3)}</span>
      <span className="text-xs opacity-80 uppercase tracking-wider">{label}</span>
    </button>
  );
}

/* ============================================================
   ZÁLOŽKA: KALKULÁTOR CESTY
============================================================ */

function TripView({
  vehicles,
  participants, setParticipants,
  activeVehicleId, applyVehicleDefault,
  tripName, setTripName,
  items, addSegment, addMezi, updateItem, removeItem, resetTrip,
  computed, eurRate, maxItems, hasAnySegment,
  onSaveTrip, onAddVehicle,
  lastSavedTrip, onContinueLastTrip,
}) {
  const atMax = items.length >= maxItems;
  const segmentCount = items.filter((i) => i.type === 'segment').length;
  const meziCount    = items.filter((i) => i.type === 'mezi').length;
  const canSave      = computed.totalKm > 0 && computed.totalCZK > 0;

  // Detekce „čisté" cesty bez vyplněných údajů — pak nabídneme volbu
  // pokračovat v poslední uložené cestě, nebo začít novou.
  const isFreshTrip =
    items.length === 1 &&
    items[0].type === 'segment' &&
    !items[0].kmBefore && !items[0].kmAfter &&
    !items[0].litersRefueled && !items[0].fuelPrice;
  const [continueDismissed, setContinueDismissed] = useState(false);
  const showContinueChoice = isFreshTrip && lastSavedTrip && !continueDismissed;

  // Stav tachometru = poslední zadaný kmAfter z poslední uložené cesty
  // (sledujeme nejnovější datum a v rámci téhož data poslední segment).
  const lastKmAfter = useMemo(() => {
    if (!lastSavedTrip) return null;
    let bestDate = '';
    let result = null;
    for (const it of lastSavedTrip.items) {
      if (it.type !== 'segment') continue;
      const km = parseFloat(it.kmAfter);
      if (!isFinite(km)) continue;
      const d = it.date || '';
      if (d >= bestDate) { bestDate = d; result = km; }
    }
    return result;
  }, [lastSavedTrip]);

  return (
    <div className="space-y-4 anim-fadein">
      {/* CONTINUE CHOICE — když je čistá cesta a existuje uložená historie */}
      {showContinueChoice && (
        <div className="bg-stone-900/70 border border-amber-500/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-amber-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-display text-lg leading-none">POSLEDNÍ CESTA</div>
              <div className="text-sm font-semibold text-stone-200 mt-1 truncate">
                {lastSavedTrip.name}
              </div>
              {lastKmAfter !== null && (
                <div className="text-xs text-stone-500 mt-1 flex items-center gap-1.5">
                  <Gauge className="w-3 h-3" />
                  Stav tachometru: <span className="font-mono text-stone-300">{formatNumber(lastKmAfter, 0)} km</span>
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setContinueDismissed(true)}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 active:scale-95 text-stone-200 font-semibold text-sm transition"
            >
              <Plus className="w-3.5 h-3.5" />
              Začít novou
            </button>
            <button
              onClick={onContinueLastTrip}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-stone-950 font-bold text-sm transition"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Pokračovat
            </button>
          </div>
        </div>
      )}

      {/* PARTICIPANTS + VEHICLE */}
      <div className="bg-stone-900/70 border border-stone-800 rounded-2xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-stone-800 flex items-center justify-center">
              <Users className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-stone-500">Účastníci cesty</div>
              <div className="text-sm text-stone-300">Cena se vydělí mezi všechny</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setParticipants(Math.max(1, participants - 1))}
              className="w-10 h-10 rounded-xl bg-stone-800 hover:bg-stone-700 active:scale-95 flex items-center justify-center transition"
              aria-label="Méně"
            >
              <Minus className="w-4 h-4" />
            </button>
            <div className="font-display text-3xl tabular-nums w-10 text-center text-amber-400">
              {participants}
            </div>
            <button
              onClick={() => setParticipants(Math.min(20, participants + 1))}
              className="w-10 h-10 rounded-xl bg-stone-800 hover:bg-stone-700 active:scale-95 flex items-center justify-center transition"
              aria-label="Více"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Volba vozidla */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-wider text-stone-500">Vozidlo</div>
            <button
              type="button"
              onClick={onAddVehicle}
              className="text-xs font-semibold text-amber-400 hover:text-amber-300 flex items-center gap-1 active:scale-95 transition"
            >
              <Plus className="w-3 h-3" /> Přidat vozidlo
            </button>
          </div>
          {(() => {
            const cars = vehicles.filter((v) => v.type === 'car' && v.inCalculator);
            if (cars.length === 0) {
              return (
                <button
                  type="button"
                  onClick={onAddVehicle}
                  className="w-full p-5 rounded-xl border-2 border-dashed border-stone-700 hover:border-amber-500/50 hover:bg-amber-500/5 transition text-center active:scale-95"
                >
                  <Car className="w-7 h-7 mx-auto text-stone-500 mb-2" />
                  <div className="font-display text-base text-stone-300">VYTVOŘ PRVNÍ VOZIDLO</div>
                  <div className="text-xs text-stone-500 mt-1">
                    Název · počáteční tachometr · palivo
                  </div>
                </button>
              );
            }
            return (
              <div className="grid grid-cols-2 gap-2">
                {cars.map((v, idx) => {
                  const active = activeVehicleId === v.id;
                  const isLastOdd = cars.length % 2 === 1 && idx === cars.length - 1;
                  return (
                    <button
                      key={v.id}
                      onClick={() => applyVehicleDefault(v.id)}
                      className={`text-left rounded-xl px-3 py-2.5 border transition active:scale-95 ${
                        isLastOdd ? 'col-span-2' : ''
                      } ${
                        active
                          ? 'bg-stone-100 text-stone-950 border-stone-100'
                          : 'bg-stone-800/50 border-stone-700 text-stone-300 hover:bg-stone-800'
                      }`}
                    >
                      <div className="font-display text-lg leading-none">{v.name}</div>
                      <div className="text-xs mt-1 font-mono opacity-70">
                        {v.defaultFuel === 'diesel' ? 'nafta' : 'benzín'}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>

      {/* INFO BANNER */}
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2.5">
        <Fuel className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <div className="text-xs text-stone-300 leading-relaxed">
          <span className="font-semibold text-amber-300">Úsek:</span> jízda od plné nádrže k dalšímu dotankování do plna.{' '}
          <span className="font-semibold text-amber-300">Mezitankování:</span> doplnění mezi úseky (nikoli do plna). Stav km se přebírá z předchozího úseku.
        </div>
      </div>

      {/* SEZNAM POLOŽEK */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-amber-400" />
            <h2 className="font-display text-xl">PRŮBĚH CESTY</h2>
            <span className="text-xs text-stone-500 font-mono">
              ({segmentCount} úsek{segmentCount === 1 ? '' : segmentCount < 5 ? 'y' : 'ů'}
              {meziCount > 0 ? ` · ${meziCount} mezi` : ''})
            </span>
          </div>
          <button
            onClick={resetTrip}
            className="text-xs text-stone-500 hover:text-stone-300 underline-offset-4 hover:underline transition"
          >
            Resetovat
          </button>
        </div>

        {items.map((item, idx) => {
          const calc = computed.itemCalcs[idx];
          if (item.type === 'segment') {
            return (
              <SegmentCard
                key={item.id}
                item={item}
                calc={calc}
                eurRate={eurRate}
                onUpdate={(patch) => updateItem(item.id, patch)}
                onRemove={() => removeItem(item.id)}
                canRemove={segmentCount > 1}
              />
            );
          }
          return (
            <MeziCard
              key={item.id}
              item={item}
              calc={calc}
              eurRate={eurRate}
              onUpdate={(patch) => updateItem(item.id, patch)}
              onRemove={() => removeItem(item.id)}
            />
          );
        })}

        {/* TLAČÍTKA NA PŘIDÁNÍ */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={addSegment}
            disabled={atMax}
            className={`flex items-center justify-center gap-2 py-3.5 border-2 border-dashed rounded-2xl transition font-semibold text-sm ${
              atMax
                ? 'bg-stone-900/30 border-stone-800 text-stone-600 cursor-not-allowed'
                : 'bg-stone-900/60 border-stone-700 hover:border-amber-500/60 hover:bg-stone-900 text-stone-300 hover:text-amber-400'
            }`}
          >
            <Plus className="w-4 h-4" />
            Přidat úsek
          </button>
          <button
            onClick={addMezi}
            disabled={atMax || !hasAnySegment}
            className={`flex items-center justify-center gap-2 py-3.5 border-2 border-dashed rounded-2xl transition font-semibold text-sm ${
              atMax || !hasAnySegment
                ? 'bg-stone-900/30 border-stone-800 text-stone-600 cursor-not-allowed'
                : 'bg-stone-900/40 border-stone-700/70 hover:border-amber-500/40 hover:bg-stone-900/70 text-stone-400 hover:text-amber-400'
            }`}
          >
            <Plus className="w-4 h-4" />
            Mezitankování
          </button>
        </div>

        {atMax && (
          <div className="text-xs text-stone-500 text-center">Maximum {maxItems} položek na cestu.</div>
        )}
      </div>

      {/* DETAILNÍ ROZPIS */}
      {computed.totalKm > 0 && (
        <DetailedSummary computed={computed} participants={participants} />
      )}

      {/* TLAČÍTKO ULOŽIT CESTU */}
      {canSave && (
        <button
          onClick={onSaveTrip}
          className="w-full flex items-center justify-center gap-2 py-3.5 bg-emerald-600 hover:bg-emerald-500 active:scale-95 rounded-2xl transition text-white font-bold shadow-lg shadow-emerald-900/40"
        >
          <Save className="w-5 h-5" />
          Uložit cestu do přehledu
        </button>
      )}

      <div className="h-8" />
    </div>
  );
}

/* ============================================================
   KARTA SEGMENTU
============================================================ */

function SegmentCard({ item, calc, eurRate, onUpdate, onRemove, canRemove }) {
  const valid         = calc?.valid;
  const distance      = calc?.distance || 0;
  const consumption   = calc?.consumption || 0;
  const odometerError = calc?.odometerError;
  const segNumber     = calc?.segNumber || 1;
  const isFirst       = calc?.isFirst;
  const linkedBefore  = !isFirst && calc?.kmBeforeNum != null ? calc.kmBeforeNum : null;
  const meziLitersInSegment = calc?.pendingMeziLiters || 0;

  return (
    <div className={`bg-stone-900/70 border rounded-2xl overflow-hidden transition ${
      odometerError ? 'border-red-500/50' : 'border-stone-800'
    }`}>
      {/* Hlavička */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-stone-800/60">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="w-7 h-7 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center font-display text-base">
            {segNumber}
          </div>
          <div className="text-sm font-semibold text-stone-200">Úsek {segNumber}</div>
          <span className="text-xs px-1.5 py-0.5 rounded bg-stone-800 text-stone-400 uppercase tracking-wider font-semibold">
            {item.fuelType === 'diesel' ? 'nafta' : 'benzín'}
          </span>
          {!isFirst && (
            <span className="inline-flex items-center gap-1 text-xs text-stone-500">
              <Link2 className="w-3 h-3" /> navázáno
            </span>
          )}
          {distance > 0 && !odometerError && (
            <span className="font-mono text-xs text-stone-500">
              · {formatNumber(distance, 0)} km · {formatNumber(calc.liters, 1)} L
            </span>
          )}
        </div>
        {canRemove && (
          <button
            onClick={onRemove}
            className="w-8 h-8 rounded-lg text-stone-500 hover:text-red-400 hover:bg-red-500/10 active:scale-95 flex items-center justify-center transition shrink-0"
            aria-label="Odstranit"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Inputy */}
      <div className="p-4 space-y-3">
        {/* DATUM TANKOVÁNÍ */}
        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
            <Calendar className="w-3 h-3" /> Datum tankování
          </label>
          <input
            type="date"
            value={item.date || ''}
            onChange={(e) => onUpdate({ date: e.target.value })}
            className="w-full bg-stone-800/60 border border-stone-700 rounded-xl px-3 py-3 text-stone-100 text-base font-mono focus:border-amber-500/70 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
        </div>

        {/* TACHOMETR – před / po */}
        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
            <Gauge className="w-3 h-3" /> Stav tachometru
          </label>
          <div className="grid gap-2 items-center" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
            <div>
              <div className="text-xs text-stone-500 mb-1 ml-0.5">Před jízdou</div>
              {isFirst ? (
                <NumberField
                  value={item.kmBefore}
                  onChange={(v) => onUpdate({ kmBefore: v })}
                  placeholder="0"
                  suffix="km"
                />
              ) : (
                <div className="flex items-center bg-stone-800/30 border border-stone-800 rounded-xl px-3 py-3 text-stone-300 font-mono">
                  <Link2 className="w-4 h-4 mr-2 text-amber-500/70 shrink-0" />
                  {linkedBefore !== null && isFinite(linkedBefore) ? (
                    <span className="text-base">{formatNumber(linkedBefore, 0)}</span>
                  ) : (
                    <span className="text-stone-600 text-sm">vyplň úsek {segNumber - 1} výše</span>
                  )}
                  <span className="ml-auto text-stone-500 text-sm">km</span>
                </div>
              )}
            </div>
            <div className="text-stone-600 text-xl pt-5">→</div>
            <div>
              <div className="text-xs text-stone-500 mb-1 ml-0.5">Po dotankování</div>
              <NumberField
                value={item.kmAfter}
                onChange={(v) => onUpdate({ kmAfter: v })}
                placeholder="0"
                suffix="km"
              />
            </div>
          </div>

          {/* Vypočtená vzdálenost / chyby */}
          {distance > 0 && !odometerError && (
            <div className="mt-2 flex items-center gap-2 text-amber-400 font-mono text-sm">
              <Route className="w-3.5 h-3.5" />
              Vzdálenost: <span className="font-bold">{formatNumber(distance, 0)} km</span>
            </div>
          )}
          {odometerError && (
            <div className="mt-2 flex items-center gap-2 text-red-400 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Stav po jízdě musí být vyšší než před jízdou.
            </div>
          )}
        </div>

        {/* NATANKOVÁNO */}
        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
            <Fuel className="w-3 h-3" /> Natankováno do plna
          </label>
          <NumberField
            value={item.litersRefueled}
            onChange={(v) => onUpdate({ litersRefueled: v })}
            placeholder="0"
            suffix="L"
          />
          {distance > 0 && consumption > 0 && (
            <div className="mt-1.5 flex items-center gap-2 text-xs font-mono text-stone-400">
              <Gauge className="w-3 h-3 text-amber-400" />
              Spotřeba: <span className="text-stone-200 font-bold">{formatNumber(consumption, 2)} L/100km</span>
              {meziLitersInSegment > 0 && (
                <span className="text-stone-500">(včetně {formatNumber(meziLitersInSegment, 1)} L mezi)</span>
              )}
            </div>
          )}
        </div>

        {/* CENA + MĚNA */}
        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
            <Coins className="w-3 h-3" /> Cena za litr
          </label>
          <div className="flex gap-2">
            <NumberField
              className="flex-1"
              value={item.fuelPrice}
              onChange={(v) => onUpdate({ fuelPrice: v })}
              placeholder="0,00"
              suffix={item.currency === 'EUR' ? '€/L' : 'Kč/L'}
            />
            <Segmented
              value={item.currency}
              onChange={(v) => onUpdate({ currency: v })}
              options={[
                { value: 'CZK', label: 'Kč' },
                { value: 'EUR', label: '€' },
              ]}
            />
          </div>
          {item.currency === 'EUR' && item.fuelPrice && (
            <div className="text-xs text-stone-500 mt-1.5 font-mono">
              ≈ {formatNumber(parseFloat(item.fuelPrice) * eurRate, 2)} Kč/L
            </div>
          )}
        </div>
      </div>

      {/* CENA ÚSEKU */}
      {valid && (
        <div className="px-4 py-3 bg-stone-950/40 border-t border-stone-800/60 flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-stone-500">Cena úseku</div>
          <div className="font-mono font-bold text-amber-400 text-lg">
            {formatCZK(calc.costCZK)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   KARTA MEZITANKOVÁNÍ
============================================================ */

function MeziCard({ item, calc, eurRate, onUpdate, onRemove }) {
  const valid = calc?.valid;
  const kmAt  = calc?.kmAt;
  const liters = parseFloat(item.litersRefueled) || 0;
  const afterSeg = calc?.afterSegmentNumber || 0;

  return (
    <div className="ml-4 bg-stone-900/40 border border-stone-800/70 rounded-2xl overflow-hidden relative">
      {/* "Lano" na levé straně, vizuálně odděluje od úseků */}
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-500/30" />

      {/* Hlavička */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-stone-800/40">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="w-7 h-7 rounded-lg bg-stone-800/80 text-amber-400/80 flex items-center justify-center">
            <Fuel className="w-4 h-4" />
          </div>
          <div className="text-sm font-semibold text-stone-300">Mezitankování</div>
          <span className="text-xs px-1.5 py-0.5 rounded bg-stone-800 text-stone-400 uppercase tracking-wider font-semibold">
            {item.fuelType === 'diesel' ? 'nafta' : 'benzín'}
          </span>
          <span className="font-mono text-xs text-stone-500">
            po úseku {afterSeg}
          </span>
        </div>
        <button
          onClick={onRemove}
          className="w-8 h-8 rounded-lg text-stone-500 hover:text-red-400 hover:bg-red-500/10 active:scale-95 flex items-center justify-center transition shrink-0"
          aria-label="Odstranit"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Inputy – kompaktnější než úsek */}
      <div className="p-4 space-y-3">
        {/* DATUM TANKOVÁNÍ */}
        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
            <Calendar className="w-3 h-3" /> Datum tankování
          </label>
          <input
            type="date"
            value={item.date || ''}
            onChange={(e) => onUpdate({ date: e.target.value })}
            className="w-full bg-stone-800/60 border border-stone-700 rounded-xl px-3 py-3 text-stone-100 text-base font-mono focus:border-amber-500/70 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
            <Fuel className="w-3 h-3" /> Natankováno (ne do plna)
          </label>
          <NumberField
            value={item.litersRefueled}
            onChange={(v) => onUpdate({ litersRefueled: v })}
            placeholder="0"
            suffix="L"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
            <Coins className="w-3 h-3" /> Cena za litr
          </label>
          <div className="flex gap-2">
            <NumberField
              className="flex-1"
              value={item.fuelPrice}
              onChange={(v) => onUpdate({ fuelPrice: v })}
              placeholder="0,00"
              suffix={item.currency === 'EUR' ? '€/L' : 'Kč/L'}
            />
            <Segmented
              value={item.currency}
              onChange={(v) => onUpdate({ currency: v })}
              options={[
                { value: 'CZK', label: 'Kč' },
                { value: 'EUR', label: '€' },
              ]}
            />
          </div>
          {item.currency === 'EUR' && item.fuelPrice && (
            <div className="text-xs text-stone-500 mt-1.5 font-mono">
              ≈ {formatNumber(parseFloat(item.fuelPrice) * eurRate, 2)} Kč/L
            </div>
          )}
        </div>
      </div>

      {/* Cena */}
      {valid && (
        <div className="px-4 py-3 bg-stone-950/30 border-t border-stone-800/40 flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-stone-500">
            Cena · {formatNumber(liters, 1)} L
          </div>
          <div className="font-mono font-bold text-amber-400/90 text-base">
            {formatCZK(calc.costCZK)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   DETAILNÍ ROZPIS POD SEGMENTY
============================================================ */

function DetailedSummary({ computed, participants }) {
  return (
    <div className="bg-gradient-to-br from-stone-900 to-stone-900/60 border border-stone-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Receipt className="w-4 h-4 text-amber-400" />
        <h3 className="font-display text-lg tracking-wider">ROZPIS CESTY</h3>
      </div>

      <div className="space-y-2">
        {computed.itemCalcs.map((c) => {
          if (!c.valid) return null;

          if (c.type === 'segment') {
            return (
              <div key={c.id} className="flex items-start justify-between py-2 border-b border-stone-800/60 last:border-0 gap-3">
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <span className="w-6 h-6 rounded-md bg-amber-500/15 text-amber-400 flex items-center justify-center text-xs font-display shrink-0 mt-0.5">{c.segNumber}</span>
                  <div className="min-w-0">
                    <div className="text-sm text-stone-200 font-mono truncate">
                      {c.date && <span className="text-stone-400">{formatDate(c.date)} · </span>}
                      {formatNumber(c.kmBeforeNum, 0)} → {formatNumber(c.kmAfterNum, 0)} km
                    </div>
                    <div className="text-xs text-stone-500 font-mono">
                      {formatNumber(c.distance, 0)} km · {formatNumber(c.liters, 1)} L · {formatNumber(c.consumption, 2)} L/100km
                    </div>
                    <div className="text-xs text-stone-600 font-mono">
                      {formatNumber(c.price, 2)} {c.currency === 'EUR' ? '€' : 'Kč'}/L · {c.fuelType === 'diesel' ? 'nafta' : 'benzín'}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono font-semibold text-stone-100">{formatCZK(c.costCZK)}</div>
                  {participants > 1 && (
                    <div className="text-xs text-stone-500 font-mono">
                      {formatCZK(c.costCZK / participants)}/os.
                    </div>
                  )}
                </div>
              </div>
            );
          }

          // Mezitankování
          return (
            <div key={c.id} className="flex items-start justify-between py-2 border-b border-stone-800/60 last:border-0 gap-3 ml-2">
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <span className="w-6 h-6 rounded-md bg-stone-700/50 text-stone-300 flex items-center justify-center shrink-0 mt-0.5">
                  <Fuel className="w-3 h-3" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm text-stone-300 font-mono truncate">
                    {c.date && <span className="text-stone-400">{formatDate(c.date)} · </span>}
                    Mezi · po úseku {c.afterSegmentNumber}
                    {c.kmAt != null && isFinite(c.kmAt) ? ` · ${formatNumber(c.kmAt, 0)} km` : ''}
                  </div>
                  <div className="text-xs text-stone-500 font-mono">
                    {formatNumber(c.liters, 1)} L · {formatNumber(c.price, 2)} {c.currency === 'EUR' ? '€' : 'Kč'}/L
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono font-semibold text-stone-200">{formatCZK(c.costCZK)}</div>
                {participants > 1 && (
                  <div className="text-xs text-stone-500 font-mono">
                    {formatCZK(c.costCZK / participants)}/os.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Souhrn */}
      {computed.totalKm > 0 && (
        <div className="pt-2 mt-2 border-t border-stone-800 space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-stone-400 font-semibold">Cena za 1 km</span>
            <span className="font-mono font-bold text-amber-400">
              {formatCZK(computed.totalCZK / computed.totalKm, 2)}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-stone-400 font-semibold">Průměrná spotřeba</span>
            <span className="font-mono font-bold text-amber-400">
              {formatNumber(computed.avgConsumption, 2)} L/100km
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   FIXNÍ SOUHRN VESPOD
============================================================ */

function SummaryBar({ computed, participants, setParticipants }) {
  const empty = computed.totalCZK <= 0;
  const pricePerKm = computed.totalKm > 0 ? computed.totalCZK / computed.totalKm : 0;
  return (
    <div className="fixed bottom-0 inset-x-0 z-20 pointer-events-none">
      <div className="max-w-xl mx-auto px-3 pb-3 pointer-events-auto">
        <div className={`rounded-2xl border shadow-2xl shadow-black/50 transition ${
          empty
            ? 'bg-stone-900/90 border-stone-800 backdrop-blur'
            : 'bg-gradient-to-br from-amber-500 via-amber-500 to-orange-600 border-amber-400/50'
        }`}>
          <div className="p-3.5">
            {empty ? (
              <div className="flex items-center gap-3 text-stone-400">
                <Sparkles className="w-4 h-4" />
                <div className="text-sm">Vyplň aspoň jeden úsek pro výpočet…</div>
              </div>
            ) : (
              <div className="text-stone-950">
                {/* Horní řádek: celkem + na osobu */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-widest opacity-80 font-semibold">Celkem</div>
                    <div className="font-display text-3xl leading-none mt-1">{formatCZK(computed.totalCZK)}</div>
                    <div className="text-xs mt-1 font-mono opacity-80">
                      {formatNumber(computed.totalKm, 0)} km · {formatNumber(computed.totalLiters, 1)} L
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-widest opacity-80 font-semibold">Na osobu</div>
                    <div className="font-display text-3xl leading-none mt-1">{formatCZK(computed.perPerson)}</div>
                    <div className="text-xs mt-1 font-mono opacity-80">
                      {formatNumber(pricePerKm, 2)} Kč/km
                    </div>
                  </div>
                </div>
                {/* Spodní řádek: ovládání účastníků */}
                <div className="mt-3 pt-3 border-t border-stone-950/15 flex items-center justify-between">
                  <div className="text-xs uppercase tracking-widest font-semibold opacity-80 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" />
                    Účastníci
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setParticipants(Math.max(1, participants - 1))}
                      className="w-8 h-8 rounded-lg bg-stone-950/15 hover:bg-stone-950/25 active:scale-95 flex items-center justify-center transition"
                      aria-label="Méně"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <div className="font-display text-2xl tabular-nums w-8 text-center">{participants}</div>
                    <button
                      onClick={() => setParticipants(Math.min(20, participants + 1))}
                      className="w-8 h-8 rounded-lg bg-stone-950/15 hover:bg-stone-950/25 active:scale-95 flex items-center justify-center transition"
                      aria-label="Více"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ZÁLOŽKA: VOZIDLA
============================================================ */

function VehiclesView({
  vehicles, setVehicles,
  vehiclesData, setVehiclesData, saveVehiclesData,
  notificationSettings, setNotificationSettings,
  authUser,
  onEdit,
}) {
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [showAddTrailer, setShowAddTrailer] = useState(false);

  const cars     = vehicles.filter((v) => v.type === 'car');
  const trailers = vehicles.filter((v) => v.type === 'trailer');
  const isEmpty  = vehicles.length === 0;

  const handleAddVehicle = (data) => {
    const id = generateVehicleId(data.name, vehicles.map((v) => v.id));
    const newVeh = {
      id,
      name: data.name.trim(),
      type: 'car',
      defaultFuel: data.defaultFuel,
      inCalculator: false,        // jen tracking
      hasVignette: data.hasVignette,
      stkYears: parseInt(data.stkYears, 10),
    };
    setVehicles([...vehicles, newVeh]);
    const docs = {};
    if (data.initialStk)
      docs.stk = { dateFrom: data.initialStk, dateTo: addYearsISO(data.initialStk, parseInt(data.stkYears, 10)) };
    if (data.initialInsurance)
      docs.insurance = { dateFrom: data.initialInsurance, dateTo: addYearsISO(data.initialInsurance, 1) };
    if (data.hasVignette && data.initialVignette)
      docs.vignette = { dateFrom: data.initialVignette, dateTo: addYearsISO(data.initialVignette, 1) };
    saveVehiclesData({ ...vehiclesData, [id]: docs });
    setShowAddVehicle(false);
  };

  const handleAddTrailer = (data) => {
    const id = generateVehicleId(data.name, vehicles.map((v) => v.id));
    const newVeh = {
      id,
      name: data.name.trim(),
      type: 'trailer',
      inCalculator: false,
      hasVignette: false,
      stkYears: parseInt(data.stkYears, 10),
    };
    setVehicles([...vehicles, newVeh]);
    const docs = {};
    if (data.initialStk)
      docs.stk = { dateFrom: data.initialStk, dateTo: addYearsISO(data.initialStk, parseInt(data.stkYears, 10)) };
    if (data.initialInsurance)
      docs.insurance = { dateFrom: data.initialInsurance, dateTo: addYearsISO(data.initialInsurance, 1) };
    saveVehiclesData({ ...vehiclesData, [id]: docs });
    setShowAddTrailer(false);
  };

  const handleDelete = (id, name) => {
    if (confirm(`Smazat vozidlo "${name}"? Smažou se i jeho doklady.`)) {
      setVehicles(vehicles.filter((v) => v.id !== id));
      const next = { ...vehiclesData };
      delete next[id];
      saveVehiclesData(next);
    }
  };

  return (
    <div className="space-y-4 anim-fadein">
      {/* NOTIFIKACE */}
      <NotificationsPanel
        settings={notificationSettings}
        setSettings={setNotificationSettings}
        authUser={authUser}
      />

      {/* EMPTY STATE */}
      {isEmpty && (
        <div className="bg-stone-900/40 border border-stone-800 rounded-2xl p-8 text-center space-y-3">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-500/15 flex items-center justify-center">
            <Car className="w-7 h-7 text-amber-400" />
          </div>
          <div>
            <div className="font-display text-xl">ZATÍM ŽÁDNÁ VOZIDLA</div>
            <div className="text-xs text-stone-500 mt-1">
              Začni přidáním auta nebo vozíku, který chceš sledovat.
            </div>
          </div>
        </div>
      )}

      {/* AUTA */}
      {cars.length > 0 && (
        <section>
          <div className="flex items-center gap-2 px-1 mb-3">
            <Car className="w-4 h-4 text-amber-400" />
            <h2 className="font-display text-xl">AUTA</h2>
            <span className="text-xs text-stone-500 font-mono">({cars.length})</span>
          </div>
          <div className="space-y-3">
            {cars.map((v) => (
              <VehicleCard
                key={v.id}
                vehicle={v}
                data={vehiclesData[v.id] || {}}
                onEdit={(docType) => onEdit({ vehicleId: v.id, docType })}
                onDelete={() => handleDelete(v.id, v.name)}
              />
            ))}
          </div>
        </section>
      )}

      {/* VOZÍKY */}
      {trailers.length > 0 && (
        <section>
          <div className="flex items-center gap-2 px-1 mb-3">
            <Truck className="w-4 h-4 text-amber-400" />
            <h2 className="font-display text-xl">VOZÍKY</h2>
            <span className="text-xs text-stone-500 font-mono">({trailers.length})</span>
          </div>
          <div className="space-y-3">
            {trailers.map((v) => (
              <VehicleCard
                key={v.id}
                vehicle={v}
                data={vehiclesData[v.id] || {}}
                onEdit={(docType) => onEdit({ vehicleId: v.id, docType })}
                onDelete={() => handleDelete(v.id, v.name)}
              />
            ))}
          </div>
        </section>
      )}

      {/* TLAČÍTKA PRO PŘIDÁNÍ */}
      <div className="grid grid-cols-2 gap-2 pt-2">
        <button
          onClick={() => setShowAddVehicle(true)}
          className="flex items-center justify-center gap-2 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-stone-950 font-bold text-sm transition"
        >
          <Plus className="w-4 h-4" /> Přidat vozidlo
        </button>
        <button
          onClick={() => setShowAddTrailer(true)}
          className="flex items-center justify-center gap-2 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 active:scale-95 text-stone-200 font-bold text-sm transition border border-stone-700"
        >
          <Plus className="w-4 h-4" /> Přidat vozík
        </button>
      </div>

      {/* INFO */}
      {!isEmpty && (
        <div className="bg-stone-900/40 border border-stone-800 rounded-xl p-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-xs text-stone-400 leading-relaxed">
            Zadej pouze <span className="text-stone-200 font-semibold">datum „od"</span> — datum konce platnosti aplikace dopočítá podle nastavených let. Vozíky nemají dálniční známku.
          </div>
        </div>
      )}

      <div className="h-8" />

      {/* MODALY */}
      {showAddVehicle && (
        <AddTrackingVehicleModal
          onCancel={() => setShowAddVehicle(false)}
          onConfirm={handleAddVehicle}
        />
      )}
      {showAddTrailer && (
        <AddTrailerModal
          onCancel={() => setShowAddTrailer(false)}
          onConfirm={handleAddTrailer}
        />
      )}
    </div>
  );
}

function VehicleCard({ vehicle, data, onEdit, onDelete }) {
  const applicable = docsForVehicle(vehicle);
  const docs = applicable.map((d) => {
    const stored = data[d.key] || {};
    const calculatedTo = calcExpiration(stored.from, vehicle, d.key);
    const status = statusFromDate(calculatedTo);
    return { ...d, range: { from: stored.from, to: calculatedTo }, status };
  });

  // Souhrnný status karty = nejhorší z dokumentů
  const order = ['red', 'amber', 'yellow', 'emerald', 'gray'];
  const worst = docs.reduce(
    (acc, d) => (order.indexOf(d.status.tone) < order.indexOf(acc) ? d.status.tone : acc),
    'gray'
  );
  const t = toneClasses[worst];
  const isTrailer = vehicle.type === 'trailer';

  return (
    <div className="bg-stone-900/70 border border-stone-800 rounded-2xl overflow-hidden">
      {/* Hlavička karty */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-800/60 gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${t.dot} ring-4 ${t.ring}`} />
          <div className="font-display text-2xl tracking-wider truncate">{vehicle.name.toUpperCase()}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-xs uppercase tracking-wider text-stone-500 font-mono">
            {isTrailer ? 'vozík' : (vehicle.defaultFuel === 'diesel' ? 'nafta' : 'benzín')}
          </div>
          {onDelete && (
            <button
              onClick={onDelete}
              className="w-7 h-7 rounded-lg bg-stone-800 hover:bg-red-500/20 text-stone-500 hover:text-red-400 flex items-center justify-center transition"
              title="Smazat vozidlo"
              aria-label="Smazat vozidlo"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Řádky dokumentů */}
      <div className="divide-y divide-stone-800/60">
        {docs.map((d) => {
          const tt = toneClasses[d.status.tone];
          const Icon = d.Icon;
          const yrs = yearsFor(vehicle, d.key);
          return (
            <button
              key={d.key}
              onClick={() => onEdit(d.key)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-stone-800/40 active:bg-stone-800/60 transition text-left"
            >
              <div className={`w-9 h-9 rounded-lg ${tt.bg} ${tt.text} flex items-center justify-center shrink-0`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-stone-200 flex items-center gap-1.5">
                  {d.label}
                  <span className="text-xs font-mono text-stone-500 font-normal">+{yrs}r</span>
                </div>
                <div className="text-xs font-mono text-stone-500 truncate">
                  {d.range.from ? (
                    <>
                      {formatDate(d.range.from)} <span className="text-stone-600">→</span> {formatDate(d.range.to)}
                    </>
                  ) : (
                    'Klepnutím nastavíte termín'
                  )}
                </div>
              </div>
              <div className={`text-xs font-semibold ${tt.text} text-right shrink-0`}>{d.status.label}</div>
              <Edit3 className="w-3.5 h-3.5 text-stone-600 shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}


/* ============================================================
   MODAL — Přidat vozidlo do KALKULÁTORU
   Pole: název, počáteční stav tachometru, palivo
   Auto-vytvoří i v sekci Vozidla (ale s prázdnými termíny).
============================================================ */

function AddCalcVehicleModal({ existingIds, onCancel, onConfirm }) {
  const [name, setName] = useState('');
  const [initialKm, setInitialKm] = useState('');
  const [defaultFuel, setDefaultFuel] = useState('gasoline');
  const [error, setError] = useState('');

  const submit = () => {
    if (!name.trim()) { setError('Zadej název vozidla.'); return; }
    const km = initialKm === '' ? 0 : parseFloat(initialKm);
    if (isNaN(km) || km < 0) { setError('Stav tachometru musí být nezáporné číslo.'); return; }
    onConfirm({ name: name.trim(), initialKm: km, defaultFuel });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-full max-w-xl bg-stone-900 border-t sm:border border-stone-700 rounded-t-3xl sm:rounded-3xl p-5 anim-fadein space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-2xl">PŘIDAT VOZIDLO</h3>
          <button type="button" onClick={onCancel} className="w-8 h-8 rounded-lg bg-stone-800 hover:bg-stone-700 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 text-xs text-amber-200/90 leading-relaxed">
          💡 Toto vozidlo se ti objeví v kalkulátoru cest <em>i</em> v záložce Vozidla (zatím bez termínů — doplníš je tam později).
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Název</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="např. Audi A4"
            autoFocus
            className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Počáteční stav tachometru</label>
          <NumberField
            value={initialKm}
            onChange={setInitialKm}
            placeholder="např. 45000"
            suffix="km"
          />
          <div className="text-xs text-stone-500 mt-1">
            Použije se jako výchozí <strong>km Před</strong> u prvního úseku tvé první cesty.
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Palivo</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'gasoline', label: 'Benzín', activeCls: 'bg-emerald-500 text-stone-950' },
              { id: 'diesel',   label: 'Nafta',  activeCls: 'bg-blue-500 text-white' },
            ].map(({ id, label, activeCls }) => (
              <button
                key={id}
                type="button"
                onClick={() => setDefaultFuel(id)}
                className={`flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition active:scale-95 ${
                  defaultFuel === id ? activeCls : 'bg-stone-800 text-stone-400 border border-stone-700'
                }`}
              >
                <Fuel className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-lg px-3 py-2 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-stone-950 font-bold transition"
        >
          Vytvořit vozidlo
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   MODAL — Přidat AUTO do sekce VOZIDLA (jen tracking, ne kalkulátor)
   Pole: název, palivo, dálnička, STK roky, počáteční datumy
============================================================ */

function AddTrackingVehicleModal({ onCancel, onConfirm }) {
  const [name, setName]                       = useState('');
  const [defaultFuel, setDefaultFuel]         = useState('gasoline');
  const [hasVignette, setHasVignette]         = useState(true);
  const [stkYears, setStkYears]               = useState(2);
  const [initialStk, setInitialStk]           = useState('');
  const [initialInsurance, setInitialInsurance] = useState('');
  const [initialVignette, setInitialVignette] = useState('');
  const [error, setError]                     = useState('');

  const submit = () => {
    if (!name.trim()) { setError('Zadej název vozidla.'); return; }
    onConfirm({
      name, defaultFuel, hasVignette,
      stkYears, initialStk, initialInsurance,
      initialVignette: hasVignette ? initialVignette : '',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-full max-w-xl bg-stone-900 border-t sm:border border-stone-700 rounded-t-3xl sm:rounded-3xl p-5 anim-fadein space-y-4 max-h-screen overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between sticky top-0 bg-stone-900 -m-5 mb-0 px-5 pt-5 pb-3 z-10">
          <h3 className="font-display text-2xl">PŘIDAT VOZIDLO (TRACKING)</h3>
          <button type="button" onClick={onCancel} className="w-8 h-8 rounded-lg bg-stone-800 hover:bg-stone-700 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-stone-800/50 border border-stone-700 rounded-xl px-3 py-2 text-xs text-stone-400 leading-relaxed">
          ℹ️ Toto vozidlo bude jen v záložce <strong>Vozidla</strong> pro hlídání termínů. Nezobrazí se v kalkulátoru cest.
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Název</label>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            autoFocus placeholder="např. Škoda Octavia"
            className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Palivo</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'gasoline', label: 'Benzín', activeCls: 'bg-emerald-500 text-stone-950' },
              { id: 'diesel',   label: 'Nafta',  activeCls: 'bg-blue-500 text-white' },
            ].map(({ id, label, activeCls }) => (
              <button key={id} type="button" onClick={() => setDefaultFuel(id)}
                className={`flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition active:scale-95 ${
                  defaultFuel === id ? activeCls : 'bg-stone-800 text-stone-400 border border-stone-700'
                }`}>
                <Fuel className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">STK platnost</label>
          <div className="grid grid-cols-2 gap-2">
            {[2, 4].map((y) => (
              <button key={y} type="button" onClick={() => setStkYears(y)}
                className={`py-3 rounded-xl text-sm font-semibold transition active:scale-95 ${
                  stkYears === y ? 'bg-amber-500 text-stone-950' : 'bg-stone-800 text-stone-400 border border-stone-700'
                }`}>
                {y} roky
              </button>
            ))}
          </div>
        </div>

        <button type="button" onClick={() => setHasVignette(!hasVignette)}
          className="w-full flex items-center justify-between gap-3 p-3 bg-stone-800/60 border border-stone-700 rounded-xl text-left">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Má dálniční známku</div>
            <div className="text-xs text-stone-500 mt-0.5">Vypni pro vozidla, která známku nepotřebují (např. moto).</div>
          </div>
          <div className={`relative w-11 h-6 rounded-full shrink-0 transition ${hasVignette ? 'bg-amber-500' : 'bg-stone-700'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${hasVignette ? 'left-5' : 'left-0.5'}`} />
          </div>
        </button>

        <div className="border-t border-stone-800 pt-3 space-y-3">
          <div className="text-xs uppercase tracking-wider text-stone-500 font-semibold">Počáteční datumy (od)</div>

          <div>
            <label className="text-xs text-stone-500 mb-1 flex items-center gap-1.5"><Wrench className="w-3 h-3" /> STK od</label>
            <input type="date" value={initialStk} onChange={(e) => setInitialStk(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 font-mono text-sm focus:border-amber-500 focus:outline-none" />
            {initialStk && <div className="text-xs text-stone-500 mt-1">Vyprší: {addYearsISO(initialStk, parseInt(stkYears, 10))}</div>}
          </div>

          <div>
            <label className="text-xs text-stone-500 mb-1 flex items-center gap-1.5"><ShieldCheck className="w-3 h-3" /> Pojištění od</label>
            <input type="date" value={initialInsurance} onChange={(e) => setInitialInsurance(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 font-mono text-sm focus:border-amber-500 focus:outline-none" />
            {initialInsurance && <div className="text-xs text-stone-500 mt-1">Vyprší: {addYearsISO(initialInsurance, 1)}</div>}
          </div>

          {hasVignette && (
            <div>
              <label className="text-xs text-stone-500 mb-1 flex items-center gap-1.5"><BadgeCheck className="w-3 h-3" /> Dálniční známka od</label>
              <input type="date" value={initialVignette} onChange={(e) => setInitialVignette(e.target.value)}
                className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 font-mono text-sm focus:border-amber-500 focus:outline-none" />
              {initialVignette && <div className="text-xs text-stone-500 mt-1">Vyprší: {addYearsISO(initialVignette, 1)}</div>}
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-lg px-3 py-2 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}

        <button type="button" onClick={submit} className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-stone-950 font-bold transition">
          Vytvořit vozidlo
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   MODAL — Přidat VOZÍK do sekce VOZIDLA
   Pole: název, STK roky, počáteční datumy STK + pojištění
============================================================ */

function AddTrailerModal({ onCancel, onConfirm }) {
  const [name, setName]                       = useState('');
  const [stkYears, setStkYears]               = useState(4);
  const [initialStk, setInitialStk]           = useState('');
  const [initialInsurance, setInitialInsurance] = useState('');
  const [error, setError]                     = useState('');

  const submit = () => {
    if (!name.trim()) { setError('Zadej název vozíku.'); return; }
    onConfirm({ name, stkYears, initialStk, initialInsurance });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-full max-w-xl bg-stone-900 border-t sm:border border-stone-700 rounded-t-3xl sm:rounded-3xl p-5 anim-fadein space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-2xl">PŘIDAT VOZÍK</h3>
          <button type="button" onClick={onCancel} className="w-8 h-8 rounded-lg bg-stone-800 hover:bg-stone-700 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Název</label>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            autoFocus placeholder="např. Vozík Agados"
            className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">STK platnost</label>
          <div className="grid grid-cols-2 gap-2">
            {[2, 4].map((y) => (
              <button key={y} type="button" onClick={() => setStkYears(y)}
                className={`py-3 rounded-xl text-sm font-semibold transition active:scale-95 ${
                  stkYears === y ? 'bg-amber-500 text-stone-950' : 'bg-stone-800 text-stone-400 border border-stone-700'
                }`}>
                {y} roky
              </button>
            ))}
          </div>
          <div className="text-xs text-stone-500 mt-1">Vozíky obvykle 4 roky.</div>
        </div>

        <div className="border-t border-stone-800 pt-3 space-y-3">
          <div className="text-xs uppercase tracking-wider text-stone-500 font-semibold">Počáteční datumy (od)</div>
          <div>
            <label className="text-xs text-stone-500 mb-1 flex items-center gap-1.5"><Wrench className="w-3 h-3" /> STK od</label>
            <input type="date" value={initialStk} onChange={(e) => setInitialStk(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 font-mono text-sm focus:border-amber-500 focus:outline-none" />
            {initialStk && <div className="text-xs text-stone-500 mt-1">Vyprší: {addYearsISO(initialStk, parseInt(stkYears, 10))}</div>}
          </div>
          <div>
            <label className="text-xs text-stone-500 mb-1 flex items-center gap-1.5"><ShieldCheck className="w-3 h-3" /> Pojištění od</label>
            <input type="date" value={initialInsurance} onChange={(e) => setInitialInsurance(e.target.value)}
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 font-mono text-sm focus:border-amber-500 focus:outline-none" />
            {initialInsurance && <div className="text-xs text-stone-500 mt-1">Vyprší: {addYearsISO(initialInsurance, 1)}</div>}
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-lg px-3 py-2 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}

        <button type="button" onClick={submit} className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-stone-950 font-bold transition">
          Vytvořit vozík
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   PANEL — Notifikační nastavení (uvnitř Vozidla tabu)
   - E-mail (override přihlašovacího), frekvence, sledované doklady
============================================================ */

function NotificationsPanel({ settings, setSettings, authUser }) {
  const [expanded, setExpanded] = useState(false);
  const dayChoices = [60, 30, 14, 7, 3, 1];
  const authEmail = authUser?.email || '';

  const toggleEnabled = () => setSettings({ ...settings, enabled: !settings.enabled });
  const toggleDay = (n) => {
    const has = settings.daysBefore.includes(n);
    setSettings({
      ...settings,
      daysBefore: has
        ? settings.daysBefore.filter((x) => x !== n)
        : [...settings.daysBefore, n].sort((a, b) => b - a),
    });
  };
  const toggleDocType = (t) =>
    setSettings({ ...settings, docTypes: { ...settings.docTypes, [t]: !settings.docTypes[t] } });

  const effectiveEmail = settings.email?.trim() || authEmail;

  return (
    <div className="bg-stone-900/70 border border-stone-800 rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-stone-800/30 transition"
      >
        <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
          <Bell className="w-5 h-5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-display text-lg leading-none">NOTIFIKACE</div>
          <div className="text-xs text-stone-500 mt-1 truncate">
            {settings.enabled
              ? <>na <span className="text-stone-300">{effectiveEmail || 'nemáš e-mail'}</span> · {settings.daysBefore.join(', ')} dní předem</>
              : <>vypnuto</>}
          </div>
        </div>
        <ChevronRight className={`w-4 h-4 text-stone-500 transition shrink-0 ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && (
        <div className="border-t border-stone-800 p-4 space-y-4">
          {/* Master switch */}
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">E-mailové notifikace</div>
              <div className="text-xs text-stone-500 mt-0.5">
                {settings.enabled ? 'Zapnuto — chodí ti připomínky' : 'Vypnuto — žádné e-maily'}
              </div>
            </div>
            <button onClick={toggleEnabled}
              className={`relative w-12 h-7 rounded-full transition shrink-0 ${settings.enabled ? 'bg-amber-500' : 'bg-stone-700'}`}>
              <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white transition-all ${settings.enabled ? 'left-5' : 'left-0.5'}`} />
            </button>
          </div>

          {/* E-mail */}
          <div>
            <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">
              Kam posílat
            </label>
            <input
              type="email"
              value={settings.email || ''}
              onChange={(e) => setSettings({ ...settings, email: e.target.value })}
              placeholder={authEmail || 'tvuj@email.cz'}
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 disabled:opacity-50"
              disabled={!settings.enabled}
            />
            <div className="text-xs text-stone-500 mt-1">
              Necháš-li prázdné, použije se přihlašovací e-mail{authEmail ? ` (${authEmail})` : ''}.
            </div>
          </div>

          {/* Frekvence */}
          <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
            <div className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
              <Calendar className="w-3 h-3" /> Kolik dní předem
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dayChoices.map((d) => {
                const active = settings.daysBefore.includes(d);
                return (
                  <button key={d} onClick={() => toggleDay(d)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold transition active:scale-95 ${
                      active ? 'bg-amber-500 text-stone-950' : 'bg-stone-800 text-stone-400 hover:bg-stone-700'
                    }`}>
                    {d === 1 ? '1 den' : `${d} dní`}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Doklady */}
          <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
            <div className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3" /> Sledované doklady
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {DOC_TYPES.map(({ key, label }) => {
                const active = !!settings.docTypes?.[key];
                return (
                  <button key={key} onClick={() => toggleDocType(key)}
                    className={`px-2 py-1.5 rounded-lg text-xs font-semibold transition active:scale-95 ${
                      active
                        ? 'bg-amber-500/15 border border-amber-500/40 text-stone-100'
                        : 'bg-stone-800 border border-stone-700 text-stone-500'
                    }`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ============================================================
   MODAL – editace data
============================================================ */

function EditDocModal({ editing, vehicles, vehiclesData, saveVehiclesData, onClose }) {
  const vehicle  = vehicles.find((v) => v.id === editing.vehicleId);
  const docMeta  = DOC_TYPES.find((d) => d.key === editing.docType);
  const current  = vehiclesData[editing.vehicleId]?.[editing.docType] || {};
  const yrsAdded = yearsFor(vehicle, editing.docType);

  const [from, setFrom] = useState(current.from || '');
  const calculatedTo = calcExpiration(from, vehicle, editing.docType);
  const status = statusFromDate(calculatedTo);
  const tt = toneClasses[status.tone];

  const handleSave = async () => {
    const next = {
      ...vehiclesData,
      [editing.vehicleId]: {
        ...vehiclesData[editing.vehicleId],
        [editing.docType]: { from }, // ukládáme jen "od"; "do" se dopočítává
      },
    };
    await saveVehiclesData(next);
    onClose();
  };

  const handleClear = async () => {
    const next = {
      ...vehiclesData,
      [editing.vehicleId]: {
        ...vehiclesData[editing.vehicleId],
        [editing.docType]: { from: '' },
      },
    };
    await saveVehiclesData(next);
    onClose();
  };

  const Icon = docMeta.Icon;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-stone-900 border-t sm:border border-stone-700 rounded-t-3xl sm:rounded-3xl p-5 anim-fadein"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <div className="font-display text-2xl">{vehicle.name.toUpperCase()}</div>
              <div className="text-xs text-stone-400 flex items-center gap-1.5">
                {docMeta.label}
                <span className="font-mono text-amber-400">+{yrsAdded} {yrsAdded === 1 ? 'rok' : (yrsAdded < 5 ? 'roky' : 'let')}</span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg bg-stone-800 hover:bg-stone-700 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Vstup: pouze "od" */}
        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Platnost od</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-3 text-stone-100 text-base font-mono focus:border-amber-500 focus:outline-none"
          />
        </div>

        {/* Výstup: vypočítané "do" */}
        <div className="mt-3">
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">
            Platnost do <span className="text-amber-400 normal-case">(vypočítáno)</span>
          </label>
          <div className="w-full bg-stone-950/60 border border-stone-800 rounded-xl px-3 py-3 text-stone-100 text-base font-mono flex items-center justify-between">
            <span>{calculatedTo ? formatDate(calculatedTo) : <span className="text-stone-600">— zadej datum „od" —</span>}</span>
            {calculatedTo && (
              <span className="text-xs text-stone-500">+{yrsAdded} {yrsAdded === 1 ? 'rok' : (yrsAdded < 5 ? 'roky' : 'let')}</span>
            )}
          </div>

          {calculatedTo && (
            <div className={`mt-2 inline-flex items-center gap-2 px-3 py-1 rounded-lg ${tt.bg} ${tt.text} text-xs font-semibold`}>
              <span className={`w-1.5 h-1.5 rounded-full ${tt.dot}`} />
              {status.label}
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={handleClear}
            className="flex-1 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 font-semibold transition active:scale-95"
          >
            Vymazat
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-bold flex items-center justify-center gap-2 transition active:scale-95"
            style={{ flexGrow: 2 }}
          >
            <Check className="w-4 h-4" /> Uložit
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   MODAL – kurz EUR
============================================================ */

/* ============================================================
   POMOCNÉ FUNKCE PRO PŘEHLED
============================================================ */

// Spočítá souhrn jedné uložené cesty
function tripSummary(trip, eurRate) {
  let totalKm = 0, totalLiters = 0, totalCZK = 0;
  let totalLitersBenzin = 0, totalLitersNafta = 0;
  let firstDate = null, lastDate = null;
  let segCount = 0;
  let prevKmAfter = NaN;

  trip.items.forEach((it) => {
    if (it.date) {
      if (!firstDate || it.date < firstDate) firstDate = it.date;
      if (!lastDate  || it.date > lastDate)  lastDate  = it.date;
    }
    const liters = parseFloat(it.litersRefueled) || 0;
    const price  = parseFloat(it.fuelPrice)      || 0;
    const cost   = liters * price;
    const costCZK = it.currency === 'EUR' ? cost * eurRate : cost;

    totalLiters += liters;
    totalCZK    += costCZK;
    if (it.fuelType === 'diesel') totalLitersNafta += liters;
    else                          totalLitersBenzin += liters;

    if (it.type === 'segment') {
      segCount++;
      const isFirst = segCount === 1;
      const ownBefore = parseFloat(it.kmBefore);
      const before    = isFirst ? ownBefore : prevKmAfter;
      const after     = parseFloat(it.kmAfter);
      if (isFinite(before) && isFinite(after) && after > before) {
        totalKm += (after - before);
      }
      if (isFinite(after)) prevKmAfter = after;
    }
  });

  const avgConsumption = totalKm > 0 ? (totalLiters / totalKm) * 100 : 0;
  const pricePerKm     = totalKm > 0 ? totalCZK / totalKm : 0;
  const perPerson      = trip.participants > 0 ? totalCZK / trip.participants : totalCZK;

  return {
    totalKm, totalLiters, totalLitersBenzin, totalLitersNafta,
    totalCZK, avgConsumption, pricePerKm, perPerson,
    firstDate, lastDate, segCount,
  };
}

// Filtrace cest podle datumového rozsahu (na základě dat položek)
function filterTripsByDate(trips, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return trips;
  return trips.filter((t) => {
    const dates = t.items.map((i) => i.date).filter(Boolean).sort();
    if (dates.length === 0) return true; // žádná data => zachovej
    const first = dates[0];
    const last  = dates[dates.length - 1];
    if (dateFrom && last  < dateFrom) return false;
    if (dateTo   && first > dateTo)   return false;
    return true;
  });
}

// Export do Excelu
// CSV escaping pro Excel: zalomené uvozovky, středník jako oddělovač
function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[;"\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Stáhne CSV soubor (BOM + středník + CRLF, otevírá se přímo v Excelu i v Google Sheets)
function downloadCSV(filename, headers, rows) {
  const csvLines = [headers.join(';'), ...rows.map((r) => r.map(csvEscape).join(';'))];
  const csv = '\uFEFF' + csvLines.join('\r\n'); // BOM pro UTF-8 detekci v Excelu
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// Hlavní export – jeden CSV se všemi položkami (každý řádek má kontext o cestě)
function exportToCSV(trips, eurRate, vehicles) {
  if (trips.length === 0) return;

  const headers = [
    'Cesta', 'Vozidlo', 'Účastníci', 'Datum',
    'Typ', 'Č.', 'km Před', 'km Po', 'Vzdálenost',
    'Litry', 'Cena/L', 'Měna', 'Palivo',
    'Cena Kč', 'Cena na osobu Kč',
  ];

  const rows = [];
  trips.forEach((t) => {
    const v = vehicles.find((x) => x.id === t.vehicleId);
    const vehicleName = v?.name || '';
    const participants = Math.max(1, t.participants || 1);
    let segNum = 0;
    let prevKmAfter = NaN;

    t.items.forEach((it) => {
      const liters = parseFloat(it.litersRefueled) || 0;
      const price  = parseFloat(it.fuelPrice)      || 0;
      const cost   = liters * price;
      const costCZK = it.currency === 'EUR' ? cost * eurRate : cost;
      const perPerson = costCZK / participants;
      const fuel = it.fuelType === 'diesel' ? 'nafta' : 'benzín';

      if (it.type === 'segment') {
        segNum++;
        const isFirst = segNum === 1;
        const before  = isFirst ? parseFloat(it.kmBefore) : prevKmAfter;
        const after   = parseFloat(it.kmAfter);
        const dist    = (isFinite(before) && isFinite(after) && after > before) ? after - before : 0;
        if (isFinite(after)) prevKmAfter = after;

        rows.push([
          t.name, vehicleName, participants,
          it.date ? formatDate(it.date) : '',
          'úsek', segNum,
          isFinite(before) ? before : '',
          isFinite(after)  ? after  : '',
          dist || '',
          liters || '', price || '',
          it.currency || '', fuel,
          Math.round(costCZK), Math.round(perPerson),
        ]);
      } else {
        rows.push([
          t.name, vehicleName, participants,
          it.date ? formatDate(it.date) : '',
          'mezitank.', '',
          '', '', '',
          liters || '', price || '',
          it.currency || '', fuel,
          Math.round(costCZK), Math.round(perPerson),
        ]);
      }
    });
  });

  downloadCSV(`cestak-export-${todayISODate()}.csv`, headers, rows);
}

/* ============================================================
   ZÁLOŽKA: PŘEHLED / DASHBOARD
============================================================ */

function StatsView({ vehicles, savedTrips, deleteSavedTrip, reopenTrip, eurRate }) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');
  const [expanded, setExpanded] = useState(null); // id rozbalené cesty
  const [sortBy,   setSortBy]   = useState('newest'); // newest | oldest | expensive | longest

  // Preset filtry
  const presets = useMemo(() => {
    const today = todayISODate();
    const d = new Date();
    const offset = (n) => {
      const t = new Date();
      t.setDate(t.getDate() - n);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    };
    const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const yearStart  = `${d.getFullYear()}-01-01`;
    return [
      { id: 'all',   label: 'Vše',        from: '',          to: ''     },
      { id: '30d',   label: 'Posl. 30 d', from: offset(30),  to: today  },
      { id: 'month', label: 'Měsíc',      from: monthStart,  to: today  },
      { id: 'year',  label: 'Rok',        from: yearStart,   to: today  },
    ];
  }, []);

  // Vozidla, která se reálně objevila v uložených cestách
  const usedVehicleIds = useMemo(() => {
    const ids = new Set(savedTrips.map((t) => t.vehicleId));
    return vehicles.filter((v) => ids.has(v.id)).map((v) => v.id);
  }, [savedTrips]);

  // Filtr vozidel — výchozí stav: všechna vybraná
  const [selectedVehicleIds, setSelectedVehicleIds] = useState([]);
  useEffect(() => {
    setSelectedVehicleIds((prev) => {
      if (prev.length === 0) return usedVehicleIds;
      const next = prev.filter((id) => usedVehicleIds.includes(id));
      usedVehicleIds.forEach((id) => { if (!next.includes(id)) next.push(id); });
      return next;
    });
  }, [usedVehicleIds]);

  const toggleVehicle = (id) => {
    setSelectedVehicleIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const hasAnyFilter =
    dateFrom !== '' || dateTo !== '' ||
    (selectedVehicleIds.length > 0 && selectedVehicleIds.length < usedVehicleIds.length);

  // Filtrace cest podle data + vozidla
  const filtered = useMemo(() => {
    let result = filterTripsByDate(savedTrips, dateFrom, dateTo);
    if (selectedVehicleIds.length > 0 && selectedVehicleIds.length < usedVehicleIds.length) {
      result = result.filter((t) => selectedVehicleIds.includes(t.vehicleId));
    }
    return result;
  }, [savedTrips, dateFrom, dateTo, selectedVehicleIds, usedVehicleIds]);

  // Souhrny pro každou cestu
  const tripStats = useMemo(
    () => filtered.map((t) => ({ trip: t, stats: tripSummary(t, eurRate) })),
    [filtered, eurRate]
  );

  // Agregace
  const aggregate = useMemo(() => {
    let totalKm = 0, totalLiters = 0, totalCZK = 0;
    let totalLitersBenzin = 0, totalLitersNafta = 0;
    const perVehicle = {}; // vehicleId -> { km, l, czk }
    tripStats.forEach(({ trip, stats }) => {
      totalKm += stats.totalKm;
      totalLiters += stats.totalLiters;
      totalCZK += stats.totalCZK;
      totalLitersBenzin += stats.totalLitersBenzin;
      totalLitersNafta += stats.totalLitersNafta;
      const vid = trip.vehicleId;
      if (!perVehicle[vid]) perVehicle[vid] = { km: 0, l: 0, czk: 0 };
      perVehicle[vid].km  += stats.totalKm;
      perVehicle[vid].l   += stats.totalLiters;
      perVehicle[vid].czk += stats.totalCZK;
    });
    const avg = totalKm > 0 ? (totalLiters / totalKm) * 100 : 0;
    const pricePerKm = totalKm > 0 ? totalCZK / totalKm : 0;
    return {
      totalKm, totalLiters, totalCZK, avg, pricePerKm,
      totalLitersBenzin, totalLitersNafta,
      perVehicle, tripCount: filtered.length,
    };
  }, [tripStats, filtered]);

  // Data pro grafy
  const tripsChartData = useMemo(
    () => tripStats.slice(-10).map(({ trip, stats }) => ({
      name: trip.name.length > 12 ? trip.name.slice(0, 12) + '…' : trip.name,
      Kč: Math.round(stats.totalCZK),
      km: Math.round(stats.totalKm),
    })),
    [tripStats]
  );

  const fuelPieData = useMemo(() => {
    const data = [];
    if (aggregate.totalLitersBenzin > 0) data.push({ name: 'Benzín', value: Number(aggregate.totalLitersBenzin.toFixed(1)), color: '#fbbf24' });
    if (aggregate.totalLitersNafta  > 0) data.push({ name: 'Nafta',  value: Number(aggregate.totalLitersNafta.toFixed(1)),  color: '#3b82f6' });
    return data;
  }, [aggregate]);

  const vehicleChartData = useMemo(() => {
    return Object.entries(aggregate.perVehicle).map(([vid, v]) => {
      const veh = vehicles.find((x) => x.id === vid);
      return {
        name: veh?.name || vid,
        km:   Math.round(v.km),
      };
    }).sort((a, b) => b.km - a.km);
  }, [aggregate]);

  // Měsíční agregace pro time-series graf
  const monthlyData = useMemo(() => {
    const byMonth = {};
    tripStats.forEach(({ stats }) => {
      const key = stats.firstDate ? stats.firstDate.slice(0, 7) : null;
      if (!key) return;
      if (!byMonth[key]) byMonth[key] = { month: key, label: '', Kč: 0, km: 0 };
      byMonth[key].Kč += stats.totalCZK;
      byMonth[key].km += stats.totalKm;
    });
    Object.values(byMonth).forEach((d) => {
      const [y, m] = d.month.split('-');
      d.label = `${parseInt(m, 10)}/${y.slice(2)}`; // např. "5/26"
      d.Kč = Math.round(d.Kč);
      d.km = Math.round(d.km);
    });
    return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
  }, [tripStats]);

  // Seznam cest seřazený podle volby uživatele
  const sortedTripStats = useMemo(() => {
    const arr = [...tripStats];
    switch (sortBy) {
      case 'oldest':
        return arr.sort((a, b) => (a.stats.firstDate || '').localeCompare(b.stats.firstDate || ''));
      case 'expensive':
        return arr.sort((a, b) => b.stats.totalCZK - a.stats.totalCZK);
      case 'longest':
        return arr.sort((a, b) => b.stats.totalKm - a.stats.totalKm);
      case 'newest':
      default:
        return arr.sort((a, b) => (b.stats.lastDate || '').localeCompare(a.stats.lastDate || ''));
    }
  }, [tripStats, sortBy]);

  if (savedTrips.length === 0) {
    return (
      <div className="space-y-4 anim-fadein">
        <div className="bg-stone-900/70 border border-stone-800 rounded-2xl p-8 text-center">
          <Inbox className="w-10 h-10 mx-auto text-stone-600 mb-3" />
          <h3 className="font-display text-2xl mb-1.5">ZATÍM ŽÁDNÉ CESTY</h3>
          <p className="text-sm text-stone-400 leading-relaxed">
            Vyplň cestu v kalkulátoru a klikni na <span className="text-emerald-400 font-semibold">„Uložit cestu do přehledu"</span>.
            Tady pak uvidíš statistiky, grafy a budeš moct exportovat data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 anim-fadein pb-8">
      {/* FILTR + EXPORT */}
      <div className="bg-stone-900/70 border border-stone-800 rounded-2xl p-3 space-y-3">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-amber-400" />
          <span className="text-xs uppercase tracking-wider text-stone-500 font-semibold">Filtry</span>
          {hasAnyFilter && (
            <button
              onClick={() => {
                setDateFrom(''); setDateTo('');
                setSelectedVehicleIds(usedVehicleIds);
              }}
              className="ml-auto text-xs text-stone-500 hover:text-stone-200 underline"
            >
              vyčistit
            </button>
          )}
        </div>

        {/* Preset chipy */}
        <div className="flex gap-1.5 flex-wrap">
          {presets.map((p) => {
            const active = dateFrom === p.from && dateTo === p.to;
            return (
              <button
                key={p.id}
                onClick={() => { setDateFrom(p.from); setDateTo(p.to); }}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition active:scale-95 ${
                  active
                    ? 'bg-amber-500 text-stone-950'
                    : 'bg-stone-800 text-stone-400 hover:bg-stone-700 hover:text-stone-200'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Datumový rozsah */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-xs text-stone-500 mb-1">Od</div>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full bg-stone-800/60 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 text-sm font-mono focus:border-amber-500/70 focus:outline-none"
            />
          </div>
          <div>
            <div className="text-xs text-stone-500 mb-1">Do</div>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full bg-stone-800/60 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 text-sm font-mono focus:border-amber-500/70 focus:outline-none"
            />
          </div>
        </div>

        {/* Filtr vozidel - chipy */}
        {usedVehicleIds.length > 0 && (
          <div>
            <div className="text-xs text-stone-500 mb-1.5 flex items-center gap-1.5">
              <Car className="w-3 h-3" /> Vozidla
              <span className="text-stone-600 font-mono">
                ({selectedVehicleIds.length}/{usedVehicleIds.length})
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {usedVehicleIds.map((id) => {
                const v = vehicles.find((x) => x.id === id);
                const active = selectedVehicleIds.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => toggleVehicle(id)}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold transition active:scale-95 ${
                      active
                        ? 'bg-amber-500 text-stone-950'
                        : 'bg-stone-800 text-stone-500 hover:bg-stone-700 hover:text-stone-300'
                    }`}
                  >
                    {v?.name || id}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* EMPTY STATE — když filtry vyloučí všechno */}
      {filtered.length === 0 && (
        <div className="bg-stone-900/40 border border-stone-800 rounded-2xl p-6 text-center">
          <Filter className="w-8 h-8 mx-auto text-stone-600 mb-2" />
          <div className="text-sm text-stone-400">
            Žádné cesty neodpovídají vybraným filtrům.
          </div>
        </div>
      )}

      {/* OBSAH — pouze pokud filtr něco najde */}
      {filtered.length > 0 && (
      <>
      {/* KPI KARTY */}
      <div className="grid grid-cols-2 gap-2">
        <KpiCard label="Celkem cest"     value={aggregate.tripCount}                            unit=""        accent="amber" />
        <KpiCard label="Celkem km"       value={formatNumber(aggregate.totalKm, 0)}             unit="km"      accent="amber" />
        <KpiCard label="Celkem litrů"    value={formatNumber(aggregate.totalLiters, 1)}         unit="L"       accent="amber" />
        <KpiCard label="Průměrná spotř." value={formatNumber(aggregate.avg, 2)}                 unit="L/100km" accent="amber" />
        <KpiCard label="Celkové náklady" value={formatNumber(aggregate.totalCZK, 0)}            unit="Kč"      accent="emerald" big />
        <KpiCard label="Cena za 1 km"    value={formatNumber(aggregate.pricePerKm, 2)}          unit="Kč/km"   accent="emerald" big />
      </div>

      {/* GRAF — Měsíční náklady */}
      {monthlyData.length >= 2 && (
        <ChartCard title="MĚSÍČNÍ NÁKLADY">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyData} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
              <XAxis dataKey="label" tick={{ fill: '#a8a29e', fontSize: 10 }} />
              <YAxis tick={{ fill: '#a8a29e', fontSize: 10 }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1c1917', border: '1px solid #44403c', borderRadius: 8, fontSize: 12 }}
                formatter={(value, name) => [name === 'Kč' ? `${formatNumber(value, 0)} Kč` : `${value} km`, name]}
              />
              <Bar dataKey="Kč" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* GRAF — Cena za posledních 10 cest */}
      {tripsChartData.length > 0 && (
        <ChartCard title="POSLEDNÍCH 10 CEST · CENA">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={tripsChartData} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
              <XAxis dataKey="name" tick={{ fill: '#a8a29e', fontSize: 10 }} />
              <YAxis tick={{ fill: '#a8a29e', fontSize: 10 }} />
              <Tooltip contentStyle={{ backgroundColor: '#1c1917', border: '1px solid #44403c', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="Kč" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* GRAF — KM podle vozidla */}
      {vehicleChartData.length > 0 && (
        <ChartCard title="KM PODLE VOZIDLA">
          <ResponsiveContainer width="100%" height={Math.max(140, vehicleChartData.length * 36)}>
            <BarChart data={vehicleChartData} layout="vertical" margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
              <XAxis type="number" tick={{ fill: '#a8a29e', fontSize: 10 }} />
              <YAxis type="category" dataKey="name" tick={{ fill: '#a8a29e', fontSize: 11 }} width={80} />
              <Tooltip contentStyle={{ backgroundColor: '#1c1917', border: '1px solid #44403c', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="km" fill="#10b981" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* PIE — benzín vs nafta */}
      {fuelPieData.length > 0 && (
        <ChartCard title="POMĚR PALIV (LITRY)">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={fuelPieData}
                cx="50%" cy="50%"
                innerRadius={45} outerRadius={75}
                dataKey="value"
                label={({ name, value }) => `${name}: ${value} L`}
                labelLine={false}
              >
                {fuelPieData.map((entry, idx) => (
                  <Cell key={idx} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ backgroundColor: '#1c1917', border: '1px solid #44403c', borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* SEZNAM CEST */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1 flex-wrap">
          <Receipt className="w-4 h-4 text-amber-400" />
          <h3 className="font-display text-xl">SEZNAM CEST</h3>
          <span className="text-xs text-stone-500 font-mono">({filtered.length})</span>
        </div>

        {/* Sort chipy */}
        <div className="flex gap-1.5 flex-wrap px-1">
          {[
            { id: 'newest',    label: 'Nejnovější' },
            { id: 'oldest',    label: 'Nejstarší'  },
            { id: 'expensive', label: 'Nejdražší'  },
            { id: 'longest',   label: 'Nejdelší'   },
          ].map((s) => {
            const active = sortBy === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSortBy(s.id)}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition active:scale-95 ${
                  active
                    ? 'bg-stone-100 text-stone-950'
                    : 'bg-stone-800 text-stone-400 hover:bg-stone-700 hover:text-stone-200'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {sortedTripStats.map(({ trip, stats }) => {
          const v = vehicles.find((x) => x.id === trip.vehicleId);
          const isExpanded = expanded === trip.id;
          const meziCount  = trip.items.filter((i) => i.type === 'mezi').length;
          return (
            <div key={trip.id} className="bg-stone-900/70 border border-stone-800 rounded-2xl overflow-hidden">
              <button
                onClick={() => setExpanded(isExpanded ? null : trip.id)}
                className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-stone-800/40 transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-display text-lg leading-tight truncate">{trip.name}</div>
                  <div className="text-xs text-stone-500 font-mono mt-0.5">
                    {stats.firstDate ? formatDate(stats.firstDate) : '—'}
                    {stats.lastDate && stats.lastDate !== stats.firstDate ? ` → ${formatDate(stats.lastDate)}` : ''}
                    {' · '}{v?.name || ''}
                    {' · '}{trip.participants}× 👤
                  </div>
                  <div className="text-xs font-mono text-stone-400 mt-0.5">
                    {formatNumber(stats.totalKm, 0)} km · {formatNumber(stats.totalLiters, 1)} L · {formatNumber(stats.avgConsumption, 2)} L/100km
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono font-bold text-amber-400">{formatCZK(stats.totalCZK)}</div>
                  <div className="text-xs text-stone-500 font-mono">{formatNumber(stats.pricePerKm, 2)} Kč/km</div>
                </div>
                <ChevronRight className={`w-4 h-4 text-stone-500 transition shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
              </button>

              {isExpanded && (
                <div className="border-t border-stone-800 p-4 space-y-3 bg-stone-950/30">
                  {/* Stats grid */}
                  <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                    <div className="bg-stone-800/40 rounded-lg px-2.5 py-2">
                      <div className="text-stone-500 uppercase tracking-wider text-xs">Cena/os.</div>
                      <div className="text-stone-200 font-bold">{formatCZK(stats.perPerson)}</div>
                    </div>
                    <div className="bg-stone-800/40 rounded-lg px-2.5 py-2">
                      <div className="text-stone-500 uppercase tracking-wider text-xs">Úseků</div>
                      <div className="text-stone-200 font-bold">{stats.segCount}</div>
                    </div>
                    <div className="bg-stone-800/40 rounded-lg px-2.5 py-2">
                      <div className="text-stone-500 uppercase tracking-wider text-xs">Mezi</div>
                      <div className="text-stone-200 font-bold">{meziCount}</div>
                    </div>
                  </div>

                  {/* Akční tlačítka */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => {
                        if (confirm(`Otevřít cestu "${trip.name}" v kalkulátoru?\n\nAktuální rozpracovaná cesta bude nahrazena.`)) {
                          reopenTrip(trip);
                        }
                      }}
                      className="flex items-center justify-center gap-1.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-95 text-stone-950 text-sm font-bold transition"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Otevřít
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Smazat cestu "${trip.name}"?`)) deleteSavedTrip(trip.id);
                      }}
                      className="flex items-center justify-center gap-1.5 py-2 rounded-lg bg-red-500/15 hover:bg-red-500/25 active:scale-95 text-red-400 text-sm font-semibold transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Smazat
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* EXPORT — na konci dashboardu */}
      <div className="pt-2">
        <button
          onClick={() => exportToCSV(filtered, eurRate, vehicles)}
          disabled={filtered.length === 0}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed text-stone-200 font-semibold text-sm transition active:scale-95"
        >
          <Download className="w-4 h-4" />
          Stáhnout přehled (.csv) — {filtered.length} {filtered.length === 1 ? 'cesta' : (filtered.length < 5 ? 'cesty' : 'cest')}
        </button>
      </div>
      </>
      )}
    </div>
  );
}

function KpiCard({ label, value, unit, accent = 'amber', big = false }) {
  const accentClass = accent === 'emerald' ? 'text-emerald-400' : 'text-amber-400';
  return (
    <div className={`bg-stone-900/70 border border-stone-800 rounded-2xl p-3 ${big ? 'col-span-2' : ''}`}>
      <div className="text-xs uppercase tracking-wider text-stone-500 font-semibold">{label}</div>
      <div className={`font-display ${big ? 'text-3xl' : 'text-2xl'} ${accentClass} mt-1 leading-none`}>
        {value}
      </div>
      {unit && <div className="text-xs font-mono text-stone-500 mt-1">{unit}</div>}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="bg-stone-900/70 border border-stone-800 rounded-2xl p-3">
      <div className="text-xs uppercase tracking-wider text-stone-500 font-semibold mb-2 px-1">{title}</div>
      {children}
    </div>
  );
}

/* ============================================================
   MODAL — uložení cesty
============================================================ */

function SaveTripModal({ vehicles, tripName, setTripName, activeVehicleId, onClose, onSave }) {
  const [name, setName] = useState(tripName || buildDefaultTripName(vehicles, activeVehicleId));

  const handleSave = () => {
    const finalName = name.trim() || buildDefaultTripName(vehicles, activeVehicleId);
    setTripName(finalName);
    onSave(finalName);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-stone-900 border-t sm:border border-stone-700 rounded-t-3xl sm:rounded-3xl p-5 anim-fadein"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
              <Save className="w-5 h-5" />
            </div>
            <div>
              <div className="font-display text-2xl">ULOŽIT CESTU</div>
              <div className="text-xs text-stone-400">Uloží do přehledu a začne novou cestu</div>
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg bg-stone-800 hover:bg-stone-700 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Název cesty</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-3 text-stone-100 text-base focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 font-semibold transition active:scale-95"
          >
            Zrušit
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center justify-center gap-2 transition active:scale-95"
            style={{ flexGrow: 2 }}
          >
            <Check className="w-4 h-4" /> Uložit a nová
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   MODAL — kurz EUR
============================================================ */

function RateModal({ rate, rateMeta, rateInput, setRateInput, onClose, onSave, onRefresh }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-stone-900 border-t sm:border border-stone-700 rounded-t-3xl sm:rounded-3xl p-5 anim-fadein"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <ArrowRightLeft className="w-5 h-5" />
            </div>
            <div>
              <div className="font-display text-2xl">KURZ EUR</div>
              <div className="text-xs text-stone-400">
                {rateMeta.status === 'success' && rateMeta.date && `Stažen z ČNB · ${formatDate(rateMeta.date)}`}
                {rateMeta.status === 'manual' && 'Ručně zadaný kurz'}
                {rateMeta.status === 'error' && 'Používá se záložní hodnota'}
                {rateMeta.status === 'loading' && 'Načítám…'}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg bg-stone-800 hover:bg-stone-700 flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Info banner při fallback stavu */}
        {rateMeta.status === 'error' && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-4 text-xs text-stone-300 leading-relaxed">
            <div className="font-semibold text-amber-300 mb-1">Co to znamená?</div>
            Aplikace zkouší stáhnout kurz z <span className="font-mono text-amber-400">api.cnb.cz</span>. Pokud běží v sandboxu (např. v náhledu), externí síťové volání může být blokované — pak se používá záložní hodnota. <span className="text-amber-300">Po nasazení na vlastní web (GitHub Pages, Vercel) to půjde automaticky.</span> Mezitím můžeš zadat kurz ručně.
          </div>
        )}

        <div className="bg-stone-950/60 border border-stone-800 rounded-xl p-4 mb-4 text-center">
          <div className="text-xs uppercase tracking-wider text-stone-500 mb-1">Aktuálně použito</div>
          <div className="font-display text-4xl text-amber-400">
            1 € = <span className="font-mono">{formatNumber(rate, 3)}</span> Kč
          </div>
        </div>

        <button
          onClick={onRefresh}
          className="w-full py-3 mb-3 rounded-xl bg-stone-800 hover:bg-stone-700 flex items-center justify-center gap-2 font-semibold transition active:scale-95"
        >
          <RefreshCw className="w-4 h-4" /> Načíst aktuální kurz z ČNB
        </button>

        <div>
          <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Nebo zadej ručně</label>
          <div className="flex gap-2">
            <NumberField
              className="flex-1"
              value={rateInput}
              onChange={setRateInput}
              placeholder={String(rate.toFixed(3))}
              prefix="1 € ="
              suffix="Kč"
            />
            <button
              onClick={() => onSave(rateInput || rate)}
              className="px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-bold flex items-center gap-1.5 transition active:scale-95"
            >
              <Check className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   AUTH — loading + login/signup screen
============================================================ */

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 font-body flex items-center justify-center">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&display=swap');
        .font-body    { font-family: 'DM Sans', system-ui, sans-serif; }
        .font-display { font-family: 'Bebas Neue', sans-serif; letter-spacing: 0.04em; }
      `}</style>
      <div className="text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center animate-pulse">
          <Fuel className="w-6 h-6 text-stone-950" strokeWidth={2.5} />
        </div>
        <div className="font-display text-2xl text-stone-300">AUTO MONITORING</div>
        <div className="text-xs text-stone-500 mt-1">Načítám…</div>
      </div>
    </div>
  );
}

function AuthScreen() {
  const [mode, setMode]         = useState('login');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [info, setInfo]         = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!email) return;
    if ((mode === 'login' || mode === 'signup') && !password) return;
    setLoading(true); setError(''); setInfo('');
    try {
      if (mode === 'signup') {
        const { error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        setInfo('Účet vytvořen. Pokud je v Supabase zapnuté potvrzení e-mailu, podívej se do schránky.');
      } else if (mode === 'magic') {
        const { error: err } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        });
        if (err) throw err;
        setInfo('Zkontroluj si e-mail — poslali jsme ti přihlašovací odkaz.');
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
    } catch (err) {
      setError(err.message || 'Něco se pokazilo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 font-body flex items-center justify-center p-4">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&display=swap');
        .font-body    { font-family: 'DM Sans', system-ui, sans-serif; }
        .font-display { font-family: 'Bebas Neue', sans-serif; letter-spacing: 0.04em; }
        body { background: #0a0908; }
      `}</style>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
            <Fuel className="w-7 h-7 text-stone-950" strokeWidth={2.5} />
          </div>
          <div className="font-display text-3xl">AUTO MONITORING</div>
          <div className="text-xs uppercase tracking-widest text-stone-500 mt-1">palivo · vozidla</div>
        </div>

        <form onSubmit={submit} className="bg-stone-900/70 border border-stone-800 rounded-2xl p-5 space-y-3">
          <div className="grid grid-cols-3 gap-1 bg-stone-800/60 border border-stone-700 rounded-xl p-1">
            {[
              { id: 'login',  label: 'Přihlášení' },
              { id: 'signup', label: 'Registrace' },
              { id: 'magic',  label: 'E-mail link' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { setMode(m.id); setError(''); setInfo(''); }}
                className={`py-2 rounded-lg text-xs font-semibold transition ${
                  mode === m.id ? 'bg-amber-500 text-stone-950' : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'magic' && (
            <div className="bg-stone-800/40 border border-stone-700 rounded-xl px-3 py-2 text-xs text-stone-400">
              💡 Bez hesla — pošleme ti odkaz e-mailem, klikneš a jsi přihlášen/a.
            </div>
          )}

          <div>
            <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">E-mail</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            />
          </div>

          {(mode === 'login' || mode === 'signup') && (
            <div>
              <label className="text-xs uppercase tracking-wider text-stone-500 mb-1.5 block">Heslo</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={6}
                className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-stone-100 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
              />
              {mode === 'signup' && (
                <div className="text-xs text-stone-500 mt-1">Min. 6 znaků</div>
              )}
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {info && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs rounded-lg px-3 py-2">
              {info}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed text-stone-950 font-bold transition active:scale-95"
          >
            {loading ? '…' : (
              mode === 'login'  ? 'Přihlásit' :
              mode === 'signup' ? 'Vytvořit účet' :
              'Poslat přihlašovací odkaz'
            )}
          </button>
        </form>

        <div className="text-center text-xs text-stone-600 mt-6">
          Data se ukládají bezpečně do tvého účtu (Supabase + RLS).<br />
          Tvoje cesty uvidíš na všech zařízeních.
        </div>
      </div>
    </div>
  );
}
