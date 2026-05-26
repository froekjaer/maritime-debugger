const rows = document.querySelector("#messageRows");
const stats = document.querySelector("#stats");
const serialStatus = document.querySelector("#serialStatus");
const portSelect = document.querySelector("#portSelect");
const baudInput = document.querySelector("#baudInput");
const filterInput = document.querySelector("#filterInput");
const protocolFilter = document.querySelector("#protocolFilter");
const replayText = document.querySelector("#replayText");
const messages = [];
let paused = false;

document.querySelector("#refreshPorts").addEventListener("click", loadPorts);
document.querySelector("#startSerial").addEventListener("click", startSerial);
document.querySelector("#stopSerial").addEventListener("click", stopSerial);
document.querySelector("#runReplay").addEventListener("click", runReplay);
document.querySelector("#clearLog").addEventListener("click", () => {
  messages.length = 0;
  renderRows();
});
document.querySelector("#pauseLog").addEventListener("click", (event) => {
  paused = !paused;
  event.currentTarget.textContent = paused ? "Fortsæt" : "Pause";
});
document.querySelector("#exportJson").addEventListener("click", exportJson);
filterInput.addEventListener("input", renderRows);
protocolFilter.addEventListener("change", renderRows);

const events = new EventSource("/events");
events.addEventListener("message", (event) => {
  if (paused) return;
  messages.unshift(JSON.parse(event.data));
  if (messages.length > 1500) messages.pop();
  renderRows();
});
events.addEventListener("state", (event) => renderState(JSON.parse(event.data)));
events.addEventListener("error", () => {
  serialStatus.textContent = "Stream fejl";
  serialStatus.classList.remove("online");
});

await loadPorts();
renderRows();

async function loadPorts() {
  const data = await fetchJson("/api/ports");
  portSelect.innerHTML = "";
  if (!data.ports?.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Ingen porte fundet";
    portSelect.append(option);
    return;
  }
  for (const port of data.ports) {
    const option = document.createElement("option");
    option.value = port;
    option.textContent = port;
    portSelect.append(option);
  }
}

async function startSerial() {
  await fetchJson("/api/serial/start", {
    method: "POST",
    body: JSON.stringify({
      device: portSelect.value,
      baud: Number(baudInput.value || 115200)
    })
  });
}

async function stopSerial() {
  await fetchJson("/api/serial/stop", { method: "POST" });
}

async function runReplay() {
  await fetchJson("/api/replay", {
    method: "POST",
    body: JSON.stringify({ text: replayText.value })
  });
}

function renderState(state) {
  if (state.serial) {
    serialStatus.textContent = `${state.serial.device} @ ${state.serial.baud}`;
    serialStatus.classList.add("online");
  } else {
    serialStatus.textContent = "Offline";
    serialStatus.classList.remove("online");
  }

  const counters = state.counters || {};
  stats.innerHTML = [
    ["Total", counters.total || 0],
    ["NMEA 0183", counters.nmea0183 || 0],
    ["NMEA 2000", counters.nmea2000 || 0],
    ["CAN", counters.can || 0],
    ["Raw", counters.raw || 0],
    ["Warnings", counters.warnings || 0]
  ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
}

function renderRows() {
  const query = filterInput.value.trim().toLowerCase();
  const protocol = protocolFilter.value;
  const visible = messages
    .filter((message) => !protocol || message.protocol === protocol)
    .filter((message) => !query || JSON.stringify(message).toLowerCase().includes(query))
    .slice(0, 500);

  rows.innerHTML = visible.map((message) => `
    <tr class="${message.level === "warn" ? "warn" : ""}">
      <td>${new Date(message.timestamp).toLocaleTimeString()}</td>
      <td><span class="badge ${message.protocol}">${labelProtocol(message.protocol)}</span></td>
      <td>${escapeHtml(message.summary || "")}</td>
      <td>${escapeHtml(formatDecoded(message))}</td>
      <td>${escapeHtml(message.raw || "")}</td>
    </tr>
  `).join("");
}

function formatDecoded(message) {
  if (message.nmea2000) {
    return JSON.stringify({
      pgn: message.nmea2000.pgn,
      name: message.nmea2000.name,
      source: message.nmea2000.source,
      destination: message.nmea2000.destination,
      fastPacket: message.nmea2000.fastPacket,
      ...message.nmea2000.fields
    });
  }
  if (message.protocol === "nmea0183") {
    return JSON.stringify({
      talker: message.talker,
      sentence: message.sentence,
      checksumOk: message.checksumOk,
      ...message.decoded
    });
  }
  if (message.can) return JSON.stringify(message.can);
  return "";
}

function labelProtocol(protocol) {
  return {
    nmea0183: "NMEA 0183",
    "nmea2000-can": "NMEA 2000",
    "nmea2000-pcdin": "PCDIN",
    "nmea2000-debug": "N2K Debug",
    can: "CAN",
    raw: "Raw"
  }[protocol] || protocol;
}

function exportJson() {
  const blob = new Blob([JSON.stringify(messages, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `maritime-debug-${new Date().toISOString().replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
