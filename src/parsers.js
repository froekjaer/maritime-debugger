const NMEA0183_FIELDS = {
  GGA: ["utc", "latitude", "latHemisphere", "longitude", "lonHemisphere", "quality", "satellites", "hdop", "altitude", "altitudeUnit", "geoidSeparation", "geoidUnit", "dgpsAge", "dgpsStation"],
  RMC: ["utc", "status", "latitude", "latHemisphere", "longitude", "lonHemisphere", "speedKnots", "courseTrue", "date", "magneticVariation", "variationDirection", "mode"],
  HDG: ["headingMagnetic", "deviation", "deviationDirection", "variation", "variationDirection"],
  HDT: ["headingTrue", "trueIndicator"],
  MWV: ["windAngle", "reference", "windSpeed", "speedUnit", "status"],
  VHW: ["headingTrue", "trueIndicator", "headingMagnetic", "magneticIndicator", "speedKnots", "knotsUnit", "speedKmh", "kmhUnit"],
  DBT: ["depthFeet", "feetUnit", "depthMeters", "metersUnit", "depthFathoms", "fathomsUnit"],
  DPT: ["depthMeters", "offsetMeters", "maxRangeMeters"],
  GSA: ["mode", "fixType", "satellite1", "satellite2", "satellite3", "satellite4", "satellite5", "satellite6", "satellite7", "satellite8", "satellite9", "satellite10", "satellite11", "satellite12", "pdop", "hdop", "vdop", "systemId"],
  GSV: ["messageCount", "messageNumber", "satellitesInView", "satellite1Id", "satellite1Elevation", "satellite1Azimuth", "satellite1Snr", "satellite2Id", "satellite2Elevation", "satellite2Azimuth", "satellite2Snr", "satellite3Id", "satellite3Elevation", "satellite3Azimuth", "satellite3Snr", "satellite4Id", "satellite4Elevation", "satellite4Azimuth", "satellite4Snr", "signalId"],
  MTW: ["waterTemperature", "celsiusUnit"],
  VTG: ["courseTrue", "trueIndicator", "courseMagnetic", "magneticIndicator", "speedKnots", "knotsUnit", "speedKmh", "kmhUnit", "mode"],
  VDM: ["fragmentCount", "fragmentNumber", "messageId", "radioChannel", "payload", "fillBits"],
  VDO: ["fragmentCount", "fragmentNumber", "messageId", "radioChannel", "payload", "fillBits"]
};

const FAST_PACKET_PGNS = new Set([
  126208, 126464, 126996, 126998, 127489, 127496, 127497, 127498, 128275,
  129029, 129038, 129039, 129040, 129041, 129044, 129285, 129540, 129542,
  129545, 129549, 129551, 129793, 129794, 129795, 129796, 129797, 129798,
  129800, 129801, 129802, 129803, 129804, 129805, 129806, 129807, 129808,
  129809, 129810, 130060, 130064, 130065, 130066, 130067, 130068, 130069,
  130070, 130071, 130072, 130073, 130074, 130320, 130321, 130322, 130323,
  130324, 130567, 130578, 130581, 130582, 130583, 130584, 130585
]);

const PGN_NAMES = {
  59392: "ISO Acknowledgement",
  59904: "ISO Request",
  60928: "ISO Address Claim",
  126208: "NMEA Request/Command/Acknowledge",
  126464: "PGN List",
  126992: "System Time",
  126996: "Product Information",
  127245: "Rudder",
  127250: "Vessel Heading",
  127251: "Rate of Turn",
  127257: "Attitude",
  127258: "Magnetic Variation",
  127488: "Engine Parameters, Rapid Update",
  127489: "Engine Parameters, Dynamic",
  127505: "Fluid Level",
  128259: "Speed",
  128267: "Water Depth",
  128275: "Distance Log",
  129025: "Position, Rapid Update",
  129026: "COG/SOG, Rapid Update",
  129029: "GNSS Position Data",
  129033: "Local Time Offset",
  129038: "AIS Class A Position Report",
  129039: "AIS Class B Position Report",
  129040: "AIS Class B Extended Position Report",
  129041: "AIS Aids to Navigation Report",
  129283: "Cross Track Error",
  129284: "Navigation Data",
  129285: "Route/WP Information",
  129793: "AIS UTC and Date Report",
  129794: "AIS Class A Static and Voyage Related Data",
  129795: "AIS Addressed Binary Message",
  129796: "AIS Acknowledge",
  129797: "AIS Binary Broadcast Message",
  129798: "AIS SAR Aircraft Position Report",
  129801: "AIS Addressed Safety Related Message",
  129802: "AIS Safety Related Broadcast Message",
  129809: "AIS Class B Static Data Report, Part A",
  129810: "AIS Class B Static Data Report, Part B",
  130306: "Wind Data",
  130310: "Environmental Parameters",
  130311: "Environmental Parameters",
  130312: "Temperature",
  130313: "Humidity",
  130314: "Actual Pressure",
  130316: "Temperature, Extended Range"
};

