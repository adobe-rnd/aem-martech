// jsdom does not always expose structuredClone on the window object.
if (!window.structuredClone) {
  window.structuredClone = typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone.bind(globalThis)
    : (value) => JSON.parse(JSON.stringify(value));
}
