import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("renders the production Vite entry document", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /<html[^>]*>/i);
  assert.match(html, /<div id=["']root["']/i);
  assert.match(html, /<script[^>]+type=["']module["']/i);
});
