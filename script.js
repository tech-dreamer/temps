const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';
if (!window.__supabase_client) {
  window.__supabase_client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
const client = window.__supabase_client;

let cities = [];
let hasSavedForecast = false;
let selectedHour = null;
let hourlyCurrentDateKey = '';
let isDailyPage = false;
let isHourlyPage = false;
const BACKUP_EMAIL_STREAK = 7;
const BACKUP_EMAIL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const HOURLY_LABELS = [
  // "Noon",
  "1PM",
  "2PM",
  "3PM",
  "4PM",
  "5PM",
  "6PM",
  "7PM",
  "8PM"
];
const HOURLY_GAME_SWITCH_HOUR_ET = 20; // 19
function setStatus(html) {
  const status = document.getElementById('status');
  if (status) status.innerHTML = html;
}

function detectPageMode() {
  isDailyPage = !!document.getElementById('tempsForm');
  isHourlyPage = !!document.getElementById('hourlyForm');
}

function isValidEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}

async function promptAndSaveBackupEmail(currentStreak) {
  if (currentStreak < BACKUP_EMAIL_STREAK) return;

  const {
    data: { user },
    error: userErr
  } = await client.auth.getUser();
  if (userErr || !user) return;

  if (user.email) return; // stop prompting once user saves an email

  const lastPromptedAt = user.user_metadata?.backup_email_prompted_at;
  if (!isPromptDue(currentStreak, lastPromptedAt)) return;

  const value = window.prompt("🎉 You reached a great 7+ day streak! Want to keep your progress across devices? Save a backup email to recover your account: ");

  if (!value) {
    await markBackupEmailPrompt();
    return;
  }

  const email = value.trim();
  if (!isValidEmail(email)) {
    setStatus('<span style="color:red;"> Please enter a valid email: </span>');
    await markBackupEmailPrompt();
    return;
  }

  const { error } = await client.auth.updateUser({ email });
  if (error) {
    setStatus(`<span style="color:red;"> Backup email save failed: ${error.message}</span>`);
    return;
  }

  await client.auth.updateUser({ data: { backup_email_prompted_at: null } });
  setStatus('<span style="color:green;"> Backup email saved, your progress safe ✅ </span>');
}

// Helper to get existing user or create new anon
let userId = null;
let ensureSessionPromise = null;

function getUserIdFromAuthPayload(data) {
  return data?.user?.id || data?.session?.user?.id || null;
}

function getSessionFromAuthPayload(data) {
  return data?.session || null;
}

async function createAnonymousSession() {
  try {
    const { data, error } = await client.auth.signInAnonymously();

    if (error) {
      console.error("Anon sign-in error:", error.message);
      return null;
    }

    const newUserId = getUserIdFromAuthPayload(data);
    if (!newUserId) {
      console.error("Anon sign-in returned no user id:", data);
      return null;
    }

    userId = newUserId;
    return getSessionFromAuthPayload(data);
  } catch (err) {
    console.error("Unexpected anon sign-in error:", err.message || err);
    return null;
  }
}

function isForeignKeyError(err) {
  if (!err) return false;
  return err.code === "23503" || /foreign key/i.test(err.message || "");
}

function getSessionRecoveryFailureMessage() {
  return "Save hitting a stale account reference (23503). Please make a Daily Forecast to create a new anon account, then try saving again.";
}

// Paste this block and replace your old refresh/recover/session save logic.

const AUTH_CALLBACK_URL = `${window.location.origin}/auth/callback`;
const MAGIC_LINK_RESEND_COOLDOWN_MS = 45_000;

let userId = null;
let ensureSessionPromise = null;
let lastMagicLinkSentAt = 0;
let authRecoveryState = null;

function isAnonymousUser(user) {
  return Boolean(
    user?.is_anonymous ||
    user?.app_metadata?.provider === "anon" ||
    user?.app_metadata?.provider === "anonymous"
  );
}

function setAuthRecoveryState(state) {
  authRecoveryState = state;
}

function popAuthRecoveryState() {
  const s = authRecoveryState;
  authRecoveryState = null;
  return s;
}

