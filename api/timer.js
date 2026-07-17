import GIFEncoder from "gif-encoder-2";
import { Redis } from "@upstash/redis";
import sharp from "sharp";
import TextToSVG from "text-to-svg";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import gifsicle from "gifsicle";

const DEFAULTS = {
  width: 400,
  height: 90,
  background: "FFFFFF",
  foreground: "0F1A4C",
  accent: "233DB2",
  label: "DAYS,HRS,MINS,SECS",
  duration: 7200,
  frames: 15,
  style: "arc",
  font: "inter",
  loop: false,
};

let redis;
let textToSvg;

const SEGMENTS = {
  0: ["a", "b", "c", "d", "e", "f"],
  1: ["b", "c"],
  2: ["a", "b", "g", "e", "d"],
  3: ["a", "b", "g", "c", "d"],
  4: ["f", "g", "b", "c"],
  5: ["a", "f", "g", "c", "d"],
  6: ["a", "f", "e", "d", "c", "g"],
  7: ["a", "b", "c"],
  8: ["a", "b", "c", "d", "e", "f", "g"],
  9: ["a", "b", "c", "d", "f", "g"],
};

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const params = await resolveParams(url.searchParams);
    const options = getOptions(params);
    const endTime = await resolveEndTime(params, options);
    const now = Date.now();
    const remaining = Math.max(0, Math.floor((endTime - now) / 1000));
    const gif = await optimizeGif(await createTimerGif(remaining, options));

    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.status(200).send(gif);
  } catch (error) {
    const fallback = await optimizeGif(await createTimerGif(0, DEFAULTS));
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(fallback);
  }
}

async function resolveParams(params) {
  const configId = sanitizeKey(params.get("config") || "");
  if (!configId) {
    return params;
  }

  const config = await getRedis().get(`timer:config:${configId}`);
  if (!config || typeof config !== "object") {
    throw new Error("Timer config not found");
  }

  const merged = new URLSearchParams();
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && value !== null) {
      merged.set(key, String(value));
    }
  }

  for (const [key, value] of params.entries()) {
    if (key !== "config") {
      merged.set(key, value);
    }
  }

  return merged;
}

async function resolveEndTime(params, options) {
  const mode = (params.get("mode") || (params.has("end") ? "fixed" : "duration")).toLowerCase();

  if (mode === "fixed") {
    const end = Date.parse(params.get("end") || params.get("time") || "");
    if (!Number.isFinite(end)) {
      throw new Error("Missing or invalid fixed end date");
    }
    return end;
  }

  if (mode === "evergreen") {
    if (parseBoolean(params.get("preview"), false)) {
      return Date.now() + options.duration * 1000;
    }

    const id = sanitizeKey(params.get("id"));
    if (!id) {
      throw new Error("Evergreen mode requires id");
    }

    const key = `timer:first-seen:${id}`;
    const ttl = Math.max(options.duration + 86400 * 30, 86400);
    const client = getRedis();
    const created = Date.now();
    const wasSet = await client.set(key, created, { nx: true, ex: ttl });
    const firstSeen = wasSet ? created : Number(await client.get(key));

    if (!Number.isFinite(firstSeen)) {
      await client.set(key, created, { ex: ttl });
      return created + options.duration * 1000;
    }

    return firstSeen + options.duration * 1000;
  }

  return Date.now() + options.duration * 1000;
}

function getRedis() {
  if (!redis) {
    redis = Redis.fromEnv();
  }
  return redis;
}

function getOptions(params) {
  return {
    width: clampNumber(params.get("width"), 320, 1200, DEFAULTS.width),
    height: clampNumber(params.get("height"), 80, 320, DEFAULTS.height),
    background: normalizeHex(params.get("bg") || params.get("background"), DEFAULTS.background),
    foreground: normalizeHex(params.get("fg") || params.get("foreground"), DEFAULTS.foreground),
    accent: normalizeHex(params.get("accent"), DEFAULTS.accent),
    label: params.get("label") || DEFAULTS.label,
    duration: clampNumber(params.get("duration"), 60, 60 * 60 * 24 * 30, DEFAULTS.duration),
    frames: clampNumber(params.get("frames"), 1, 60, DEFAULTS.frames),
    style: ["arc", "card"].includes((params.get("style") || "").toLowerCase()) ? params.get("style").toLowerCase() : DEFAULTS.style,
    font: normalizeFont(params.get("font")),
    loop: parseBoolean(params.get("loop"), DEFAULTS.loop),
  };
}

