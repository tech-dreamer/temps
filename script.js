const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';
const FORECAST_TYPES = {DAILY: "daily", HOURLY: "hourly", SIXHR: "6hr"};

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];

// Load cities from DB
function buildHourlies() {
  const template = document.getElementById("hourly");
  for (let i=0; i<8; i++){
    const clone = template.content.cloneNode(true);
    const span = document.getElementsByTagName("span")[0];
    span.innerText = i+"AM";
    document.body.appendChild(clone);
  }
}

// Load cities from DB
async function loadCities() {
  const { data, error } = await client
    .from('cities')
    .select('id, name')
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

// Save forecast
document.getElementById('tempsForm').addEventListener('submit', async e => {
  e.preventDefault();

  const cityId = document.getElementById('citySelect').value;
  const isHourly = document.getElementById('forecastType').value === FORECAST_TYPES.HOURLY;
  const guess = document.getElementById(isHourly ? FORECAST_TYPES.HOURLY : 'high').value.trim();

  if (!cityId || !guess) {
    document.getElementById('status').innerHTML = '<span style="color:red;">Pick a city and make your forecast!</span>';
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  const { error } = await client
    .from('hourly_forecasts')
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
    document.getElementById('status').innerHTML = `<span style="color:green;">Saved! ${guess}°F for ${cityName}</span>`;
  }
});

// Reveal actuals
document.getElementById('revealBtn').addEventListener('click', async () => {
  const today = new Date().toISOString().split('T')[0];

  const { data: actuals } = await client
    .from('daily_actuals')
    .select('city_id, high')
    .eq('date', today);

  const { data: predictions } = await client
    .from('daily_forecasts')
    .select('city_id, forecast')
    .eq('user_id', 1)
    .eq('date', today);

  if (!actuals || actuals.length === 0) {
    document.getElementById('revealResults').innerHTML = `
      <p style="color:#e67e22;text-align:center;">🌤️ Actuals not ready yet — check tomorrow!</p>
    `;
    return;
  }

  let results = '<h3 style="text-align:center;color:#2c3e50;">🐰 Today\'s Reveal 🐰</h3>';

  actuals.forEach(actual => {
    const cityName = cities.find(c => c.id === actual.city_id)?.name || 'Unknown City';
    const pred = predictions.find(p => p.city_id === actual.city_id);
    const guess = pred ? pred.forecast : null;
    const diff = guess !== null ? Math.abs(guess - actual.high) : null;

    let reaction = '';
    if (diff === 0) reaction = '🥇 Perfect! Your bunny earned 10 Bun Coins! :D';
    else if (diff <= 1) reaction = '😎 So close! Your bunny earned 5 Bun Coins!';
    else if (diff <= 2) reaction = '😎 So close! Your bunny earned 2 Bun Coins!';
    else if (diff <= 3) reaction = '👍 Good try! You will get it next time.';
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

// Load cities on page load
const isHourly = document.getElementById('forecastType').value === FORECAST_TYPES.HOURLY;
if(isHourly){
  buildHourlies();
}
loadCities();
