#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 22. Silence that one
// warning before anything loads it; other warnings go to stderr as usual.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// `covibe log | head` closes the pipe early; that is not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const { main } = await import('./main.js');
process.exitCode = await main(process.argv.slice(2));
// Apps members started (a chat after a run, say) end with covibe.
const { appHub } = await import('./apps/manager.js');
await appHub.shutdown();
