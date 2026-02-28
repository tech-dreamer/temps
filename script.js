// rollback/simple version (no max-height animation logic)
// keep basic guards against duplicate initialization and idempotent expand/collapse

const SUPABASE_URL = 'https://ckyqknlxmjqlkqnxhgef.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreXFrbmx4bWpxbGtxbnhoZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MDEwNjksImV4cCI6MjA4MDQ3NzA2OX0.KPzrKD3TW1CubAQhHyo5oJV0xQ_GLxBG96FSDfTN6p0';

if (window.__TEMPS_SCRIPT_INITIALIZED__) {
  console.warn('script.js: already initialized, skipping duplicate run.');
} else {
  window.__TEMPS_SCRIPT_INITIALIZED__ = true;

  const { createClient } = supabase;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let cities = [];
  let allExpanded = false;

  /* --- Minimal styles (no max-height transition) --- */
  (function injectStyles() {
    if (document.querySelector('style[data-injected-by="script.simple"]')) return;
    const css = `
      .city-card { border: 1px solid #ddd; border-radius: 6px; margin: 8px 0; background: #fff; }
      .city-card-header { padding: 12px; cursor: pointer; font-weight: 600; user-select: none; }
      .city-card-content { padding: 12px; display: none; }
      .city-card.expanded .city-card-content { display: block; }
      .pt-hint { display: inline-block; vertical-align: middle; margin-left: 8px; position: relative; width: 18px; height: 18px; border-radius: 50%; background: #2d8cf0; color: white; text-align: center; font-size: 12px; line-height: 18px; cursor: default; }
      .pt-hint .pt-tooltip { display: none; position: absolute; left: 110%; top: 50%; transform: translateY(-50%); background: #222; color: #fff; padding: 6px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.15); z-index: 1000; }
      .pt-hint:hover .pt-tooltip { display: block; }
      @media (max-width: 520px) {
        .pt-hint .pt-tooltip { left: 0; top: 110%; transform: translateY(0); }
      }
    `;
    const s = document.createElement('style');
    s.setAttribute('data-injected-by', 'script.simple');
    s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  })();

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

  function insertPtHintIfMissing() {
    const dateDisplay = document.getElementById('currentDate');
    if (!dateDisplay) return;
    if (dateDisplay.dataset.ptHint === '1') return;

    const span = document.createElement('span');
    span.className = 'pt-hint';
    span.setAttribute('aria-label', 'Dates shown in Pacific Time (PT)');
    span.innerHTML = 'i';

    const tooltip = document.createElement('span');
    tooltip.className = 'pt-tooltip';
    tooltip.textContent = 'Dates shown in Pacific Time (PT)';
    span.appendChild(tooltip);

    dateDisplay.parentNode && dateDisplay.parentNode.insertBefore(span, dateDisplay.nextSibling);
    dateDisplay.dataset.ptHint = '1';
  }

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

      insertPtHintIfMissing();
    }
  }

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
    insertPtHintIfMissing();
    buildDailyGrid();
    refreshCurrentDateDisplay();
  }

  async function loadDailyData() {
    const pstToday = getPstTodayStart();
    const pstTodayISO = formatDateYMD(pstToday);
    const pstTomorrow = new Date(pstToday);
    pstTomorrow.setDate(pstTomorrow.getDate() + 1);
    const pstTomorrowISO = formatDateYMD(pstTomorrow);

    const pstYesterday = new Date(pstToday);
    pstYesterday.setDate(pstYesterday.getDate() - 1);
    const pstYesterdayISO = formatDateYMD(pstYesterday);

    const [{ data: actuals = [] } = {}, { data: guesses = [] } = {}] = await Promise.all([
      client.from('hourly_actuals').select('city_id, temp').eq('date', pstYesterdayISO),
      client.from('daily_forecasts').select('city_id, high, low, date').eq('user_id', 1).in('date', [pstTodayISO, pstTomorrowISO])
    ]);

    return { actuals, guesses };
  }

  function enableOrDisableInputsForCity(card, city, targetIsoDate, showYesterday) {
    const inputs = card.querySelectorAll('input.daily-high, input.daily-low');
    if (!inputs) return;

    const pstTodayIso = formatDateYMD(getPstTodayStart());
    const isTargetToday = targetIsoDate === pstTodayIso;

    if (isTargetToday) {
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
      } else if (notice) {
        notice.remove();
      }
    } else {
      inputs.forEach(inp => inp.disabled = false);
      const notice = card.querySelector('.cutoff-note');
      if (notice) notice.remove();
    }
  }

  function setCardExpandedState(card, expanded) {
    const isExpanded = card.classList.contains('expanded');
    if (expanded && !isExpanded) {
      card.classList.remove('collapsed');
      card.classList.add('expanded');
    } else if (!expanded && isExpanded) {
      card.classList.remove('expanded');
      card.classList.add('collapsed');
    }
  }

  async function buildDailyGrid() {
    const grid = document.getElementById('dailyGrid');
    if (!grid) return;
    grid.innerHTML = '<p>Loading cities...</p>';

    try {
      const { actuals, guesses } = await loadDailyData();

      grid.innerHTML = '';

      const forecastDay = (document.getElementById('forecastDay')?.value) || 'today';
      const targetIsoDate = targetDateForForecastDay(forecastDay);
      const showYesterday = forecastDay === 'today';

      cities.forEach(city => {
        const cityActuals = actuals.filter(a => a.city_id === city.id);
        const yesterdayHigh = showYesterday && cityActuals.length ? Math.max(...cityActuals.map(a => a.temp)) : '?';
        const yesterdayLow = showYesterday && cityActuals.length ? Math.min(...cityActuals.map(a => a.temp)) : '?';

        const prevGuess = guesses.find(g => g.city_id === city.id && g.date === targetIsoDate) || {};
        const hasPrevGuess = prevGuess.high !== undefined || prevGuess.low !== undefined;

        const card = document.createElement('div');
        card.className = 'city-card collapsed';

        card.innerHTML = `
          <div class="city-card-header">${escapeHtml(city.name)}</div>
          <div class="city-card-content">
            ${showYesterday ? `<p><small>Yesterday: H ${yesterdayHigh}° / L ${yesterdayLow}°</small></p>` : ''}
            ${hasPrevGuess ? `<p><small>Your last guess: H ${prevGuess.high ?? '-'}° / L ${prevGuess.low ?? '-'}°</small></p>` : ''}
            <label style="display:block;margin-top:8px;">High °F:
              <input type="number" class="daily-high" data-city-id="${city.id}" min="-25" max="125" step="1" placeholder="High">
            </label>
            <label style="display:block;margin-top:6px;">Low °F:
              <input type="number" class="daily-low" data-city-id="${city.id}" min="-50" max="100" step="1" placeholder="Low">
            </label>
          </div>
        `;
        grid.appendChild(card);

        enableOrDisableInputsForCity(card, city, targetIsoDate, showYesterday);
        setCardExpandedState(card, allExpanded);
      });

      if (!allExpanded) {
        document.querySelectorAll('#dailyGrid .city-card').forEach(c => setCardExpandedState(c, false));
      }
    } catch (err) {
      console.error('buildDailyGrid error', err);
      grid.innerHTML = '<p style="color:red;">Failed to load grid</p>';
    }
  }

  /* --- PST noon handling --- */
  let pstNoonTriggerKey = null;
  function pstNoonCheck() {
    const sel = document.getElementById('forecastDay');
    if (!sel) return;

    const nowPST = nowInZone('America/Los_Angeles');
    const secondsOfDay = nowPST.getHours() * 3600 + nowPST.getMinutes() * 60 + nowPST.getSeconds();

    const windowStart = (11 * 3600) + (45 * 60);
    const windowEnd = 12 * 3600;

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
      if (sel.value === 'today') {
        sel.value = 'tomorrow';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        refreshCurrentDateDisplay();
        buildDailyGrid();
      }
    } catch (err) {
      console.error('doPstNoonSwitch error', err);
    }
  }

  setInterval(() => {
    try { pstNoonCheck(); } catch (e) { console.error(e); }
  }, 2 * 60 * 1000);
  pstNoonCheck();

  function handlePstMidnight() {
    try {
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
      try { handlePstMidnight(); } catch (e) { console.error(e); } finally { scheduleNextPstMidnightUpdate(); }
    }, msUntil + 100);
  }
  scheduleNextPstMidnightUpdate();

  /* --- Click handler: expand all --- */
  document.addEventListener('click', (e) => {
    const hdr = e.target.closest && e.target.closest('.city-card-header');
    if (hdr) {
      if (!allExpanded) {
        allExpanded = true;
        document.querySelectorAll('#dailyGrid .city-card').forEach(c => setCardExpandedState(c, true));
        const firstInput = document.querySelector('#dailyGrid .city-card.expanded input:not([disabled])');
        if (firstInput) firstInput.focus();
      }
      return;
    }
  });

  /* --- Form submit (save) --- */
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

      const st = document.getElementById('status');
      if (payload.length === 0) {
        if (st) st.innerHTML = '<span style="color:red;">Enter at least one valid guess!</span>';
        return;
      }

      if (st) st.innerHTML = '<span style="color:#444;">Saving…</span>';

      const { error } = await client
        .from('daily_forecasts')
        .upsert(payload, { onConflict: 'user_id,city_id,date' });

      if (error) {
        if (st) st.innerHTML = `<span style="color:red;">Save failed: ${escapeHtml(error.message || 'unknown')}</span>`;
      } else {
        if (st) st.innerHTML = `<span style="color:green;">Saved ${payload.length} city forecasts for ${forecastDay}! 🐰 Good luck!</span>`;
        allExpanded = false;
        document.querySelectorAll('#dailyGrid .city-card').forEach(c => setCardExpandedState(c, false));
        buildDailyGrid();
      }
    });
  }

  const forecastDayEl = document.getElementById('forecastDay');
  if (forecastDayEl) {
    forecastDayEl.addEventListener('change', () => {
      refreshCurrentDateDisplay();
      buildDailyGrid();
    });
  }

  /* --- Initial load --- */
  refreshCurrentDateDisplay();
  loadCities();
}
