// Runs inside the page (main world). It reads the page as a member sees it in
// a snapshot: headings, text and the things you can interact with, each
// interactive element numbered ([12] button "Sign in") so the member can say
// "click 12". Numbers stay the same across snapshots while the element is on
// the page. Kept as plain JavaScript text: it is evaluated in the browser, not
// bundled.
export const PAGE_SCRIPT = String.raw`(() => {
  const KEY = Symbol.for('covibe.browser');
  if (window[KEY]) return window[KEY];
  const ids = new WeakMap();
  const refs = new Map();
  let next = 1;
  const refOf = (el) => {
    let id = ids.get(el);
    if (!id) { id = next++; ids.set(el, id); }
    refs.set(id, new WeakRef(el));
    return id;
  };
  const clip = (s, n) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const q = (s) => JSON.stringify(s);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);
  const LANDMARK = { NAV: 'nav', HEADER: 'header', MAIN: 'main', FOOTER: 'footer', ASIDE: 'aside', FORM: 'form', DIALOG: 'dialog' };
  const ROLE_LANDMARK = new Set(['navigation', 'banner', 'main', 'contentinfo', 'complementary', 'form', 'dialog', 'alertdialog', 'search', 'region']);
  const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'spinbutton', 'treeitem', 'file', 'clickable', 'date', 'time', 'datetime-local', 'month', 'week', 'color']);
  const TEXT_INPUT = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', '']);

  const roleOf = (el, style) => {
    const r = el.getAttribute('role');
    if (r) return r.trim().split(/\s+/)[0];
    const t = el.tagName;
    if (t === 'A' && el.hasAttribute('href')) return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'file') return 'file';
      if (ty === 'search') return 'searchbox';
      if (TEXT_INPUT.has(ty)) return 'textbox';
      return ty;
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (t === 'IMG') return 'img';
    if (t === 'IFRAME') return 'iframe';
    // Divs and spans made clickable with script.
    const tab = el.getAttribute('tabindex');
    if (el.hasAttribute('onclick') || (tab !== null && Number(tab) >= 0)) return 'clickable';
    if (style.cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') && t !== 'LABEL' && t !== 'svg') return 'clickable';
    return null;
  };

  /** A label's own words, without the text of the control inside it (a select's options). */
  const labelText = (label, control) => {
    const out = [];
    const walk = (n) => {
      if (n === control) return;
      if (n.nodeType === 3) out.push(n.data);
      else if (n.nodeType === 1 && !SKIP.has(n.tagName) && !(n.contains && n.contains(control))) out.push(n.innerText || n.textContent || '');
      else for (const c of n.childNodes) walk(c);
    };
    for (const c of label.childNodes) walk(c);
    return out.join(' ');
  };

  /** Whether a label names a control the snapshot lists (its text is that control's name). */
  const labelsControl = (el) => {
    const c = el.control;
    return !!c && c.type !== 'hidden';
  };

  const nameOf = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const s = lb.split(/\s+/).map((id) => { const x = document.getElementById(id); return x ? x.innerText || x.textContent : ''; }).join(' ');
      if (s.trim()) return s;
    }
    const t = el.tagName;
    if ((t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') && el.labels && el.labels.length) return Array.from(el.labels).map((l) => labelText(l, el)).join(' ');
    if (t === 'IMG') return el.alt || el.title || '';
    if (t === 'INPUT') {
      const ty = (el.type || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(ty)) return el.value || ty;
      if (ty === 'image') return el.alt || 'submit';
      return el.placeholder || el.title || el.name || '';
    }
    if (t === 'TEXTAREA' || t === 'SELECT') return el.placeholder || el.title || el.name || '';
    const text = el.innerText;
    if (text && text.trim()) return text;
    const img = el.querySelector && el.querySelector('img[alt], svg[aria-label], [title]');
    return el.title || (img && (img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title'))) || '';
  };

  const shortHref = (a) => {
    try {
      const u = new URL(a.href, location.href);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
    } catch { return a.getAttribute('href') || ''; }
  };

  const describeInteractive = (el, role, id) => {
    let line = '[' + id + '] ' + role;
    const name = clip(nameOf(el), 80);
    if (name) line += ' ' + q(name);
    const t = el.tagName;
    if (role === 'link') line += ' → ' + clip(shortHref(el), 120);
    if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton') {
      const value = t === 'INPUT' || t === 'TEXTAREA' ? el.value : el.innerText;
      if (t === 'INPUT' && el.type === 'password') line += value ? ' value="••••"' : ' value=""';
      else line += ' value=' + q(clip(value, 120));
      if (el.placeholder && el.placeholder !== nameOf(el)) line += ' placeholder=' + q(clip(el.placeholder, 60));
      if (t === 'INPUT' && el.type && !['text', 'search'].includes(el.type)) line += ' type=' + el.type;
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const checked = t === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
      line += checked ? ' checked' : ' unchecked';
    }
    if (t === 'SELECT') {
      const opts = Array.from(el.options);
      const sel = opts.filter((o) => o.selected).map((o) => clip(o.label, 40));
      line += ' value=' + q(sel.join(', '));
      line += ' options: ' + opts.slice(0, 15).map((o) => clip(o.label, 30)).join(' | ') + (opts.length > 15 ? ' | … (' + opts.length + ')' : '');
    }
    if (role === 'slider' && t === 'INPUT') line += ' value=' + q(el.value) + ' min=' + el.min + ' max=' + el.max;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
    const exp = el.getAttribute('aria-expanded');
    if (exp) line += exp === 'true' ? ' expanded' : ' collapsed';
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) line += ' selected';
    if (document.activeElement === el) line += ' focused';
    return line;
  };

  const snapshot = (opts) => {
    opts = opts || {};
    const max = opts.maxChars || 8000;
    const lines = [];
    let buf = [];
    let visited = 0;
    const flush = () => {
      const s = clip(buf.join(' '), 300);
      if (s) lines.push(s);
      buf = [];
    };
    const visit = (node, inside, hiddenVis) => {
      if (visited > 8000) return;
      if (node.nodeType === 3) {
        if (!inside && !hiddenVis) { const s = node.data; if (s.trim()) buf.push(s); }
        return;
      }
      if (node.nodeType !== 1) {
        if (node.nodeType === 11) for (const c of node.childNodes) visit(c, inside, hiddenVis);
        return;
      }
      const el = node;
      if (SKIP.has(el.tagName)) return;
      visited++;
      const style = getComputedStyle(el);
      if (style.display === 'none') return;
      const hidden = hiddenVis || style.visibility === 'hidden' || style.visibility === 'collapse';
      const block = style.display !== 'contents' && !style.display.startsWith('inline');
      const rect = el.getBoundingClientRect();
      const boxless = rect.width === 0 && rect.height === 0 && style.display !== 'contents';
      const role = roleOf(el, style);
      const showable = !hidden && !boxless && Number(style.opacity) !== 0;
      if (block) flush();

      const landmark = LANDMARK[el.tagName] || (ROLE_LANDMARK.has(el.getAttribute('role')) ? el.getAttribute('role') : null);
      if (landmark && showable && (el.tagName !== 'DIALOG' || el.open)) {
        const label = el.getAttribute('aria-label') || '';
        lines.push('— ' + landmark + (label ? ' ' + q(clip(label, 60)) : ''));
      }

      if (role && INTERACTIVE.has(role) && (showable || (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels.length))) {
        if (!(role === 'clickable' && !nameOf(el).trim())) {
          flush();
          lines.push(describeInteractive(el, role, refOf(el)));
          // Its own text is its name; still look inside for nested controls.
          for (const c of el.childNodes) visit(c, true, hidden);
          if (el.shadowRoot) visit(el.shadowRoot, true, hidden);
          if (block) flush();
          return;
        }
      }
      if (role === 'heading' && showable && !inside) {
        flush();
        const level = Number(el.getAttribute('aria-level')) || Number(el.tagName.slice(1)) || 2;
        const text = clip(el.innerText, 200);
        if (text) lines.push('#'.repeat(Math.min(level, 6)) + ' ' + text);
        for (const c of el.childNodes) visit(c, true, hidden);
        return;
      }
      if (role === 'img' && showable && !inside) {
        const alt = clip(nameOf(el), 100);
        if (alt) { flush(); lines.push('img ' + q(alt)); }
        return;
      }
      if (role === 'iframe' && showable) {
        flush();
        lines.push('iframe ' + clip(el.getAttribute('title') || el.src || '', 100) + ' (not inspected; open its address to see it)');
        return;
      }
      if (el.tagName === 'TR' && showable && !inside) {
        flush();
        const cells = Array.from(el.cells).map((c) => clip(c.innerText, 60));
        if (cells.some(Boolean)) lines.push('| ' + cells.join(' | ') + ' |');
        // Cells' text is in the row; look inside only for controls.
        for (const c of el.childNodes) visit(c, true, hidden);
        return;
      }
      if (el.tagName === 'LI' && !inside && !hidden) { flush(); buf.push('-'); }
      // A label's words are its control's name; only look inside it for the control.
      const quiet = inside || (el.tagName === 'LABEL' && labelsControl(el));
      for (const c of el.childNodes) visit(c, quiet, hidden);
      if (el.shadowRoot) visit(el.shadowRoot, quiet, hidden);
      if (block) flush();
    };
    if (document.body) visit(document.body, false, false);
    flush();
    // Drop list markers left without text.
    let all = lines.filter((l) => l !== '-');
    if (opts.query) {
      const needle = String(opts.query).toLowerCase();
      all = all.filter((l) => l.toLowerCase().includes(needle));
    }
    let out = '';
    let shown = 0;
    for (const l of all) {
      if (out.length + l.length + 1 > max) break;
      out += l + '\n';
      shown++;
    }
    return { text: out, shown, total: all.length, truncated: shown < all.length, scroll: scrollInfo(), visited };
  };

  const scrollInfo = () => {
    const d = document.documentElement;
    return { x: Math.round(scrollX), y: Math.round(scrollY), width: d ? d.scrollWidth : 0, height: d ? d.scrollHeight : 0, vw: innerWidth, vh: innerHeight };
  };

  const describe = (el) => {
    if (!el) return 'nothing';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/)[0];
    const text = clip(el.innerText || el.getAttribute('aria-label') || '', 40);
    return text ? s + ' ' + q(text) : s;
  };

  const element = (id) => {
    const w = refs.get(id);
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  };

  /** Scroll an element into view and say where to click it. */
  const locate = (id) => {
    let el = element(id);
    if (!el) return { error: '[' + id + '] is not on the page any more. Take a new snapshot.' };
    let target = el;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    let r = el.getClientRects()[0] || el.getBoundingClientRect();
    // A visually hidden checkbox or radio is clicked through its label.
    if ((!r || r.width < 2 || r.height < 2 || getComputedStyle(el).opacity === '0') && el.labels && el.labels.length) {
      target = el.labels[0];
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = target.getClientRects()[0] || target.getBoundingClientRect();
    }
    if (!r || (r.width === 0 && r.height === 0)) return { error: '[' + id + '] ' + describe(el) + ' has no size on the page (hidden?).' };
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (target.contains(hit) || hit === target || (el.labels && Array.from(el.labels).some((l) => l.contains(hit))));
    return { x, y, element: describe(el), covered: ok ? null : describe(hit) };
  };

  const focused = (id) => {
    const el = element(id);
    if (!el) return false;
    const a = document.activeElement;
    if (a === el || (a && el.contains(a))) return true;
    el.focus();
    return document.activeElement === el;
  };

  /** Select an editable element's content, so typed text replaces it. */
  const selectAll = (id) => {
    const el = element(id);
    if (!el) return false;
    if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { el.focus(); el.select(); return true; }
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    return false;
  };

  const selectOption = (id, value) => {
    const el = element(id);
    if (!el) return { error: '[' + id + '] is not on the page any more. Take a new snapshot.' };
    if (el.tagName !== 'SELECT') return { error: '[' + id + '] ' + describe(el) + ' is not a drop-down (select); click it instead.' };
    const want = String(value);
    const opts = Array.from(el.options);
    const o = opts.find((x) => x.value === want) || opts.find((x) => x.label.trim() === want) || opts.find((x) => x.label.trim().toLowerCase().includes(want.toLowerCase()));
    if (!o) return { error: 'no option ' + q(want) + ' in [' + id + ']. Options: ' + opts.map((x) => x.label.trim()).join(' | ') };
    // The native setter, so frameworks that track the value see the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, o.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: o.label.trim() };
  };

  const api = { snapshot, locate, focused, selectAll, selectOption, scrollInfo, element, describe };
  Object.defineProperty(window, KEY, { value: api });
  return api;
})()`;

/** Calls a function of the page script, installing it first if this page has not got it yet. */
export function pageCall(fn: string, ...args: unknown[]): string {
  return `(${PAGE_SCRIPT}).${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

/**
 * Added to every page before its own scripts: alert, confirm and prompt would
 * block a page nobody is looking at, so they answer at once and leave a note
 * in the console instead.
 */
export const DIALOG_SCRIPT = `(() => {
  const note = (kind, msg) => console.info('[dialog] ' + kind + ': ' + String(msg == null ? '' : msg));
  window.alert = (m) => { note('alert', m); };
  window.confirm = (m) => { note('confirm (answered OK)', m); return true; };
  window.prompt = (m, d) => { note('prompt (answered with its default)', m); return d == null ? '' : String(d); };
})()`;
