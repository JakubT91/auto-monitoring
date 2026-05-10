// ============================================================
// Auto monitoring — Notifications Worker (clean rewrite)
// ============================================================

const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: true,
  email: '',
  daysBefore: [30, 7],
  docTypes: { stk: true, insurance: true, vignette: true },
};

const DOC_LABELS = { stk: 'STK', insurance: 'Pojištění', vignette: 'Dálniční známka' };
const DEFAULT_YEARS = { stk: 2, insurance: 1, vignette: 1 };

// Spočítá konec platnosti z "from" (datum) + počtu let
function calcExpiry(fromIso, years) {
  if (!fromIso) return null;
  const d = new Date(fromIso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCFullYear(d.getUTCFullYear() + (years || 1));
  return d;
}

async function sb(env, method, path, body) {
  const url = env.SUPABASE_URL + path;
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function getKeyForUser(env, userId, key) {
  const res = await sb(env, 'GET',
    `/rest/v1/user_data?user_id=eq.${userId}&key=eq.${key}&select=value&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.value ?? null;
}

async function getUserEmail(env, userId) {
  const res = await sb(env, 'GET', `/auth/v1/admin/users/${userId}`);
  if (!res.ok) return null;
  const u = await res.json();
  return u.email || null;
}

export async function runNotifications(env) {
  const summary = { timestamp: new Date().toISOString(), users_scanned: 0, notifications_due: 0, emails_sent: 0, skipped_disabled: 0, errors: [] };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);

  // 1) Najdi všechny usery, kteří mají vehicles-data
  const dataRes = await sb(env, 'GET', '/rest/v1/user_data?key=eq.vehicles-data&select=user_id,value');
  if (!dataRes.ok) {
    summary.errors.push(`Fetch user_data failed: ${dataRes.status} ${await dataRes.text()}`);
    return summary;
  }
  const userRows = await dataRes.json();

  for (const row of userRows) {
    summary.users_scanned++;
    const userId = row.user_id;
    const vehiclesData = row.value || {};
    console.log('USER:', userId, 'vehiclesData keys:', Object.keys(vehiclesData));

    const settingsVal = await getKeyForUser(env, userId, 'notification-settings');
    const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(settingsVal || {}) };
    if (!settings.enabled) { summary.skipped_disabled++; continue; }

    const vehiclesList = (await getKeyForUser(env, userId, 'vehicles-list')) || [];
    console.log('VEHICLES_LIST:', JSON.stringify(vehiclesList));

    const userEmail = settings.email?.trim() || (await getUserEmail(env, userId));
    if (!userEmail) { summary.errors.push(`No email for user ${userId}`); continue; }

    // 2) Pro každé vozidlo zkontroluj termíny
    const expiring = [];
    for (const [vehicleId, docs] of Object.entries(vehiclesData)) {
      if (!docs || typeof docs !== 'object') continue;
      const meta = vehiclesList.find(v => v.id === vehicleId) || {};
      const vehicleName = meta.name || vehicleId;

      for (const docType of ['stk', 'insurance', 'vignette']) {
        if (!settings.docTypes[docType]) continue;
        const docEntry = docs[docType];
        if (!docEntry || !docEntry.from) continue;

        const years = docType === 'stk' ? (meta.stkYears || DEFAULT_YEARS.stk) : DEFAULT_YEARS[docType];
        const expDate = calcExpiry(docEntry.from, years);
        if (!expDate) continue;

        const daysLeft = Math.round((expDate - today) / 86400000);
        console.log('CHECK:', vehicleName, docType, 'from:', docEntry.from, 'years:', years, 'expDate:', expDate.toISOString(), 'daysLeft:', daysLeft, 'thresholds:', settings.daysBefore);

        for (const d of settings.daysBefore) {
          if (Math.abs(daysLeft - d) <= 1) {
            expiring.push({ vehicleId, vehicleName, docType, docLabel: DOC_LABELS[docType], expiry: expDate.toISOString().slice(0, 10), daysAhead: d, daysLeft });
            break;
          }
        }
      }
    }

    if (expiring.length === 0) continue;
    summary.notifications_due += expiring.length;
    console.log('EXPIRING for user:', expiring);

    // 3) Pošli email přes Resend
    const emailBody = expiring.map(e => `<li><b>${e.vehicleName}</b> — ${e.docLabel} vyprší ${e.expiry} (za ${e.daysLeft} dní)</li>`).join('');
    const html = `<h2>Auto monitoring — připomínka</h2><ul>${emailBody}</ul><p><a href="${env.APP_URL}">Otevřít aplikaci</a></p>`;
    const subject = expiring.length === 1
      ? `Auto monitoring: ${expiring[0].vehicleName} — ${expiring[0].docLabel} vyprší za ${expiring[0].daysLeft} dní`
      : `Auto monitoring: ${expiring.length} připomínek termínů`;

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.FROM_EMAIL, to: userEmail, subject, html }),
    });
    if (sendRes.ok) {
      summary.emails_sent++;
      console.log('EMAIL SENT to', userEmail);
    } else {
      summary.errors.push(`Resend failed for ${userEmail}: ${sendRes.status} ${await sendRes.text()}`);
    }
  }

  return summary;
}
