const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];

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
  buildDailyGrid();  // Populate the grid after loading cities
}

// Fetch yesterday's actuals + today's previous guesses for reference
async function loadDailyData() {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // Yesterday's actuals (simple max/min example from hourly_actuals)
  const { data: actuals } = await client
    .from('hourly_actuals')
    .select('city_id, temp')
    .eq('date', yesterday);

  // Today's previous guesses
  const { data: guesses } = await client
    .from('daily_forecasts')
    .select('city_id, high, low')
    .eq('user_id', 1)  // TODO: replace with real user ID from auth
    .eq('date', today);

  return { actuals: actuals || [], guesses: guesses || [] };
}

// Build the multi-city daily grid
async function buildDailyGrid() {
  const grid = document.getElementById('dailyGrid');
  if (!grid) return;

  grid.innerHTML = '<p>Loading cities...</p>';

  const { actuals, guesses } = await loadDailyData();

  grid.innerHTML = '';

  cities.forEach(city => {
    // Find yesterday's high/low (simple max/min for demo)
    const cityActuals = actuals.filter(a => a.city_id === city.id);
    const yesterdayHigh = cityActuals.length ? Math.max(...cityActuals.map(a => a.temp)) : '?';
    const yesterdayLow = cityActuals.length ? Math.min(...cityActuals.map(a => a.temp)) : '?';

    const prevGuess = guesses.find(g => g.city_id === city.id) || {};

    const card = document.createElement('div');
    card.className = 'city-card';
    card.innerHTML = `
      <h3>${city.name}</h3>
      <p><small>Yesterday: H ${yesterdayHigh}° / L ${yesterdayLow}°</small></p>
      <p><small>Your last guess: H ${prevGuess.high ?? '-'}° / L ${prevGuess.low ?? '-'}°</small></p>
      <label>High °F:
        <input type="number" class="daily-high" data-city-id="${city.id}" min="-25" max="125" step="1" placeholder="High">
      </label>
      <label>Low °F:
        <input type="number" class="daily-low" data-city-id="${city.id}" min="-50" max="100" step="1" placeholder="Low">
      </label>
    `;
    grid.appendChild(card);
  });
}

// Batch save daily guesses on form submit
document.getElementById('tempsForm').addEventListener('submit', async e => {
  e.preventDefault();

  const today = new Date().toISOString().split('T')[0];
  const payload = [];

  document.querySelectorAll('.daily-high, .daily-low').forEach(input => {
    const val = input.value.trim();
    if (!val) return;

    const cityId = Number(input.dataset.cityId);
    const type = input.classList.contains('daily-high') ? 'high' : 'low';

    let entry = payload.find(p => p.city_id === cityId);
    if (!entry) {
      entry = { city_id: cityId, date: today, user_id: 1 };  // TODO: use real user_id
      payload.push(entry);
    }
    entry[type] = Number(val);
  });

  if (payload.length === 0) {
    document.getElementById('status').innerHTML = '<span style="color:red;">Enter at least one guess!</span>';
    return;
  }

  const { error } = await client
    .from('daily_forecasts')
    .upsert(payload, { onConflict: 'user_id,city_id,date' });

  if (error) {
    document.getElementById('status').innerHTML = `<span style="color:red;">Save failed: ${error.message}</span>`;
  } else {
    document.getElementById('status').innerHTML = `<span style="color:green;">Saved ${payload.length} city forecasts! 🐰 Good luck!</span>`;
  }
});

// Reveal button (unchanged)
document.getElementById('revealBtn').addEventListener('click', async () => {
  document.getElementById('revealResults').innerHTML = '<p style="text-align:center;"> 🌤️ Reveal coming soon! </p>';
});

// Load on page start
loadCities();
