/** Reads a child process stream without ever buffering more than `maxBytes`. */
export async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      onOverflow();
      return text + "\n[saída truncada]";
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
