const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];
let isExpandedAll = false;  // start collapsed

// Load cities from DB
async function loadCities() {
  const { data, error } = await client
    .from('cities')
    .select('id, name, timezone_id, timezones(name)')
    .order('name');

  if (error || !data) {
    document.getElementById('status').innerHTML = '<span style="color:red;">Failed to load cities.</span>';
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
  const now = new Date();
  const pstToday = now.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric"
  });

  const tomorrow = new Date(now.getTime() + 86400000);
  const pstTomorrow = tomorrow.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric"
  });

  const dateDisplay = document.getElementById('currentDate');
  if (dateDisplay) {
    const forecastDay = document.getElementById('forecastDay')?.value || 'today';
    dateDisplay.textContent = forecastDay === 'today' ? pstToday : pstTomorrow;
  }

  // Auto-default to Tomorrow if past noon PST (but Today stays selectable)
  const pstNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const cutoff = new Date(pstNow);
  cutoff.setHours(12, 0, 0, 0);
  if (pstNow > cutoff && document.getElementById('forecastDay').value === 'today') {
    document.getElementById('forecastDay').value = 'tomorrow';
    updateCurrentDate();  // refresh date display
  }

  // Re-build grid after possible switch
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

  const forecastDay = document.getElementById('forecastDay').value || 'today';
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
    card.className = 'city-card collapsed';  // force collapsed on creation
    card.innerHTML = `
      <div class="city-card-header">${city.name}</div>
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

// Toggle expand/collapse ALL cards on ANY header click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('city-card-header')) {
    isExpandedAll = !isExpandedAll;
    document.querySelectorAll('.city-card').forEach(card => {
      card.classList.toggle('collapsed', !isExpandedAll);
      card.classList.toggle('expanded', isExpandedAll);
    });
  }
});

// Batch save daily guesses
document.getElementById('tempsForm').addEventListener('submit', async e => {
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
    document.getElementById('status').innerHTML = '<span style="color:red;">Enter at least one valid guess!</span>';
    return;
  }

  const { error } = await client
    .from('daily_forecasts')
    .upsert(payload, { onConflict: 'user_id,city_id,date' });

  if (error) {
    document.getElementById('status').innerHTML = `<span style="color:red;">Save failed: ${error.message}</span>`;
  } else {
    document.getElementById('status').innerHTML = `<span style="color:green;">Saved ${payload.length} city forecasts for ${forecastDay}! 🐰 Good luck!</span>`;
  }
});

// Update grid + date label when dropdown changes
document.getElementById('forecastDay').addEventListener('change', () => {
  updateCurrentDate();
  buildDailyGrid();
});

// Load on start
loadCities();
