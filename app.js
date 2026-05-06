/* ============================================================
   KEL-8 IoT Dashboard — app.js
   SMKN 2 Klaten | ESP32 MQTT Monitor
   ============================================================ */

// ─────────────────────────────────────────────────────────────
//  KONFIGURASI DEFAULT MQTT
// ─────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  host:      'ebf1a04ed41b47c6b5f43d391722bc20.s1.eu.hivemq.cloud',
  port:      '8884',
  username:  'khairil',
  password:  'Pass1234',
  baseTopic: 'smkn2klaten/kel-8/esp32',
};

// ─────────────────────────────────────────────────────────────
//  STATE APLIKASI
// ─────────────────────────────────────────────────────────────
let mqttConfig  = { ...DEFAULT_CONFIG };
let mqttClient  = null;
let relayState  = [false, false, false, false];
let currentMode = 'MANUAL';
let msgCount    = 0;
let toastTimer  = null;

// ── State sensor terakhir (untuk riwayat & grafik) ──
let lastSuhu = null;
let lastHum  = null;
let lastLdr  = '—';

// ─────────────────────────────────────────────────────────────
//  HYSTERESIS STATE SUHU
//  Sama persis dengan logika di Arduino:
//  State 0 : < 20°C         → idle (belum ada data / terlalu dingin)
//  State 1 : 20°C – 26°C   → normal (hijau)
//  State 2 : 26°C – 30°C   → warm   (kuning)
//  State 3 : ≥ 30°C         → hot    (merah)
//  Hysteresis ±0.5°C pada setiap batas transisi.
// ─────────────────────────────────────────────────────────────
let suhuState = 0; // 0=idle, 1=normal, 2=warm, 3=hot

function updateSuhuState(suhu) {
  switch (suhuState) {
    case 0:
      if (suhu >= 20.0)             suhuState = 1;
      break;
    case 1:
      if      (suhu >= 26.0)        suhuState = 2;
      else if (suhu <  19.5)        suhuState = 0;
      break;
    case 2:
      if      (suhu >= 30.0)        suhuState = 3;
      else if (suhu <  25.5)        suhuState = 1;
      break;
    case 3:
      if      (suhu <  29.5)        suhuState = 2;
      break;
  }
}

// Kembalikan label teks & class CSS berdasarkan state
function getSuhuMeta(state) {
  switch (state) {
    case 1:  return { label: 'NORMAL',  cls: 'suhu-normal', tblCls: 'normal' };
    case 2:  return { label: 'HANGAT',  cls: 'suhu-warm',   tblCls: 'warm'   };
    case 3:  return { label: 'PANAS!',  cls: 'suhu-hot',    tblCls: 'hot'    };
    default: return { label: '—',       cls: '',             tblCls: 'idle'   };
  }
}

// ─────────────────────────────────────────────────────────────
//  GRAFIK — Chart.js
//  Menyimpan maksimal 10 data, interval minimal 10 detik.
// ─────────────────────────────────────────────────────────────
const CHART_MAX_POINTS  = 10;
const CHART_MIN_INTERVAL_MS = 10000; // 10 detik
let lastChartTime = 0;

const chartLabels = [];   // label waktu
const chartSuhu   = [];   // data suhu
const chartHum    = [];   // data kelembaban

let sensorChart = null;

