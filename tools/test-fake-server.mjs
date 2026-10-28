import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { startFakeServer } from "./fake-server.mjs";

// The fake web app (tools/fake-server.mjs): with --stage-ms (the browser checks and screenshots) a
// design is the same as in plain IS_FAKE=1. PN-04a: the delayed fake provider answered with RS's
// 64 x 64 test disc instead of the fake layout's AI image, so every black & white stone read the
// transparent frame and became Crystal.

const PHOTO = readFileSync(new URL("./fixtures/upload/photo.png", import.meta.url));

async function design(stageMs, settings) {
  const srv = await startFakeServer({ stageMs, deps: { verifyTurnstile: async () => true } });
  try {
    const body = new FormData();
    body.append("consent", "1");
    body.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
    const { code } = await (await fetch(`${srv.url}/api/upload`, { method: "POST", body })).json();
    let created;
    for (let i = 0; i < 100; i++) {
      created = await fetch(`${srv.url}/api/attempts/${code}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ upload: 1, removeBackground: true, adjustments: {}, ...settings })
      });
      if (created.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const { attempt } = await created.json();
    await srv.pipeline.idle();
    return (await (await fetch(`${srv.url}/api/attempts/${code}/${attempt}`)).json()).result;
  } finally {
    await srv.stop();
  }
}

test("fake server with stage delay: black & white shows Jet and Crystal, as IS_FAKE=1", async () => {
  for (const bwStyle of ["stencil", "halftone"]) {
    const plain = await design(0, { mode: "bw", bwStyle });
    const delayed = await design(1, { mode: "bw", bwStyle });
    assert.deepEqual(Object.keys(delayed.byColour).sort(), ["crystal-clear", "jet"]);
    assert.ok(delayed.byColour.jet > 0.3 * delayed.stones, `Jet ${delayed.byColour.jet} of ${delayed.stones}`);
    assert.deepEqual(delayed, plain);
  }
});

test("fake server with stage delay: colour design equals IS_FAKE=1", async () => {
  assert.deepEqual(await design(1, { mode: "colour" }), await design(0, { mode: "colour" }));
});
