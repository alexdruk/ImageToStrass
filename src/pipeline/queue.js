// The design queue (spec section 7): one design at a time, at most QUEUE_LIMIT waiting or running.
// Jobs are identified by a string id ("<code>/<n>"). run(id) is awaited; it must not reject (a
// rejection is logged and the queue moves on).

export const QUEUE_LIMIT = 10;

export function createQueue({ run, limit = QUEUE_LIMIT, log = console }) {
  const waiting = [];
  let running = null;
  let idle = Promise.resolve();
  let wake = null;

  async function loop() {
    while (waiting.length > 0) {
      running = waiting.shift();
      try {
        await run(running);
      } catch (error) {
        log.error(`Design ${running} stopped: ${error.stack || error.message}`);
      }
      running = null;
    }
    wake = null;
  }

  function kick() {
    if (!wake) {
      wake = loop();
      idle = wake;
    }
  }

  return {
    // False when the queue is full. A front job (an automatic re-run) skips the line and the
    // limit; a forced job (re-queued at start-up) skips the limit only.
    add(id, { front = false, force = false } = {}) {
      if (!front && !force && this.length() >= limit) return false;
      if (front) waiting.unshift(id); else waiting.push(id);
      kick();
      return true;
    },
    has: (id) => running === id || waiting.includes(id),
    // 0 = running now, 1 = next, ...; null when the job is not in the queue.
    position(id) {
      if (running === id) return 0;
      const i = waiting.indexOf(id);
      return i < 0 ? null : i + (running ? 1 : 0);
    },
    length: () => waiting.length + (running ? 1 : 0),
    idle: () => idle
  };
}
