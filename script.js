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

// Build 8 hourly inputs
function buildHourlies() {
  const container = document.querySelector('#tempsForm');
  const template = document.getElementById("hourlyForecast");

  const cityId = document.getElementById('citySelect').value;
  if (!cityId) return;

  const city = cities.find(c => c.id == cityId);
  if (!city || !city.timezone) return;

  const tz = city.timezone;

  // Clear old
  container.querySelectorAll('.hourly-input').forEach(el => el.remove());

  const estBase = new Date();
  estBase.setHours(11, 0, 0, 0);

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

// Save forecasts
document.getElementById('tempsForm').addEventListener('submit', async e => {
  e.preventDefault();

  const cityId = document.getElementById('citySelect').value;
  const forecastType = document.getElementById('forecastType').value;

  if (!cityId) {
    document.getElementById('status').innerHTML = '<span style="color:red;"> Choose a city! </span>';
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  if (forecastType === FORECAST_TYPES.DAILY) {
    const highGuess = document.getElementById('high').value.trim();
    const lowGuess = document.getElementById('low').value.trim();
    if (!highGuess && !lowGuess) {
      document.getElementById('status').innerHTML = '<span style="color:red;">Enter high or low forecast!</span>';
      return;
  }

    const { error } = await client
      .from('daily_forecasts')
      .upsert({
        user_id: 1,
        city_id: Number(cityId),
        date: today,
        high: Number(highGuess)
        low: Number(lowGuess)
      }, { onConflict: 'user_id,city_id,date' });

    if (error) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${error.message}</span>`;
    } else {
      const cityName = cities.find(c => c.id == cityId)?.name || 'Unknown';
      document.getElementById('status').innerHTML = `<span style="color:green;"> Saved daily forecast for ${cityName}! </span>`;
    }

  // Hourly: Save any number of hours & update forecasts if edited
  } else if (forecastType === FORECAST_TYPES.HOURLY) {
    const hourlyGuesses = [];
    const inputs = document.querySelectorAll('input[id^="hour-"]');
    inputs.forEach(input => {
      if (input.value.trim()) {
        const utcHour = parseInt(input.id.split('-')[1]);
        hourlyGuesses.push({
          hour: utcHour,
          forecast: Number(input.value.trim())
        });
      }
    });

    if (hourlyGuesses.length === 0) {
      document.getElementById('status').innerHTML = '<span style="color:red;"> Enter at least 1 hourly forecast! </span>';
      return;
    }

    // Create or get parent set
    let setId;
    const { data: existingSet, error: fetchError } = await client
      .from('hourly_forecasts_sets')
      .select('id')
      .eq('user_id', 1)
      .eq('city_id', Number(cityId))
      .eq('date', today)
      .maybeSingle();

    if (fetchError && fetchError.code !== 'PGRST116') {
      document.getElementById('status').innerHTML = `<span style="color:red;">${fetchError.message}</span>`;
      return;
    }

    if (existingSet) {
      setId = existingSet.id;
    } else {
      const { data: newSet, error: insertError } = await client
        .from('hourly_forecasts_sets')
        .insert({
          user_id: 1,
          city_id: Number(cityId),
          date: today
        })
        .select()
        .single();

      if (insertError) {
        document.getElementById('status').innerHTML = `<span style="color:red;">${insertError.message}</span>`;
        return;
      }
      setId = newSet.id;
    }

    // Delete old forecasts
    const { error: deleteError } = await client
      .from('hourly_forecasts')
      .delete()
      .eq('set_id', setId);

    if (deleteError) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${deleteError.message}</span>`;
      return;
    }

    // Insert new forecasts
    const hourlyInserts = hourlyGuesses.map(guess => ({
      set_id: setId,
      hour: guess.hour,
      forecast: guess.forecast
    }));

    const { error: hourlyError } = await client
      .from('hourly_forecasts')
      .insert(hourlyInserts);

    if (hourlyError) {
      document.getElementById('status').innerHTML = `<span style="color:red;">${hourlyError.message}</span>`;
    } else {
      document.getElementById('status').innerHTML = `<span style="color:green;"> Saved ${hourlyGuesses.length} hourly forecasts! </span>`;
    }
  }
});

// Reveal placeholder
document.getElementById('revealBtn').addEventListener('click', async () => {
  document.getElementById('revealResults').innerHTML = '<p style="text-align:center;"> 🌤️ Reveal coming soon! </p>';
});

// Load on start
const isHourly = document.getElementById('forecastType').value === FORECAST_TYPES.HOURLY;
loadCities();
if (isHourly) {
  document.getElementById('citySelect').addEventListener('change', buildHourlies);
}