async function sendReauthMagicLink(email) {
  const now = Date.now();

  if (now - lastMagicLinkSentAt < MAGIC_LINK_RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      message:
        "A sign-in link was sent recently. Please check your inbox before sending again."
    };
  }

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: AUTH_CALLBACK_URL
    }
  });

  lastMagicLinkSentAt = now;

  if (error) {
    return {
      ok: false,
      message: `Could not send sign-in link: ${error.message}`
    };
  }

  return {
    ok: true,
    message:
      "Your account link is stale. We sent a sign-in link to your email. Please click it, then try again."
  };
}

async function refreshAndRecoverSession(currentSession = null) {
  const previousUser = currentSession?.user || null;

  try {
    await client.auth.signOut();
  } catch (_) {
    // ignore
  }

  if (!previousUser || isAnonymousUser(previousUser)) { // recovery for anon user or no prior session
    const anonSession = await createAnonymousSession();
    return { session: anonSession };
  }

  const email = previousUser.email; // verified user: do not auto-switch to anon recovery
  if (!email) {
    return {
      needsReauth: true,
      message: "Your account session is stale. Please sign in again."
    };
  }

  const magic = await sendReauthMagicLink(email);
  return {
    needsReauth: true,
    message:
      magic.message || "Your account link is stale. Please sign in again."
  };
}

async function ensureSession(forceRefresh = false) {
  if (!forceRefresh && ensureSessionPromise) return ensureSessionPromise;

  const run = async () => {
    const { data, error } = await client.auth.getSession();
    const session = data?.session || null;

    if (session?.user?.id && !error) {
      const { data: userData, error: userError } =
        await client.auth.getUser(session.access_token);

      if (!userError && userData?.user?.id === session.user.id) {
        userId = userData.user.id;
        authRecoveryState = null;
        return session;
      }

      console.warn(
        "Session is stale/deleted:",
        userError?.message || "user mismatch"
      );
    }

    const recovery = await refreshAndRecoverSession(session);

    if (recovery?.needsReauth) {
      setAuthRecoveryState({
        needsReauth: true,
        message: recovery.message || "Your account link is stale. Please sign in again."
      });
      return null;
    }

    const recoveredSession = recovery?.session || null;
    if (!recoveredSession?.user?.id) {
      setAuthRecoveryState({
        needsReauth: true,
        message: "Session recovery failed. Please sign in again."
      });
      return null;
    }

    userId = recoveredSession.user.id;
    authRecoveryState = null;
    return recoveredSession;
  };

  ensureSessionPromise = run().finally(() => {
    ensureSessionPromise = null;
  });

  return ensureSessionPromise;
}

async function upsertWithSessionRecovery(
  rows,
  tableName = "daily_forecasts",
  retries = 2
) {
  let payload = rows.map((r) => ({ ...r, user_id: userId }));

  for (let attempt = 0; attempt < retries; attempt++) {
    const session = await ensureSession(attempt > 0);

    const recoveryState = popAuthRecoveryState();
    if (recoveryState?.needsReauth) {
      return {
        data: null,
        error: new Error(recoveryState.message)
      };
    }

    const activeUserId = session?.user?.id || userId;
    if (!activeUserId) {
      return {
        data: null,
        error: new Error("No active user session.")
      };
    }

    const rowsWithUser = payload.map((r) => ({ ...r, user_id: activeUserId }));

    const { data, error } = await client
      .from(tableName)
      .upsert(rowsWithUser, { onConflict: "id" })
      .select();

    if (!error) {
      return { data, error: null };
    }

    if (error.code !== "23503" || attempt >= retries - 1) { // retry only for stale FK reference, otherwise return immediately
      return { data: null, error };
    }

    // FK/User reference stale -> recover and retry once
    const recovered = await ensureSession(true);

    const recoveryOnRetry = popAuthRecoveryState();
    if (recoveryOnRetry?.needsReauth) {
      return {
        data: null,
        error: new Error(recoveryOnRetry.message)
      };
    }

    const recoveredUserId = recovered?.user?.id || userId;
    if (!recoveredUserId) {
      return {
        data: null,
        error: new Error("Session recovery failed. Please sign in again.")
      };
    }

    if (recoveredUserId !== activeUserId) {
      payload = rows.map((r) => ({ ...r, user_id: recoveredUserId }));
      userId = recoveredUserId;
    }
  }

  return {
    data: null,
    error: new Error("Save failed after retries.")
  };
}

