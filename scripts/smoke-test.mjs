import { readFile } from "node:fs/promises";

const { default: handler } = await import(new URL("../api/timer.js", import.meta.url));

const chunks = [];
const response = {
  headers: {},
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  send(payload) {
    chunks.push(Buffer.from(payload));
  },
};

await handler(
  {
    url: process.argv[2] || "/api/timer?mode=duration&duration=120&frames=2",
    headers: { host: "localhost" },
  },
  response,
);

const output = Buffer.concat(chunks);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

if (response.statusCode !== 200) {
  throw new Error(`Expected HTTP 200, got ${response.statusCode}`);
}

if (response.headers["content-type"] !== "image/gif") {
  throw new Error(`Expected image/gif, got ${response.headers["content-type"]}`);
}

if (output.slice(0, 6).toString("ascii") !== "GIF89a") {
  throw new Error("Response is not a GIF89a image");
}

if (!packageJson.dependencies["@upstash/redis"]) {
  throw new Error("Missing Upstash dependency");
}

console.log(`Generated ${output.length} bytes`);
