// script.js
const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];
let isExpandedAll = false; // start collapsed

/* ------------------------
   Utilities: timezone helpers
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

/* ------------------------
   Existing app functions (kept mostly intact)
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
  const forecastDayEl = document.getElementById('forecastDay');
  const forecastDay = forecastDayEl?.value || 'today';

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
    card.className = 'city-card collapsed'; // force collapsed on creation
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
   Escape helper to avoid HTML injection when rendering city.name
   ------------------------ */
function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ------------------------
   PST cutoff periodic check
   - Run immediately, then every 5 minutes
   - Only active between 11:45 and 12:00 America/Los_Angeles
   - Schedules an action at exactly noon PST (or triggers immediately if past)
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

      const msToNoon = (windowEnd * 60 * 1000) - (mmTotal * 60 * 1000 + nowPST.getSeconds() * 1000 + nowPST.getMilliseconds());
      if (msToNoon <= 0) {
        // already at/after noon PST
        console.log('PST cutoff: immediate switch to Tomorrow');
        doPstNoonSwitch();
      } else {
        console.log('PST cutoff: scheduling switch in', msToNoon, 'ms');
        setTimeout(() => {
          doPstNoonSwitch();
        }, msToNoon + 50);
      }
    }
  } else {
    // outside window: nothing to do
  }
}

function doPstNoonSwitch() {
  console.log('Executing PST noon auto-switch (noon PST).');

  try {
    if (typeof switchToTomorrow === 'function') {
      switchToTomorrow();
    } else {
      // If your app uses forecastDay select, set it to tomorrow and trigger change handlers
      const sel = document.getElementById('forecastDay');
      if (sel) {
        sel.value = 'tomorrow';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // dispatch event for other app code to pick up
        window.dispatchEvent(new CustomEvent('pstNoonAutoSwitch', { detail: { at: new Date().toISOString() } }));
      }
    }
  } catch (err) {
    console.error('Error during PST noon switch:', err);
  }
}

/* Start periodic PST check */
(function startPstPeriodic() {
  pstCutoffCheck();
  setInterval(pstCutoffCheck, 5 * 60 * 1000); // every 5 minutes
})();

/* ------------------------
   EST midnight updater
   - Updates dropdown labels + adjacent date text at 00:00 America/New_York
   - Runs once at load, then schedules next run exactly at next midnight EST
   ------------------------ */

function updateDropdownDates(todayDateObj, tomorrowDateObj) {
  // Simple DOM update — adapt to your desired format
  const labelEl = document.getElementById('date-label') || document.getElementById('currentDate');
  const dropdown = document.getElementById('date-dropdown') || document.getElementById('forecastDay');

  const todayStr = formatDateYMD(todayDateObj);
  const tomorrowStr = formatDateYMD(tomorrowDateObj);

  if (labelEl) labelEl.textContent = `Today: ${todayStr} • Tomorrow: ${tomorrowStr}`;

  if (dropdown && dropdown.tagName === 'SELECT') {
    const optToday = dropdown.querySelector('option[value="today"]');
    const optTmr = dropdown.querySelector('option[value="tomorrow"]');
    if (optToday) optToday.textContent = `Today — ${todayStr}`;
    if (optTmr) optTmr.textContent = `Tomorrow — ${tomorrowStr}`;
  } else if (dropdown && dropdown.id === 'forecastDay') {
    // If the forecastDay input is not a select, update the nearby #currentDate
    const dateDisplay = document.getElementById('currentDate');
    if (dateDisplay) {
      const curVal = document.getElementById('forecastDay')?.value || 'today';
      const dd = curVal === 'today' ? todayStr : tomorrowStr;
      dateDisplay.textContent = new Date(dd).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric' });
    }
  }
}

function refreshTodayCards() {
  // Hook to re-render or refresh cards when the day advances (EST midnight)
  // By default we rebuild the grid which re-checks cutoffs per city timezone.
  try {
    buildDailyGrid();
  } catch (e) {
    console.warn('refreshTodayCards error', e);
  }
}

function setupEstMidnightUpdate() {
  async function updateNowAndScheduleNext() {
    const nowEST = nowInZone('America/New_York');

    const todayEST = new Date(nowEST.getFullYear(), nowEST.getMonth(), nowEST.getDate());
    const tomorrowEST = new Date(todayEST);
    tomorrowEST.setDate(todayEST.getDate() + 1);

    // Update UI now
    updateDropdownDates(todayEST, tomorrowEST);
    refreshTodayCards();

    // Compute ms until next 00:00 EST
    const nextMidnightEST = new Date(todayEST);
    nextMidnightEST.setDate(nextMidnightEST.getDate() + 1);

    // Use Intl to get exact wall-clock components for that midnight in America/New_York,
    // then convert to a UTC epoch ms to compute the delay.
    const nmParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
    }).formatToParts(new Date(nextMidnightEST)).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});

    const targetUTC = Date.UTC(
      Number(nmParts.year),
      Number(nmParts.month) - 1,
      Number(nmParts.day),
      Number(nmParts.hour),
      Number(nmParts.minute),
      Number(nmParts.second)
    );

    const nowMs = Date.now();
    const msUntil = targetUTC - nowMs;
    const safeMsUntil = Math.max(msUntil, 0);

    setTimeout(() => {
      updateNowAndScheduleNext();
    }, safeMsUntil + 100);
  }

  updateNowAndScheduleNext();
}

/* Start EST midnight scheduler */
setupEstMidnightUpdate();

/* ------------------------
   UI interactions: expand/collapse behavior
   - Your CSS uses .collapsed on .city-card; toggle header click to expand all/ collapse all
   - Keep your existing 'toggle all on header click' but make it robust
   ------------------------ */

document.addEventListener('click', (e) => {
  // Individual card header toggle (if you want per-card toggles)
  const hdr = e.target.closest && e.target.closest('.city-card-header');
  if (hdr) {
    const card = hdr.closest('.city-card');
    if (card) {
      card.classList.toggle('collapsed');
      return;
    }
  }

  // Your existing behavior: any header click toggles all cards expanded/collapsed
  if (e.target.classList && e.target.classList.contains('city-card-header')) {
    // This block will be unreachable because above returns on per-card header click.
    // Keep for backward compatibility or other header types.
    isExpandedAll = !isExpandedAll;
    document.querySelectorAll('.city-card').forEach(card => {
      card.classList.toggle('collapsed', !isExpandedAll);
      card.classList.toggle('expanded', isExpandedAll);
    });
  }
});

/* ------------------------
   Save form handler (kept from your original file)
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
      // Optionally rebuild grid to reflect stored guesses
      buildDailyGrid();
    }
  });
}

/* ------------------------
   Dropdown change to update grid + date label
   ------------------------ */
const forecastDayEl = document.getElementById('forecastDay');
if (forecastDayEl) {
  forecastDayEl.addEventListener('change', () => {
    updateCurrentDate();
    buildDailyGrid();
  });
}

/* ------------------------
   Load on start
   ------------------------ */
loadCities();

/* ------------------------
   Optional: expose hooks for other scripts
   ------------------------ */
window.myApp = window.myApp || {};
window.myApp.doPstNoonSwitch = doPstNoonSwitch;
window.myApp.pstCutoffCheck = pstCutoffCheck;
window.myApp.refreshTodayCards = refreshTodayCards;
window.myApp.updateDropdownDates = updateDropdownDates;
