const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';
const FORECAST_TYPES = {DAILY: "daily", HOURLY: "hourly", SIXHR: "6hr"};

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

  
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(now);

  const get = t => parts.find(p => p.type === t).value;

  const estBase = new Date(Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    16, 0, 0, 0
  ));

  const localFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: true
  });

  for (let i = 0; i < 8; i++) {
    const estHourDate = new Date(estBase.getTime() + i * 60 * 60 * 1000);
    const localTime = localFormatter.format(estHourDate);

    const clone = template.content.cloneNode(true);
    const div = clone.querySelector('div');
    div.classList.add('hourly-input');  // for clearing later
    const span = clone.querySelector("span");
    const input = clone.querySelector("input");

    span.innerText = localTime;

    const utcHour = estHourDate.getUTCHours();
    input.id = `hour-${utcHour}`;
    input.name = `hour-${utcHour}`;

    // Disable if past 30-min cutoff
    input.disabled = isHourPastCutoff(estHourDate, tz);

    container.insertBefore(clone, document.getElementById('submitBtn'));
  }
}

function isHourPastCutoff(estHourDate, tz) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric'
  }).formatToParts(now);

  const get = t => parts.find(p => p.type === t).value;

  const localNow = new Date(Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute')
  ));

  const cutoff = new Date(estHourDate.getTime() - 30 * 60 * 1000);

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
  const inserts = [];

  if (forecastType === FORECAST_TYPES.DAILY) {
    const guess = document.getElementById('high').value.trim();
    if (!guess) {
      document.getElementById('status').innerHTML = '<span style="color:red;">Enter a guess!</span>';
      return;
    }

    inserts.push({
      user_id: 1,
      city_id: Number(cityId),
      date: today,
      forecast: Number(guess)
    });

    const { error } = await client.from('daily_forecasts').upsert(inserts, { onConflict: 'user_id,city_id,date' });
    if (error) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${error.message}</span>`;
    } else {
      const cityName = cities.find(c => c.id == cityId)?.name || 'Unknown';
      document.getElementById('status').innerHTML = `<span style="color:green;">Saved daily forecast for ${cityName}!</span>`;
    }
  } else if (forecastType === FORECAST_TYPES.HOURLY) {
    // Collect all filled hourly inputs
    for (let i = 0; i < 8; i++) {
      const estHour = 11 + i;
      const input = document.querySelector(`input[id^="hour-"]:nth-child(${i + 1})`);  // rough selector, improve if needed
      if (input && input.value.trim()) {
        const utcHour = new Date().setHours(estHour);  // approximate UTC
        inserts.push({
          user_id: 1,
          city_id: Number(cityId),
          date: today,
          hour: utcHour,  // or use estHour if storing EST
          forecast: Number(input.value.trim())
        });
      }
    }

    if (inserts.length === 0) {
      document.getElementById('status').innerHTML = '<span style="color:red;">Enter at least one hourly forecast!</span>';
      return;
    }

    const { error } = await client.from('hourly_forecasts').upsert(inserts, { onConflict: 'user_id,city_id,date,hour' });

    if (error) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${error.message}</span>`;
    } else {
      document.getElementById('status').innerHTML = `<span style="color:green;">Saved ${inserts.length} hourly forecasts!</span>`;
    }
  }
});

// Reveal actuals
document.getElementById('revealBtn').addEventListener('click', async () => {
  const today = new Date().toISOString().split('T')[0];
  const { data: predictions } = await client
    .from('daily_forecasts')
    .select('city_id, high, low')
    .eq('user_id', 1)
    .eq('date', today); 
  let results = '<h3 style="text-align:center;color:#2c3e50;"> Today\'s Reveal </h3>';
  document.getElementById('revealResults').innerHTML = results;
});
// Load on start
const isHourly = document.getElementById('forecastType').value === FORECAST_TYPES.HOURLY;
loadCities();
if (isHourly) {
  document.getElementById('citySelect').addEventListener('change', buildHourlies);
}