async function handleAuthCallbackFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hasCallback =
    params.has("code") || params.has("token_hash") || params.has("type");

  if (!hasCallback) return;

  const { error } = await client.auth.getSessionFromUrl({ storeSession: true });
  if (error) {
    console.error("Auth callback failed:", error.message);
  }
}

// Call this once during boot
document.addEventListener("DOMContentLoaded", async () => {
  await handleAuthCallbackFromUrl();
  // ...your existing DOMContentLoaded code...
});

async function loadUserScopedDataOrEmpty(queryBuilder) {
  const session = await ensureSession();
  if (!session?.user?.id) return [];
  userId = session.user.id;
  return queryBuilder().eq("user_id", userId);
}

// Check to increment user current streak
async function checkIncrementDailyStreak(payload, forecastDate) {
  // require at least 2 cities with daily high forecasts
  const newHighCityIds = new Set(
    payload
      .filter(p => p.high !== undefined && Number.isFinite(Number(p.high)))
      .map(p => p.city_id)
  );
  if (newHighCityIds.size < 2) return null;

  // get how many highs already exist for this date before submit
  const { data: existing, error: existErr } = await client
    .from('daily_forecasts')
    .select('city_id')
    .eq('user_id', userId)
    .eq('date', forecastDate)
    .not('high', 'is', null);

  if (existErr) {
    console.error('Failed to read existing highs:', existErr.message);
    return null;
  }

  const existingSet = new Set((existing || []).map(r => r.city_id));
  const countBefore = existingSet.size;

  newHighCityIds.forEach(id => existingSet.add(id));
  const countAfter = existingSet.size;

  if (countBefore >= 2 || countAfter < 2) return null;

  const { data: stats, error: statsErr } = await client // get current streak
    .from('user_stats')
    .select('current_streak')
    .eq('user_id', userId)
    .single();

  if (statsErr) {
    console.error('Failed to read user_stats:', statsErr.message);
    return null;
  }

  const nextStreak = Number(stats?.current_streak || 0) + 1;

  const { error: upErr } = await client // write new streak to user stats
    .from('user_stats')
    .update({ current_streak: nextStreak })
    .eq('user_id', userId);

  if (upErr) {
    console.error('Failed to update streak:', upErr.message);
    return null;
  }

  return nextStreak; // return updated value for email prompt
}

function isPromptDue(currentStreak, lastPromptedAtIso) {
  if (currentStreak < BACKUP_EMAIL_STREAK) return false;
  if (!lastPromptedAtIso) return true;

  const last = Date.parse(lastPromptedAtIso);
  if (Number.isNaN(last)) return true;

  return Date.now() - last >= BACKUP_EMAIL_INTERVAL_MS;
}

async function markBackupEmailPrompt() {
  const nowIso = new Date().toISOString();
  const { error } = await client.auth.updateUser({
    data: { backup_email_prompted_at: nowIso }
  });
  if (error) {
    console.error("Could not save prompt timestamp:", error.message);
  }
  return nowIso;
}

// Time helpers
function getCityLocalDateISO(timezone, offset = 0) {
  const now = new Date();
  const local = new Date(
    now.toLocaleString("en-US", { timeZone: timezone })
  );

  local.setDate(local.getDate() + offset);

  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getETGameDateISO(useTomorrow = false) {
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  if (useTomorrow) {
    etNow.setDate(etNow.getDate() + 1);
  }

  const year = etNow.getFullYear();
  const month = String(etNow.getMonth() + 1).padStart(2, '0');
  const day = String(etNow.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getPTNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
}

function getETNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

function getHourlyCutoff(etNow, hourValue) {
  const cutoff = new Date(etNow);
  const wholeHour = Math.floor(hourValue);
  const minuteMark = Number.isInteger(hourValue) ? 0 : 30;
  cutoff.setHours(wholeHour, minuteMark, 0, 0);
  cutoff.setMinutes(cutoff.getMinutes() - 30);
  return cutoff;
}

function isPastCutoffForHour(etNow, useTomorrow, hourValue) {
  if (useTomorrow) return false;
  return etNow >= getHourlyCutoff(etNow, hourValue);
}

function getHourlyGameDateMeta() {
  const etNow = getETNow();

  const switchTime = new Date(etNow);
  switchTime.setHours(HOURLY_GAME_SWITCH_HOUR_ET, 0, 0, 0);

  const useTomorrow = etNow >= switchTime;

  const labelDate = new Date(etNow);
  if (useTomorrow) {
    labelDate.setDate(labelDate.getDate() + 1);
  }

  return {
    etNow,
    useTomorrow,
    gameDate: getETGameDateISO(useTomorrow),
    gameDateLabel: labelDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric"
    })
  };
}

