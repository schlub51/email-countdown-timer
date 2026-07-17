import { Redis } from "@upstash/redis";
import { randomBytes } from "node:crypto";

const ALLOWED_KEYS = new Set([
  "mode",
  "end",
  "duration",
  "style",
  "font",
  "bg",
  "fg",
  "accent",
  "width",
  "height",
  "frames",
  "loop",
  "id",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJson(req);
    const config = sanitizeConfig(body);
    const id = randomBytes(5).toString("base64url");
    const redis = Redis.fromEnv();

    await redis.set(`timer:config:${id}`, config, { ex: 60 * 60 * 24 * 365 });

    const origin = `https://${req.headers.host}`;
    res.status(200).json({
      id,
      url: `${origin}/api/timer?config=${id}`,
      expiresInDays: 365,
    });
  } catch (error) {
    res.status(400).json({ error: "Could not shorten timer URL" });
  }
}

function sanitizeConfig(body) {
  const config = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (ALLOWED_KEYS.has(key) && value !== undefined && value !== null && value !== "") {
      config[key] = String(value).slice(0, 500);
    }
  }
  return config;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
