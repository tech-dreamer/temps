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
function setStatus(html, append = false) {
  const status = document.getElementById('status');
  if (!status) return;

  status.innerHTML = append && status.innerHTML
    ? `${status.innerHTML}<br>${html}`
    : html;
}

function detectPageMode() {
  isDailyPage = !!document.getElementById('tempsForm');
  isHourlyPage = !!document.getElementById('hourlyForm');
}

function isValidEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}

const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

function isInvalidRefreshTokenError(err) { 
  const msg = String(err?.message || err?.error_description || "");
  return (
    err?.status === 400 &&
    (err?.code === "invalid_refresh_token" ||
      err?.code === "refresh_token_not_found" ||
      err?.code === "invalid_grant" ||
      /Invalid Refresh Token/i.test(msg) ||
      /refresh token not found/i.test(msg))
  );
}

function clearSupabaseAuthStorage() {
  const collectAndRemove = (store) => {
    const keys = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key) continue;
      if (
        key === "supabase.auth.token" ||
        key === `sb-${PROJECT_REF}-auth-token` ||
        (key.startsWith("sb-") && key.includes("auth-token"))
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) store.removeItem(key);
  };

  try {
    collectAndRemove(localStorage);
    collectAndRemove(sessionStorage);
  } catch (_) {}
}

async function recoverByResettingAuth({ allowAnonymous = false } = {}) {    // auto recover from stale/invalid refresh token
  try { await client.auth.signOut({ scope: "global" }); } catch (_) {}
  clearSupabaseAuthStorage();

  if (!allowAnonymous) return null;
  return createAnonymousSession();
}