function updateHourlyCurrentDate() {
  const el = document.getElementById('currentHourlyDate');
  if (!el) return getHourlyGameDateMeta().gameDate;

  const state = getHourlyGameDateMeta();
  el.textContent = `Forecast date (ET): ${state.gameDateLabel}`;
  return state.gameDate;
}

function getStationDisplay(city) {
  const raw = String(city?.station || '').trim().toUpperCase();
  if (!raw) return '';
  return raw.startsWith("K") ? raw : `K${raw}`;
}

async function loadDailyData() {
  const now = new Date();

  const minDate = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
  const maxDate = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

  const { data: hourlyGuesses } = await client
    .from('hourly_forecasts')
    .select('city_id, hour, temp, date')
    .eq('user_id', userId);

  const { data: actuals } = await client
    .from('daily_actuals')
    .select('city_id, high, low, date');

  const { data: guesses } = await client
    .from('daily_forecasts')
    .select('city_id, high, low, date')
    .eq('user_id', userId)
    .gte('date', minDate)
    .lte('date', maxDate);

  return { actuals: actuals || [], guesses: guesses || [], hourlyGuesses: hourlyGuesses || [] };
}

// Update current date label on daily page
function updateCurrentDate() {
  const dateDisplay = document.getElementById('currentDate');
  const forecastDaySelect = document.getElementById('forecastDay');

  if (!dateDisplay || !forecastDaySelect) return;

  const now = new Date();
  const ptNow = getPTNow();
  const ptCutoff = new Date(ptNow);
  ptCutoff.setHours(12, 0, 0, 0);

  const dateKey = `${ptNow.getFullYear()}-${String(ptNow.getMonth() + 1).padStart(2, "0")}-${String(ptNow.getDate()).padStart(2, "0")}`;
  const autoSwitchKey = `temps_auto_switched_${dateKey}`;

  let hasAutoSwitched = false;
  try {
    hasAutoSwitched = sessionStorage.getItem(autoSwitchKey);
  } catch (e) {
    hasAutoSwitched = false;
  }

  if (ptNow >= ptCutoff && !hasAutoSwitched) {
    forecastDaySelect.value = "tomorrow";
    try {
      sessionStorage.setItem(autoSwitchKey, "true");
    } catch (e) {
      // storage blocked; ignore
    }
  }

  const ptToday = ptNow.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric"
  });

  const tomorrow = new Date(ptNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const ptTomorrow = tomorrow.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric"
  });

  dateDisplay.textContent =
    forecastDaySelect.value === "today"
      ? ptToday
      : ptTomorrow;
}

async function loadCities() {
  const statusEl = document.getElementById('status');

  const { data, error } = await client
    .from('cities')
    .select('id, name, station, timezone_id, timezones(name)')
    .order('timezone_id', { ascending: false });

  if (error || !data) {
    if (statusEl) statusEl.innerHTML =
      '<span style="color:red;">Failed to load cities.</span>';
    return;
  }

  for (const datum of data) {
    datum.timezone = datum.timezones?.name;
    delete datum.timezones;
    delete datum.timezone_id;
  }

  cities = data;
  buildDailyGrid();
  updateCurrentDate();

  if (isHourlyPage) {
    hourlyCurrentDateKey = updateHourlyCurrentDate();
  }
}

