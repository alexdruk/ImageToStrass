// A minimal Chrome DevTools Protocol driver for the web app checks: an isolated headless Chrome with
// a throw-away profile, one page, and the few commands the checks need. It starts and stops only
// its own instance; no other Chrome window is touched. Node 22's built-in WebSocket, no dependency.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchBrowser({ timeoutMs = 20_000 } = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), "is-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"
  ], { stdio: "ignore" });

  const portFile = path.join(profile, "DevToolsActivePort");
  const until = Date.now() + timeoutMs;
  while (!existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2) {
    if (Date.now() > until) throw new Error("Chrome did not start");
    await sleep(100);
  }
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const page = await connect(target.webSocketDebuggerUrl);

  return {
    page,
    async close() {
      page.socket.close();
      const exited = chrome.exitCode !== null ? null : new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await Promise.race([exited, sleep(5_000)]);
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left to the OS */ }
    }
  };
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ""}`));
      else resolve(message.result);
    } else if (message.method) {
      for (const fn of listeners.get(message.method) || []) fn(message.params);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) || []), fn]);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");

  const page = {
    socket, send, on,

    async eval(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(`${exceptionDetails.text} ${exceptionDetails.exception?.description || ""}`);
      return result.value;
    },

    async waitFor(expression, { timeoutMs = 30_000, what = expression } = {}) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const value = await page.eval(`(() => { try { return ${expression}; } catch { return false; } })()`);
        if (value) return value;
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await sleep(150);
      }
    },

    async viewport(width, height, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    },

    async goto(url) {
      const loaded = new Promise((resolve) => on("Page.loadEventFired", resolve));
      await send("Page.navigate", { url });
      await loaded;
    },

    async click(selector) {
      const ok = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
      if (!ok) throw new Error(`no element ${selector}`);
    },

    async setFiles(selector, files) {
      const { root } = await send("DOM.getDocument");
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`no element ${selector}`);
      await send("DOM.setFileInputFiles", { nodeId, files });
    },

    // Full-page PNG at the current width.
    async screenshot() {
      const { cssContentSize } = await send("Page.getLayoutMetrics");
      const { data } = await send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: cssContentSize.width, height: Math.ceil(cssContentSize.height), scale: 1 }
      });
      return Buffer.from(data, "base64");
    }
  };
  return page;
}
