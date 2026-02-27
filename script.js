const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];
let isExpandedAll = false; // track whether we should open all cards after EST rollover

/* ------------------------
   Utilities
   ------------------------ */

function nowInZone(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return new Date(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
}

function formatDateYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/* ------------------------
   Data loading
   ------------------------ */

async function loadCities() {
  const { data, error } = await client
    .from('cities')
    .select('id, name, timezone_id, timezones(name)')
    .order('name');

  if (error || !data) {
    const st = document.getElementById('status');
    if (st) st.innerHTML = '<span style="color:red;">Failed to load cities.</span>';
    return;
  }

  for (const datum of data) {
    datum.timezone = datum.timezones.name;
    delete datum.timezones;
    delete datum.timezone_id;
  }

  cities = data;
  buildDailyGrid(); // first build
  refreshCurrentDateDisplay(); // and update date label
}

/* ------------------------
   Date / display management
   ------------------------ */

// Returns a Date object representing "today" in America/New_York (wall-clock)
function getEstTodayStart() {
  const nowEST = nowInZone('America/New_York');
  return new Date(nowEST.getFullYear(), nowEST.getMonth(), nowEST.getDate());
}

// Returns 'YYYY-MM-DD' for EST-today or EST-tomorrow depending on forecastDay select
function targetDateForForecastDay(forecastDay) {
  const estToday = getEstTodayStart();
  if (forecastDay === 'today') {
    return formatDateYMD(estToday);
  } else {
    const t = new Date(estToday);
    t.setDate(t.getDate() + 1);
    return formatDateYMD(t);
  }
}

// Update the small #currentDate element (PST-style) and ensure options remain "Today"/"Tomorrow"
function refreshCurrentDateDisplay() {
  const forecastDayEl = document.getElementById('forecastDay');
  const dateDisplay = document.getElementById('currentDate');

  // Keep options text exactly "Today" and "Tomorrow" — DO NOT append dates
  if (forecastDayEl && forecastDayEl.tagName === 'SELECT') {
    const optToday = forecastDayEl.querySelector('option[value="today"]');
    const optTmr = forecastDayEl.querySelector('option[value="tomorrow"]');
    if (optToday) optToday.textContent = 'Today';
    if (optTmr) optTmr.textContent = 'Tomorrow';
  }

  // For the visible date label, show month/day in PST like the original UI.
  if (dateDisplay) {
    const curVal = (forecastDayEl && forecastDayEl.value) || 'today';
    // Determine the EST-based date for the selected value, but format it in PST month/day
    const estToday = getEstTodayStart();
    const displayDate = curVal === 'today' ? estToday : new Date(estToday.getFullYear(), estToday.getMonth(), estToday.getDate() + 1);

    // Format using PST timezone so the UI keeps the old behavior
    dateDisplay.textContent = displayDate.toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "long",
      day: "numeric"
    });
  }
}

/* ------------------------
   Load daily data
   ------------------------ */

async function loadDailyData() {
  const todayEST = getEstTodayStart();
  const todayISO = formatDateYMD(todayEST);
  const tomorrow = new Date(todayEST);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = formatDateYMD(tomorrow);

  const yesterday = new Date(todayEST);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayISO = formatDateYMD(yesterday);

  const { data: actuals } = await client
    .from('hourly_actuals')
    .select('city_id, temp')
    .eq('date', yesterdayISO);

  const { data: guesses } = await client
    .from('daily_forecasts')
    .select('city_id, high, low, date')
    .eq('user_id', 1)
    .in('date', [todayISO, tomorrowISO]);

  return { actuals: actuals || [], guesses: guesses || [] };
}

/* ------------------------
   Build grid
   ------------------------ */