async function buildDailyGrid() {
  const grid = document.getElementById('dailyGrid');
  const forecastDaySelect = document.getElementById('forecastDay');
  if (!grid || !forecastDaySelect) return;

  grid.innerHTML = '<p>Loading cities...</p>';

  const { actuals, guesses } = await loadDailyData();
  grid.innerHTML = '';

  const forecastDay = forecastDaySelect.value;

  cities.forEach(city => {
    const stationDisplay = getStationDisplay(city);

    const cityToday = getCityLocalDateISO(city.timezone, 0);
    const cityTomorrow = getCityLocalDateISO(city.timezone, 1);
    const cityYesterday = getCityLocalDateISO(city.timezone, -1);

    const targetDate = forecastDay === 'today' ? cityToday : cityTomorrow;
    const showYesterday = forecastDay === 'today';

    const cityActuals = actuals
      .filter(a => a.city_id === city.id && a.date <= cityYesterday)
      .sort((a, b) => b.date.localeCompare(a.date));

    const yesterdayHigh = showYesterday && cityActuals.length ? cityActuals[0].high : ' ';
    const yesterdayLow = showYesterday && cityActuals.length ? cityActuals[0].low : ' ';

    const prevGuess = guesses.find(
      g => g.city_id === city.id && g.date === targetDate
    ) || {};

    const hasPrevGuess = prevGuess.high !== undefined || prevGuess.low !== undefined;

    // Cutoff check (noon local time)
    const now = new Date();
    const ptNow = getPTNow();

    const localNow = new Date(
      now.toLocaleString("en-US", { timeZone: city.timezone })
    );

    const cutoff = new Date(localNow);
    cutoff.setHours(12, 0, 0, 0);

    const ptCutoff = new Date(ptNow);
    ptCutoff.setHours(12, 0, 0, 0);

    const isPastCutoff =
      forecastDay === 'today' &&
      (ptNow >= ptCutoff || localNow >= cutoff);

    const card = document.createElement('div');
    card.className =
      hasSavedForecast ? 'city-card expanded' : 'city-card collapsed';

    card.innerHTML = `
      <div class="city-card-header">
        <span class="city-title">${city.name}</span>
        ${stationDisplay ? `<small class="city-station">(${stationDisplay})</small>` : ''}
      </div>
      <div class="city-card-content">
        ${showYesterday
          ? `<p><small>Yesterday: H ${yesterdayHigh}° / L ${yesterdayLow}°</small></p>`
          : ''}

        ${hasPrevGuess
          ? `<p><small>Your current forecast: H ${prevGuess.high ?? '-'}° / L ${prevGuess.low ?? '-'}°</small></p>`
          : ''}

        <label>High Temp °F:
          <input type="number"
            class="daily-high"
            data-city-id="${city.id}"
            value="${prevGuess.high ?? ''}"
            min="-25" max="125"
            ${isPastCutoff ? 'disabled' : ''}>
        </label>

        <label>Low Temp °F:
          <input type="number"
            class="daily-low"
            data-city-id="${city.id}"
            value="${prevGuess.low ?? ''}"
            min="-50" max="100"
            ${isPastCutoff ? 'disabled' : ''}>
        </label>

        ${isPastCutoff
          ? '<small style="color:#e74c3c; display:block; margin-top:0.5rem;">Past cutoff (noon local)</small>'
          : ''}
      </div>
    `;

    grid.appendChild(card);
  });
}

function buildHourSelector() {
  const container = document.getElementById('hourSelector');
  if (!container) return;

  container.innerHTML = '';

  HOURLY_LABELS.forEach(label => {
    const box = document.createElement('div');
    box.className = 'hour-box';
    box.textContent = label;

    box.addEventListener('click', () => {
      document.querySelectorAll('.hour-box')
        .forEach(b => b.classList.remove('active'));

      box.classList.add('active');
      selectedHour = label;

      buildHourlyGrid();
      updateHourlyButton();
    });

    container.appendChild(box);
  });
}

