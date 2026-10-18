// From Rhinestone-Studio @38cd831 server/redraw/jobs.mjs
// IS (spec section 7.4): only callLayoutService and its constants are taken; the job store is replaced
// by queue.js. The error messages are for the local log only and never reach the browser.

export const LAYOUT_TARGET_PITCH_MM = 2.1;

const LAYOUT_TIMEOUT = Symbol('layout-timeout');

// One POST /layout to the layout service. Never rejects: resolves { layout }, { error: { code,
// message } }, or { cancelled: true } when `signal` aborts. No retry.
export async function callLayoutService({ fetch, timers, url, timeoutMs, pngBuffer, colorIds, signal }) {
  if (!url) return { error: { code: 'layout-unavailable', message: 'The layout service is not set up (LAYOUT_SERVICE_URL is empty).' } };
  if (signal.aborted) return { cancelled: true };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timeoutError = { error: { code: 'layout-timeout', message: `The layout service took longer than ${Math.round(timeoutMs / 1000)} s.` } };
  let timer;
  let timedOut = false;
  try {
    const form = new FormData();
    form.append('image', new Blob([pngBuffer], { type: 'image/png' }), 'redraw.png');
    form.append('options', JSON.stringify({ colorIds, targetPitchMm: LAYOUT_TARGET_PITCH_MM }));
    const timeout = new Promise((resolve) => { timer = timers.setTimeout(() => { timedOut = true; controller.abort(); resolve(LAYOUT_TIMEOUT); }, timeoutMs); });
    const request = fetch(`${url.replace(/\/+$/, '')}/layout`, { method: 'POST', body: form, signal: controller.signal });
    request.catch(() => {});
    const response = await Promise.race([request, timeout]);
    if (signal.aborted) return { cancelled: true };
    if (response === LAYOUT_TIMEOUT) return timeoutError;
    const reading = response.json().catch(() => null);
    const body = await Promise.race([reading, timeout]);
    if (signal.aborted) return { cancelled: true };
    if (body === LAYOUT_TIMEOUT) return timeoutError;
    if (response.status !== 200) {
      const message = body && typeof body.error === 'string'
        ? `${body.error}: ${typeof body.message === 'string' ? body.message : ''}`
        : `The layout service answered ${response.status}.`;
      return { error: { code: 'layout-failed', message } };
    }
    if (!body || !Array.isArray(body.stones)) return { error: { code: 'layout-failed', message: 'The layout service returned no layout.' } };
    return { layout: body };
  } catch (error) {
    if (signal.aborted) return { cancelled: true };
    if (timedOut) return timeoutError;
    const cause = error && error.cause ? error.cause : error;
    if (cause && cause.code === 'ECONNREFUSED') return { error: { code: 'layout-unavailable', message: `The layout service at ${url} is not running.` } };
    return { error: { code: 'layout-failed', message: error && error.message ? error.message : String(error) } };
  } finally {
    timers.clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
