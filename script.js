// script.js
// Supabase config (unchanged)
const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// App state (unchanged semantics)
let cities = [];
let isExpandedAll = false; // start collapsed

/* ------------------------
   Small helpers (pure functions only)
   ------------------------ */
function formatDateYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Return a Date object that represents the current wall-clock time in given IANA tz
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

/* ------------------------
   DB loaders (kept as in your original)
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
  buildDailyGrid();
  updateCurrentDate();
}

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

  // Re-build grid after date change
  buildDailyGrid();
}

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
    .eq('user_id', 1) // TODO: replace with real user ID
    .in('date', [today, tomorrow]);

  return { actuals: actuals || [], guesses: guesses || [] };
}

// Keep city rendering exactly as your original logic (no style changes)
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
    card.className = 'city-card collapsed'; // match original behavior
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

/* Small helper to avoid HTML injection */
function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ------------------------
   PST noon cutoff logic (no DOM style changes)
   ------------------------ */

let pstCutoffLastTriggeredDate = null;

function pstCutoffCheck() {
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

      const secsNow = nowPST.getSeconds();
      const msToNoon = ((windowEnd * 60) - (mmTotal * 60 + secsNow)) * 1000 - nowPST.getMilliseconds();

      if (msToNoon <= 0) {
        doPstNoonSwitch();
      } else {
        setTimeout(() => doPstNoonSwitch(), msToNoon + 50);
      }
    }
  }
}

function doPstNoonSwitch() {
  // Do not modify styles. Only change the forecastDay select (if present).
  const sel = document.getElementById('forecastDay');
  if (sel) {
    sel.value = 'tomorrow';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    window.dispatchEvent(new CustomEvent('pstNoonAutoSwitch', { detail: { at: new Date().toISOString() } }));
  }
}

// start periodic PST check (as before)
pstCutoffCheck();
setInterval(pstCutoffCheck, 5 * 60 * 1000);

/* ------------------------
   Correct EST-midnight updater (fixed)
   - Immediately updates UI to EST local date (so at 1:48am EST it shows Feb 26)
   - Schedules next exact EST midnight update
   ------------------------ */

function updateDropdownDatesNow() {
  // Determine "today" and "tomorrow" in America/New_York
  const nowEST = nowInZone('America/New_York');

  const todayEST = new Date(nowEST.getFullYear(), nowEST.getMonth(), nowEST.getDate());
  const tomorrowEST = new Date(todayEST);
  tomorrowEST.setDate(todayEST.getDate() + 1);

  // Compute YMD strings
  const todayYMD = formatDateYMD(todayEST);
  const tomorrowYMD = formatDateYMD(tomorrowEST);

  // Update existing UI pieces without changing any styles
  // 1) If you have #currentDate (used elsewhere), update it to match forecastDay value
  const forecastDayEl = document.getElementById('forecastDay');
  const displayEl = document.getElementById('currentDate');
  if (displayEl) {
    const curVal = forecastDayEl?.value || 'today';
    // Display as long month/day but ensure it's the EST day converted to PST display (to match prior behavior)
    const whichDate = curVal === 'today' ? todayEST : tomorrowEST;
    const pstDisplay = whichDate.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric' });
    displayEl.textContent = pstDisplay;
  }

  // 2) If forecastDay is a <select>, update option labels if present (non-destructive)
  if (forecastDayEl && forecastDayEl.tagName === 'SELECT') {
    const optToday = forecastDayEl.querySelector('option[value="today"]');
    const optTmr = forecastDayEl.querySelector('option[value="tomorrow"]');
    if (optToday) optToday.textContent = `Today — ${todayYMD}`;
    if (optTmr) optTmr.textContent = `Tomorrow — ${tomorrowYMD}`;
  }

  // 3) Custom label element: #date-label (safe update if exists)
  const dateLabel = document.getElementById('date-label');
  if (dateLabel) {
    dateLabel.textContent = `Today: ${todayYMD} • Tomorrow: ${tomorrowYMD}`;
  }
}

function scheduleNextEstMidnightUpdate() {
  // Compute next midnight in America/New_York and schedule an update at that exact wall-clock time.
  const now = new Date();
  // Build next-midnight EST wall-clock components
  const nowEST = nowInZone('America/New_York');
  const todayEST = new Date(nowEST.getFullYear(), nowEST.getMonth(), nowEST.getDate());
  const nextMidnightEST = new Date(todayEST);
  nextMidnightEST.setDate(nextMidnightEST.getDate() + 1);

  // Convert the nextMidnightEST wall-clock to epoch ms via Intl (ensures DST-safe)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
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

  const delay = Math.max(0, targetUTCms - Date.now());

  setTimeout(() => {
    // On EST midnight, update UI and rebuild grid (but do not reset input values)
    updateDropdownDatesNow();
    try { buildDailyGrid(); } catch (e) { console.warn('buildDailyGrid failed on EST midnight update', e); }
    // Schedule the following midnight
    scheduleNextEstMidnightUpdate();
  }, delay + 100); // slight buffer
}

// Run immediate EST update now (fixes your reported Feb25->Feb26 problem)
updateDropdownDatesNow();
// Schedule next ones
scheduleNextEstMidnightUpdate();

/* ------------------------
   Expand/collapse behavior (keeps original semantics)
   - Clicking a .city-card-header toggles that card only
   - If you want the old "toggle ALL", you can still click a global button (not added here)
   ------------------------ */
document.addEventListener('click', (e) => {
  const hdr = e.target.closest && e.target.closest('.city-card-header');
  if (hdr) {
    const card = hdr.closest('.city-card');
    if (card) {
      card.classList.toggle('collapsed');
    }
  }
});

/* ------------------------
   Save handler (kept exactly as your original)
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
      buildDailyGrid();
    }
  });
}

/* ------------------------
   Wire up dropdown change (unchanged)
   ------------------------ */
const forecastDayEl = document.getElementById('forecastDay');
if (forecastDayEl) {
  forecastDayEl.addEventListener('change', () => {
    updateCurrentDate();
    buildDailyGrid();
  });
}

/* ------------------------
   Start: load cities (unchanged)
   ------------------------ */
loadCities();

// Expose a couple hooks (non-visual)
window.myApp = window.myApp || {};
window.myApp.doPstNoonSwitch = doPstNoonSwitch;
window.myApp.pstCutoffCheck = pstCutoffCheck;
window.myApp.updateDropdownDatesNow = updateDropdownDatesNow;
