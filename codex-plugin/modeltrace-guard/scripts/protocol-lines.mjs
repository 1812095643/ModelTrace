// Bound a JSON-RPC frame BEFORE decoding it into a JS string. readline buffers
// an entire line and can throw outside request promises on large responses.
export const MAX_PROTOCOL_MESSAGE_BYTES = 16 * 1024 * 1024;

export function readProtocolLines(input, onMessage, onError, { maxMessageBytes = MAX_PROTOCOL_MESSAGE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > MAX_PROTOCOL_MESSAGE_BYTES) throw new Error('Invalid Codex protocol message limit');
  let parts = [], bytes = 0, closed = false;
  function close() {
    if (closed) return;
    closed = true; parts = []; bytes = 0;
    input.off('data', data); input.off('end', end); input.off('error', fail);
  }
  function fail(error) { if (!closed) { close(); onError(error); } }
  function append(part) {
    if (bytes + part.length > maxMessageBytes) {
      const error = new Error(`Codex probe protocol message exceeds ${maxMessageBytes} bytes; no sample accepted`);
      error.code = 'MODELTRACE_PROTOCOL_MESSAGE_TOO_LARGE';
      fail(error); return false;
    }
    if (part.length) { parts.push(part); bytes += part.length; }
    return true;
  }
  function emit() {
    const line = Buffer.concat(parts, bytes).toString('utf8').trim();
    parts = []; bytes = 0;
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Not a JSON-RPC object');
    } catch {
      const error = new Error('Codex probe transport returned an invalid JSON-RPC message; no sample accepted');
      error.code = 'MODELTRACE_PROTOCOL_INVALID_MESSAGE';
      fail(error); return;
    }
    try { onMessage(message); }
    catch (error) { fail(error); }
  }
  function data(chunk) {
    if (closed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let start = 0, newline;
    while (!closed && (newline = chunk.indexOf(10, start)) !== -1) {
      if (!append(chunk.subarray(start, newline))) return;
      emit(); start = newline + 1;
    }
    if (!closed) append(chunk.subarray(start));
  }
  function end() { if (!closed) { if (bytes) emit(); close(); } }
  input.on('data', data); input.once('end', end); input.on('error', fail);
  return { close };
}
