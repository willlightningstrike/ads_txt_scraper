// Stop this caller's wait without cancelling work shared with other callers.
// Keep rejection handlers attached even after abort so a late failure is consumed.
function awaitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
    if (signal.aborted) onAbort();
  });
}

module.exports = { awaitWithSignal };
