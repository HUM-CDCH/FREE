import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadBlob } from "./download.js";
import { stubBrowser } from "./test-browser.js";

test("clicks a temporary link that carries the blob and the name", () => {
  const browser = stubBrowser();
  try {
    downloadBlob(new Blob(["text"]), "result.csv");
    assert.equal(browser.downloads.length, 1);
    assert.equal(browser.downloads[0]!.filename, "result.csv");
  } finally {
    browser.restore();
  }
});

test("fails when the browser download APIs are absent", () => {
  assert.throws(
    () => downloadBlob(new Blob(["text"]), "result.csv"),
    /Browser download APIs are unavailable/,
  );
});

test("removes the link and reports a blocked click", () => {
  const original = globalThis.document;
  let removed = false;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { append: () => undefined },
      createElement: () => ({
        href: "",
        download: "",
        hidden: false,
        remove: () => {
          removed = true;
        },
        click: () => {
          throw new Error("blocked");
        },
      }),
    },
  });

  try {
    assert.throws(() => downloadBlob(new Blob(["text"]), "result.csv"), /blocked/);
    assert.equal(removed, true);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: original });
  }
});
