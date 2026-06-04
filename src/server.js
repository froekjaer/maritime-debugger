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
  tcpProcess: null,
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
    if (url.pathname === "/api/serial/start" && req.method === "POST") return await handleSerialStart(req, res);
    if (url.pathname === "/api/serial/stop" && req.method === "POST") return handleSerialStop(res);
    if (url.pathname === "/api/tcp/start" && req.method === "POST") return await handleTcpStart(req, res);
    if (url.pathname === "/api/tcp/stop" && req.method === "POST") return handleTcpStop(res);
    if (url.pathname === "/api/udp/start" && req.method === "POST") return await handleUdpStart(req, res);
    if (url.pathname === "/api/udp/stop" && req.method === "POST") return handleUdpStop(res);
    if (url.pathname === "/api/replay" && req.method === "POST") return await handleReplay(req, res);
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
  const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs || 8000), 60000));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, { error: "TCP host and port are required." }, 400);
  }
  if (isWildcardAddress(host) || host === "::") {
    return sendJson(res, { error: "TCP host must be the remote device IP or hostname, not a bind address like 0.0.0.0." }, 400);
  }

  stopTcp();
  state.buffers.tcp = "";
  const socket = net.createConnection({ host, port, timeout: timeoutMs });
  socket.setEncoding("utf8");
  state.tcpSocket = socket;
  state.tcp = { host, port, timeoutMs, status: "connecting", startedAt: new Date().toISOString() };
  socket.on("connect", () => {
    if (state.tcpSocket !== socket) return;
    state.tcp = { ...state.tcp, status: "connected", localPort: socket.localPort };
    broadcast("state", publicState());
  });
  socket.on("data", (chunk) => readChunk(chunk, "tcp"));
  socket.on("error", (error) => {
    if (state.tcpSocket !== socket) return;
    broadcast("error", { source: "tcp", message: error.message });
    state.tcp = { ...state.tcp, status: "error", error: error.message };
    broadcast("state", publicState());
  });
  socket.on("timeout", () => {
    socket.destroy(new Error(`TCP connection timed out after ${timeoutMs} ms`));
  });
  socket.on("close", () => {
    if (state.tcpSocket !== socket) return;
    if (state.tcp?.status === "connected") {
      state.tcp = { ...state.tcp, status: "closed", closedAt: new Date().toISOString() };
    }
    state.tcpSocket = null;
    state.buffers.tcp = "";
    broadcast("state", publicState());
  });

  broadcast("state", publicState());
  try {
    await waitForTcpConnect(socket);
    sendJson(res, publicState());
  } catch (error) {
    if (shouldFallbackToNc(error)) {
      try {
        socket.removeAllListeners();
        socket.destroy();
        await startNcTcp(host, port, timeoutMs, error);
        return sendJson(res, publicState());
      } catch (fallbackError) {
        error = new Error(`${error.message}; nc fallback failed: ${fallbackError.message}`);
      }
    }
    state.tcp = { host, port, timeoutMs, status: "error", error: error.message, startedAt: state.tcp?.startedAt };
    state.tcpSocket = null;
    broadcast("error", { source: "tcp", message: error.message });
    broadcast("state", publicState());
    sendJson(res, publicState(), 502);
  }
}

function handleTcpStop(res) {
  stopTcp();
  broadcast("state", publicState());
  sendJson(res, publicState());
}

async function handleUdpStart(req, res) {
  const body = await readJson(req);
  const port = Number(body.port || 0);
  const requestedHost = String(body.host || "0.0.0.0").trim() || "0.0.0.0";
  const { host, warning } = resolveUdpBindHost(requestedHost);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, { error: "UDP listen port is required." }, 400);
  }

  stopUdp();
  state.buffers.udp = "";
  const socket = dgram.createSocket("udp4");
  state.udpSocket = socket;
  state.udp = { host, port, requestedHost, warning, status: "binding", startedAt: new Date().toISOString() };
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
  if (warning) broadcast("error", { source: "udp", message: warning });
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
  if (state.tcpProcess) state.tcpProcess.kill();
  state.tcp = null;
  state.tcpSocket = null;
  state.tcpProcess = null;
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

function waitForTcpConnect(socket) {
  if (socket.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function shouldFallbackToNc(error) {
  return os.platform() === "darwin" && error?.code === "EHOSTUNREACH";
}

function startNcTcp(host, port, timeoutMs, originalError) {
  return new Promise((resolve, reject) => {
    const child = spawn("nc", ["-v", host, String(port)]);
    let settled = false;
    let connected = false;
    let stderr = "";
    const startedAt = new Date().toISOString();

    state.tcpProcess = child;
    state.tcpSocket = null;
    state.tcp = {
      host,
      port,
      timeoutMs,
      status: "connecting",
      adapter: "nc",
      fallbackFrom: originalError.message,
      startedAt
    };
    broadcast("error", { source: "tcp", message: `Node TCP failed (${originalError.message}); trying nc fallback.` });
    broadcast("state", publicState());

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`nc connection timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const markConnected = () => {
      if (connected) return;
      connected = true;
      clearTimeout(timer);
      state.tcp = { ...state.tcp, status: "connected" };
      broadcast("state", publicState());
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      markConnected();
      readChunk(chunk, "tcp");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (/succeeded|open/i.test(stderr)) markConnected();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(stderr.trim() || `nc exited with ${code}`));
        return;
      }
      if (state.tcpProcess === child) {
        state.tcpProcess = null;
        state.tcp = connected
          ? { ...state.tcp, status: "closed", closedAt: new Date().toISOString() }
          : state.tcp;
        state.buffers.tcp = "";
        broadcast("state", publicState());
      }
    });
  });
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

function resolveUdpBindHost(host) {
  if (host === "::") {
    return {
      host: "0.0.0.0",
      warning: "UDP uses IPv4 in this app; listening on all IPv4 interfaces instead of ::."
    };
  }
  if (isWildcardAddress(host) || isLocalAddress(host)) {
    return { host };
  }

  return {
    host: "0.0.0.0",
    warning: `UDP bind address ${host} is not assigned to this computer; listening on all interfaces instead.`
  };
}

function isWildcardAddress(host) {
  return host === "0.0.0.0" || host.toLowerCase() === "localhost";
}

function isLocalAddress(host) {
  if (host === "127.0.0.1") return true;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && address.address === host) return true;
    }
  }
  return false;
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
