// A small Markdown renderer for notes and skills: headings, lists, code,
// quotes, emphasis, links. Text is escaped first; no raw HTML gets through.
import { useMemo } from 'react';

function escape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string): string {
  return escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flush();
      close();
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i]!);
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    const oli = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      close();
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
    } else if (li || oli) {
      flush();
      const kind = li ? 'ul' : 'ol';
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((li ?? oli)![1]!)}</li>`);
    } else if (/^>\s?/.test(line)) {
      flush();
      close();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (!line.trim()) {
      flush();
      close();
    } else {
      close();
      para.push(line.trim());
    }
  }
  flush();
  close();
  return out.join('\n');
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
