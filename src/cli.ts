#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 22. Silence that one
// warning before anything loads it; other warnings go to stderr as usual.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import('./main.js');
process.exitCode = await main(process.argv.slice(2));
