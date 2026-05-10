/* ============================================================
   NOTIFIER — denně projde všechna vozidla všech uživatelů
   a pošle e-mail těm, kterým něco vyprší za 30 nebo 7 dní.
============================================================ */

// Seznam vozidel musí být sync s VEHICLES v App.jsx
// (kdyby se měnil, uprav i tady — alternativně bys mohl vehicles
//  ukládat se jménem v user_data, ale to by chtělo refactor app)
const VEHICLES = [
  { id: 'toyota',      name: 'Toyota'       },
  { id: 'transporter', name: 'Transporter'  },
  { id: 'roomster',    name: 'Roomster'     },
  { id: 'volvo',       name: 'Volvo'        },
  { id: 'nissan',      name: 'Nissan'       },
  { id: 'trailer-1',   name: 'Vozík 1'      },
  { id: 'trailer-2',   name: 'Vozík 2'      },
  { id: 'trailer-3',   name: 'Vozík 3'      },
  { id: 'trailer-4',   name: 'Vozík 4'      },
  { id: 'trailer-5',   name: 'Vozík 5'      },
];

const DOC_LABELS = {
  stk:       'STK',
  insurance: 'Pojištění',
  vignette:  'Dálniční známka',
};

// Defaultní nastavení – pokud uživatel nemá v DB notification-settings
const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: true,
  email: '',          // prázdné = použít přihlašovací e-mail z auth.users
  daysBefore: [30, 7],
  docTypes: { stk: true, insurance: true, vignette: true },
};

// Kolik dní před expirací poslat upozornění (deprecated – nahrazeno user settings)
const NOTIFICATION_DAYS_LABELS = {
  60: '2 měsíce',
  30: 'měsíc',
  14: '2 týdny',
  7:  '7 dní',
  3:  '3 dny',
  1:  '1 den',
};

function dayLabel(days) {
  return NOTIFICATION_DAYS_LABELS[days] || `${days} dní`;
}

/* ----------------------------- HLAVNÍ FCE ----------------------------- */

export async function runNotifications(env) {
  const summary = {
    timestamp: new Date().toISOString(),
    users_scanned: 0,
    notifications_due: 0,
    emails_sent: 0,
    skipped_disabled: 0,
    errors: [],
  };

  try {
    // 1. Vytáhneme všechna data o vozidlech (jeden řádek per uživatel)
    const dataRes = await sb(env, 'GET',
      '/rest/v1/user_data?key=eq.vehicles-data&select=user_id,value'
    );
    if (!dataRes.ok) {
      summary.errors.push(`Fetch user_data failed: ${dataRes.status} ${await dataRes.text()}`);
      return summary;
    }
    const userData = await dataRes.json();
    summary.users_scanned = userData.length;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // 2. Pro každého uživatele najdeme expirující doklady a pošleme mail
    for (const row of userData) {
      try {
        const userId   = row.user_id;
        const vehiclesData = row.value;
        if (!vehiclesData || typeof vehiclesData !== 'object') continue;

        // Načteme uživatelská nastavení notifikací (může být null = použít default)
        const settings = await getUserSettings(env, userId);
        if (!settings.enabled) {
          summary.skipped_disabled++;
          continue;
        }

        // Načteme uživatelský seznam vozidel (s názvy)
        const vehiclesList = await getUserVehicles(env, userId);

        const expiring = findExpiringDocs(vehiclesData, vehiclesList, today, settings);
        if (expiring.length === 0) continue;

        // Filtr: jen ty, které jsme ještě neposlali
        const newOnes = [];
        for (const notif of expiring) {
          const already = await checkSent(env, userId, notif);
          if (!already) newOnes.push(notif);
        }
        if (newOnes.length === 0) continue;

        // E-mail uživatele:
        //   1. settings.email (uživatelská preference) má prioritu
        //   2. auth.users.email jako fallback
        let toEmail = settings.email || '';
        if (!toEmail) {
          const userInfo = await getUserEmail(env, userId);
          toEmail = userInfo?.email || '';
        }
        if (!toEmail) {
          summary.errors.push(`User ${userId}: no email found`);
          continue;
        }

        // Pošli jeden e-mail s všemi novými notifikacemi
        const ok = await sendNotificationEmail(env, toEmail, newOnes);
        if (ok) {
          summary.emails_sent++;
          for (const notif of newOnes) {
            await logSent(env, userId, notif);
            summary.notifications_due++;
          }
        } else {
          summary.errors.push(`Email send failed for ${toEmail}`);
        }
      } catch (e) {
        summary.errors.push(`User ${row.user_id}: ${e.message || e}`);
      }
    }
  } catch (e) {
    summary.errors.push(`Fatal: ${e.message || e}`);
  }

  console.log('Notifications run:', JSON.stringify(summary));
  return summary;
}

