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
const inputFilterInput = document.querySelector("#inputFilterInput");
const inputFilterLogic = document.querySelector("#inputFilterLogic");
const inputFilterAction = document.querySelector("#inputFilterAction");
const inputFilterStatus = document.querySelector("#inputFilterStatus");
const filterInput = document.querySelector("#filterInput");
const filterLogic = document.querySelector("#filterLogic");
const filterAction = document.querySelector("#filterAction");
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
document.querySelector("#clearLog").addEventListener("click", () => {
  messages.length = 0;
  renderRows();
});
document.querySelector("#pauseLog").addEventListener("click", (event) => {
  paused = !paused;
  event.currentTarget.textContent = paused ? "Fortsæt" : "Pause";
});
document.querySelector("#exportJson").addEventListener("click", exportJson);
inputFilterInput.addEventListener("input", renderInputFilterStatus);
inputFilterLogic.addEventListener("change", renderInputFilterStatus);
inputFilterAction.addEventListener("change", renderInputFilterStatus);
filterInput.addEventListener("input", renderRows);
filterLogic.addEventListener("change", renderRows);
filterAction.addEventListener("change", renderRows);
protocolFilter.addEventListener("change", renderRows);

const events = new EventSource("/events");
events.addEventListener("message", (event) => {
  if (paused) return;
  const message = JSON.parse(event.data);
  if (!passesInputFilter(message)) return;
  messages.unshift(message);
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
renderInputFilterStatus();
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
  try {
    await fetchJson("/api/tcp/start", {
      method: "POST",
      body: JSON.stringify({
        host: tcpHostInput.value,
        port: Number(tcpPortInput.value || 10110)
      })
    });
  } catch (error) {
    tcpStatus.textContent = `TCP error: ${error.message}`;
    inputStatus.textContent = `Fejl: ${error.message}`;
    inputStatus.classList.remove("online");
  }
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

function renderState(state) {
  const activeInputs = [
    state.serial ? "Serial" : null,
    isActiveTcp(state.tcp) ? "TCP" : null,
    isActiveUdp(state.udp) ? "UDP" : null
  ].filter(Boolean);
  inputStatus.textContent = activeInputs.length ? activeInputs.join(" + ") : "Offline";
  inputStatus.classList.toggle("online", activeInputs.length > 0);
  tcpStatus.textContent = formatTcpStatus(state.tcp);
  udpStatus.textContent = state.udp
    ? `UDP ${state.udp.status}: ${state.udp.host}:${state.udp.port}`
    : "UDP offline";

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

function isActiveTcp(tcp) {
  return tcp && (tcp.status === "connecting" || tcp.status === "connected");
}

function isActiveUdp(udp) {
  return udp && (udp.status === "binding" || udp.status === "listening");
}

function formatTcpStatus(tcp) {
  if (!tcp) return "TCP offline";
  const target = `${tcp.host}:${tcp.port}`;
  if (tcp.status === "error") return `TCP error: ${target} - ${tcp.error || "connection failed"}`;
  if (tcp.status === "closed") return `TCP closed: ${target}`;
  return `TCP ${tcp.status}: ${target}`;
}

function renderRows() {
  const terms = parseFilterTerms(filterInput.value);
  const logic = filterLogic.value;
  const action = filterAction.value;
  const protocol = protocolFilter.value;
  const visible = messages
    .filter((message) => !protocol || message.protocol === protocol)
    .filter((message) => matchesTextFilter(message, terms, logic, action))
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

function passesInputFilter(message) {
  const terms = parseFilterTerms(inputFilterInput.value);
  return matchesTextFilter(message, terms, inputFilterLogic.value, inputFilterAction.value);
}

function renderInputFilterStatus() {
  const terms = parseFilterTerms(inputFilterInput.value);
  if (!terms.length) {
    inputFilterStatus.textContent = "Ingen inputfilter";
    return;
  }
  const action = inputFilterAction.value === "drop" ? "Drop" : "Pass";
  const logic = inputFilterLogic.value.toUpperCase();
  inputFilterStatus.textContent = `${action} ${logic}: ${terms.join(", ")}`;
}

function parseFilterTerms(value) {
  return value
    .toLowerCase()
    .split(/[\s,;|]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function matchesTextFilter(message, terms, logic, action) {
  if (!terms.length) return true;
  const haystack = JSON.stringify(message).toLowerCase();
  const matched = logic === "and"
    ? terms.every((term) => haystack.includes(term))
    : terms.some((term) => haystack.includes(term));
  return action === "drop" ? !matched : matched;
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
  if (!response.ok) {
    const error = new Error(data.error || data.tcp?.error || "Request failed");
    error.data = data;
    throw error;
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
