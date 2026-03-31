const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let cities = [];
let hasSavedForecast = false;

const HOURLY_LABELS = [
  // "Noon",
  "1PM",
  "2PM",
  "3PM",
  "4PM",
  "5PM",
  "6PM",
  "7PM",
  "8PM"
];

const HOURLY_GAME_SWITCH_HOUR_ET = 20; // 19

const isDailyPage = !!document.getElementById('tempsForm');
const isHourlyPage = !!document.getElementById('hourlyForm');

let selectedHour = null;
let userId;
let hourlyCurrentDateKey = '';

// Helper to get existing user or create new
async function getOrCreateUser() {
  let id = localStorage.getItem("temps_user_id");

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("temps_user_id", id);
  }

  const { data } = await client
    .from('users')
    .select('id')
    .eq('id', id)
    .single();

  if (!data) {
    await client
      .from('users')
      .insert({ id: id });
  }

  return id;
}

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

function getETGameDateISO(useTomorrow = false) {
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  if (useTomorrow) {
    etNow.setDate(etNow.getDate() + 1);
  }

  const year = etNow.getFullYear();
  const month = String(etNow.getMonth() + 1).padStart(2, '0');
  const day = String(etNow.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getPTNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
}

function getETNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

function getHourlyCutoff(etNow, hourValue) {
  const cutoff = new Date(etNow);
  const wholeHour = Math.floor(hourValue);
  const minuteMark = Number.isInteger(hourValue) ? 0 : 30;
  cutoff.setHours(wholeHour, minuteMark, 0, 0);
  cutoff.setMinutes(cutoff.getMinutes() - 30);
  return cutoff;
}

function isPastCutoffForHour(etNow, useTomorrow, hourValue) {
  if (useTomorrow) return false;
  return etNow >= getHourlyCutoff(etNow, hourValue);
}

function getHourlyGameDateMeta() {
  const etNow = getETNow();

  const switchTime = new Date(etNow);
  switchTime.setHours(HOURLY_GAME_SWITCH_HOUR_ET, 0, 0, 0);

  const useTomorrow = etNow >= switchTime;

  const labelDate = new Date(etNow);
  if (useTomorrow) {
    labelDate.setDate(labelDate.getDate() + 1);
  }

  return {
    etNow,
    useTomorrow,
    gameDate: getETGameDateISO(useTomorrow),
    gameDateLabel: labelDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric"
    })
  };
}

function updateHourlyCurrentDate() {
  const el = document.getElementById('currentHourlyDate');
  if (!el) return getHourlyGameDateMeta().gameDate;

  const state = getHourlyGameDateMeta();
  el.textContent = `Forecast date (ET): ${state.gameDateLabel}`;
  return state.gameDate;
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

  if (isHourlyPage) {
    hourlyCurrentDateKey = updateHourlyCurrentDate();
  }
}

// Update current date label on daily page

function updateCurrentDate() {
  const dateDisplay = document.getElementById('currentDate');
  const forecastDaySelect = document.getElementById('forecastDay');

  if (!dateDisplay || !forecastDaySelect) return;

  const now = new Date();

  const ptNow = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  ); // current PT

  const ptCutoff = new Date(ptNow); // noon PT cutoff
  ptCutoff.setHours(12, 0, 0, 0);

  const dateKey = `${ptNow.getFullYear()}-${String(ptNow.getMonth() + 1).padStart(2, "0")}-${String(ptNow.getDate()).padStart(2, "0")}`;
  const autoSwitchKey = `temps_auto_switched_${dateKey}`;

  const hasAutoSwitched = sessionStorage.getItem(autoSwitchKey);

  if (ptNow >= ptCutoff && !hasAutoSwitched) {
    forecastDaySelect.value = "tomorrow";
    sessionStorage.setItem(autoSwitchKey, "true");
  } // auto-switch dropdown once after noon PT

  const ptToday = ptNow.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric"
  }); // build display dates

  const tomorrow = new Date(ptNow);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const ptTomorrow = tomorrow.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric"
  });

  dateDisplay.textContent =
    forecastDaySelect.value === "today"
      ? ptToday
      : ptTomorrow;
}

// Load data in safe window

async function loadDailyData() {
  const now = new Date();

  const minDate = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
  const maxDate = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

  const { data: hourlyGuesses } = await client
    .from('hourly_forecasts')
    .select('city_id, hour, temp, date')
    .eq('user_id', userId);

  const { data: actuals } = await client
    .from('daily_actuals')
    .select('city_id, high, low, date');

  const { data: guesses } = await client
    .from('daily_forecasts')
    .select('city_id, high, low, date')
    .eq('user_id', userId)
    .gte('date', minDate)
    .lte('date', maxDate);

  return { actuals: actuals || [], guesses: guesses || [], hourlyGuesses: hourlyGuesses || [] };
}

