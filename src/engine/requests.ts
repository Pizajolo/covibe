// Work requests between members. A member with can_request may ask a teammate
// to do something for it (request_work): the teammate runs a turn of its own,
// even when it has no workflow step, its changes are committed and merged, and
// its reply is the tool's answer. Asking is optional; the workflow does not
// depend on it.

export const REQUEST_TOOL = 'request_work';

export function requestPrompt(p: { goal: string; from: string; to: string; request: string; context?: string; messages: { from: string; text: string }[] }): string {
  return [
    `# Goal\n${p.goal}`,
    `# Request from ${p.from}\n${p.request}`,
    ...(p.context ? [`## Context from ${p.from}\n${p.context}`] : []),
    ...(p.messages.length ? [`## Messages\n${p.messages.map((m) => `- from ${m.from}: ${m.text}`).join('\n')}`] : []),
    `${p.from} is waiting for you before it continues. Do what is asked, within your role and the files you may change; covibe commits and merges your changes when you finish, so ${p.from} sees them. Then reply with what you did: the files you created or changed and what ${p.from} needs to know to use them. If you cannot do it, or only part of it, say so and why.`,
  ].join('\n\n');
}

/**
 * Who waits on whom while requests are open, so two members never wait on
 * each other (each would hold its turn until the other finished).
 */
export class RequestChains {
  private readonly waitsFor = new Map<string, string>();

  /** The chain `to` waits on, if it leads back to `from`; undefined when asking is safe. */
  cycle(from: string, to: string): string[] | undefined {
    const chain = [to];
    for (let at: string | undefined = to; at; at = this.waitsFor.get(at)) {
      if (at === from) return chain;
      if (at !== to) chain.push(at);
      if (chain.length > 64) break;
    }
    return undefined;
  }

  /** `from` now waits on `to`; call the result once the request is done. */
  wait(from: string, to: string): () => void {
    this.waitsFor.set(from, to);
    return () => {
      if (this.waitsFor.get(from) === to) this.waitsFor.delete(from);
    };
  }
}
