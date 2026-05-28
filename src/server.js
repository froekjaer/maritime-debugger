import fs from "node:fs";
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLine } from "./parsers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const port = Number(process.env.PORT || 8787);
const clients = new Set();
const state = {
  serial: null,
  serialStream: null,
  tcp: null,
  tcpSocket: null,
  udp: null,
  udpSocket: null,
  buffers: {
    serial: "",
    tcp: "",
    udp: ""
  },
  counters: {
    total: 0,
    nmea0183: 0,
    nmea2000: 0,
    can: 0,
    raw: 0,
    warnings: 0
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/events") return handleEvents(req, res);
    if (url.pathname === "/api/ports") return sendJson(res, await listPorts());
    if (url.pathname === "/api/state") return sendJson(res, publicState());
    if (url.pathname === "/api/serial/start" && req.method === "POST") return handleSerialStart(req, res);
    if (url.pathname === "/api/serial/stop" && req.method === "POST") return handleSerialStop(res);
    if (url.pathname === "/api/tcp/start" && req.method === "POST") return handleTcpStart(req, res);
    if (url.pathname === "/api/tcp/stop" && req.method === "POST") return handleTcpStop(res);
    if (url.pathname === "/api/udp/start" && req.method === "POST") return handleUdpStart(req, res);
    if (url.pathname === "/api/udp/stop" && req.method === "POST") return handleUdpStop(res);
    if (url.pathname === "/api/replay" && req.method === "POST") return handleReplay(req, res);
    return serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

server.listen(port, () => {
  console.log(`Maritime Debugger running on http://localhost:${port}`);
});

function handleEvents(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

async function handleSerialStart(req, res) {
  const body = await readJson(req);
  const device = String(body.device || "");
  const baud = Number(body.baud || 115200);
  const adapter = String(body.adapter || "plain");
  if (!device.startsWith("/dev/")) {
    return sendJson(res, { error: "Only /dev serial devices are supported in this no-dependency MVP." }, 400);
  }

  stopSerial();
  await configureSerial(device, baud);
  if (adapter === "canable-slcan") {
    await initializeCanable(device);
  }

  state.serialStream = fs.createReadStream(device, { encoding: "utf8" });
  state.serial = { device, baud, adapter, startedAt: new Date().toISOString() };
  state.buffers.serial = "";
  state.serialStream.on("data", (chunk) => readChunk(chunk, "serial"));
  state.serialStream.on("error", (error) => broadcast("error", { message: error.message }));
  state.serialStream.on("close", () => {
    state.serial = null;
    broadcast("state", publicState());
  });

  broadcast("state", publicState());
  sendJson(res, publicState());
}

function handleSerialStop(res) {
  stopSerial();
  broadcast("state", publicState());
  sendJson(res, publicState());
}

async function handleTcpStart(req, res) {
  const body = await readJson(req);
  const host = String(body.host || "").trim();
  const port = Number(body.port || 0);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, { error: "TCP host and port are required." }, 400);
  }

  stopTcp();
  state.buffers.tcp = "";
  const socket = net.createConnection({ host, port });
  socket.setEncoding("utf8");
  state.tcpSocket = socket;
  state.tcp = { host, port, status: "connecting", startedAt: new Date().toISOString() };
  socket.on("connect", () => {
    state.tcp = { ...state.tcp, status: "connected", localPort: socket.localPort };
    broadcast("state", publicState());
  });
  socket.on("data", (chunk) => readChunk(chunk, "tcp"));
  socket.on("error", (error) => {
    broadcast("error", { source: "tcp", message: error.message });
    state.tcp = { ...state.tcp, status: "error", error: error.message };
    broadcast("state", publicState());
  });
  socket.on("close", () => {
    state.tcp = null;
    state.tcpSocket = null;
    state.buffers.tcp = "";
    broadcast("state", publicState());
  });

  broadcast("state", publicState());
  sendJson(res, publicState());
}

function handleTcpStop(res) {
  stopTcp();
  broadcast("state", publicState());
  sendJson(res, publicState());
}

async function handleUdpStart(req, res) {
  const body = await readJson(req);
  const port = Number(body.port || 0);
  const host = String(body.host || "0.0.0.0").trim() || "0.0.0.0";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, { error: "UDP listen port is required." }, 400);
  }

  stopUdp();
  state.buffers.udp = "";
  const socket = dgram.createSocket("udp4");
  state.udpSocket = socket;
  state.udp = { host, port, status: "binding", startedAt: new Date().toISOString() };
  socket.on("message", (message, remote) => {
    const source = `udp ${remote.address}:${remote.port}`;
    readDatagram(message.toString("utf8"), source);
  });
  socket.on("error", (error) => {
    broadcast("error", { source: "udp", message: error.message });
    state.udp = { ...state.udp, status: "error", error: error.message };
    broadcast("state", publicState());
  });
  socket.on("close", () => {
    state.udp = null;
    state.udpSocket = null;
    state.buffers.udp = "";
    broadcast("state", publicState());
  });

  await new Promise((resolve, reject) => {
    socket.once("listening", resolve);
    socket.once("error", reject);
    socket.bind(port, host);
  });

  const address = socket.address();
  state.udp = { ...state.udp, status: "listening", host: address.address, port: address.port };
  broadcast("state", publicState());
  sendJson(res, publicState());
}