// Build grid

async function buildDailyGrid() {
  const grid = document.getElementById('dailyGrid');
  const forecastDaySelect = document.getElementById('forecastDay');
  if (!grid || !forecastDaySelect) return; // guard clause

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

    const cityActuals = actuals
      .filter(a => a.city_id === city.id && a.date <= cityYesterday)
      .sort((a, b) => b.date.localeCompare(a.date));

    const yesterdayHigh =
      showYesterday && cityActuals.length
        ? cityActuals[0].high
        : ' ';

    const yesterdayLow =
      showYesterday && cityActuals.length
        ? cityActuals[0].low
        : ' ';

    const prevGuess = guesses.find(
      g => g.city_id === city.id && g.date === targetDate
    ) || {};

    const hasPrevGuess =
      prevGuess.high !== undefined || prevGuess.low !== undefined;

    // Cutoff check (noon local time)
    const now = new Date();
    const ptNow = getPTNow();

    const localNow = new Date(
      now.toLocaleString("en-US", { timeZone: city.timezone })
    );

    const cutoff = new Date(localNow);
    cutoff.setHours(12, 0, 0, 0);

    const ptCutoff = new Date(ptNow);
    ptCutoff.setHours(12, 0, 0, 0);

    const isPastCutoff =
      forecastDay === 'today' &&
      (ptNow >= ptCutoff || localNow >= cutoff); // all cities stay closed from PT noon to midnight

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
          ? `<p><small>Your current forecast: H ${prevGuess.high ?? '-'}° / L ${prevGuess.low ?? '-'}°</small></p>`
          : ''}

        <label>High Temp °F:
          <input type="number"
            class="daily-high"
            data-city-id="${city.id}"
            value="${prevGuess.high ?? ''}"
            min="-25" max="125"
            ${isPastCutoff ? 'disabled' : ''}>
        </label>

        <label>Low Temp °F:
          <input type="number"
            class="daily-low"
            data-city-id="${city.id}"
            value="${prevGuess.low ?? ''}"
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

function buildHourSelector() {
  const container = document.getElementById('hourSelector');
  if (!container) return;

  container.innerHTML = '';

  HOURLY_LABELS.forEach(label => {
    const box = document.createElement('div');
    box.className = 'hour-box';
    box.textContent = label;

    box.addEventListener('click', () => {
      document.querySelectorAll('.hour-box')
        .forEach(b => b.classList.remove('active'));

      box.classList.add('active');
      selectedHour = label;

      buildHourlyGrid();
      updateHourlyButton();
    });

    container.appendChild(box);
  });
}

async function buildHourlyGrid() {
  const { hourlyGuesses } = await loadDailyData();
  const grid = document.getElementById('hourlyGrid');
  if (!grid || !selectedHour) return;

  const hourlyState = getHourlyGameDateMeta();
  const etNow = hourlyState.etNow;
  const useTomorrow = hourlyState.useTomorrow;
  const selectedForecastDate = hourlyState.gameDate;

  const hourNum = convertHourLabel(selectedHour);
  const showSixHrHigh = hourNum === 14 || hourNum === 20; // hourNum === 13 || hourNum === 19;
  const sixHrHourNum = showSixHrHigh ? hourNum + 0.5 : null;

  grid.innerHTML = '';

  cities.forEach(city => {
    const localLabel = convertETToCityHourLabel(hourNum, city.timezone);
    const isPastCutoff = isPastCutoffForHour(etNow, useTomorrow, hourNum);

    const prevGuess = hourlyGuesses.find(
      g =>
        g.city_id === city.id &&
        g.hour === hourNum &&
        g.date === selectedForecastDate
    );

    const prev6HrGuess = sixHrHourNum !== null ? hourlyGuesses.find(
      g =>
        g.city_id === city.id &&
        g.hour === sixHrHourNum &&
        g.date === selectedForecastDate
    ) : null;

    const card = document.createElement('div');
    card.className = 'city-card expanded';
    card.dataset.cityId = city.id;
    card.innerHTML = `
      <div class="city-card-header">${city.name}</div>
      <div class="city-card-content">
        <label>
          Temp °F at ${localLabel}:
          <input type="number"
            class="hourly-input"
            data-city-id="${city.id}"
            data-hour="${hourNum}"
            value="${prevGuess?.temp ?? ''}"
            min="-25"
            max="125"
            ${isPastCutoff ? 'disabled' : ''}>
        </label>

        ${sixHrHourNum !== null ? `
          <label>
            6-hr High °F:
            <input type="number"
              class="hourly-input"
              data-city-id="${city.id}"
              data-hour="${sixHrHourNum}"
              value="${prev6HrGuess?.temp ?? ''}"
              min="-25"
              max="125"
              ${isPastCutoff ? 'disabled' : ''}>
          </label>
        ` : ''}

        ${(isPastCutoff)
          ? '<small style="color:#e74c3c;">Past cutoff</small>'
          : ''}
      </div>
    `;

    grid.appendChild(card);
  });
}