/* ----------------------------- USER SETTINGS ----------------------------- */

async function getUserSettings(env, userId) {
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    key: 'eq.notification-settings',
    select: 'value',
    limit: '1',
  });
  const res = await sb(env, 'GET', `/rest/v1/user_data?${params}`);
  if (!res.ok) return DEFAULT_NOTIFICATION_SETTINGS;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return DEFAULT_NOTIFICATION_SETTINGS;
  const userSettings = data[0].value || {};
  return {
    enabled:    userSettings.enabled !== false,
    email:      typeof userSettings.email === 'string' ? userSettings.email.trim() : '',
    daysBefore: Array.isArray(userSettings.daysBefore) && userSettings.daysBefore.length > 0
                ? userSettings.daysBefore
                : DEFAULT_NOTIFICATION_SETTINGS.daysBefore,
    docTypes:   { ...DEFAULT_NOTIFICATION_SETTINGS.docTypes, ...(userSettings.docTypes || {}) },
  };
}

async function getUserVehicles(env, userId) {
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    key: 'eq.vehicles-list',
    select: 'value',
    limit: '1',
  });
  const res = await sb(env, 'GET', `/rest/v1/user_data?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return Array.isArray(data[0].value) ? data[0].value : null;
}

/* ----------------------------- BUSINESS LOGIKA ----------------------------- */

function findExpiringDocs(vehiclesData, vehiclesList, today, settings) {
  const result = [];
  const allVehicles = Array.isArray(vehiclesList) && vehiclesList.length > 0
    ? vehiclesList
    : VEHICLES;

  for (const [vehicleId, vehicleEntry] of Object.entries(vehiclesData)) {
    if (!vehicleEntry || typeof vehicleEntry !== 'object') continue;

    const meta = allVehicles.find((v) => v.id === vehicleId);
    const vehicleName = meta?.name || vehicleId;

    // Doklady mohou být buď přímo na vehicleEntry, nebo v vehicleEntry.docs (variantní strukura)
    const docs = vehicleEntry.docs || vehicleEntry;

    for (const docType of Object.keys(DOC_LABELS)) {
      // Filtr: uživatel mohl tento typ dokladu vypnout v nastavení
      if (settings.docTypes && settings.docTypes[docType] === false) continue;

      const docInfo = docs[docType];
      const dateTo = docInfo?.dateTo;
      if (!dateTo) continue;

      const expDate = new Date(dateTo + 'T00:00:00Z');
      if (isNaN(expDate.getTime())) continue;

      const daysLeft = Math.round((expDate - today) / 86400000);

      // Projdeme uživatelské "kolik dní předem"
      for (const days of settings.daysBefore) {
        if (daysLeft === days) {
          result.push({
            vehicleId,
            vehicleName,
            docType,
            docLabel: DOC_LABELS[docType] || docType,
            expirationDate: dateTo,
            notificationType: `d${days}`,   // unikátní per počet dní pro dedup
            daysAhead: dayLabel(days),
            daysLeft,
          });
        }
      }
    }
  }
  return result;
}

/* ----------------------------- DEDUPE ----------------------------- */

async function checkSent(env, userId, notif) {
  const params = new URLSearchParams({
    user_id:           `eq.${userId}`,
    vehicle_id:        `eq.${notif.vehicleId}`,
    doc_type:          `eq.${notif.docType}`,
    expiration_date:   `eq.${notif.expirationDate}`,
    notification_type: `eq.${notif.notificationType}`,
    select:            'id',
    limit:             '1',
  });
  const res = await sb(env, 'GET', `/rest/v1/notifications_sent?${params}`);
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function logSent(env, userId, notif) {
  await sb(env, 'POST', '/rest/v1/notifications_sent', {
    user_id:           userId,
    vehicle_id:        notif.vehicleId,
    doc_type:          notif.docType,
    expiration_date:   notif.expirationDate,
    notification_type: notif.notificationType,
  });
}

/* ----------------------------- EMAIL ----------------------------- */

async function getUserEmail(env, userId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return null;
  return await res.json();
}

async function sendNotificationEmail(env, toEmail, notifications) {
  const itemsHtml = notifications.map((n) => `
    <tr>
      <td style="padding:14px 16px; border-bottom:1px solid #e7e5e4; vertical-align:top;">
        <strong style="color:#1c1917;">${escapeHtml(n.vehicleName)}</strong>
      </td>
      <td style="padding:14px 16px; border-bottom:1px solid #e7e5e4; color:#44403c;">
        ${escapeHtml(n.docLabel)}
      </td>
      <td style="padding:14px 16px; border-bottom:1px solid #e7e5e4; color:#d97706; font-weight:700; white-space:nowrap;">
        ${formatCzechDate(n.expirationDate)}
      </td>
      <td style="padding:14px 16px; border-bottom:1px solid #e7e5e4; color:#78716c; white-space:nowrap;">
        za ${escapeHtml(n.daysAhead)}
      </td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auto monitoring — připomínka termínu</title>
</head>
<body style="margin:0; padding:24px; background:#f5f5f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; color:#1c1917;">
  <div style="max-width:600px; margin:0 auto; background:white; border-radius:14px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.06);">
    <div style="background:linear-gradient(135deg, #fbbf24 0%, #d97706 100%); padding:28px 24px;">
      <h1 style="margin:0; color:#1c1917; font-size:32px; font-weight:700; letter-spacing:0.04em;">🚗 AUTO MONITORING</h1>
      <p style="margin:6px 0 0; color:#451a03; font-size:14px; font-weight:500;">Připomínka termínů</p>
    </div>
    <div style="padding:28px 24px;">
      <p style="margin:0 0 12px; font-size:16px;">Ahoj,</p>
      <p style="margin:0 0 20px; font-size:15px; color:#44403c; line-height:1.5;">
        blíží se vypršení následujících dokladů. Doporučujeme si je co nejdřív obnovit.
      </p>
      <table style="width:100%; border-collapse:collapse; margin:8px 0 24px; font-size:14px; border:1px solid #e7e5e4; border-radius:8px; overflow:hidden;">
        <thead>
          <tr style="background:#fafaf9;">
            <th style="padding:10px 16px; text-align:left; font-size:11px; text-transform:uppercase; color:#78716c; letter-spacing:0.05em;">Vozidlo</th>
            <th style="padding:10px 16px; text-align:left; font-size:11px; text-transform:uppercase; color:#78716c; letter-spacing:0.05em;">Doklad</th>
            <th style="padding:10px 16px; text-align:left; font-size:11px; text-transform:uppercase; color:#78716c; letter-spacing:0.05em;">Vyprší</th>
            <th style="padding:10px 16px; text-align:left; font-size:11px; text-transform:uppercase; color:#78716c; letter-spacing:0.05em;">Za</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <p style="text-align:center; margin:28px 0 8px;">
        <a href="${escapeHtml(env.APP_URL || '#')}" style="display:inline-block; padding:14px 28px; background:#d97706; color:white; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px;">
          Otevřít Auto monitoring
        </a>
      </p>
      <hr style="border:none; border-top:1px solid #e7e5e4; margin:28px 0 16px;">
      <p style="color:#a8a29e; font-size:12px; line-height:1.5; margin:0;">
        Tento e-mail jsi dostal/a, protože v aplikaci Auto monitoring máš zaregistrované doklady k vozidlům.
        Notifikace přijdou <strong>měsíc</strong> a <strong>týden</strong> před vypršením.
      </p>
    </div>
  </div>
</body>
</html>`;

  const subject = notifications.length === 1
    ? `Auto monitoring: ${notifications[0].vehicleName} — ${notifications[0].docLabel} vyprší za ${notifications[0].daysAhead}`
    : `Auto monitoring: ${notifications.length} připomínek termínů`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [toEmail],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', res.status, err);
    return false;
  }
  return true;
}

/* ----------------------------- HELPERY ----------------------------- */

// Volání Supabase REST API se service-role klíčem (obchází RLS)
async function sb(env, method, path, body) {
  const opts = {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(`${env.SUPABASE_URL}${path}`, opts);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCzechDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)}. ${parseInt(m, 10)}. ${y}`;
}
