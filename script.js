// - Global day boundary and display use PST
// - Auto-switch to "Tomorrow" occurs at PST noon (no auto-expand)
// - Per-city cutoff still uses each city's local noon to disable inputs for "Today"
// - Cards start collapsed. Clicking any card expands all cards. They do not collapse on click
// - All cards collapse only after a successful Save Forecast submission

const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];
let allExpanded = false; // global expansion state — false = collapsed start

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
  buildDailyGrid();
  refreshCurrentDateDisplay();
}

/* ------------------------
   PST day boundary & display management
   ------------------------ */

function getPstTodayStart() {
  const nowPST = nowInZone('America/Los_Angeles');
  return new Date(nowPST.getFullYear(), nowPST.getMonth(), nowPST.getDate());
}

function targetDateForForecastDay(forecastDay) {
  const pstToday = getPstTodayStart();
  if (forecastDay === 'today') {
    return formatDateYMD(pstToday);
  } else {
    const t = new Date(pstToday);
    t.setDate(t.getDate() + 1);
    return formatDateYMD(t);
  }
}

function refreshCurrentDateDisplay() {
  const forecastDayEl = document.getElementById('forecastDay');
  const dateDisplay = document.getElementById('currentDate');

  if (forecastDayEl && forecastDayEl.tagName === 'SELECT') {
    const optToday = forecastDayEl.querySelector('option[value="today"]');
    const optTmr = forecastDayEl.querySelector('option[value="tomorrow"]');
    if (optToday) optToday.textContent = 'Today';
    if (optTmr) optTmr.textContent = 'Tomorrow';
  }

  if (dateDisplay) {
    const curVal = (forecastDayEl && forecastDayEl.value) || 'today';
    const pstToday = getPstTodayStart();
    const displayDate = curVal === 'today' ? pstToday : new Date(pstToday.getFullYear(), pstToday.getMonth(), pstToday.getDate() + 1);

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
  const pstToday = getPstTodayStart();
  const pstTodayISO = formatDateYMD(pstToday);
  const pstTomorrow = new Date(pstToday);
  pstTomorrow.setDate(pstTomorrow.getDate() + 1);
  const pstTomorrowISO = formatDateYMD(pstTomorrow);

  const pstYesterday = new Date(pstToday);
  pstYesterday.setDate(pstYesterday.getDate() - 1);
  const pstYesterdayISO = formatDateYMD(pstYesterday);

  const { data: actuals } = await client
    .from('hourly_actuals')
    .select('city_id, temp')
    .eq('date', pstYesterdayISO);

  const { data: guesses } = await client
    .from('daily_forecasts')
    .select('city_id, high, low, date')
    .eq('user_id', 1)
    .in('date', [pstTodayISO, pstTomorrowISO]);

  return { actuals: actuals || [], guesses: guesses || [] };
}

/* ------------------------
   Build grid & per-city cutoff
   ------------------------ */

function enableOrDisableInputsForCity(card, city, targetIsoDate, showYesterday) {
  const inputs = card.querySelectorAll('input.daily-high, input.daily-low');
  if (!inputs) return;

  const pstTodayIso = formatDateYMD(getPstTodayStart());
  const isTargetToday = targetIsoDate === pstTodayIso;

  if (isTargetToday) {
    // Use city's local time to determine noon cutoff
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
    // Target is tomorrow -> inputs enabled
    inputs.forEach(inp => inp.disabled = false);
    const notice = card.querySelector('.cutoff-note');
    if (notice) notice.remove();
  }
}

function setCardExpandedState(card, expanded) {
  if (expanded) {
    card.classList.remove('collapsed');
    card.classList.add('expanded');
  } else {
    card.classList.remove('expanded');
    card.classList.add('collapsed');
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
  const pstTodayIso = formatDateYMD(getPstTodayStart());

  cities.forEach(city => {
    const cityActuals = actuals.filter(a => a.city_id === city.id);
    const yesterdayHigh = showYesterday && cityActuals.length ? Math.max(...cityActuals.map(a => a.temp)) : '?';
    const yesterdayLow = showYesterday && cityActuals.length ? Math.min(...cityActuals.map(a => a.temp)) : '?';

    const prevGuess = guesses.find(g => g.city_id === city.id && g.date === targetIsoDate) || {};
    const hasPrevGuess = prevGuess.high !== undefined || prevGuess.low !== undefined;

    const card = document.createElement('div');
    // start collapsed by default
    card.className = 'city-card collapsed';

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

    // set inputs enabled/disabled according to cutoff logic
    enableOrDisableInputsForCity(card, city, targetIsoDate, showYesterday);

    // apply global expansion state
    setCardExpandedState(card, allExpanded);
  });

  // ensure collapsed start after build if needed
  if (!allExpanded) {
    document.querySelectorAll('#dailyGrid .city-card').forEach(c => setCardExpandedState(c, false));
  }
}

/* ------------------------
   PST noon auto-switch (no auto-expand behavior now)
   ------------------------ */

let pstNoonTriggerKey = null;

function pstNoonCheck() {
  const sel = document.getElementById('forecastDay');
  if (!sel) return;

  const nowPST = nowInZone('America/Los_Angeles');
  const secondsOfDay = nowPST.getHours() * 3600 + nowPST.getMinutes() * 60 + nowPST.getSeconds();

  const windowStart = (11 * 3600) + (45 * 60); // 11:45:00 PST
  const windowEnd = 12 * 3600; // 12:00:00 PST

  const todayKey = formatDateYMD(nowPST);

  if (secondsOfDay >= windowStart && secondsOfDay < windowEnd) {
    if (pstNoonTriggerKey !== todayKey) {
      pstNoonTriggerKey = todayKey;

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
    // No auto-expand on PST noon; simply switch the dropdown to tomorrow if currently today
    if (sel.value === 'today') {
      sel.value = 'tomorrow';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // if already tomorrow, still rebuild to refresh cutoff notes
      refreshCurrentDateDisplay();
      buildDailyGrid();
    }
  } catch (err) {
    console.error('doPstNoonSwitch error', err);
  }
}

// run initial check and poll every 2 minutes
pstNoonCheck();
setInterval(pstNoonCheck, 2 * 60 * 1000);

/* ------------------------
   Day rollover scheduler (PST midnight) — ensures display refreshes at PST midnight
   ------------------------ */

function handlePstMidnight() {
  try {
    // Refresh display and rebuild grid so PST-day-based data reloads
    refreshCurrentDateDisplay();
    buildDailyGrid();
  } catch (e) {
    console.error('handlePstMidnight error', e);
  }
}

function scheduleNextPstMidnightUpdate() {
  const now = new Date();

  const nowPST = nowInZone('America/Los_Angeles');
  const todayPST = new Date(nowPST.getFullYear(), nowPST.getMonth(), nowPST.getDate());
  const nextMidnightPST = new Date(todayPST);
  nextMidnightPST.setDate(nextMidnightPST.getDate() + 1);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  }).formatToParts(nextMidnightPST).reduce((acc, p) => {
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
      handlePstMidnight();
    } catch (e) {
      console.error('PST midnight handler failed', e);
    } finally {
      scheduleNextPstMidnightUpdate();
    }
  }, msUntil + 100);
}

refreshCurrentDateDisplay();
scheduleNextPstMidnightUpdate();

/* ------------------------
   UI interactions
   ------------------------ */

document.addEventListener('click', (e) => {
  const hdr = e.target.closest && e.target.closest('.city-card-header');
  if (hdr) {
    // Expand all cards (do not collapse on second click)
    if (!allExpanded) {
      allExpanded = true;
      document.querySelectorAll('#dailyGrid .city-card').forEach(c => setCardExpandedState(c, true));
    }
    return;
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
      // After successful save, collapse all cards and reset global state
      allExpanded = false;
      document.querySelectorAll('#dailyGrid .city-card').forEach(c => setCardExpandedState(c, false));
      buildDailyGrid();
    }
  });
}

/* ------------------------
   Dropdown hook
   ------------------------ */
const forecastDayEl = document.getElementById('forecastDay');
if (forecastDayEl) {
  forecastDayEl.addEventListener('change', () => {
    refreshCurrentDateDisplay();
    buildDailyGrid();
  });
}

/* ------------------------
   Initial load
   ------------------------ */
loadCities();
