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
    .select('id, name, timezone_id')
    .order('name');

  if (error || !data) {
    document.getElementById('status').innerHTML = '<span style="color:red;">Failed to load cities</span>';
    return;
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

  const estBase = new Date();
  estBase.setHours(11, 0, 0, 0);  // 11 AM today EST (approximate — good enough for display)

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
  const { data: actuals } = await client
    .from('daily_actuals')
    .select('city_id, high')
    .eq('date', today);  const { data: predictions } = await client
    .from('daily_forecasts')
    .select('city_id, forecast')
    .eq('user_id', 1)
    .eq('date', today);  if (!actuals || actuals.length === 0) {
    document.getElementById('revealResults').innerHTML = '<p style="color:#e67e22;text-align:center;"> Actuals not ready yet — check tomorrow!</p>';
    return;
  }  
  let results = '<h3 style="text-align:center;color:#2c3e50;"> Today\'s Reveal </h3>';
  actuals.forEach(actual => {
    const cityName = cities.find(c => c.id === actual.city_id)?.name || 'Unknown City';
    const pred = predictions.find(p => p.city_id === actual.city_id);
    const guess = pred ? pred.forecast : null;
    const diff = guess !== null ? Math.abs(guess - actual.high) : null;
    let reaction = '';
    if (diff === 0) reaction = ' Perfect! Your bun earned 10 Bun Coins & gained 1 Happy! :D';
    else if (diff <= 1) reaction = ' So close! Your bunny earned 5 Bun Coins!';
    else if (diff <= 2) reaction = ' Close! Your bunny earned 2 Bun Coins!';
    else if (diff <= 3) reaction = ' Good try! You will get it next time.';
    else reaction = 'Quite a bit off ... Your bunny lost 1 Happy :(';

    results += `
      <div style="background:#ffffff;padding:1rem;margin:0.5rem 0;border-radius:10px;border-left:5px solid #3498db;">
        <p><strong>${cityName}</strong></p>
        <p>Your guess: <strong>${guess !== null ? guess + '°F' : 'No guess'}</strong></p>
        <p>Actual high: <strong>${actual.high}°F</strong></p>
        <p>${reaction}</p>
      </div>
    `;  
  });
  document.getElementById('revealResults').innerHTML = results;
});
// Load on start
const isHourly = document.getElementById('forecastType').value === FORECAST_TYPES.HOURLY;
loadCities();
if (isHourly) {
  document.getElementById('citySelect').addEventListener('change', buildHourlies);
}