function handleUdpStop(res) {
  stopUdp();
  broadcast("state", publicState());
  sendJson(res, publicState());
}

async function handleReplay(req, res) {
  const body = await readJson(req);
  const text = String(body.text || "");
  const delayMs = Math.max(0, Math.min(Number(body.delayMs || 0), 2000));
  const lines = text.split(/\r?\n/).filter(Boolean);
  let index = 0;

  const tick = () => {
    if (index >= lines.length) {
      broadcast("state", publicState());
      return;
    }
    ingestLine(lines[index++], "replay");
    if (delayMs) setTimeout(tick, delayMs);
    else tick();
  };
  tick();
  sendJson(res, { accepted: lines.length });
}

function readChunk(chunk, source, bufferKey = source) {
  if (!Object.hasOwn(state.buffers, bufferKey)) state.buffers[bufferKey] = "";
  state.buffers[bufferKey] += chunk;
  const lines = state.buffers[bufferKey].split(/\r?\n/);
  state.buffers[bufferKey] = lines.pop() || "";
  for (const line of lines) ingestLine(line, source);
}

function readDatagram(message, source) {
  if (/\r|\n/.test(message)) {
    readChunk(message, source, "udp");
    return;
  }
  ingestLine(message, source);
}

function ingestLine(line, source) {
  const parsed = parseLine(line);
  if (!parsed) return;
  const event = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source,
    ...parsed
  };

  state.counters.total += 1;
  if (event.protocol === "nmea0183") state.counters.nmea0183 += 1;
  else if (event.protocol.startsWith("nmea2000")) state.counters.nmea2000 += 1;
  else if (event.protocol === "can") state.counters.can += 1;
  else state.counters.raw += 1;
  if (event.level === "warn") state.counters.warnings += 1;

  broadcast("message", event);
  broadcast("state", publicState());
}

function stopSerial() {
  if (state.serialStream) state.serialStream.destroy();
  state.serial = null;
  state.serialStream = null;
  state.buffers.serial = "";
}

function stopTcp() {
  if (state.tcpSocket) state.tcpSocket.destroy();
  state.tcp = null;
  state.tcpSocket = null;
  state.buffers.tcp = "";
}

function stopUdp() {
  if (state.udpSocket) state.udpSocket.close();
  state.udp = null;
  state.udpSocket = null;
  state.buffers.udp = "";
}

async function configureSerial(device, baud) {
  const args = os.platform() === "darwin"
    ? ["-f", device, String(baud), "raw", "-echo"]
    : ["-F", device, String(baud), "raw", "-echo"];

  if (os.platform() === "darwin") {
    await run("stty", args);
  } else if (os.platform() === "linux") {
    await run("stty", args);
  }
}

async function initializeCanable(device) {
  const file = await fs.promises.open(device, "w");
  try {
    await file.write("C\r");
    await sleep(50);
    await file.write("S5\r");
    await sleep(50);
    await file.write("O\r");
    await sleep(50);
  } finally {
    await file.close();
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listPorts() {
  if (os.platform() !== "darwin" && os.platform() !== "linux") {
    return { ports: [], note: "Automatic serial listing currently supports macOS/Linux." };
  }
  const devDir = "/dev";
  const names = await fs.promises.readdir(devDir);
  const patterns = os.platform() === "darwin"
    ? [/^tty\./, /^cu\./]
    : [/^ttyUSB/, /^ttyACM/, /^serial/];
  const ports = names
    .filter((name) => patterns.some((pattern) => pattern.test(name)))
    .map((name) => path.join(devDir, name))
    .sort();
  return { ports };
}

function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return sendJson(res, { error: "Not found" }, 404);

  fs.createReadStream(filePath)
    .on("error", () => sendJson(res, { error: "Not found" }, 404))
    .on("open", () => {
      res.writeHead(200, { "Content-Type": contentType(filePath) });
    })
    .pipe(res);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

function publicState() {
  return {
    serial: state.serial,
    tcp: state.tcp,
    udp: state.udp,
    counters: state.counters
  };
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}
