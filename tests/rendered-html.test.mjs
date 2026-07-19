import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("static build emits HTML with preview metadata", async () => {
  const indexPath = fileURLToPath(new URL("../dist/index.html", import.meta.url));
  const html = await readFile(indexPath, "utf8");

  assert.match(html, developmentPreviewMeta);
  assert.match(html, /id=["']root["']/i);
  assert.match(html, /<script\b[^>]*\bsrc=["'][^"']+\.js["']/i);
});