async function buildHourlyGrid() {
  const { hourlyGuesses } = await loadDailyData();
  const grid = document.getElementById('hourlyGrid');
  if (!grid || !selectedHour) return;

  const hourlyState = getHourlyGameDateMeta();
  const etNow = hourlyState.etNow;
  const useTomorrow = hourlyState.useTomorrow;
  const selectedForecastDate = hourlyState.gameDate;

  const hourNum = convertHourLabel(selectedHour);
  const showSixHrHigh = hourNum === 14 || hourNum === 20;
  const sixHrHourNum = showSixHrHigh ? hourNum + 0.5 : null;

  grid.innerHTML = '';

  cities.forEach(city => {
    const localLabel = convertETToCityHourLabel(hourNum, city.timezone);
    const isPastCutoff = isPastCutoffForHour(etNow, useTomorrow, hourNum);

    const prevGuess = hourlyGuesses.find(
      g =>
        g.city_id === city.id &&
        g.hour === hourNum &&
        g.date === selectedForecastDate
    );

    const prev6HrGuess = sixHrHourNum !== null ? hourlyGuesses.find(
      g =>
        g.city_id === city.id &&
        g.hour === sixHrHourNum &&
        g.date === selectedForecastDate
    ) : null;

    const card = document.createElement('div');
    card.className = 'city-card expanded';
    card.dataset.cityId = city.id;
    card.innerHTML = `
      <div class="city-card-header">${city.name}</div>
      <div class="city-card-content">
        <label>
          Temp °F at ${localLabel}:
          <input type="number"
            class="hourly-input"
            data-city-id="${city.id}"
            data-hour="${hourNum}"
            value="${prevGuess?.temp ?? ''}"
            min="-25"
            max="125"
            ${isPastCutoff ? 'disabled' : ''}>
        </label>

        ${sixHrHourNum !== null ? `
          <label>
            6-hr High °F:
            <input type="number"
              class="hourly-input"
              data-city-id="${city.id}"
              data-hour="${sixHrHourNum}"
              value="${prev6HrGuess?.temp ?? ''}"
              min="-25"
              max="125"
              ${isPastCutoff ? 'disabled' : ''}>
          </label>
        ` : ''}

        ${isPastCutoff
          ? '<small style="color:#e74c3c;">Past cutoff</small>'
          : ''}
      </div>
    `;

    grid.appendChild(card);
  });
}

function convertHourLabel(label) {
  let num = parseInt(label);
  if (label.includes("PM") && num !== 12) num += 12;
  return num;
}

function convertETToCityHourLabel(etHour, cityTimezone) {
  const now = new Date();

  const etDate = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  const hourPart = Math.floor(etHour);
  const minutePart = Number.isInteger(etHour) ? 0 : 30;

  etDate.setHours(hourPart, minutePart, 0, 0);

  const cityTime = new Date(
    etDate.toLocaleString("en-US", { timeZone: cityTimezone })
  );

  let hours = cityTime.getHours();
  const minutes = cityTime.getMinutes();

  const period = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;

  const minuteText = minutes === 0 ? "" : `:${String(minutes).padStart(2, '0')}`;
  return `${hours}${minuteText} ${period}`;
}

function updateHourlyButton() {
  const btn = document.getElementById('hourlySaveBtn');
  if (!btn) return;

  if (!selectedHour) {
    btn.disabled = true;
    btn.textContent = "Select an Hour";
  } else {
    btn.disabled = false;
    btn.textContent = `Save ${selectedHour} Forecasts`;
  }
}

// Click handler (works on both pages)
document.addEventListener('click', (e) => {
  const header = e.target.closest('.city-card-header');
  if (!header) return;

  if (!hasSavedForecast) {
    document.querySelectorAll('.city-card').forEach(card => {
      card.classList.remove('collapsed');
      card.classList.add('expanded');
    });
  }
});