async function promptAndSaveBackupEmail(currentStreak) {
  if (currentStreak < BACKUP_EMAIL_STREAK) return;

  const {
    data: { user },
    error: userErr
  } = await client.auth.getUser();
  if (userErr || !user) return;

  if (user.email) return;    // stop prompting once user saves an email

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

const AUTH_CALLBACK_URL = `${window.location.origin}/auth/callback`;
const MAGIC_LINK_RESEND_COOLDOWN_MS = 45_000;

let userId = null;
let ensureSessionPromise = null;
let ensureSessionPromiseMode = null;
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
  if (state?.needsReauth) userId = null;    // clear stale user id
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

async function refreshAndRecoverSession(currentSession = null, options = {}) {
  const { allowAnonymous = false } = options;
  const previousUser = currentSession?.user || null;

  try { await client.auth.signOut({ scope: "global" }); } catch (_) {}
  clearSupabaseAuthStorage();

  if (!previousUser || isAnonymousUser(previousUser)) {
    if (!allowAnonymous) return null;    // no auto-create anon unless explicitly allowed
    const anonSession = await createAnonymousSession();
    return { session: anonSession };
  }

  const email = previousUser.email;    // verified user: no auto-switch to anon recovery
  if (!email) {
    userId = null;
    return {
      needsReauth: true,
      message: "Your account session is stale. Please sign in again."
    };
  }

  const magic = await sendReauthMagicLink(email);
  if (magic?.ok !== true) {
    userId = null;
  }
  userId = null;
  return {
    needsReauth: true,
    message:
      magic.message || "Your account link is stale. Please sign in again."
  };
}

// Helper to get existing user or create new anon user
async function ensureSession(forceRefresh = false, options = {}) {
  const { allowAnonymous = false } = options;

  if (
    ensureSessionPromise &&
    !forceRefresh &&
    ensureSessionPromiseMode === allowAnonymous
  ) {
    return ensureSessionPromise;
  }

  const run = async () => {
    let session = null;
    let error = null;

    try {
      const result = await client.auth.getSession();
      session = result?.data?.session || null;
      error = result?.error || null;
    } catch (err) {
      error = err;
    }

    if (error) {
      if (isInvalidRefreshTokenError(error)) {
        console.warn("Invalid refresh token detected, attempting recovery...");
        const recovery = await refreshAndRecoverSession(session, { allowAnonymous });

        if (recovery?.needsReauth) {
          setAuthRecoveryState({
            needsReauth: true,
            message: recovery.message || "Your account link is stale. Please sign in again."
          });
          return null;
        }

        const recoveredSession = recovery?.session || null;
        if (!recoveredSession?.user?.id) {
          userId = null;
          return null;
        }

        userId = recoveredSession.user.id;
        authRecoveryState = null;
        return recoveredSession;
      }

      console.warn("Session retrieval failed:", error.message || error);
      return null;
    }

    if (session?.user?.id) {
      const { data: userData, error: userError } = await client.auth.getUser(
        session.access_token
      );

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

    const recovery = await refreshAndRecoverSession(session, { allowAnonymous });

    if (recovery?.needsReauth) {
      setAuthRecoveryState({
        needsReauth: true,
        message: recovery.message || "Your account link is stale. Please sign in again."
      });
      return null;
    }

    const recoveredSession = recovery?.session || null;
    if (!recoveredSession?.user?.id) {
      userId = null;
      return null;
    }

    userId = recoveredSession.user.id;
    authRecoveryState = null;
    return recoveredSession;
  };

  ensureSessionPromiseMode = allowAnonymous;
  ensureSessionPromise = run().finally(() => {
    ensureSessionPromise = null;
    ensureSessionPromiseMode = null;
  });

  return ensureSessionPromise;
}

async function upsertWithSessionRecovery({
  rows = [],
  table = "daily_forecasts",
  onConflict = "id",
  retries = 2,
  allowAnonymous = false
}) {
  let payload = rows.map((r) => ({ ...r, user_id: userId }));

  for (let attempt = 0; attempt < retries; attempt++) {
    const session = await ensureSession(attempt > 0, { allowAnonymous });

    const recoveryState = popAuthRecoveryState();
    if (recoveryState?.needsReauth) {
      userId = null;
      return { data: null, error: new Error(recoveryState.message) };
    }

    const activeUserId = session?.user?.id || userId;
    if (!activeUserId) {
      return { data: null, error: new Error("No active user session.") };
    }

    const rowsWithUser = payload.map((r) => ({ ...r, user_id: activeUserId }));

    const { data, error } = await client
      .from(table)
      .upsert(rowsWithUser, { onConflict })
      .select();

    if (!error) return { data, error: null, userId: activeUserId }

    if (error.code !== "23503" || attempt >= retries - 1) {
      return { data: null, error };
    }

    const recovered = await ensureSession(true, { allowAnonymous });
    const recoveryOnRetry = popAuthRecoveryState();
    if (recoveryOnRetry?.needsReauth) {
      userId = null;
      return { data: null, error: new Error(recoveryOnRetry.message) };
    }

    const recoveredUserId = recovered?.user?.id || userId;
    if (!recoveredUserId) {
      return { data: null, error: new Error("Session recovery failed. Please sign in again.") };
    }

    if (recoveredUserId !== activeUserId) {
      payload = rows.map((r) => ({ ...r, user_id: recoveredUserId }));
      userId = recoveredUserId;
    }
  }

  return { data: null, error: new Error("Save failed after retries.") };
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

async function loadUserScopedDataOrEmpty(queryBuilder) {
  const session = await ensureSession();
  if (!session?.user?.id) return [];
  userId = session.user.id;
  return queryBuilder().eq("user_id", userId);
}

// Predict if this submit will reach daily streak threshold
async function checkIncrementDailyStreak(payload, forecastDate, explicitUserId = null) {
  const uid = explicitUserId || userId;
  if (!uid) return { ok: false, reason: 'NO_USER_ID' };

  const newHighCityIds = new Set(
    payload
      .filter((p) =>
        p.date === forecastDate &&
        p.high !== null &&
        p.high !== undefined &&
        Number.isFinite(Number(p.high))
      )
      .map((p) => Number(p.city_id))
  );

  if (newHighCityIds.size === 0) {
    return { ok: false, reason: 'NO_HIGHS_IN_PAYLOAD' };
  }

  const { data: existing, error: existErr } = await client
    .from('daily_forecasts')
    .select('city_id')
    .eq('user_id', uid)
    .eq('date', forecastDate)
    .not('high', 'is', null);

  if (existErr) {
    return { ok: false, reason: 'FETCH_EXISTING_FAILED', error: existErr.message };
  }

  const existingSet = new Set((existing || []).map((r) => Number(r.city_id)));
  const countBefore = existingSet.size;
  const countAfter = new Set([...existingSet, ...newHighCityIds]).size;

  if (countBefore >= 2) return { ok: false, reason: 'ALREADY_REACHED_THRESHOLD', countBefore, countAfter };
  if (countAfter < 2) return { ok: false, reason: 'RESULT_STILL_UNDER_THRESHOLD', countBefore, countAfter };

  const { data: stats, error: statsErr } = await client
    .from('user_stats')
    .select('current_streak')
    .eq('user_id', uid)
    .maybeSingle();

  if (statsErr) {
    return { ok: false, reason: 'FETCH_STATS_FAILED', error: statsErr.message };
  }

  return {
    ok: true,
    reason: 'STREAK_WOULD_INCREMENT',
    countBefore,
    countAfter,
    nextStreak: Number(stats?.current_streak || 0) + 1
  };
}

// Update user's current mood & streak
async function incrementDailyStreak(uid, nextStreak) {
  try {
    const { data: row, error: readError } = await client    // read current values
      .from("user_stats")
      .select("current_streak, mood")
      .eq("user_id", uid)
      .maybeSingle();

    if (readError) return { ok: false, error: readError };

    const prevStreak = Number(row?.current_streak ?? 0) || 0;
    const prevMood = Number(row?.mood ?? 0) || 0;
    const nextMood = Math.min(25, prevMood + 1);

    const { data: updated, error } = await client
      .from("user_stats")
      .upsert(
        { user_id: uid, current_streak: nextStreak, mood: nextMood },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (error) return { ok: false, error };

    const moodCapped = prevMood >= 25;
    const message = moodCapped
      ? `🎉 Yay, your streak grew to ${nextStreak}! Mood is maxed at 25.`
      : `🎉 Yay, your streak grew to ${nextStreak}! Mood rose +1 to ${nextMood}.`;

    return {
      ok: true,
      data: updated,
      prevStreak,
      nextStreak,
      prevMood,
      nextMood,
      moodCapped,
      message,
    };
  } catch (err) {
    return { ok: false, error: err };
  }
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
function getTzDate(timeZone, date = new Date()) {    // get a timezone-normalized UTC Date to avoid browser timezone bug
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    })
      .formatToParts(date)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value])
  );

  return new Date(
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second)
    )
  );
}