function initChart() {
  const ctx = document.getElementById('sensorChart').getContext('2d');

  Chart.defaults.color = '#64748b';
  Chart.defaults.font.family = "'DM Mono', monospace";

  sensorChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: 'Suhu (°C)',
          data: chartSuhu,
          borderColor: '#ff4d00',
          backgroundColor: 'rgba(255, 17, 0, 0.08)',
          pointBackgroundColor: '#ee863c',
          pointBorderColor: '#0a0c10',
          pointBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          yAxisID: 'ySuhu',
        },
        {
          label: 'Kelembaban (%)',
          data: chartHum,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,.06)',
          pointBackgroundColor: '#38bdf8',
          pointBorderColor: '#0a0c10',
          pointBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          yAxisID: 'yHum',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161b28',
          borderColor: '#1e2740',
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          padding: 10,
          callbacks: {
            title: items => '⏱ ' + items[0].label,
            label: item => {
              const unit = item.datasetIndex === 0 ? '°C' : '%';
              return ` ${item.dataset.label}: ${item.formattedValue}${unit}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid:  { color: 'rgba(30,39,64,.6)', drawBorder: false },
          ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 0 },
        },
        ySuhu: {
          type: 'linear',
          position: 'left',
          grid:  { color: 'rgba(30,39,64,.6)', drawBorder: false },
          ticks: { color: '#00e5ff', font: { size: 9 }, callback: v => v + '°C' },
          title: { display: false },
        },
        yHum: {
          type: 'linear',
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#38bdf8', font: { size: 9 }, callback: v => v + '%' },
        },
      },
    },
  });
}

// Tambahkan satu titik data ke grafik (jika interval terpenuhi)
function addChartPoint(suhu, hum) {
  const now = Date.now();
  if (now - lastChartTime < CHART_MIN_INTERVAL_MS) return; // belum 10 detik
  lastChartTime = now;

  const timeLabel = new Date().toLocaleTimeString('id-ID', { hour12: false });

  chartLabels.push(timeLabel);
  chartSuhu.push(parseFloat(suhu.toFixed(1)));
  chartHum.push(parseFloat(hum.toFixed(1)));

  // Jaga maksimal CHART_MAX_POINTS data
  if (chartLabels.length > CHART_MAX_POINTS) {
    chartLabels.shift();
    chartSuhu.shift();
    chartHum.shift();
  }

  if (sensorChart) sensorChart.update();
}

// ─────────────────────────────────────────────────────────────
//  RIWAYAT DATA — Tabel
//  Maksimal 50 baris, baris terbaru di atas.
// ─────────────────────────────────────────────────────────────
const HISTORY_MAX = 50;
let historyData = []; // array of { time, suhu, hum, ldr, state }

function addHistory(suhu, hum, ldr) {
  const time  = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const meta  = getSuhuMeta(suhuState);

  historyData.unshift({ time, suhu, hum, ldr, state: suhuState, meta });
  if (historyData.length > HISTORY_MAX) historyData.pop();

  renderHistory();
}

function renderHistory() {
  const tbody = document.getElementById('history-tbody');
  const count = document.getElementById('history-count');

  count.textContent = historyData.length + ' data tercatat';

  if (historyData.length === 0) {
    tbody.innerHTML = `<tr class="history-empty"><td colspan="6">Belum ada data — menunggu koneksi MQTT...</td></tr>`;
    return;
  }

  tbody.innerHTML = historyData.map((d, i) => {
    const suhuStr = d.suhu !== null ? d.suhu.toFixed(1) : '—';
    const humStr  = d.hum  !== null ? d.hum.toFixed(1)  : '—';
    return `
      <tr>
        <td style="color:var(--muted)">${historyData.length - i}</td>
        <td>${d.time}</td>
        <td>${suhuStr}</td>
        <td>${humStr}</td>
        <td>
          <span class="ldr-badge ${d.ldr === 'GELAP' ? 'gelap' : 'terang'}"
                style="font-size:10px;padding:2px 8px;margin:0">
            ${d.ldr}
          </span>
        </td>
        <td>
          <span class="tbl-badge ${d.meta.tblCls}">${d.meta.label}</span>
        </td>
      </tr>`;
  }).join('');
}

function clearHistory() {
  historyData = [];
  renderHistory();
  showToast('RIWAYAT DIHAPUS', 'var(--muted)');
}

// ─────────────────────────────────────────────────────────────
//  NOTIFIKASI SUHU PANAS (heat alert)
// ─────────────────────────────────────────────────────────────
let heatAlertShown      = false;
let heatNotifGranted    = false;
let lastHeatNotifTime   = 0;
const HEAT_NOTIF_COOLDOWN_MS = 60000; // notifikasi perangkat maks sekali per menit

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      heatNotifGranted = (p === 'granted');
    });
  } else if (Notification.permission === 'granted') {
    heatNotifGranted = true;
  }
}

function showHeatAlert(suhu) {
  // Tampilkan overlay alert
  const el  = document.getElementById('heat-alert');
  const msg = document.getElementById('heat-alert-msg');
  msg.textContent = `Suhu saat ini ${suhu.toFixed(1)}°C — melebihi batas 30°C`;
  el.classList.add('show');
  heatAlertShown = true;

  // Notifikasi sistem (browser notification)
  const now = Date.now();
  if (heatNotifGranted && (now - lastHeatNotifTime > HEAT_NOTIF_COOLDOWN_MS)) {
    lastHeatNotifTime = now;
    new Notification('⚠️ SUHU TINGGI — KEL-8 IoT', {
      body: `Suhu ESP32 mencapai ${suhu.toFixed(1)}°C. Harap periksa kondisi perangkat.`,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌡️</text></svg>',
      tag:  'suhu-panas',      // tag agar tidak duplikat
      requireInteraction: true, // tetap muncul sampai user close
    });
  }
}

function hideHeatAlert() {
  document.getElementById('heat-alert').classList.remove('show');
  heatAlertShown = false;
}

function dismissHeatAlert() {
  hideHeatAlert();
}

// ─────────────────────────────────────────────────────────────
//  UPDATE PANEL SUHU (warna + badge + notif)
// ─────────────────────────────────────────────────────────────
function applyCardSuhu(suhu) {
  updateSuhuState(suhu);

  const card  = document.getElementById('card-suhu');
  const badge = document.getElementById('suhu-badge');
  const meta  = getSuhuMeta(suhuState);

  // Hapus semua state class dulu
  card.classList.remove('suhu-normal', 'suhu-warm', 'suhu-hot');
  if (meta.cls) card.classList.add(meta.cls);

  badge.textContent = meta.label;

  // Notifikasi hanya saat state HOT
  if (suhuState === 3) {
    if (!heatAlertShown) showHeatAlert(suhu);
  } else {
    if (heatAlertShown) hideHeatAlert();
  }
}

// ─────────────────────────────────────────────────────────────
//  HELPER: BANGUN URL & TOPICS
// ─────────────────────────────────────────────────────────────
function getBrokerUrl(cfg) {
  return `wss://${cfg.host}:${cfg.port}/mqtt`;
}

function getTopics(base) {
  return {
    all:    `${base}/all`,
    suhu:   `${base}/suhu`,
    hum:    `${base}/kelembaban`,
    ldr:    `${base}/ldr`,
    relay:  `${base}/relay`,
    mode:   `${base}/mode`,
    status: `${base}/status`,
    ctrl:   `${base}/control`,
    req:    `${base}/request`,
  };
}

// ─────────────────────────────────────────────────────────────
//  CLOCK
// ─────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('id-ID', { hour12: false });
  document.getElementById('date-str').textContent =
    now.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

// ─────────────────────────────────────────────────────────────
//  TOAST
// ─────────────────────────────────────────────────────────────
function showToast(msg, color) {
  const t = document.getElementById('toast');
  t.textContent       = msg;
  t.style.borderColor = color || 'var(--accent)';
  t.style.color       = color || 'var(--accent)';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ─────────────────────────────────────────────────────────────
//  MODAL
// ─────────────────────────────────────────────────────────────
function openModal() {
  document.getElementById('cfg-host').value     = mqttConfig.host;
  document.getElementById('cfg-port').value     = mqttConfig.port;
  document.getElementById('cfg-username').value = mqttConfig.username;
  document.getElementById('cfg-password').value = mqttConfig.password;
  document.getElementById('cfg-base').value     = mqttConfig.baseTopic;
  setModalStatus('', '');
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function setModalStatus(msg, type) {
  const el = document.getElementById('modal-status');
  if (!msg) { el.classList.remove('show', 'ok', 'err', 'info'); return; }
  el.classList.remove('ok', 'err', 'info');
  el.classList.add('show', type);
  document.getElementById('modal-status-msg').textContent = msg;
}

function readFormConfig() {
  const host     = document.getElementById('cfg-host').value.trim();
  const port     = document.getElementById('cfg-port').value.trim();
  const username = document.getElementById('cfg-username').value.trim();
  const password = document.getElementById('cfg-password').value;
  const base     = document.getElementById('cfg-base').value.trim();
  if (!host)              { setModalStatus('Host broker tidak boleh kosong.', 'err'); return null; }
  if (!port || isNaN(port)) { setModalStatus('Port tidak valid.', 'err'); return null; }
  if (!base)              { setModalStatus('Base topic tidak boleh kosong.', 'err'); return null; }
  return { host, port, username, password, baseTopic: base };
}

// ─────────────────────────────────────────────────────────────
//  KONEKSI MQTT
// ─────────────────────────────────────────────────────────────
function connectMQTT(cfg) {
  if (mqttClient) { try { mqttClient.end(true); } catch(e) {} mqttClient = null; }

  const brokerUrl = getBrokerUrl(cfg);
  const topics    = getTopics(cfg.baseTopic);
  const clientId  = 'WEB-KEL8-' + Math.random().toString(16).substr(2, 6);

  setModalStatus(`Menghubungkan ke ${brokerUrl} …`, 'info');
  setMqttStatus(false);

  const opts = { clientId, clean: true, reconnectPeriod: 5000, connectTimeout: 10000 };
  if (cfg.username) { opts.username = cfg.username; opts.password = cfg.password || ''; }

  mqttClient = mqtt.connect(brokerUrl, opts);

  mqttClient.on('connect', () => {
    mqttConfig = cfg;
    setMqttStatus(true);
    updateBrokerInfo();
    setModalStatus(
      `Terhubung ke ${cfg.host}:${cfg.port} sebagai ${cfg.username || 'anonymous'}`, 'ok'
    );
    showToast('MQTT CONNECTED', 'var(--green)');
    // Update footer
    document.getElementById('footer-broker').textContent = cfg.host;
    document.getElementById('footer-base').textContent   = cfg.baseTopic;

    [topics.all, topics.suhu, topics.hum, topics.ldr,
     topics.relay, topics.mode, topics.status].forEach(t => mqttClient.subscribe(t));
  });

  mqttClient.on('message', (topic, payload) => {
    const msg = payload.toString().trim();
    msgCount++;
    document.getElementById('msg-count').textContent = 'MSG RECEIVED: ' + msgCount;

    const T = getTopics(mqttConfig.baseTopic);

    if (topic === T.all) {
      try {
        const d = JSON.parse(msg);
        if (d.suhu       !== undefined) updateSuhu(d.suhu);
        if (d.kelembaban !== undefined) updateHum(d.kelembaban);
        if (d.ldr        !== undefined) updateLDR(d.ldr);
        if (d.mode       !== undefined) setModeStatus(d.mode.toUpperCase());
        if (d.r1         !== undefined) {
          updateRelayDisplay(0, d.r1 == 1);
          updateRelayDisplay(1, d.r2 == 1);
          updateRelayDisplay(2, d.r3 == 1);
          updateRelayDisplay(3, d.r4 == 1);
        }
        // Tambah ke grafik & riwayat jika suhu dan hum tersedia
        if (d.suhu !== undefined && d.kelembaban !== undefined) {
          addChartPoint(parseFloat(d.suhu), parseFloat(d.kelembaban));
          addHistory(parseFloat(d.suhu), parseFloat(d.kelembaban), lastLdr);
        }
      } catch(e) {}
    } else if (topic === T.suhu)   { updateSuhu(msg); }
      else if (topic === T.hum)    { updateHum(msg); }
      else if (topic === T.ldr)    { updateLDR(msg); }
      else if (topic === T.relay)  { parseRelayPayload(msg); }
      else if (topic === T.mode)   { setModeStatus(msg.toUpperCase()); }
      else if (topic === T.status) {
        const online = msg.toUpperCase() === 'ONLINE';
        showToast('ESP32 ' + (online ? 'ONLINE' : 'OFFLINE'), online ? 'var(--green)' : 'var(--red)');
      }
  });

  mqttClient.on('disconnect', () => { setMqttStatus(false); });
  mqttClient.on('offline',    () => { setMqttStatus(false); showToast('MQTT OFFLINE', 'var(--red)'); });
  mqttClient.on('error', err  => {
    setMqttStatus(false);
    setModalStatus('Error: ' + err.message, 'err');
    showToast('MQTT ERROR', 'var(--red)');
  });
  mqttClient.on('close', () => { setMqttStatus(false); });
}

function onConnectClick() {
  const cfg = readFormConfig();
  if (!cfg) return;
  connectMQTT(cfg);
}

function onDisconnectClick() {
  if (mqttClient) { try { mqttClient.end(true); } catch(e) {} mqttClient = null; }
  setMqttStatus(false);
  setModalStatus('Koneksi diputus.', 'info');
  showToast('MQTT DISCONNECTED', 'var(--muted)');
}

// ─────────────────────────────────────────────────────────────
//  UPDATE TAMPILAN STATUS MQTT & MODE
// ─────────────────────────────────────────────────────────────
function setMqttStatus(connected) {
  const card = document.getElementById('card-mqtt');
  const dot  = document.getElementById('dot-mqtt');
  const lbl  = document.getElementById('lbl-mqtt');
  if (connected) {
    card.classList.remove('offline');
    dot.classList.replace('off','on');
    dot.style.cssText = 'background:var(--green);box-shadow:0 0 8px var(--green)';
    lbl.textContent = 'CONNECTED'; lbl.className = 'connected';
  } else {
    card.classList.add('offline');
    dot.classList.replace('on','off');
    dot.style.cssText = 'background:var(--red);box-shadow:0 0 8px var(--red)';
    lbl.textContent = 'DISCONNECTED'; lbl.className = 'disconnected';
  }
}

function updateBrokerInfo() {
  const el = document.getElementById('broker-info');
  if (el) {
    const user = mqttConfig.username ? `@${mqttConfig.username}` : '';
    el.textContent = `${mqttConfig.host}:${mqttConfig.port} ${user}`;
  }
}

function setModeStatus(mode) {
  currentMode  = mode;
  const card   = document.getElementById('card-mode');
  const dot    = document.getElementById('dot-mode');
  const lbl    = document.getElementById('lbl-mode');
  const isAuto = (mode === 'AUTO');
  dot.style.cssText = isAuto
    ? 'background:var(--accent2);box-shadow:0 0 8px var(--accent2)'
    : 'background:var(--accent);box-shadow:0 0 8px var(--accent)';
  dot.className   = 'status-dot on';
  lbl.textContent = isAuto ? 'AUTO (SUHU)' : 'MANUAL (BUTTON)';
  lbl.className   = isAuto ? 'auto' : 'manual';
  if (isAuto) card.classList.add('mode-auto');
  else        card.classList.remove('mode-auto');
  document.getElementById('btn-auto').className =
    'btn-mode' + (isAuto ? ' active-auto' : '');
  document.getElementById('btn-manual').className =
    'btn-mode' + (!isAuto ? ' active-manual' : '');
  document.querySelectorAll('#relay-grid .relay-card').forEach(c => {
    if (isAuto) c.classList.add('disabled');
    else        c.classList.remove('disabled');
  });
}

// ─────────────────────────────────────────────────────────────
//  UPDATE SENSOR
// ─────────────────────────────────────────────────────────────
function setTimestamp(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = 'UPD ' + new Date().toLocaleTimeString('id-ID', { hour12: false });
}

function updateSuhu(val) {
  const suhu = parseFloat(val);
  lastSuhu   = suhu;
  document.getElementById('val-suhu').textContent = suhu.toFixed(1);
  setTimestamp('upd-suhu');

  // ✅ Update warna panel + hysteresis state
  applyCardSuhu(suhu);

  // Jika hum sudah tersedia, update grafik & riwayat dari topic individual
  // (fallback jika /all tidak digunakan)
  if (lastHum !== null) {
    addChartPoint(suhu, lastHum);
    addHistory(suhu, lastHum, lastLdr);
  }
}

function updateHum(val) {
  const hum = parseFloat(val);
  lastHum   = hum;
  document.getElementById('val-hum').textContent = hum.toFixed(1);
  setTimestamp('upd-hum');
}

function updateLDR(val) {
  const isGelap = val.toUpperCase() === 'GELAP';
  lastLdr       = val.toUpperCase();
  document.getElementById('val-ldr-icon').textContent = isGelap ? 'GELAP' : 'TERANG';
  const badge = document.getElementById('ldr-badge');
  badge.textContent = val.toUpperCase();
  badge.className   = 'ldr-badge ' + (isGelap ? 'gelap' : 'terang');
  setTimestamp('upd-ldr');
}

// ─────────────────────────────────────────────────────────────
//  UPDATE RELAY
// ─────────────────────────────────────────────────────────────
function updateRelayDisplay(idx, on) {
  relayState[idx] = on;
  const card = document.getElementById('relay-' + idx);
  const lbl  = document.getElementById('rlbl-' + idx);
  if (!card || !lbl) return;
  if (on) card.classList.add('on'); else card.classList.remove('on');
  lbl.textContent = on ? 'ON' : 'OFF';
}

function parseRelayPayload(payload) {
  payload.split('#').forEach(p => {
    const [key, val] = p.split(':');
    if (!key || val === undefined) return;
    const idx = parseInt(key.replace('R', '')) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < 4) updateRelayDisplay(idx, val === '1');
  });
}

// ─────────────────────────────────────────────────────────────
//  PUBLISH
// ─────────────────────────────────────────────────────────────
function publish(cmd) {
  if (!mqttClient || !mqttClient.connected) {
    showToast('MQTT TIDAK TERHUBUNG', 'var(--red)'); return;
  }
  mqttClient.publish(getTopics(mqttConfig.baseTopic).ctrl, cmd, { qos: 1 });
}

function toggleRelay(idx) {
  if (currentMode !== 'MANUAL') return;
  const newState = !relayState[idx];
  publish(`R${idx + 1}:${newState ? '1' : '0'}`);
  updateRelayDisplay(idx, newState);
  showToast(`R${idx + 1} → ${newState ? 'ON' : 'OFF'}`);
}

function setMode(mode) {
  publish('MODE:' + mode);
  setModeStatus(mode === 'SUHU' ? 'AUTO' : 'MANUAL');
  showToast('MODE: ' + (mode === 'SUHU' ? 'AUTO (SUHU)' : 'MANUAL'), 'var(--accent2)');
}

function resetRelay() {
  publish('R1:0#R2:0#R3:0#R4:0');
  [0,1,2,3].forEach(i => updateRelayDisplay(i, false));
  showToast('SEMUA RELAY DIMATIKAN', 'var(--accent3)');
}

// ─────────────────────────────────────────────────────────────
//  TUTUP MODAL KLIK DI LUAR
// ─────────────────────────────────────────────────────────────
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// ─────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────
setInterval(updateClock, 1000);
updateClock();
initChart();
requestNotifPermission();
connectMQTT({ ...DEFAULT_CONFIG });