// Daily save handler
async function handleDailySubmit(e) {
  e.preventDefault();

  const forecastDaySelect = document.getElementById('forecastDay');
  if (!forecastDaySelect) return;

  const forecastDay = forecastDaySelect.value;
  const payload = [];
  const forecastDates = new Set();
  let blocked = false;

  document.querySelectorAll('.daily-high, .daily-low').forEach(input => {
    const val = input.value.trim();
    if (!val) return;

    const cityId = Number(input.dataset.cityId);
    const city = cities.find(c => c.id === cityId);
    if (!city) return;

    const localNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: city.timezone })
    );

    const cutoff = new Date(localNow);
    cutoff.setHours(12, 0, 0, 0);

    if (forecastDay === 'today' && localNow >= cutoff) {
      blocked = true;
      return;
    }

    const dateValue =
      forecastDay === 'today'
        ? getCityLocalDateISO(city.timezone, 0)
        : getCityLocalDateISO(city.timezone, 1);

    const type = input.classList.contains('daily-high') ? 'high' : 'low';

    let entry = payload.find(p => p.city_id === cityId);
    if (!entry) {
      entry = {
        city_id: cityId,
        city: city.name,
        date: dateValue,
        user_id: userId
      };
      payload.push(entry);
    }

    entry[type] = Number(val);
    forecastDates.add(dateValue);
  });

  if (blocked) {
    setStatus('<span style="color:red;"> Cutoff passed for at least 1 city </span>');
    return;
  }

  if (!payload.length) {
    setStatus('<span style="color:red;"> Enter at least 1 valid forecast! </span>');
    return;
  }

  const { error } = await upsertWithSessionRecovery({
    table: 'daily_forecasts',
    rows: payload,
    onConflict: 'user_id,city_id,date'
  });

  if (error) {
    setStatus(`<span style="color:red;"> Save failed: ${error.message}</span>`);
    return;
  }

  hasSavedForecast = true;
  setStatus(`<span style="color:green;"> Saved ${payload.length} forecasts! 🐰 </span>`);
  buildDailyGrid();

  // check streak for each forecast date used (safe if timezone edge case creates >1)
  for (const forecastDate of forecastDates) {
    const updatedStreak = await checkIncrementDailyStreak(payload, forecastDate);
    if (updatedStreak !== null) {
      await promptAndSaveBackupEmail(updatedStreak);
      break;
    }
  }
}

// Hourly save handler
async function handleHourlySubmit(e) {
  e.preventDefault();

  const status = document.getElementById("status");
  const cityRows = new Map(); // cityId -> row data for validation
  const payload = [];

  if (!selectedHour) {
    if (status) status.innerHTML = '<span style="color:red;">Select an hour first.</span>';
    return;
  }

  const clearInput = (input) => {
    if (!input) return;
    input.style.borderColor = "";
    input.style.boxShadow = "";
    input.style.backgroundColor = "";
  };

  const markInvalid = (input) => {
    if (!input) return;
    input.style.borderColor = "#dc2626";
    input.style.boxShadow = "0 0 0 1px #dc2626";
    input.style.backgroundColor = "#fef2f2";
  };

  document.querySelectorAll(".hourly-validation-msg").forEach(el => el.remove());
  document.querySelectorAll(".hourly-input").forEach(clearInput);

  const hourlyState = getHourlyGameDateMeta();
  const etNow = hourlyState.etNow;
  const useTomorrow = hourlyState.useTomorrow;
  const selectedForecastDate = hourlyState.gameDate;
  const selectedHourNum = convertHourLabel(selectedHour);
  const showSixHrHigh = selectedHourNum === 14 || selectedHourNum === 20;
  const selectedCutoff = getHourlyCutoff(etNow, selectedHourNum);
  const sixHrHourNum = showSixHrHigh ? selectedHourNum + 0.5 : null;

  if (!Number.isFinite(selectedHourNum)) {
    setStatus('<span style="color:red;">Invalid selected hour.</span>');
    return;
  }

  let blocked = false;
  const EPS = 1e-6;
  const sameHour = (a, b) =>
    Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < EPS;

  document.querySelectorAll(".hourly-input").forEach((input) => {
    if (input.disabled) return;

    const raw = input.value.trim();
    if (!raw) return;

    const cityId = Number(input.dataset.cityId);
    const inputHour = Number(input.dataset.hour);
    const numVal = Number(raw);

    if (Number.isNaN(cityId) || Number.isNaN(inputHour) || Number.isNaN(numVal)) return;

    if (!useTomorrow && etNow >= selectedCutoff) {
      blocked = true;
      return;
    }

    const city = cities.find((c) => c.id === cityId);
    if (!city) return;

    const row = cityRows.get(cityId) || {
      cityName: city.name,
      cityId,
      hourlyVal: undefined,
      sixHrVal: undefined,
      sixHrInput: null
    };

    if (sameHour(inputHour, selectedHourNum)) {
      row.hourlyVal = numVal;
    }

    if (sameHour(inputHour, sixHrHourNum)) {
      row.sixHrVal = numVal;
      row.sixHrInput = input;
    }

    cityRows.set(cityId, row);

    payload.push({
      city_id: cityId,
      city: city.name,
      date: selectedForecastDate,
      hour: inputHour,
      temp: numVal,
      user_id: userId
    });
  });

  if (blocked) {
    setStatus('<span style="color:red;">Cutoff passed for this hour selection.</span>');
    return;
  }

  if (!payload.length) {
    setStatus('<span style="color:red;">Enter at least 1 forecast.</span>');
    return;
  }

  const validationMessages = [];

  cityRows.forEach((row, cityId) => {
    if (!row.sixHrInput) return; // no 6-hr rule if no 6-hr input entered

    const cityCard = document.querySelector(`#hourlyGrid .city-card[data-city-id="${cityId}"]`);
    const msgHost = cityCard?.querySelector(".city-card-content");

    if (row.hourlyVal === undefined) {
      markInvalid(row.sixHrInput);
      validationMessages.push(`${row.cityName}: 6-hr high requires the hourly ${selectedHour} forecast first.`);
    } else if (row.sixHrVal < row.hourlyVal) {
      markInvalid(row.sixHrInput);
      validationMessages.push(
        `${row.cityName}: 6-hr high (${row.sixHrVal}°F) must be >= hourly temp (${row.hourlyVal}°F).`
      );
    }

    if (validationMessages.length && msgHost) {
      if (!msgHost.querySelector('.hourly-validation-msg')) {
        msgHost.insertAdjacentHTML(
          "beforeend",
          `<div class="hourly-validation-msg" style="color:#dc2626; margin-top:.4rem;">Fix invalid 6-hr input.</div>`
        );
      }
    }
  });

  if (validationMessages.length) {
    setStatus(`<span style="color:red;">${validationMessages.join("<br>")}</span>`);
    return;
  }

  const { error } = await upsertWithSessionRecovery({
    table: 'hourly_forecasts',
    rows: payload,
    onConflict: 'user_id,city_id,date,hour'
  });

  if (error) {
    setStatus(`<span style="color:red;">Save failed: ${error.message}</span>`);
  } else {
    setStatus(`<span style="color:green;">Saved ${selectedHour} forecasts! 🐰</span>`);
    await buildHourlyGrid();
  }
}

