// script.js (corrected)
// NOTE: This file intentionally avoids changing any page-level styles or classes.
// It only updates content and rebuilds the city cards like your original script.

// Supabase config (keep yours)
const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];
let isExpandedAll = false;  // start collapsed

/* ------------------------
   Helper utilities
   ------------------------ */

function nowInZone(tz) {
  // Produce a Date representing the local wall-clock time in the given IANA timezone.
  // Construct via Intl.formatToParts to avoid timezone offsets/ambiguity.
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ------------------------
   Original app functions (kept behavior)
   ------------------------ */

// Load cities from DB
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
  buildDailyGrid();
  updateCurrentDate();
}

// Update date label next to dropdown (full month name, PST)
function updateCurrentDate() {
  const forecastDay = document.getElementById('forecastDay')?.value || 'today';

  const now = new Date();
  let displayDate = now;
  if (forecastDay === 'tomorrow') {
    displayDate = new Date(now.getTime() + 86400000);
  }

  const pstDate = displayDate.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric"
  });

  const dateDisplay = document.getElementById('currentDate');
  if (dateDisplay) {
    dateDisplay.textContent = pstDate;
  }

  // Re-build grid after date change (keeps inputs in initial state)
  buildDailyGrid();
}

// Fetch yesterday's actuals + today's & tomorrow's previous guesses
async function loadDailyData() {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const { data: actuals } = await client
    .from('hourly_actuals')
    .select('city_id, temp')
    .eq('date', yesterday);

  const { data: guesses } = await client
    .from('daily_forecasts')
    .select('city_id, high, low, date')
    .eq('user_id', 1) // TODO: replace with real user ID from auth
    .in('date', [today, tomorrow]);

  return { actuals: actuals || [], guesses: guesses || [] };
}

// Build collapsible city grid (all start collapsed)
async function buildDailyGrid() {
  const grid = document.getElementById('dailyGrid');
  if (!grid) return;

  grid.innerHTML = '<p>Loading cities...</p>';

  const { actuals, guesses } = await loadDailyData();

  grid.innerHTML = '';

  const forecastDay = document.getElementById('forecastDay')?.value || 'today';
  const targetDate = forecastDay === 'today'
    ? new Date().toISOString().split('T')[0]
    : new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const showYesterday = forecastDay === 'today';

  cities.forEach(city => {
    const cityActuals = actuals.filter(a => a.city_id === city.id);
    const yesterdayHigh = showYesterday && cityActuals.length ? Math.max(...cityActuals.map(a => a.temp)) : '?';
    const yesterdayLow = showYesterday && cityActuals.length ? Math.min(...cityActuals.map(a => a.temp)) : '?';

    const prevGuess = guesses.find(g => g.city_id === city.id && g.date === targetDate) || {};
    const hasPrevGuess = prevGuess.high !== undefined || prevGuess.low !== undefined;

    // Check if today's forecast is past cutoff (noon local time)
    const now = new Date();
    const localNow = new Date(now.toLocaleString("en-US", { timeZone: city.timezone }));
    const cutoff = new Date(localNow);
    cutoff.setHours(12, 0, 0, 0);
    const isPastCutoff = localNow > cutoff && forecastDay === 'today';

    const card = document.createElement('div');
    card.className = 'city-card collapsed';  // keep collapsed on creation
    card.innerHTML = `
      <div class="city-card-header">${escapeHtml(city.name)}</div>
      <div class="city-card-content">
        ${showYesterday ? `<p><small>Yesterday: H ${yesterdayHigh}° / L ${yesterdayLow}°</small></p>` : ''}
        ${hasPrevGuess ? `<p><small>Your last guess: H ${prevGuess.high ?? '-'}° / L ${prevGuess.low ?? '-'}°</small></p>` : ''}
        <label>High °F:
          <input type="number" class="daily-high" data-city-id="${city.id}" min="-25" max="125" step="1" placeholder="High" ${isPastCutoff ? 'disabled' : ''}>
        </label>
        <label>Low °F:
          <input type="number" class="daily-low" data-city-id="${city.id}" min="-50" max="100" step="1" placeholder="Low" ${isPastCutoff ? 'disabled' : ''}>
        </label>
        ${isPastCutoff ? '<small style="color:#e74c3c; display:block; margin-top:0.5rem;">Past cutoff (noon local) — switch to Tomorrow</small>' : ''}
      </div>
    `;

    grid.appendChild(card);
  });
}

/* ------------------------
   PST noon auto-switch (safe)
   ------------------------ */

let pstCutoffLastTriggeredDate = null;

function pstCutoffCheck() {
  // Only schedule/switch if there's a forecastDay select present
  const sel = document.getElementById('forecastDay');
  if (!sel) return;

  const nowPST = nowInZone('America/Los_Angeles');
  const minutes = nowPST.getMinutes();
  const hours = nowPST.getHours();
  const mmTotal = hours * 60 + minutes;

  const windowStart = 11 * 60 + 45; // 11:45
  const windowEnd = 12 * 60; // 12:00

  const todayKey = formatDateYMD(nowPST);

  if (mmTotal >= windowStart && mmTotal < windowEnd) {
    if (pstCutoffLastTriggeredDate !== todayKey) {
      pstCutoffLastTriggeredDate = todayKey;

      const secsPast = nowPST.getSeconds();
      const msToNoon = ((windowEnd * 60) - (hours * 3600 + minutes * 60 + secsPast)) * 1000 - nowPST.getMilliseconds();

      if (msToNoon <= 0) {
        doPstNoonSwitch();
      } else {
        setTimeout(() => {
          doPstNoonSwitch();
        }, msToNoon + 50);
      }
    }
  }
}