function convertHourLabel(label) {
  let num = parseInt(label);
  if (label.includes("PM") && num !== 12) num += 12;
  return num;
}

function convertETToCityHourLabel(etHour, cityTimezone) {
  const now = new Date();

  const etDate = new Date( // create a date in ET at the selected hour
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  const hourPart = Math.floor(etHour);
  const minutePart = Number.isInteger(etHour) ? 0 : 30;

  etDate.setHours(hourPart, minutePart, 0, 0);

  const cityTime = new Date(  // convert to city local time
    etDate.toLocaleString("en-US", { timeZone: cityTimezone })
  );

  let hours = cityTime.getHours();
  const minutes = cityTime.getMinutes();

  const period = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;

  const minuteText = minutes === 0 ? "" : `:${String(minutes).padStart(2, '0')}`;
  return `${hours}${minuteText} ${period}`;
}

function updateHourlyButton() {
  const btn = document.getElementById('hourlySaveBtn');
  if (!btn) return;

  if (!selectedHour) {
    btn.disabled = true;
    btn.textContent = "Select an Hour";
  } else {
    btn.disabled = false;
    btn.textContent = `Save ${selectedHour} Forecasts`;
  }
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

// Save handlers

const dailyForm = document.getElementById('tempsForm');
if (dailyForm) {
  dailyForm.addEventListener('submit', async e => {
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
          city: city.name,
          date:
            forecastDay === 'today'
              ? getCityLocalDateISO(city.timezone, 0)
              : getCityLocalDateISO(city.timezone, 1),
          user_id: userId
        };
        payload.push(entry);
      }

      entry[type] = Number(val);
    });

    if (blocked) {
      document.getElementById('status').innerHTML =
        '<span style="color:red;">Cutoff passed for at least 1 city.</span>';
      return;
    }

    if (!payload.length) {
      document.getElementById('status').innerHTML =
        '<span style="color:red;">Enter at least 1 valid forecast!</span>';
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
}

const hourlyForm = document.getElementById('hourlyForm');

async function handleHourlySubmit(e) {
  e.preventDefault();

  const status = document.getElementById("status");
  if (!selectedHour) {
    status.innerHTML = '<span style="color:red;">Select an hour first.</span>';
    return;
  }

  const clearInput = (input) => {
    if (!input) return;
    input.style.borderColor = "";
    input.style.boxShadow = "";
    input.style.backgroundColor = "";
  };

  const markInvalid = (input) => {
    if (!input) return;
    input.style.borderColor = "#dc2626";
    input.style.boxShadow = "0 0 0 1px #dc2626";
    input.style.backgroundColor = "#fef2f2";
  };

  // Clear old validation
  document.querySelectorAll(".hourly-validation-msg").forEach(el => el.remove());
  document.querySelectorAll(".hourly-input").forEach(clearInput);

  const hourlyState = getHourlyGameDateMeta();
  const etNow = hourlyState.etNow;
  const useTomorrow = hourlyState.useTomorrow;
  const selectedForecastDate = hourlyState.gameDate;
  const selectedHourNum = convertHourLabel(selectedHour);
  const showSixHrHigh = selectedHourNum === 14 || selectedHourNum === 20;
  const selectedCutoff = getHourlyCutoff(etNow, selectedHourNum);
  const sixHrHourNum = showSixHrHigh ? selectedHourNum + 0.5 : null;

  if (!Number.isFinite(selectedHourNum)) {
    status.innerHTML = '<span style="color:red;">Invalid selected hour.</span>';
    return;
  }

  let blocked = false;
  const payload = [];
  const cityRows = new Map(); // cityId -> { cityName, cityId, hourlyVal, sixHrVal, sixHrInput }

  const EPS = 1e-6;
  const sameHour = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < EPS;

  document.querySelectorAll(".hourly-input").forEach((input) => {
    if (input.disabled) return; // prevent disabled fields from being validated or included in payload
    const raw = input.value.trim();
    if (!raw) return;

    const cityId = Number(input.dataset.cityId);
    const inputHour = Number(input.dataset.hour);
    const numVal = Number(raw);

    if (Number.isNaN(cityId) || Number.isNaN(inputHour) || Number.isNaN(numVal)) return;

    if (!useTomorrow && etNow >= selectedCutoff) {
      blocked = true;
      return;
    }

    const city = cities.find((c) => c.id === cityId);
    if (!city) return;

    const row = cityRows.get(cityId) || {
      cityName: city.name,
      cityId,
      hourlyVal: undefined,
      sixHrVal: undefined,
      sixHrInput: null
    };

    if (sameHour(inputHour, selectedHourNum)) { // integer hour = hourly input at selected hour
      row.hourlyVal = numVal;
    }

    if (sameHour(inputHour, sixHrHourNum)) { // hour + 0.5 = 6-hr input at selected hour
      row.sixHrVal = numVal;
      row.sixHrInput = input;
    }

    cityRows.set(cityId, row);

    payload.push({
      city_id: cityId,
      city: city.name,
      date: selectedForecastDate,
      hour: inputHour,
      temp: numVal,
      user_id: userId
    });
  });

  if (blocked) {
    status.innerHTML = '<span style="color:red;">Cutoff passed for this hour selection.</span>';
    return;
  }

  if (!payload.length) {
    status.innerHTML = '<span style="color:red;">Enter at least 1 forecast.</span>';
    return;
  }

  const validationMessages = [];
  cityRows.forEach((row, cityId) => {
    if (!row.sixHrInput) return; // no 6-hr rule needed if no 6-hr entered

    const cityCard = document.querySelector(`#hourlyGrid .city-card[data-city-id="${cityId}"]`);
    const msgHost = cityCard?.querySelector(".city-card-content");

    if (row.hourlyVal === undefined) {
      markInvalid(row.sixHrInput);
      validationMessages.push(`${row.cityName}: 6-hr high requires the hourly ${selectedHour} forecast first.`);
    } else if (row.sixHrVal < row.hourlyVal) {
      markInvalid(row.sixHrInput);
      validationMessages.push(
        `${row.cityName}: 6-hr high (${row.sixHrVal}°F) must be >= hourly temp (${row.hourlyVal}°F).`
      );
    }

    if (validationMessages.length && msgHost) {
      if (!msgHost.querySelector('.hourly-validation-msg')) {
        msgHost.insertAdjacentHTML(
          "beforeend",
          `<div class="hourly-validation-msg" style="color:#dc2626; margin-top:.4rem;">Fix invalid 6-hr input.</div>`
        );
      }
    }
  });

  if (validationMessages.length) {
    status.innerHTML = `<span style="color:red;">${validationMessages.join("<br>")}</span>`;
    return; // save nothing if any invalid
  }

  const { error } = await client
    .from("hourly_forecasts")
    .upsert(payload, { onConflict: "user_id,city_id,date,hour" });

  if (error) {
    status.innerHTML = `<span style="color:red;">Save failed: ${error.message}</span>`;
  } else {
    status.innerHTML = `<span style="color:green;">Saved ${selectedHour} forecasts! 🐰</span>`;
    await buildHourlyGrid();
  }
}

if (hourlyForm) {
  hourlyForm.addEventListener('submit', handleHourlySubmit);
}

// Advance dropdown

const forecastDaySelect = document.getElementById('forecastDay');

if (forecastDaySelect) {
  forecastDaySelect.addEventListener('change', () => {
    updateCurrentDate();
    buildDailyGrid();
  });
}

// Auto check PT UI refresh

function shouldCheckNow() {
  const ptNow = getPTNow();
  const hours = ptNow.getHours();
  const minutes = ptNow.getMinutes();

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

  if (isHourlyPage) {
    const current = updateHourlyCurrentDate();
    if (current !== hourlyCurrentDateKey) {
      hourlyCurrentDateKey = current;
      if (selectedHour) {
        buildHourlyGrid();
      }
    }
  }
}, 60000);

// Connect Show Score button to user score page
document.addEventListener("DOMContentLoaded", function () {
  const btn = document.getElementById("revealBtn");

  if (btn) {
    btn.addEventListener("click", function () {
      window.location.href = `score.html?mode=${isHourlyPage ? 'hourly' : 'daily'}`;
    }
  }
};

// Start page

(async () => {
  userId = await getOrCreateUser();
  await loadCities();

  if (document.getElementById('hourSelector')) {
    buildHourSelector();
  }
})();