function enableOrDisableInputsForCity(card, city, targetIsoDate, showYesterday) {
  // Determine per-city whether inputs should be disabled based on local noon cutoff.
  // If local time is past noon and the forecastDay is today (targetIsoDate === EST-today), disable inputs.
  // If the targetIsoDate is EST-tomorrow, inputs should be enabled regardless of current local time (tomorrow's forecasts allowed until next day's cutoff).
  const inputs = card.querySelectorAll('input.daily-high, input.daily-low');
  if (!inputs) return;

  // If target date equals EST today, we may disable if city local time is past noon.
  const estTodayIso = formatDateYMD(getEstTodayStart());
  const isTargetToday = targetIsoDate === estTodayIso;

  if (isTargetToday) {
    // get city's local wall-clock time now
    const localNow = nowInZone(city.timezone);
    const cutoff = new Date(localNow);
    cutoff.setHours(12, 0, 0, 0);
    const isPastCutoff = localNow > cutoff;

    inputs.forEach(inp => {
      inp.disabled = isPastCutoff;
    });

    const notice = card.querySelector('.cutoff-note');
    if (isPastCutoff) {
      if (!notice) {
        const n = document.createElement('small');
        n.className = 'cutoff-note';
        n.style.color = '#e74c3c';
        n.style.display = 'block';
        n.style.marginTop = '0.5rem';
        n.textContent = 'Past cutoff (noon local) — switch to Tomorrow';
        card.querySelector('.city-card-content')?.appendChild(n);
      }
    } else {
      if (notice) notice.remove();
    }
  } else {
    // target is tomorrow => inputs enabled (tomorrow's forecasts allowed)
    inputs.forEach(inp => inp.disabled = false);
    const notice = card.querySelector('.cutoff-note');
    if (notice) notice.remove();
  }
}

async function buildDailyGrid() {
  const grid = document.getElementById('dailyGrid');
  if (!grid) return;

  grid.innerHTML = '<p>Loading cities...</p>';

  const { actuals, guesses } = await loadDailyData();

  grid.innerHTML = '';

  const forecastDay = (document.getElementById('forecastDay')?.value) || 'today';
  const targetIsoDate = targetDateForForecastDay(forecastDay);

  const showYesterday = forecastDay === 'today';
  const estTodayIso = formatDateYMD(getEstTodayStart());

  cities.forEach(city => {
    const cityActuals = actuals.filter(a => a.city_id === city.id);
    const yesterdayHigh = showYesterday && cityActuals.length ? Math.max(...cityActuals.map(a => a.temp)) : '?';
    const yesterdayLow = showYesterday && cityActuals.length ? Math.min(...cityActuals.map(a => a.temp)) : '?';

    const prevGuess = guesses.find(g => g.city_id === city.id && g.date === targetIsoDate) || {};
    const hasPrevGuess = prevGuess.high !== undefined || prevGuess.low !== undefined;

    const card = document.createElement('div');
    card.className = 'city-card' + (isExpandedAll ? ' expanded' : ' collapsed');
    // preserve header + content structure you expect
    card.innerHTML = `
      <div class="city-card-header">${escapeHtml(city.name)}</div>
      <div class="city-card-content">
        ${showYesterday ? `<p><small>Yesterday: H ${yesterdayHigh}° / L ${yesterdayLow}°</small></p>` : ''}
        ${hasPrevGuess ? `<p><small>Your last guess: H ${prevGuess.high ?? '-'}° / L ${prevGuess.low ?? '-'}°</small></p>` : ''}
        <label>High °F:
          <input type="number" class="daily-high" data-city-id="${city.id}" min="-25" max="125" step="1" placeholder="High">
        </label>
        <label>Low °F:
          <input type="number" class="daily-low" data-city-id="${city.id}" min="-50" max="100" step="1" placeholder="Low">
        </label>
      </div>
    `;
    grid.appendChild(card);

    // Set enabled/disabled state according to per-city cutoff logic
    enableOrDisableInputsForCity(card, city, targetIsoDate, showYesterday);
  });

  // After building the grid, reset isExpandedAll so future builds respect user toggles
  if (isExpandedAll) {
    // ensure cards are expanded; then clear the flag so we don't auto-expand again
    document.querySelectorAll('#dailyGrid .city-card').forEach(c => c.classList.remove('collapsed'));
    isExpandedAll = false;
  }
}

/* ------------------------
   PST noon auto-switch
   ------------------------ */

let pstCutoffLastTriggeredDate = null;

function pstCutoffCheck() {
  const sel = document.getElementById('forecastDay');
  if (!sel) return;

  const nowPST = nowInZone('America/Los_Angeles');
  const secondsOfDay = nowPST.getHours() * 3600 + nowPST.getMinutes() * 60 + nowPST.getSeconds();

  const windowStart = (11 * 3600) + (45 * 60); // 11:45:00
  const windowEnd = 12 * 3600; // 12:00:00

  const todayKey = formatDateYMD(nowPST);

  if (secondsOfDay >= windowStart && secondsOfDay < windowEnd) {
    if (pstCutoffLastTriggeredDate !== todayKey) {
      pstCutoffLastTriggeredDate = todayKey;

      const msToNoon = ((windowEnd) - secondsOfDay) * 1000 - nowPST.getMilliseconds();

      if (msToNoon <= 0) {
        doPstNoonSwitch();
      } else {
        setTimeout(doPstNoonSwitch, msToNoon + 50);
      }
    }
  }
}