const FLUID_TYPES = {
  0: "Fuel",
  1: "Water",
  2: "Gray water",
  3: "Live well",
  4: "Oil",
  5: "Black water"
};

export function parseLine(line) {
  const value = line.trim();
  if (!value) return null;
  if (/^N2K>[^:]+:\s*[$!]/.test(value)) return parseVelaTranslatedNmea0183(value);
  if (/^N2K:\s*PGN:/i.test(value)) return parseVelaN2kDebug(value);
  if (/^P#\d+:\s*[$!]/.test(value)) return parsePortNmea0183(value);
  if (/(?:P\d+>N2K:\s*)?PGN:\s*\d+\[[0-9A-Fa-f]+\]/.test(value)) return parsePortN2kConversion(value);
  if (/^\$PCDIN,/.test(value)) return parsePcdin(value);
  if (value.startsWith("$") || value.startsWith("!")) return parseNmea0183(value);
  if (/^[tT][0-9A-Fa-f]/.test(value)) return parseSlcan(value);
  if (/^\(\d+\.\d+\)\s+\S+\s+[0-9A-Fa-f]{3,8}#[0-9A-Fa-f]*/.test(value)) return parseCandump(value);
  return {
    protocol: "raw",
    level: "info",
    summary: "Unrecognized line",
    raw: value
  };
}

export function parseNmea0183(raw) {
  const star = raw.lastIndexOf("*");
  const body = star >= 0 ? raw.slice(1, star) : raw.slice(1);
  const checksumText = star >= 0 ? raw.slice(star + 1, star + 3) : "";
  const checksum = checksumText ? Number.parseInt(checksumText, 16) : null;
  const calculatedChecksum = xorChecksum(body);
  const fields = body.split(",");
  const formatter = fields[0] || "";
  const talker = formatter.slice(0, 2);
  const sentence = formatter.slice(2);
  const names = NMEA0183_FIELDS[sentence] || [];
  const decoded = {};

  fields.slice(1).forEach((field, index) => {
    decoded[names[index] || `field${index + 1}`] = field;
  });

  return {
    protocol: "nmea0183",
    level: checksum === null || checksum === calculatedChecksum ? "ok" : "warn",
    summary: `${talker || "??"} ${sentence || "unknown"}`,
    raw,
    talker,
    sentence,
    checksum,
    calculatedChecksum,
    checksumOk: checksum === null ? null : checksum === calculatedChecksum,
    decoded
  };
}

export function parseSlcan(raw) {
  const extended = raw[0] === "T";
  const idLength = extended ? 8 : 3;
  const idHex = raw.slice(1, 1 + idLength);
  const dlcHex = raw.slice(1 + idLength, 2 + idLength);
  const dataHex = raw.slice(2 + idLength, 2 + idLength + Number.parseInt(dlcHex, 16) * 2);
  const id = Number.parseInt(idHex, 16);
  const dlc = Number.parseInt(dlcHex, 16);
  const data = dataHex.match(/../g) || [];
  const n2k = extended ? decodeNmea2000CanId(id, data) : null;

  return {
    protocol: extended ? "nmea2000-can" : "can",
    level: Number.isFinite(id) && Number.isFinite(dlc) && data.length === dlc ? "ok" : "warn",
    summary: n2k ? `${n2k.pgn} ${n2k.name}` : `CAN ${idHex}`,
    raw,
    can: {
      format: extended ? "extended" : "standard",
      id,
      idHex,
      dlc,
      dataHex,
      data
    },
    nmea2000: n2k
  };
}

export function parseCandump(raw) {
  const match = raw.match(/^\((?<timestamp>\d+\.\d+)\)\s+(?<interface>\S+)\s+(?<id>[0-9A-Fa-f]{3,8})#(?<data>[0-9A-Fa-f]*)/);
  if (!match?.groups) {
    return {
      protocol: "raw",
      level: "warn",
      summary: "Invalid candump line",
      raw
    };
  }

  const { timestamp, interface: canInterface, id, data } = match.groups;
  const slcan = `${id.length > 3 ? "T" : "t"}${id}${Math.floor(data.length / 2).toString(16).toUpperCase()}${data}`;
  const parsed = parseSlcan(slcan);
  return {
    ...parsed,
    raw,
    candump: {
      timestamp: Number(timestamp),
      interface: canInterface
    }
  };
}

export function parseVelaTranslatedNmea0183(raw) {
  const match = raw.match(/^N2K>(?<target>[^:]+):\s*(?<sentence>[$!].*)$/);
  const parsed = parseNmea0183(match?.groups?.sentence || raw);
  return {
    ...parsed,
    raw,
    source: "vela-n2k0183-debug",
    translatedFrom: "nmea2000",
    target: match?.groups?.target || null,
    summary: `N2K>${match?.groups?.target || "?"} ${parsed.summary}`
  };
}

export function parseVelaN2kDebug(raw) {
  const match = raw.match(/^N2K:\s*PGN:\s*(?<pgn>\d+)\s+SRC:\s*(?<source>\d+)\s*=\s*\[(?<filter>[0-9A-Fa-fxX]{7})\]\s*(?:\((?<description>[^)]*)\))?(?:\s*(?<note>.*))?$/i);
  if (!match?.groups) {
    return {
      protocol: "nmea2000-debug",
      level: "warn",
      summary: "Invalid Vela-Navega N2K debug line",
      raw
    };
  }

  const pgn = Number(match.groups.pgn);
  const source = Number(match.groups.source);
  const description = match.groups.description || PGN_NAMES[pgn] || "Unknown PGN";
  return {
    protocol: "nmea2000-debug",
    level: "ok",
    summary: `${pgn} ${description}`,
    raw,
    nmea2000: {
      pgn,
      name: PGN_NAMES[pgn] || description,
      source,
      destination: null,
      filterCode: match.groups.filter,
      fastPacket: FAST_PACKET_PGNS.has(pgn),
      fields: {
        description,
        note: match.groups.note || ""
      }
    }
  };
}

export function parsePortNmea0183(raw) {
  const match = raw.match(/^P#(?<port>\d+):\s*(?<sentence>[$!].*)$/);
  const parsed = parseNmea0183(match?.groups?.sentence || raw);
  return {
    ...parsed,
    raw,
    inputPort: match?.groups?.port ? Number(match.groups.port) : null,
    summary: `P#${match?.groups?.port || "?"} ${parsed.summary}`
  };
}

export function parsePortN2kConversion(raw) {
  const normalized = raw.replace(/[\u2000-\u200B\u202F\u205F\u3000]/g, " ");
  const match = normalized.match(/^\s*(?:(?<port>P\d+)>N2K:\s*)?PGN:\s*(?<pgn>\d+)\[(?<pgnHex>[0-9A-Fa-f]+)\]\s*(?:\((?<description>[^)]*)\))?/);
  if (!match?.groups) {
    return {
      protocol: "nmea2000-conversion",
      level: "warn",
      summary: "Invalid port-to-N2K conversion line",
      raw
    };
  }

  const pgn = Number(match.groups.pgn);
  const description = (match.groups.description || "").trim();
  return {
    protocol: "nmea2000-conversion",
    level: "ok",
    summary: `${match.groups.port ? `${match.groups.port}>N2K ` : ""}${pgn} ${description || PGN_NAMES[pgn] || "Unknown PGN"}`,
    raw,
    conversion: {
      port: match.groups.port || null,
      direction: match.groups.port ? "port-to-nmea2000" : "continued-port-to-nmea2000"
    },
    nmea2000: {
      pgn,
      name: PGN_NAMES[pgn] || description || "Unknown PGN",
      source: null,
      destination: null,
      pgnHex: match.groups.pgnHex,
      fastPacket: FAST_PACKET_PGNS.has(pgn),
      fields: {
        description
      }
    }
  };
}

export function parsePcdin(raw) {
  const sentence = parseNmea0183(raw);
  const [pgnHex, timestampHex, sourceHex, dataHex = ""] = raw
    .slice(1, raw.includes("*") ? raw.lastIndexOf("*") : undefined)
    .split(",")
    .slice(1);
  const pgn = Number.parseInt(pgnHex, 16);
  const source = Number.parseInt(sourceHex, 16);
  const data = dataHex.match(/../g) || [];
  const name = pgn === 0 && data.length === 0
    ? "PCDIN Empty Frame"
    : PGN_NAMES[pgn] || "Unknown PGN";

  return {
    ...sentence,
    protocol: "nmea2000-pcdin",
    summary: `${pgn} ${name}`,
    pcdin: {
      pgnHex,
      timestampHex,
      sourceHex,
      dataHex
    },
    nmea2000: {
      pgn,
      name,
      source,
      destination: null,
      fastPacket: FAST_PACKET_PGNS.has(pgn),
      fields: decodeKnownPgn(pgn, data)
    }
  };
}

function xorChecksum(body) {
  let checksum = 0;
  for (const char of body) checksum ^= char.charCodeAt(0);
  return checksum;
}

function decodeNmea2000CanId(id, data) {
  const priority = (id >> 26) & 0x7;
  const dataPage = (id >> 24) & 0x1;
  const pduFormat = (id >> 16) & 0xff;
  const pduSpecific = (id >> 8) & 0xff;
  const source = id & 0xff;
  const destination = pduFormat < 240 ? pduSpecific : 255;
  const pgn = pduFormat < 240
    ? (dataPage << 16) | (pduFormat << 8)
    : (dataPage << 16) | (pduFormat << 8) | pduSpecific;

  return {
    priority,
    pgn,
    name: PGN_NAMES[pgn] || "Unknown PGN",
    source,
    destination,
    pduFormat,
    pduSpecific,
    fastPacket: FAST_PACKET_PGNS.has(pgn),
    fields: decodeKnownPgn(pgn, data)
  };
}

function decodeKnownPgn(pgn, data) {
  const bytes = data.map((hex) => Number.parseInt(hex, 16));
  const u16 = (offset) => bytes[offset] | (bytes[offset + 1] << 8);
  const i16 = (offset) => {
    const value = u16(offset);
    return value & 0x8000 ? value - 0x10000 : value;
  };
  const u32 = (offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const i32 = (offset) => {
    const value = u32(offset) >>> 0;
    return value & 0x80000000 ? value - 0x100000000 : value;
  };
  const radiansToDegrees = (value) => value * 180 / Math.PI;

  switch (pgn) {
    case 0:
      return {
        note: "Empty PCDIN frame",
        dataLength: bytes.length
      };
    case 127250:
      return {
        sid: bytes[0],
        headingDeg: round(radiansToDegrees(u16(1) * 0.0001), 3),
        deviationDeg: nullableAngle(i16(3)),
        variationDeg: nullableAngle(i16(5)),
        reference: ["True", "Magnetic", "Error", "Null"][bytes[7] & 0x3] || "Unknown"
      };
    case 127505: {
      const levelRaw = u16(1);
      const capacityRaw = u32(3);
      const fluidTypeId = (bytes[0] >> 4) & 0xf;
      return {
        instance: bytes[0] & 0xf,
        fluidTypeId,
        fluidType: FLUID_TYPES[fluidTypeId] || "Unknown",
        levelPercent: levelRaw === 0xffff ? null : round(levelRaw * 0.004, 3),
        capacityLiters: capacityRaw === 0xffffffff ? null : round(capacityRaw * 0.1, 1)
      };
    }
    case 128267:
      return {
        sid: bytes[0],
        depthMeters: round(u32(1) * 0.0001, 3),
        offsetMeters: round(i16(5) * 0.001, 3)
      };
    case 129025:
      return {
        latitude: round(i32(0) * 1e-7, 7),
        longitude: round(i32(4) * 1e-7, 7)
      };
    case 129026:
      return {
        sid: bytes[0],
        cogReference: bytes[1] & 0x3 ? "Magnetic" : "True",
        cogDeg: round(radiansToDegrees(u16(2) * 0.0001), 3),
        sogMs: round(u16(4) * 0.01, 3)
      };
    case 129038:
    case 129039:
    case 129040:
    case 129041:
    case 129793:
    case 129795:
    case 129796:
    case 129797:
    case 129798:
    case 129801:
    case 129802:
      return {
        dataLength: bytes.length,
        messageId: bytes[0] & 0x3f,
        userId: bytes.length >= 5 ? u32(1) : null
      };
    case 129794:
      return {
        dataLength: bytes.length,
        messageId: bytes[0] & 0x3f,
        userId: bytes.length >= 5 ? u32(1) : null,
        text: printableAscii(bytes)
      };
    case 129809:
      return {
        dataLength: bytes.length,
        messageId: bytes[0] & 0x3f,
        userId: bytes.length >= 5 ? u32(1) : null,
        vesselName: asciiField(bytes, 5, 20),
        text: printableAscii(bytes)
      };
    case 129810:
      return {
        dataLength: bytes.length,
        messageId: bytes[0] & 0x3f,
        userId: bytes.length >= 5 ? u32(1) : null,
        text: printableAscii(bytes)
      };
    case 130306:
      return {
        sid: bytes[0],
        windSpeedMs: round(u16(1) * 0.01, 3),
        windAngleDeg: round(radiansToDegrees(u16(3) * 0.0001), 3),
        reference: ["True North", "Magnetic", "Apparent", "True Boat", "True Water", "Error", "Null"][bytes[5] & 0x7] || "Unknown"
      };
    default:
      return {};
  }
}

function nullableAngle(rawValue) {
  if (rawValue === 0x7fff || rawValue === -1) return null;
  return round(rawValue * 0.0001 * 180 / Math.PI, 3);
}

function asciiField(bytes, offset, length) {
  return bytes
    .slice(offset, offset + length)
    .filter((byte) => byte >= 0x20 && byte <= 0x7e)
    .map((byte) => String.fromCharCode(byte))
    .join("")
    .trim() || null;
}

function printableAscii(bytes) {
  const text = bytes
    .map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : " ")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function round(value, decimals) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
