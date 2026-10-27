import jsonata from 'jsonata';

/**
 * Evaluate a JSONata expression against the run context. Gates, task
 * selectors and feed entries all go through here: the engine, never a model,
 * decides what they mean.
 */
export async function evaluate(expr: string, context: unknown): Promise<unknown> {
  const result = await jsonata(expr).evaluate(context);
  // JSONata returns arrays with extra "sequence" markers; normalise to plain JSON.
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
}

/** Gates pass only on a literal `true`; anything else (false, missing field, a number) fails. */
export async function evaluateGate(expr: string, context: unknown): Promise<{ passed: boolean; value: unknown }> {
  const value = await evaluate(expr, context);
  return { passed: value === true, value };
}
