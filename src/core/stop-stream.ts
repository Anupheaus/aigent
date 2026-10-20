/** Asks an abandoned stream to finish. Not awaited: a stream stuck mid-await may never complete `return()`. */
export function stopStream<T>(iterator: AsyncIterator<T>): void {
  Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => undefined); // the stream is being abandoned; its clean-up errors have nowhere useful to go
}