function formatMonthDayInTZ(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric"
  }).format(date);
}

function toYMD(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

function getCityLocalDateISO(tz, offsetDays = 0) {    // get local date of city
  const d = getTzDate(tz);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return toYMD(d);
}

function getDailyForecastDateISO(forecastDay = "today") {    // get forecast date based on PT
  const ptNow = getPTNow();
  const ptCutoff = new Date(ptNow.getTime());
  ptCutoff.setUTCHours(12, 0, 0, 0);

  const gameDate = new Date(ptNow.getTime());

  if (ptNow >= ptCutoff) {    // daily date switch at noon PT
    gameDate.setUTCDate(gameDate.getUTCDate() + 1);
  }

  if (forecastDay === "tomorrow") {    // forecast date switch
    gameDate.setUTCDate(gameDate.getUTCDate() + 1);
  }

  return toYMD(gameDate);
}

function getETNow() { return getTzDate("America/New_York"); }
function getPTNow() { return getTzDate("America/Los_Angeles"); }

function getETGameDateISO(useTomorrow = false) {
  const etNow = getETNow();
  const gameDate = new Date(etNow.getTime());
  if (useTomorrow) {
    gameDate.setUTCDate(gameDate.getUTCDate() + 1);
  }

  return toYMD(gameDate);
}

function getHourlyCutoff(etNow, hourValue) {
  const cutoff = new Date(etNow.getTime());
  const wholeHour = Math.floor(hourValue);
  const minuteMark = Number.isInteger(hourValue) ? 0 : 30;

  cutoff.setUTCHours(wholeHour, minuteMark, 0, 0);
  cutoff.setUTCMinutes(cutoff.getUTCMinutes() - 30);

  return cutoff;
}

function isPastCutoffForHour(etNow, useTomorrow, hourValue) {
  if (useTomorrow) return false;
  return etNow >= getHourlyCutoff(etNow, hourValue);
}

// Compute hourly game date context and display label
function getHourlyGameDateMeta() {
  const etNow = getETNow();

  const switchTime = new Date(etNow.getTime());
  switchTime.setUTCHours(HOURLY_GAME_SWITCH_HOUR_ET, 0, 0, 0);

  const useTomorrow = etNow >= switchTime;

  const labelDate = new Date(etNow.getTime());
  if (useTomorrow) {
    labelDate.setUTCDate(labelDate.getUTCDate() + 1);
  }

  return {
    etNow,
    useTomorrow,
    gameDate: getETGameDateISO(useTomorrow),
    gameDateLabel: formatMonthDayInTZ(labelDate, "America/New_York")
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

async function queryOrThrow(promise, label) {
  try {
    const { data, error } = await promise;
    if (error) throw new Error(`${label} failed: ${error.message}`);
    return data || [];
  } catch (err) {
    console.error(err);
    throw new Error(`${label} failed: ${err.message || err}`);
  }
}

async function loadForecastData({
  date = getDailyForecastDateISO("today"),
  userIdValue = userId,
  includeActuals = false,
  includeGuesses = true,
  table = "daily_forecasts",
  clientInstance = client
} = {}) {
  if (!clientInstance?.from) throw new Error("Supabase client is missing");
  if (!userIdValue) return { actuals: [], guesses: [] };

  const targetDate = date;
  const [actuals, guesses] = await Promise.all([
    includeActuals ? queryOrThrow(clientInstance.from("daily_actuals").select("*").eq("date", targetDate), "Load actuals") : Promise.resolve([]),
    includeGuesses ? queryOrThrow(
      clientInstance.from(table).select("*").eq("user_id", userIdValue).eq("date", targetDate),
      "Load forecasts"
    ) : Promise.resolve([])
  ]);

  return { actuals, guesses };
}

// Update current date label on daily page
function updateCurrentDate() {
  const dateDisplay = document.getElementById('currentDate');
  const forecastDaySelect = document.getElementById('forecastDay');

  if (!dateDisplay || !forecastDaySelect) return;

  const ptNow = getPTNow();
  const ptCutoff = new Date(ptNow.getTime());
  ptCutoff.setUTCHours(12, 0, 0, 0);

  const dateKey = toYMD(ptNow);
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
    } catch (e) {}    // storage blocked; ignore
  }

  const ptToday = formatMonthDayInTZ(ptNow, "America/Los_Angeles");

  const tomorrow = new Date(ptNow.getTime());
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const ptTomorrow = formatMonthDayInTZ(tomorrow, "America/Los_Angeles");

  dateDisplay.textContent = forecastDaySelect.value === "today" ? ptToday : ptTomorrow;
}

async function loadCities() {
  const statusEl = document.getElementById('status');

  const { data, error } = await client
    .from('cities')
    .select('id, name, station, timezone_id, timezones(name)')
    .order('timezone_id', { ascending: false });

  if (error || !data) {
    if (statusEl) statusEl.innerHTML =
      '<span style="color:red;"> Failed to load cities </span>';
    return;
  }

  for (const datum of data) {
    datum.timezone = datum.timezones?.name || "UTC";
    delete datum.timezones;
    delete datum.timezone_id;
  }

  cities = data;
  updateCurrentDate();
  await buildDailyGrid();

  if (isHourlyPage) {
    hourlyCurrentDateKey = updateHourlyCurrentDate();
  }
}

async function buildDailyGrid() {
  const grid = document.getElementById("dailyGrid");
  const forecastDaySelect = document.getElementById("forecastDay");
  if (!grid || !forecastDaySelect) return;
  grid.innerHTML = "<p>Loading cities...</p>";

  const forecastDay = forecastDaySelect.value || "today";
  const forecastDate = getDailyForecastDateISO(forecastDay);

  let actuals = [];
  let guesses = [];

  if (userId) {
    try {
      const result = await loadForecastData({ date: forecastDate, userIdValue: userId, includeActuals: true, table: "daily_forecasts" });
      actuals = result?.actuals || [];
      guesses = result?.guesses || [];
    } catch (err) {
      console.error("buildDailyGrid data load failed:", err);
    }
  }

  grid.innerHTML = "";
  if (!Array.isArray(cities) || cities.length === 0) {
    grid.innerHTML = "<p>No cities found.</p>";
    return;
  }

  const ptNow = getPTNow();
  const ptCutoff = new Date(ptNow);
  ptCutoff.setUTCHours(12, 0, 0, 0);

  cities.forEach((city) => {
    const stationDisplay = getStationDisplay(city);
    const cityTz = city.timezone || "UTC";
    const cityYesterday = getCityLocalDateISO(cityTz, -1);
    const showYesterday = forecastDay === "today";
    const targetDate = forecastDate;

    const cityActuals = (Array.isArray(actuals) ? actuals : [])
      .filter((a) =>
        Number(a?.city_id) === Number(city.id) &&
        String(a.date) <= cityYesterday
      )
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const yesterdayHigh = showYesterday && cityActuals.length ? cityActuals[0].high : " ";
    const yesterdayLow = showYesterday && cityActuals.length ? cityActuals[0].low : " ";

    const prevGuess = (Array.isArray(guesses) ? guesses : []).find(
      (g) => Number(g.city_id) === Number(city.id) && String(g.date) === targetDate
    ) || {};

    const hasPrevGuess = prevGuess.high !== undefined || prevGuess.low !== undefined;

    const localNow = getTzDate(city.timezone || "UTC");
    const cutoff = new Date(localNow.getTime());
    cutoff.setUTCHours(12, 0, 0, 0);

    const isPastCutoff =
      forecastDay === "today" && (ptNow >= ptCutoff || localNow >= cutoff);

    const card = document.createElement("div");
    card.className = hasSavedForecast ? "city-card expanded" : "city-card collapsed";

    card.innerHTML = `
      <div class="city-card-header">
        <span class="city-title">${city.name}</span>
        ${stationDisplay ? `<small class="city-station">(${stationDisplay})</small>` : ""}
      </div>
      <div class="city-card-content">
        ${showYesterday
          ? `<p><small>Yesterday: H ${yesterdayHigh}° / L ${yesterdayLow}°</small></p>`
          : ""}

        ${hasPrevGuess
          ? `<p><small> My current forecast: H ${prevGuess.high ?? "-"}° / L ${prevGuess.low ?? "-"}° </small></p>`
          : ""}

        <label>High Temp °F:
          <input type="number"
            class="daily-high"
            data-city-id="${Number(city.id)}"
            value="${prevGuess.high ?? ""}"
            min="-25" max="125"
            ${isPastCutoff ? "disabled" : ""}>
        </label>

        <label>Low Temp °F:
          <input type="number"
            class="daily-low"
            data-city-id="${Number(city.id)}"
            value="${prevGuess.low ?? ""}"
            min="-50" max="100"
            ${isPastCutoff ? "disabled" : ""}>
        </label>

        ${isPastCutoff
          ? '<small style="color:#e74c3c; display:block; margin-top:0.5rem;"> Past cutoff (noon local) </small>'
          : ""}
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
  const grid = document.getElementById("hourlyGrid");
  if (!grid || !selectedHour) return;

  const hourlyState = getHourlyGameDateMeta();
  const { guesses: hourlyGuesses = [] } = await loadForecastData({ date: hourlyState.gameDate, userIdValue: userId, includeActuals: false, table: "hourly_forecasts" });

  const etNow = hourlyState.etNow;
  const useTomorrow = hourlyState.useTomorrow;
  const selectedForecastDate = hourlyState.gameDate;

  const hourNum = convertHourLabel(selectedHour);
  const showSixHrHigh = hourNum === 14 || hourNum === 20;
  const sixHrHourNum = showSixHrHigh ? hourNum + 0.5 : null;

  grid.innerHTML = "";
  cities.forEach((city) => {
    const localLabel = convertETToCityHourLabel(hourNum, city.timezone || "UTC");
    const isPastCutoff = isPastCutoffForHour(etNow, useTomorrow, hourNum);

    const prevGuess = hourlyGuesses.find(
      (g) =>
        Number(g.city_id) === Number(city.id) &&
        Number(g.hour) === hourNum &&
        String(g.date) === selectedForecastDate
    );

    const prev6HrGuess =
      sixHrHourNum !== null
        ? hourlyGuesses.find(
            (g) =>
              Number(g.city_id) === Number(city.id) &&
              Number(g.hour) === sixHrHourNum &&
              String(g.date) === selectedForecastDate
          )
        : null;

    const card = document.createElement("div");
    card.className = "city-card expanded";
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
            value="${prevGuess?.temp ?? ""}"
            min="-25"
            max="125"
            ${isPastCutoff ? "disabled" : ""}>
        </label>

        ${sixHrHourNum !== null ? `
          <label>
            6-hr High °F:
            <input type="number"
              class="hourly-input"
              data-city-id="${city.id}"
              data-hour="${sixHrHourNum}"
              value="${prev6HrGuess?.temp ?? ""}"
              min="-25"
              max="125"
              ${isPastCutoff ? "disabled" : ""}>
          </label>
        ` : ""}

        ${isPastCutoff ? '<small style="color:#e74c3c;">Past cutoff</small>' : ""}
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
  const etNow = getETNow();
  const etMarker = new Date(etNow.getTime());

  const hourPart = Math.floor(etHour);
  const minutePart = Number.isInteger(etHour) ? 0 : 30;
  etMarker.setUTCHours(hourPart, minutePart, 0, 0);

  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: cityTimezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(etMarker);

  return label.replace(":00", "");
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
  const forecastDate = getDailyForecastDateISO(forecastDay);

  const inputs = document.querySelectorAll('.daily-high, .daily-low');
  const rowsByCity = new Map();
  let blocked = false;
  const dateKeys = new Set();
  let hasAnyInput = false;
  let hasInvalidNumber = false;

  inputs.forEach((input) => {
    input.style.borderColor = "";
    input.style.boxShadow = "";
    input.style.backgroundColor = "";
  });

  inputs.forEach((input) => {
    const raw = input.value.trim();
    if (raw === '') return; // allows 0

    const cityId = Number(input.dataset.cityId);
    const numVal = Number(raw);

    if (!Number.isFinite(cityId) || !Number.isFinite(numVal)) {
      hasInvalidNumber = true;
      input.style.borderColor = "#dc2626";
      input.style.boxShadow = "0 0 0 1px #dc2626";
      input.style.backgroundColor = "#fef2f2";
      return;
    }

    const city = cities.find(c => c.id === cityId);
    if (!city) return;

    const ptNow = getPTNow();
    const ptCutoff = new Date(ptNow);
    ptCutoff.setUTCHours(12, 0, 0, 0);

    const localNow = getTzDate(city.timezone || "UTC");
    const cutoff = new Date(localNow.getTime());
    cutoff.setUTCHours(12, 0, 0, 0);

    if (forecastDay === 'today' && (ptNow >= ptCutoff || localNow >= cutoff)) {
      blocked = true;
      return;
    }

    const dateValue = forecastDate;

    let row = rowsByCity.get(cityId);
    if (!row) {
      row = {
        city_id: cityId,
        city: city.name,
        date: dateValue,
        user_id: userId,
        _hasHigh: false,
        _hasLow: false
      };
      rowsByCity.set(cityId, row);
    }

    if (input.classList.contains('daily-high')) {
      row.high = numVal;
      row._hasHigh = true;
    } else {
      row.low = numVal;
      row._hasLow = true;
    }

    hasAnyInput = true;
    dateKeys.add(dateValue);
  });

  if (hasInvalidNumber) {
    setStatus('<span style="color:red;"> Enter a valid number for all filled forecast fields </span>');
    return;
  }

  if (blocked) {
    setStatus('<span style="color:red;"> Cutoff passed for at least 1 city </span>');
    return;
  }

  if (!hasAnyInput) {
    setStatus('<span style="color:red;"> Enter at least 1 valid forecast! </span>');
    return;
  }

  const lowOnlyCities = [];    // enforce high requirement
  rowsByCity.forEach((row) => {
    if (row._hasLow && !row._hasHigh) {
      const lowInput = document.querySelector(`.daily-low[data-city-id="${row.city_id}"]`);
      if (lowInput) {
        lowInput.style.borderColor = "#dc2626";
        lowInput.style.boxShadow = "0 0 0 1px #dc2626";
        lowInput.style.backgroundColor = "#fef2f2";
      }
      lowOnlyCities.push(row.city);
    }
  });

  if (lowOnlyCities.length) {
    setStatus(
      `<span style="color:red;"> A Low requires a High in the same city. Missing High forecast for: ${lowOnlyCities.join(", ")}</span>`
    );
    return;
  }

  const payload = [...rowsByCity.values()].map(({ _hasHigh, _hasLow, ...row }) => row);

  if (!payload.length) {
    setStatus('<span style="color:red;"> Enter at least 1 valid forecast! </span>');
    return;
  }

  const preSaveSession = await ensureSession(true, { allowAnonymous: true });    // ensure active user session before streak check (allow anon creation on first daily save)
  const activeUserId = preSaveSession?.user?.id || userId;
  if (!activeUserId) {
    setStatus('<span style="color:red;"> No active session. Please try again. </span>');
    return;
  }
  userId = activeUserId;

  let predictedStreak = null;      // predict streak increment before upsert using current DB state
  for (const forecastDate of [...dateKeys]) {
    const incrementCheck = await checkIncrementDailyStreak(payload, forecastDate, activeUserId);

    if (incrementCheck.ok) {
      if (!predictedStreak || (incrementCheck.nextStreak || 0) > (predictedStreak.nextStreak || 0)) {
        predictedStreak = incrementCheck;
      }
    } else if (
      incrementCheck.reason !== "ALREADY_REACHED_THRESHOLD" &&
      incrementCheck.reason !== "RESULT_STILL_UNDER_THRESHOLD" &&
      incrementCheck.reason !== "NO_HIGHS_IN_PAYLOAD"
    ) {
      console.warn("[streak skip reason]", incrementCheck.reason, incrementCheck);
    }
  }

  const result = await upsertWithSessionRecovery({      // save forecasts to table
    table: 'daily_forecasts',
    rows: payload,
    onConflict: 'user_id,city_id,date',
    allowAnonymous: true    // first daily save creates anon session
  });

  if (result.error) {
    setStatus(`<span style="color:red;"> Save failed: ${result.error.message}</span>`);
    return;
  }

  const finalUserId = result.userId || activeUserId;
  if (finalUserId) userId = finalUserId;

  hasSavedForecast = true;
  setStatus(`<span style="color:green;"> Saved ${payload.length} forecasts! 🐰 </span>`);
  await buildDailyGrid();

  if (predictedStreak?.ok) {
    const streakResult = await incrementDailyStreak(finalUserId, predictedStreak.nextStreak);
    if (streakResult.ok) {
      await promptAndSaveBackupEmail(predictedStreak.nextStreak);
      setStatus(`<span style="color: #16a34a;">${streakResult.message}</span>`, true);
    } else {
      console.warn("Daily streak increment write failed:", streakResult.error);
      setStatus(`<span style="color:orange;"> Saved, but streak update failed: ${streakResult.error.message}</span>`, true);
    }
  }
}

// Hourly save handler
async function handleHourlySubmit(e) {
  e.preventDefault();

  const session = await ensureSession(false, { allowAnonymous: false });      // require an existing user before allowing hourly save
  const recovery = popAuthRecoveryState();
  if (recovery?.needsReauth) {
    setStatus(`<span style="color:orange;">${recovery.message}</span>`);
    return;
  }
  if (!session?.user?.id) {
    setStatus('<span style="color:orange;"> Save a daily forecast to create your user session. </span>');
    return;
  }
  userId = session.user.id;
  const status = document.getElementById("status");
  const cityRows = new Map();    // cityId maps to row data for validation
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
    setStatus('<span style="color:red;"> Invalid hour selected </span>');
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
    setStatus('<span style="color:red;"> Cutoff passed for this hour </span>');
    return;
  }

  if (!payload.length) {
    setStatus('<span style="color:red;"> Enter at least 1 forecast </span>');
    return;
  }

  const validationMessages = [];

  cityRows.forEach((row, cityId) => {
    if (!row.sixHrInput) return;    // no 6-hr rule if no 6-hr input entered

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
          `<div class="hourly-validation-msg" style="color:#dc2626; margin-top:.4rem;"> Fix invalid 6-hr input </div>`
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
    onConflict: 'user_id,city_id,date,hour',
    allowAnonymous: false
  });

  if (error) {
    setStatus(`<span style="color:red;"> Save failed: ${error.message}</span>`);
  } else {
    setStatus(`<span style="color:green;"> Saved ${selectedHour} forecasts! 🐰 </span>`);
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
    forecastDaySelect.addEventListener('change', async () => {
      updateCurrentDate();
      await buildDailyGrid();
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

function initDailyHelpModal() {
  const modal = document.getElementById("dailyHelpModal");
  const howToBtn = document.getElementById("howToBtn") || document.getElementById("helpBtn");
  const understoodBtn = document.getElementById("helpDoneBtn");

  if (!modal || !howToBtn || !understoodBtn) return;

  const showModal = () => modal.classList.remove("hidden");
  const hideModal = () => modal.classList.add("hidden");

  howToBtn.addEventListener("click", (e) => {    // Show modal on How To button click
    e.preventDefault();
    showModal();
  });

  understoodBtn.addEventListener("click", (e) => {      // close model only with Understood button
    e.preventDefault();
    hideModal();
  });

  const xButtons = modal.querySelectorAll(    // hide close UI inside modal
    '#helpCloseBtn, .help-close, .close-btn, .modal-close, [aria-label="Close"], [data-modal-close]'
  );
  xButtons.forEach((btn) => {
    btn.style.display = "none";
    btn.setAttribute("aria-hidden", "true");
    btn.tabIndex = -1;
    btn.disabled = true;
  });

  modal.classList.add("hidden");
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
    setStatus('<span style="color:orange;"> No active session yet. Your first daily save will create a guest session. </span>');
  }

  await loadCities();

  if (document.getElementById('hourSelector')) {
    buildHourSelector();
  }

  setInterval(async () => {
    if (isDailyPage && (typeof shouldCheckNow === 'function' ? shouldCheckNow() : true)) {
      updateCurrentDate();
      await buildDailyGrid();
    }

    if (isHourlyPage) {
      const current = updateHourlyCurrentDate();
      if (current !== hourlyCurrentDateKey){
        hourlyCurrentDateKey = current;
        await buildHourlyGrid();
      }
    }
  }, 60000)};