function doPstNoonSwitch() {
  // Only change the dropdown if it exists and is currently 'today'.
  const sel = document.getElementById('forecastDay');
  if (!sel) return;

  try {
    const cur = sel.value;
    if (cur === 'today') {
      sel.value = 'tomorrow';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (err) {
    console.error('doPstNoonSwitch error', err);
  }
}

// Start periodic PST check (run on load and every 5 minutes)
pstCutoffCheck();
setInterval(pstCutoffCheck, 5 * 60 * 1000);

/* ------------------------
   EST midnight updater (fixes "still says Feb 25" issue)
   - Ensures the UI reflects America/New_York current date at load time
   - Schedules next update at the next EST midnight
   ------------------------ */

function updateDropdownDatesForEstNow() {
  // Get current date in America/New_York
  const nowEST = nowInZone('America/New_York');

  const todayEST = new Date(nowEST.getFullYear(), nowEST.getMonth(), nowEST.getDate());
  const tomorrowEST = new Date(todayEST);
  tomorrowEST.setDate(todayEST.getDate() + 1);

  // Update the #currentDate (keeps PST display per earlier behavior)
  const forecastDayEl = document.getElementById('forecastDay');
  const dateDisplay = document.getElementById('currentDate');

  // If forecastDay select exists, update its option text (non-destructive)
  if (forecastDayEl && forecastDayEl.tagName === 'SELECT') {
    const optToday = forecastDayEl.querySelector('option[value="today"]');
    const optTmr = forecastDayEl.querySelector('option[value="tomorrow"]');
    if (optToday) optToday.textContent = `Today — ${formatDateYMD(todayEST)}`;
    if (optTmr) optTmr.textContent = `Tomorrow — ${formatDateYMD(tomorrowEST)}`;
  }

  // Update visible date display using PST formatting like original app
  if (dateDisplay) {
    const curVal = forecastDayEl?.value || 'today';
    const displayDate = curVal === 'today' ? todayEST : tomorrowEST;
    // Show display in PST month/day format (matching original)
    dateDisplay.textContent = displayDate.toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "long",
      day: "numeric"
    });
  }

  // Rebuild grid to ensure city cutoffs reflect the new day boundaries
  buildDailyGrid();
}

function scheduleNextEstMidnightUpdate() {
  // Compute the next 00:00 in America/New_York and schedule updateDropdownDatesForEstNow() for that instant.
  const now = new Date();
  // Build the next midnight EST as a wall-clock using Intl parts for tomorrow 00:00 America/New_York
  const nowEST = nowInZone('America/New_York');
  const todayEST = new Date(nowEST.getFullYear(), nowEST.getMonth(), nowEST.getDate());
  const nextMidnightEST = new Date(todayEST);
  nextMidnightEST.setDate(nextMidnightEST.getDate() + 1);

  // Use Intl to get the components of that midnight in EST and convert to UTC epoch
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
      updateDropdownDatesForEstNow();
    } catch (e) {
      console.error('EST midnight update error', e);
    } finally {
      // schedule next one recursively
      scheduleNextEstMidnightUpdate();
    }
  }, msUntil + 100);
}

// Run once at load
updateDropdownDatesForEstNow();
// Schedule subsequent updates
scheduleNextEstMidnightUpdate();

/* ------------------------
   UI interactions: expand/collapse
   - Keep the behavior simple and non-destructive
   ------------------------ */

document.addEventListener('click', (e) => {
  // If user clicked a city-card-header, toggle that card only.
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
   Batch save daily guesses (unchanged behavior)
   ------------------------ */

const tempsForm = document.getElementById('tempsForm');
if (tempsForm) {
  tempsForm.addEventListener('submit', async e => {
    e.preventDefault();

    const forecastDay = document.getElementById('forecastDay').value;
    const targetDate = forecastDay === 'today'
      ? new Date().toISOString().split('T')[0]
      : new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const payload = [];

    document.querySelectorAll('.daily-high, .daily-low').forEach(input => {
      const val = input.value.trim();
      if (!val || input.disabled) return;

      const cityId = Number(input.dataset.cityId);
      const type = input.classList.contains('daily-high') ? 'high' : 'low';

      let entry = payload.find(p => p.city_id === cityId);
      if (!entry) {
        entry = { city_id: cityId, date: targetDate, user_id: 1 }; // TODO: real user_id
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
      // Optionally refresh grid so last guesses are visible
      buildDailyGrid();
    }
  });
}

/* ------------------------
   Hook dropdown change to update grid + date label (keeps original)
   ------------------------ */
const forecastDayEl = document.getElementById('forecastDay');
if (forecastDayEl) {
  forecastDayEl.addEventListener('change', () => {
    updateCurrentDate();
    buildDailyGrid();
  });
}

/* ------------------------
   Initial load
   ------------------------ */
loadCities();
