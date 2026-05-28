const rows = document.querySelector("#messageRows");
const stats = document.querySelector("#stats");
const inputStatus = document.querySelector("#inputStatus");
const portSelect = document.querySelector("#portSelect");
const baudInput = document.querySelector("#baudInput");
const adapterSelect = document.querySelector("#adapterSelect");
const tcpHostInput = document.querySelector("#tcpHostInput");
const tcpPortInput = document.querySelector("#tcpPortInput");
const tcpStatus = document.querySelector("#tcpStatus");
const udpHostInput = document.querySelector("#udpHostInput");
const udpPortInput = document.querySelector("#udpPortInput");
const udpStatus = document.querySelector("#udpStatus");
const jsonImportInput = document.querySelector("#jsonImportInput");
const jsonImportStatus = document.querySelector("#jsonImportStatus");
const filterEnabled = document.querySelector("#filterEnabled");
const filterMode = document.querySelector("#filterMode");
const filterPatterns = document.querySelector("#filterPatterns");
const filterStatus = document.querySelector("#filterStatus");
const filterInput = document.querySelector("#filterInput");
const protocolFilter = document.querySelector("#protocolFilter");
const replayText = document.querySelector("#replayText");
const messages = [];
let paused = false;

document.querySelector("#refreshPorts").addEventListener("click", loadPorts);
document.querySelector("#startSerial").addEventListener("click", startSerial);
document.querySelector("#stopSerial").addEventListener("click", stopSerial);
document.querySelector("#startTcp").addEventListener("click", startTcp);
document.querySelector("#stopTcp").addEventListener("click", stopTcp);
document.querySelector("#startUdp").addEventListener("click", startUdp);
document.querySelector("#stopUdp").addEventListener("click", stopUdp);
document.querySelector("#runReplay").addEventListener("click", runReplay);
document.querySelector("#importJson").addEventListener("click", () => {
  importJson().catch((error) => {
    jsonImportStatus.textContent = `Import failed: ${error.message}`;
  });
});
document.querySelector("#applyInputFilter").addEventListener("click", applyInputFilter);
document.querySelector("#clearInputFilter").addEventListener("click", clearInputFilter);
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
events.addEventListener("error", (event) => {
  const data = event.data ? JSON.parse(event.data) : {};
  inputStatus.textContent = data.message ? `Fejl: ${data.message}` : "Stream fejl";
  inputStatus.classList.remove("online");
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
      baud: Number(baudInput.value || 115200),
      adapter: adapterSelect.value
    })
  });
}

async function stopSerial() {
  await fetchJson("/api/serial/stop", { method: "POST" });
}

async function startTcp() {
  await fetchJson("/api/tcp/start", {
    method: "POST",
    body: JSON.stringify({
      host: tcpHostInput.value,
      port: Number(tcpPortInput.value || 10110)
    })
  });
}

async function stopTcp() {
  await fetchJson("/api/tcp/stop", { method: "POST" });
}

async function startUdp() {
  await fetchJson("/api/udp/start", {
    method: "POST",
    body: JSON.stringify({
      host: udpHostInput.value,
      port: Number(udpPortInput.value || 10110)
    })
  });
}

async function stopUdp() {
  await fetchJson("/api/udp/stop", { method: "POST" });
}

async function runReplay() {
  await fetchJson("/api/replay", {
    method: "POST",
    body: JSON.stringify({ text: replayText.value })
  });
}

async function importJson() {
  const file = jsonImportInput.files?.[0];
  if (!file) {
    jsonImportStatus.textContent = "Choose a JSON file";
    return;
  }

  const text = await file.text();
  const parsed = parseImportJson(text);
  const imported = Array.isArray(parsed) ? parsed : parsed.messages || parsed.events || [];
  if (!Array.isArray(imported)) throw new Error("JSON must be an array or contain a messages/events array.");

  for (const item of imported) {
    if (!item || typeof item !== "object") continue;
    messages.unshift({
      id: item.id || crypto.randomUUID(),
      timestamp: item.timestamp || new Date().toISOString(),
      source: item.source || "json-import",
      level: item.level || "ok",
      ...item
    });
  }
  if (messages.length > 5000) messages.length = 5000;
  renderRows();
  jsonImportStatus.textContent = `Imported ${imported.length} messages`;
}

function parseImportJson(text) {
  const withoutHashComments = stripHashCommentLines(text);
  const extractedFromCleaned = extractJsonPayload(withoutHashComments);
  const extractedFromRaw = extractJsonPayload(text);
  const attempts = [
    text,
    withoutHashComments,
    extractedFromCleaned,
    extractedFromRaw
  ].filter(Boolean);

  if (!extractedFromCleaned && !extractedFromRaw && !looksLikeJsonStart(withoutHashComments)) {
    throw new Error("No JSON array or object found in this file.");
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No JSON payload found.");
}

function looksLikeJsonStart(text) {
  const first = text.trimStart()[0];
  return first === "[" || first === "{";
}

function stripHashCommentLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}

function extractJsonPayload(text) {
  const trimmed = text.trim();
  const firstArray = trimmed.indexOf("[");
  const firstObject = trimmed.indexOf("{");
  const starts = [firstArray, firstObject].filter((index) => index >= 0);
  if (!starts.length) return "";
  const start = Math.min(...starts);
  const opener = trimmed[start];
  const closer = opener === "[" ? "]" : "}";
  const end = trimmed.lastIndexOf(closer);
  return end > start ? trimmed.slice(start, end + 1) : "";
}

async function applyInputFilter() {
  await fetchJson("/api/filter", {
    method: "POST",
    body: JSON.stringify({
      enabled: filterEnabled.checked,
      mode: filterMode.value,
      patterns: filterPatterns.value
    })
  });
}

async function clearInputFilter() {
  filterEnabled.checked = false;
  filterMode.value = "drop";
  filterPatterns.value = "";
  await applyInputFilter();
}

function renderState(state) {
  const activeInputs = [
    state.serial ? "Serial" : null,
    state.tcp ? "TCP" : null,
    state.udp ? "UDP" : null
  ].filter(Boolean);
  inputStatus.textContent = activeInputs.length ? activeInputs.join(" + ") : "Offline";
  inputStatus.classList.toggle("online", activeInputs.length > 0);
  tcpStatus.textContent = state.tcp
    ? `TCP ${state.tcp.status}: ${state.tcp.host}:${state.tcp.port}`
    : "TCP offline";
  udpStatus.textContent = state.udp
    ? `UDP ${state.udp.status}: ${state.udp.host}:${state.udp.port}`
    : "UDP offline";
  if (state.inputFilter) {
    if (!document.activeElement || ![filterEnabled, filterMode, filterPatterns].includes(document.activeElement)) {
      filterEnabled.checked = state.inputFilter.enabled;
      filterMode.value = state.inputFilter.mode;
      filterPatterns.value = state.inputFilter.patterns.join("\n");
    }
    filterStatus.textContent = state.inputFilter.enabled
      ? `${state.inputFilter.mode === "allow" ? "Allow only" : "Drop"}: ${state.inputFilter.patterns.join(", ")}`
      : "Filter off";
  }

  const counters = state.counters || {};
  stats.innerHTML = [
    ["Total", counters.total || 0],
    ["NMEA 0183", counters.nmea0183 || 0],
    ["NMEA 2000", counters.nmea2000 || 0],
    ["CAN", counters.can || 0],
    ["Raw", counters.raw || 0],
    ["Filtered", counters.filtered || 0],
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
    "nmea2000-conversion": "N2K Conv",
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
