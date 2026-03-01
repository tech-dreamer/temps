const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];
let hasSavedForecast = false;

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

function getPSTNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
}

// Load cities

async function loadCities() {
  const { data, error } = await client
    .from('cities')
    .select('id, name, timezone_id, timezones(name)')
    .order('timezone_id', { ascending: false });
  
  if (error || !data) {
    document.getElementById('status').innerHTML =
      '<span style="color:red;">Failed to load cities.</span>';
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

// Update PST label

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

  const forecastDay = document.getElementById('forecastDay').value;
  const dateDisplay = document.getElementById('currentDate');

  dateDisplay.textContent =
    forecastDay === 'today' ? pstToday : pstTomorrow;
}

// Load data in safe window

async function loadDailyData() {
  const now = new Date();

  const minDate = new Date(now.getTime() - 86400000).toISOString().split('T')[0];

  const maxDate = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

  const { data: actuals } = await client
    .from('hourly_actuals')
    .select('city_id, temp, date')
    .gte('date', minDate)
    .lte('date', maxDate);

  const { data: guesses } = await client
    .from('daily_forecasts')
    .select('city_id, high, low, date')
    .eq('user_id', 1)
    .gte('date', minDate)
    .lte('date', maxDate);

  return { actuals: actuals || [], guesses: guesses || [] };
}

// Build grid

async function buildDailyGrid() {
  const grid = document.getElementById('dailyGrid');
  grid.innerHTML = '<p>Loading cities...</p>';

  const { actuals, guesses } = await loadDailyData();
  grid.innerHTML = '';

  const forecastDay = document.getElementById('forecastDay').value;

  cities.forEach(city => {

    const cityToday = getCityLocalDateISO(city.timezone, 0);
    const cityTomorrow = getCityLocalDateISO(city.timezone, 1);
    const cityYesterday = getCityLocalDateISO(city.timezone, -1);

    const targetDate =
      forecastDay === 'today' ? cityToday : cityTomorrow;

    const showYesterday = forecastDay === 'today';

    const cityActuals = actuals.filter(
      a => a.city_id === city.id && a.date === cityYesterday
    );

    const yesterdayHigh =
      showYesterday && cityActuals.length
        ? Math.max(...cityActuals.map(a => a.temp))
        : '?';

    const yesterdayLow =
      showYesterday && cityActuals.length
        ? Math.min(...cityActuals.map(a => a.temp))
        : '?';

    const prevGuess = guesses.find(
      g => g.city_id === city.id && g.date === targetDate
    ) || {};

    const hasPrevGuess =
      prevGuess.high !== undefined || prevGuess.low !== undefined;

    // Cutoff check
    const now = new Date();
    const localNow = new Date(
      now.toLocaleString("en-US", { timeZone: city.timezone })
    );

    const cutoff = new Date(localNow);
    cutoff.setHours(12, 0, 0, 0);

    const isPastCutoff =
      forecastDay === 'today' && localNow >= cutoff;

    const card = document.createElement('div');
    card.className =
      hasSavedForecast ? 'city-card expanded' : 'city-card collapsed';

    card.innerHTML = `
      <div class="city-card-header">${city.name}</div>
      <div class="city-card-content">
        ${showYesterday
          ? `<p><small>Yesterday: H ${yesterdayHigh}° / L ${yesterdayLow}°</small></p>`
          : ''}

        ${hasPrevGuess
          ? `<p><small>Your last guess: H ${prevGuess.high ?? '-'}° / L ${prevGuess.low ?? '-'}°</small></p>`
          : ''}

        <label>High °F:
          <input type="number"
            class="daily-high"
            data-city-id="${city.id}"
            min="-25" max="125"
            ${isPastCutoff ? 'disabled' : ''}>
        </label>

        <label>Low °F:
          <input type="number"
            class="daily-low"
            data-city-id="${city.id}"
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

// Click handler

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

// Save handler

document.getElementById('tempsForm').addEventListener('submit', async e => {
  e.preventDefault();

  const forecastDay = document.getElementById('forecastDay').value;
  const payload = [];
  let blocked = false;

  document.querySelectorAll('.daily-high, .daily-low').forEach(input => {
    const val = input.value.trim();
    if (!val) return;

    const cityId = Number(input.dataset.cityId);
    const city = cities.find(c => c.id === cityId);

    const localNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: city.timezone })
    );

    const cutoff = new Date(localNow);
    cutoff.setHours(12, 0, 0, 0);

    if (forecastDay === 'today' && localNow >= cutoff) {
      blocked = true;
      return;
    }

    const type = input.classList.contains('daily-high')
      ? 'high'
      : 'low';

    let entry = payload.find(p => p.city_id === cityId);

    if (!entry) {
      entry = {
        city_id: cityId,
        date:
          forecastDay === 'today'
            ? getCityLocalDateISO(city.timezone, 0)
            : getCityLocalDateISO(city.timezone, 1),
        user_id: 1
      };
      payload.push(entry);
    }

    entry[type] = Number(val);
  });

  if (blocked) {
    document.getElementById('status').innerHTML =
      '<span style="color:red;">Cutoff passed for one or more cities.</span>';
    return;
  }

  if (!payload.length) {
    document.getElementById('status').innerHTML =
      '<span style="color:red;">Enter at least one valid guess!</span>';
    return;
  }

  const { error } = await client
    .from('daily_forecasts')
    .upsert(payload, { onConflict: 'user_id,city_id,date' });

  if (error) {
    document.getElementById('status').innerHTML =
      `<span style="color:red;">Save failed: ${error.message}</span>`;
  } else {
    hasSavedForecast = true;
    document.getElementById('status').innerHTML =
      `<span style="color:green;">Saved ${payload.length} forecasts! 🐰</span>`;
    buildDailyGrid();
  }
});

// Change dropdown

document.getElementById('forecastDay').addEventListener('change', () => {
  updateCurrentDate();
  buildDailyGrid();
});

// Auto check PST UI refresh

function shouldCheckNow() {
  const pstNow = getPSTNow();
  const hours = pstNow.getHours();
  const minutes = pstNow.getMinutes();

  return (
    (hours === 11 && minutes >= 55) ||
    (hours === 12 && minutes === 0) ||
    (hours === 23 && minutes >= 55) ||
    (hours === 0 && minutes === 0)
  );
}

setInterval(() => {
  if (shouldCheckNow()) {
    updateCurrentDate();
    buildDailyGrid();
  }
}, 60000);

// Start page

loadCities();