function doPstNoonSwitch() {
  const sel = document.getElementById('forecastDay');
  if (!sel) return;
  try {
    if (sel.value === 'today') {
      sel.value = 'tomorrow';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (err) {
    console.error('doPstNoonSwitch error', err);
  }
}

pstCutoffCheck();
setInterval(pstCutoffCheck, 5 * 60 * 1000);

/* ------------------------
   EST midnight updater and auto-expand behavior
   ------------------------ */

// Called at EST midnight (wall-clock) to advance the app's concept of "today"
function handleEstMidnight() {
  try {
    // When day advances at EST midnight, make all city cards open for forecasts for that new day
    isExpandedAll = true;

    // Update display and rebuild grid so per-city cutoffs re-evaluate w/ new EST day
    refreshCurrentDateDisplay();
    buildDailyGrid();
  } catch (e) {
    console.error('handleEstMidnight error', e);
  }
}

function scheduleNextEstMidnightUpdate() {
  // Compute the next midnight in America/New_York (wall clock), convert to UTC epoch ms and schedule.
  const now = new Date();

  // Build the next midnight EST as wall-clock using Intl parts for tomorrow 00:00 America/New_York
  const nowEST = nowInZone('America/New_York');
  const todayEST = new Date(nowEST.getFullYear(), nowEST.getMonth(), nowEST.getDate());
  const nextMidnightEST = new Date(todayEST);
  nextMidnightEST.setDate(nextMidnightEST.getDate() + 1);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  }).formatToParts(nextMidnightEST).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});

  const targetUTCms = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  const msUntil = Math.max(0, targetUTCms - Date.now());

  setTimeout(() => {
    try {
      handleEstMidnight();
    } catch (e) {
      console.error('EST midnight handler failed', e);
    } finally {
      // schedule next midnight
      scheduleNextEstMidnightUpdate();
    }
  }, msUntil + 100);
}

// Run once at load to ensure displays reflect current EST day
refreshCurrentDateDisplay();
scheduleNextEstMidnightUpdate();

/* ------------------------
   UI interactions
   ------------------------ */

document.addEventListener('click', (e) => {
  const hdr = e.target.closest && e.target.closest('.city-card-header');
  if (hdr) {
    const card = hdr.closest('.city-card');
    if (card) {
      card.classList.toggle('collapsed');
      return;
    }
  }
});

/* ------------------------
   Batch save daily guesses
   ------------------------ */

const tempsForm = document.getElementById('tempsForm');
if (tempsForm) {
  tempsForm.addEventListener('submit', async e => {
    e.preventDefault();

    const forecastDay = document.getElementById('forecastDay').value;
    const targetDate = targetDateForForecastDay(forecastDay);

    const payload = [];

    document.querySelectorAll('.daily-high, .daily-low').forEach(input => {
      const val = input.value.trim();
      if (!val || input.disabled) return;

      const cityId = Number(input.dataset.cityId);
      const type = input.classList.contains('daily-high') ? 'high' : 'low';

      let entry = payload.find(p => p.city_id === cityId);
      if (!entry) {
        entry = { city_id: cityId, date: targetDate, user_id: 1 };
        payload.push(entry);
      }
      entry[type] = Number(val);
    });

    if (payload.length === 0) {
      const st = document.getElementById('status');
      if (st) st.innerHTML = '<span style="color:red;">Enter at least one valid guess!</span>';
      return;
    }

    const { error } = await client
      .from('daily_forecasts')
      .upsert(payload, { onConflict: 'user_id,city_id,date' });

    if (error) {
      const st = document.getElementById('status');
      if (st) st.innerHTML = `<span style="color:red;">Save failed: ${error.message}</span>`;
    } else {
      const st = document.getElementById('status');
      if (st) st.innerHTML = `<span style="color:green;">Saved ${payload.length} city forecasts for ${forecastDay}! 🐰 Good luck!</span>`;
      buildDailyGrid();
    }
  });
}

/* ------------------------
   Hook dropdown change
   ------------------------ */
const forecastDayEl = document.getElementById('forecastDay');
if (forecastDayEl) {
  forecastDayEl.addEventListener('change', () => {
    // When user manually changes the dropdown, refresh the date display and grid
    refreshCurrentDateDisplay();
    buildDailyGrid();
  });
}

/* ------------------------
   Initial load
   ------------------------ */
loadCities();