async function createTimerGif(totalSeconds, options) {
  const encoder = new GIFEncoder(options.width, options.height);
  const frameCount = totalSeconds === 0 ? 1 : Math.min(options.frames, totalSeconds + 1);

  encoder.start();
  encoder.setRepeat(totalSeconds === 0 || !options.loop ? -1 : 0);
  encoder.setDelay(1000);
  encoder.setQuality(12);

  for (let index = 0; index < frameCount; index += 1) {
    const seconds = Math.max(0, totalSeconds - index);
    const frame = options.style === "arc" ? await drawArcSvgFrame(seconds, options) : drawFrame(seconds, options);
    encoder.addFrame(frame);
  }

  encoder.finish();
  return Buffer.from(encoder.out.getData());
}

function optimizeGif(input) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(gifsicle, ["-O3", "--colors", "64"], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(input));
    child.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        resolve(input);
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    child.stdin.end(input);
  });
}

async function drawArcSvgFrame(totalSeconds, options) {
  const svg = createArcSvg(totalSeconds, options);
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}

function createArcSvg(totalSeconds, options) {
  const bg = `#${options.background}`;
  const fg = `#${options.foreground}`;
  const accent = `#${options.accent}`;
  const values = splitTime(totalSeconds);
  const labels = options.label.split(",").map((label) => escapeXml(titleCase(label.trim().slice(0, 8) || "")));
  const gap = Math.max(0, Math.round(options.width * 0.002));
  const margin = Math.max(1, Math.round(options.width * 0.004));
  const cellWidth = Math.floor((options.width - margin * 2 - gap * 3) / 4);
  const centerY = Math.floor(options.height * 0.5);
  const radius = Math.min(Math.floor(cellWidth * 0.57), Math.floor(options.height * 0.47));
  const stroke = Math.max(4, Math.floor(radius * 0.105));
  const circumference = 2 * Math.PI * radius;
  const maxValues = [99, 24, 60, 60];
  const labelSize = Math.max(8, Math.floor(radius * 0.24));
  const numberSize = Math.max(24, Math.floor(radius * 0.82));

  const cells = values.map((value, index) => {
    const centerX = margin + Math.floor(cellWidth / 2) + index * (cellWidth + gap);
    const progress = Math.max(0, Math.min(1, value / maxValues[index]));
    const dash = circumference * progress;
    const displayValue = String(value).padStart(2, "0");
    const numberPath = svgText(displayValue, centerX, centerY - Math.floor(radius * 0.08), numberSize, fg, 500, true, 0, options.font);
    const labelPath = svgText(labels[index] || "", centerX, centerY + Math.floor(radius * 0.42), labelSize, fg, 400, true, 0, options.font);

    return `
      <g>
        <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="none" stroke="rgba(15,26,76,0.13)" stroke-width="${stroke}" />
        <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="none" stroke="${accent}" stroke-width="${stroke}" stroke-linecap="round"
          stroke-dasharray="${dash} ${circumference - dash}" transform="rotate(-90 ${centerX} ${centerY})" />
        ${numberPath}
        ${labelPath}
      </g>`;
  }).join("");

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">
      <rect width="100%" height="100%" fill="${bg}" />
      ${cells}
    </svg>`;
}

function svgText(text, x, y, fontSize, color, weight, centered = false, letterSpacing = 0, font = DEFAULTS.font) {
  const renderer = getTextRenderer(font, weight);
  const attributes = { fill: color };
  const options = {
    x,
    y,
    fontSize,
    anchor: centered ? "center" : "left",
    attributes,
  };

  if (letterSpacing > 0) {
    let cursor = x;
    const chars = String(text).split("");
    const widths = chars.map((char) => renderer.getMetrics(char, { fontSize }).width);
    const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, chars.length - 1) * letterSpacing;
    cursor = centered ? x - total / 2 : x;
    return chars.map((char, index) => {
      const path = renderer.getPath(char, {
        x: cursor,
        y,
        fontSize,
        attributes,
      });
      cursor += widths[index] + letterSpacing;
      return path;
    }).join("");
  }

  return renderer.getPath(String(text), options);
}

const FONT_FILES = {
  inter: {
    400: "../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff",
    500: "../node_modules/@fontsource/inter/files/inter-latin-500-normal.woff",
    600: "../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff",
    700: "../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff",
  },
  roboto: {
    400: "../node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff",
    500: "../node_modules/@fontsource/roboto/files/roboto-latin-500-normal.woff",
    600: "../node_modules/@fontsource/roboto/files/roboto-latin-600-normal.woff",
    700: "../node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff",
  },
  "open-sans": {
    400: "../node_modules/@fontsource/open-sans/files/open-sans-latin-400-normal.woff",
    500: "../node_modules/@fontsource/open-sans/files/open-sans-latin-500-normal.woff",
    600: "../node_modules/@fontsource/open-sans/files/open-sans-latin-600-normal.woff",
    700: "../node_modules/@fontsource/open-sans/files/open-sans-latin-700-normal.woff",
  },
  lato: {
    400: "../node_modules/@fontsource/lato/files/lato-latin-400-normal.woff",
    500: "../node_modules/@fontsource/lato/files/lato-latin-700-normal.woff",
    600: "../node_modules/@fontsource/lato/files/lato-latin-700-normal.woff",
    700: "../node_modules/@fontsource/lato/files/lato-latin-700-normal.woff",
  },
};

function getTextRenderer(font, weight) {
  if (!textToSvg) {
    textToSvg = new Map();
  }

  const family = normalizeFont(font);
  const normalizedWeight = [400, 500, 600, 700].includes(weight) ? weight : 600;
  const key = `${family}:${normalizedWeight}`;
  if (!textToSvg.has(key)) {
    textToSvg.set(
      key,
      TextToSVG.loadSync(fileURLToPath(new URL(FONT_FILES[family][normalizedWeight], import.meta.url))),
    );
  }

  return textToSvg.get(key);
}

function normalizeFont(value) {
  const font = String(value || "").toLowerCase();
  return Object.hasOwn(FONT_FILES, font) ? font : DEFAULTS.font;
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/(^|\s)\w/g, (match) => match.toUpperCase());
}

function drawFrame(totalSeconds, options) {
  const buffer = Buffer.alloc(options.width * options.height * 4);
  const bg = hexToRgb(options.background);
  const fg = hexToRgb(options.foreground);
  const accent = hexToRgb(options.accent);
  const muted = mix(bg, fg, 0.28);
  const card = mix(bg, fg, 0.08);

  fill(buffer, options.width, options.height, bg);

  const values = splitTime(totalSeconds);
  const labels = options.label.split(",").map((label) => label.trim().slice(0, 8));
  const gap = Math.max(10, Math.round(options.width * 0.018));
  const margin = Math.max(14, Math.round(options.width * 0.035));

  if (options.style === "arc") {
    drawArcLayout(buffer, options, values, labels, bg, fg, accent, muted);
    return buffer;
  }

  const cardWidth = Math.floor((options.width - margin * 2 - gap * 3) / 4);
  const cardHeight = Math.floor(options.height * 0.66);
  const cardY = Math.floor(options.height * 0.12);
  const digitHeight = Math.floor(cardHeight * 0.54);
  const digitWidth = Math.floor(cardWidth * 0.22);
  const digitGap = Math.max(4, Math.floor(cardWidth * 0.035));
  const numberWidth = digitWidth * 2 + digitGap;

  for (let i = 0; i < 4; i += 1) {
    const x = margin + i * (cardWidth + gap);
    roundedRect(buffer, options.width, options.height, x, cardY, cardWidth, cardHeight, 7, card);
    const value = String(values[i]).padStart(2, "0");
    const digitY = cardY + Math.floor(cardHeight * 0.13);
    const digitX = x + Math.floor((cardWidth - numberWidth) / 2);
    drawDigit(buffer, options.width, options.height, value[0], digitX, digitY, digitWidth, digitHeight, fg);
    drawDigit(buffer, options.width, options.height, value[1], digitX + digitWidth + digitGap, digitY, digitWidth, digitHeight, fg);
    drawTinyText(buffer, options.width, options.height, labels[i] || "", x + Math.floor(cardWidth / 2), cardY + Math.floor(cardHeight * 0.84), muted, true);

    if (i < 3) {
      drawColon(buffer, options.width, options.height, x + cardWidth + Math.floor(gap / 2), cardY + Math.floor(cardHeight * 0.31), accent);
    }
  }

  return buffer;
}

function drawArcLayout(buffer, options, values, labels, bg, fg, accent, muted) {
  const gap = Math.max(8, Math.round(options.width * 0.014));
  const margin = Math.max(12, Math.round(options.width * 0.028));
  const cellWidth = Math.floor((options.width - margin * 2 - gap * 3) / 4);
  const centerY = Math.floor(options.height * 0.48);
  const radius = Math.min(Math.floor(cellWidth * 0.42), Math.floor(options.height * 0.34));
  const ring = Math.max(5, Math.floor(radius * 0.12));
  const track = mix(bg, fg, 0.16);
  const maxValues = [99, 24, 60, 60];

  for (let i = 0; i < 4; i += 1) {
    const centerX = margin + Math.floor(cellWidth / 2) + i * (cellWidth + gap);
    drawRing(buffer, options.width, options.height, centerX, centerY, radius, ring, track, 1);
    drawRing(buffer, options.width, options.height, centerX, centerY, radius, ring, accent, values[i] / maxValues[i]);

    const value = String(values[i]).padStart(2, "0");
    const digitHeight = Math.floor(radius * 0.95);
    const digitWidth = Math.floor(radius * 0.34);
    const digitGap = Math.max(3, Math.floor(radius * 0.05));
    const numberWidth = digitWidth * 2 + digitGap;
    const digitX = centerX - Math.floor(numberWidth / 2);
    const digitY = centerY - Math.floor(digitHeight / 2);

    drawDigit(buffer, options.width, options.height, value[0], digitX, digitY, digitWidth, digitHeight, fg);
    drawDigit(buffer, options.width, options.height, value[1], digitX + digitWidth + digitGap, digitY, digitWidth, digitHeight, fg);
    drawTinyText(buffer, options.width, options.height, labels[i] || "", centerX, centerY + radius + Math.max(8, Math.floor(radius * 0.18)), muted, true);
  }
}

function splitTime(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [Math.min(days, 99), hours, minutes, seconds];
}

function drawDigit(buffer, width, height, digit, x, y, w, h, color) {
  const thickness = Math.max(4, Math.floor(w * 0.18));
  const active = SEGMENTS[digit] || SEGMENTS[0];
  const segmentRects = {
    a: [x + thickness, y, w - thickness * 2, thickness],
    b: [x + w - thickness, y + thickness, thickness, Math.floor(h / 2) - thickness],
    c: [x + w - thickness, y + Math.floor(h / 2), thickness, Math.floor(h / 2) - thickness],
    d: [x + thickness, y + h - thickness, w - thickness * 2, thickness],
    e: [x, y + Math.floor(h / 2), thickness, Math.floor(h / 2) - thickness],
    f: [x, y + thickness, thickness, Math.floor(h / 2) - thickness],
    g: [x + thickness, y + Math.floor(h / 2) - Math.floor(thickness / 2), w - thickness * 2, thickness],
  };

  for (const segment of active) {
    const [sx, sy, sw, sh] = segmentRects[segment];
    roundedRect(buffer, width, height, sx, sy, sw, sh, Math.ceil(thickness / 2), color);
  }
}

function drawColon(buffer, width, height, x, y, color) {
  const size = Math.max(3, Math.floor(width * 0.007));
  roundedRect(buffer, width, height, x - size, y, size * 2, size * 2, size, color);
  roundedRect(buffer, width, height, x - size, y + size * 5, size * 2, size * 2, size, color);
}

const LETTERS = {
  A: ["111", "101", "111", "101", "101"],
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  G: ["111", "100", "101", "101", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  R: ["110", "101", "110", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  Y: ["101", "101", "010", "010", "010"],
};

function drawTinyText(buffer, width, height, text, centerX, y, color, centered = false) {
  const scale = Math.max(2, Math.floor(width / 260));
  const spacing = scale;
  const chars = text.toUpperCase().replace(/[^A-Z]/g, "").split("");
  const textWidth = chars.length * 3 * scale + Math.max(0, chars.length - 1) * spacing;
  let x = centered ? centerX - Math.floor(textWidth / 2) : centerX;

  for (const char of chars) {
    const glyph = LETTERS[char];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        for (let col = 0; col < glyph[row].length; col += 1) {
          if (glyph[row][col] === "1") {
            rect(buffer, width, height, x + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
    }
    x += 3 * scale + spacing;
  }
}

function fill(buffer, width, height, color) {
  rect(buffer, width, height, 0, 0, width, height, color);
}

function roundedRect(buffer, width, height, x, y, w, h, radius, color) {
  for (let py = Math.floor(y); py < y + h; py += 1) {
    for (let px = Math.floor(x); px < x + w; px += 1) {
      const dx = px < x + radius ? x + radius - px : px >= x + w - radius ? px - (x + w - radius - 1) : 0;
      const dy = py < y + radius ? y + radius - py : py >= y + h - radius ? py - (y + h - radius - 1) : 0;
      if (dx * dx + dy * dy <= radius * radius || dx === 0 || dy === 0) {
        setPixel(buffer, width, height, px, py, color);
      }
    }
  }
}

function drawRing(buffer, width, height, cx, cy, radius, thickness, color, progress) {
  const start = -Math.PI / 2;
  const end = start + Math.PI * 2 * Math.max(0, Math.min(1, progress));
  const inner = radius - thickness;
  const outerSq = radius * radius;
  const innerSq = inner * inner;

  for (let py = cy - radius; py <= cy + radius; py += 1) {
    for (let px = cx - radius; px <= cx + radius; px += 1) {
      const dx = px - cx;
      const dy = py - cy;
      const distanceSq = dx * dx + dy * dy;

      if (distanceSq > outerSq || distanceSq < innerSq) {
        continue;
      }

      if (progress < 1) {
        let angle = Math.atan2(dy, dx);
        if (angle < start) {
          angle += Math.PI * 2;
        }
        if (angle > end) {
          continue;
        }
      }

      setPixel(buffer, width, height, px, py, color);
    }
  }
}

function rect(buffer, width, height, x, y, w, h, color) {
  const startX = Math.max(0, Math.floor(x));
  const startY = Math.max(0, Math.floor(y));
  const endX = Math.min(width, Math.ceil(x + w));
  const endY = Math.min(height, Math.ceil(y + h));

  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      setPixel(buffer, width, height, px, py, color);
    }
  }
}

function setPixel(buffer, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }

  const index = (y * width + x) * 4;
  buffer[index] = color.r;
  buffer[index + 1] = color.g;
  buffer[index + 2] = color.b;
  buffer[index + 3] = 255;
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex, DEFAULTS.foreground);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function normalizeHex(value, fallback) {
  const clean = String(value || "").replace("#", "").trim();
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return clean.split("").map((char) => char + char).join("").toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return clean.toUpperCase();
  }
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function parseBoolean(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function sanitizeKey(value) {
  return String(value || "")
    .trim()
    .slice(0, 200)
    .replace(/[^a-zA-Z0-9:._-]/g, "_");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mix(a, b, amount) {
  return {
    r: Math.round(a.r + (b.r - a.r) * amount),
    g: Math.round(a.g + (b.g - a.g) * amount),
    b: Math.round(a.b + (b.b - a.b) * amount),
  };
}