function initRevealBtn() {
  const revealBtn = document.getElementById("revealBtn");
  if (!revealBtn) return;

  revealBtn.addEventListener("click", () => {
    window.location.href = `score.html?mode=${isHourlyPage ? 'hourly' : 'daily'}`;
  });
}

function initBindings() {
  const forecastDaySelect = document.getElementById('forecastDay');
  if (forecastDaySelect) {
    forecastDaySelect.addEventListener('change', () => {
      updateCurrentDate();
      buildDailyGrid();
    });
  }

  const dailyForm = document.getElementById('tempsForm');
  if (dailyForm) {
    dailyForm.addEventListener('submit', handleDailySubmit);
  }

  const hourlyForm = document.getElementById('hourlyForm');
  if (hourlyForm) {
    hourlyForm.addEventListener('submit', handleHourlySubmit);
  }

  initRevealBtn();
}

document.addEventListener('DOMContentLoaded', async () => {
  await handleAuthCallbackFromUrl();
  detectPageMode();
  initBindings();

  if (typeof initDailyHelpModal === 'function') {
    initDailyHelpModal();
  }

  const session = await ensureSession();
  if (!session?.user?.id) {
    setStatus('<span style="color:red;"> Unable to start session </span>');
    return;
  }

  await loadCities();

  if (document.getElementById('hourSelector')) {
    buildHourSelector();
  }

  setInterval(() => {
    if (typeof shouldCheckNow === 'function' ? shouldCheckNow() : true) {
      updateCurrentDate();
      buildDailyGrid();
    }

    if (isHourlyPage) {
      const current = updateHourlyCurrentDate();
      if (current !== hourlyCurrentDateKey) {
        hourlyCurrentDateKey = current;
        if (selectedHour) buildHourlyGrid();
      }
    }
  }, 60000);
});
