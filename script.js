const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';
const FORECAST_TYPES = { DAILY: "daily", HOURLY: "hourly", SIXHR: "6hr" };

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
  const select = document.getElementById('citySelect');
  select.innerHTML = '<option value="" disabled selected>Select city...</option>';

  data.forEach(city => {
    const opt = document.createElement('option');
    opt.value = city.id;
    opt.textContent = city.name;
    select.appendChild(opt);
  });
}

// Rebuild hourly inputs when city changes
document.getElementById('citySelect').addEventListener('change', () => {
  if (document.getElementById('forecastType').value === FORECAST_TYPES.HOURLY) {
    buildHourlies();
  }
});

// Build 8 hourly inputs (11 AM – 7 PM EST, shown in local time)
function buildHourlies() {
  const container = document.querySelector('#tempsForm');
  const template = document.getElementById("hourlyForecast");

  const cityId = document.getElementById('citySelect').value;
  if (!cityId) return;

  const city = cities.find(c => c.id == cityId);
  if (!city || !city.timezone) return;

  const tz = city.timezone;

  // Clear old hourly inputs
  container.querySelectorAll('.hourly-input').forEach(el => el.remove());

  // Fixed EST window: 11 AM – 7 PM EST
  const estBase = new Date();
  estBase.setHours(11, 0, 0, 0);  // 

  const localFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: true
  });

  for (let i = 0; i < 8; i++) {
    const estHourDate = new Date(estBase);
    estHourDate.setHours(estBase.getHours() + i);

    const localTime = localFormatter.format(estHourDate);

    const clone = template.content.cloneNode(true);
    const div = clone.querySelector('div');
    div.classList.add('hourly-input');
    const span = clone.querySelector("span");
    const input = clone.querySelector("input");

    span.innerText = localTime;

    const utcHour = estHourDate.getUTCHours();
    input.id = `hour-${utcHour}`;
    input.name = `hour-${utcHour}`;

    input.disabled = isHourPastCutoff(estHourDate, tz);

    container.insertBefore(clone, document.getElementById('submitBtn'));
  }
}

function isHourPastCutoff(estHourDate, tz) {
  const now = new Date();
  const localNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const cutoff = new Date(estHourDate);
  cutoff.setMinutes(cutoff.getMinutes() - 30);
  return localNow > cutoff;
}

// Save forecast
document.getElementById('tempsForm').addEventListener('submit', async e => {
  e.preventDefault();

  const cityId = document.getElementById('citySelect').value;
  const forecastType = document.getElementById('forecastType').value;

  if (!cityId) {
    document.getElementById('status').innerHTML = '<span style="color:red;">Pick a city!</span>';
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  if (forecastType === FORECAST_TYPES.DAILY) {
    const guess = document.getElementById('high').value.trim();
    if (!guess) {
      document.getElementById('status').innerHTML = '<span style="color:red;">Enter a guess!</span>';
      return;
    }

    const { error } = await client
      .from('daily_forecasts')
      .upsert({
        user_id: 1,
        city_id: Number(cityId),
        date: today,
        forecast: Number(guess)
      }, { onConflict: 'user_id,city_id,date' });

    if (error) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${error.message}</span>`;
    } else {
      const cityName = cities.find(c => c.id == cityId)?.name || 'Unknown';
      document.getElementById('status').innerHTML = `<span style="color:green;">Saved daily forecast for ${cityName}!</span>`;
    }
  } else if (forecastType === FORECAST_TYPES.HOURLY) {
    const hourlyGuesses = [];
    for (let i = 0; i < 8; i++) {
      const input = document.querySelector(`input[id^="hour-"]:nth-child(${i + 1})`);
      if (input && input.value.trim()) {
        const utcHour = parseInt(input.id.split('-')[1]);
        hourlyGuesses.push({
          hour: utcHour,
          forecast: Number(input.value.trim())
        });
      }
    }

    if (hourlyGuesses.length === 0) {
      document.getElementById('status').innerHTML = '<span style="color:red;">Enter at least one hourly forecast!</span>';
      return;
    }

    // Create or get the parent set
    const { data: setData, error: setError } = await client
      .from('hourly_forecasts_sets')
      .upsert({
        user_id: 1,
        city_id: Number(cityId),
        date: today
      }, { onConflict: 'user_id,city_id,date' })
      .select()
      .single();

    if (setError) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${setError.message}</span>`;
      return;
    }

    const setId = setData.id;

    // Upsert hourly guesses
    const hourlyInserts = hourlyGuesses.map(guess => ({
      set_id: setId,
      hour: guess.hour,
      forecast: guess.forecast
    }));

    const { error: hourlyError } = await client
      .from('hourly_forecasts')
      .upsert(hourlyInserts, { onConflict: 'hour,set_id' });

    if (hourlyError) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${hourlyError.message}</span>`;
    } else {
      document.getElementById('status').innerHTML = `<span style="color:green;">Saved ${hourlyGuesses.length} hourly forecasts!</span>`;
    }
  }
});

// Reveal actuals (placeholder for now)
document.getElementById('revealBtn').addEventListener('click', async () => {
  document.getElementById('revealResults').innerHTML = '<p style="text-align:center;">🌤️ Reveal coming soon!</p>';
});

// Load on start
const isHourly = document.getElementById('forecastType').value === FORECAST_TYPES.HOURLY;
loadCities();
if (isHourly) {
  document.getElementById('citySelect').addEventListener('change', buildHourlies);
}
