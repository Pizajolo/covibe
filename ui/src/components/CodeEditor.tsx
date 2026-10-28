import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { bracketMatching, defaultHighlightStyle, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as ph } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#ff7ab2' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: '#6bdfff' },
  { tag: [tags.string, tags.special(tags.string)], color: '#ff8170' },
  { tag: tags.number, color: '#d9c97c' },
  { tag: tags.bool, color: '#ff7ab2' },
  { tag: tags.comment, color: '#7f8c98', fontStyle: 'italic' },
  { tag: tags.heading, color: '#ffffff', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.link, color: '#6bdfff' },
  { tag: tags.monospace, color: '#ff8170' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-content': { fontFamily: 'var(--mono)', padding: '10px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-3)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'rgba(127,127,127,.07)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(127,127,127,.1)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-placeholder': { color: 'var(--text-3)' },
});

export function CodeEditor({
  value,
  onChange,
  language,
  onSave,
  minHeight = 200,
  placeholder,
  lineNumbers: showLines = true,
  readOnly = false,
}: {
  value: string;
  onChange?: (v: string) => void;
  language: 'yaml' | 'markdown' | 'json' | 'text';
  onSave?: () => void;
  minHeight?: number;
  placeholder?: string;
  lineNumbers?: boolean;
  /** Show the text without letting it be edited. */
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const lang: Extension[] = language === 'yaml' ? [yaml()] : language === 'markdown' ? [markdown()] : language === 'json' ? [yaml()] : [];
    const state = EditorState.create({
      doc: value,
      extensions: [
        showLines ? [lineNumbers(), highlightActiveLineGutter()] : [],
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(dark ? darkHighlight : defaultHighlightStyle),
        EditorView.lineWrapping,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (onSaveRef.current?.(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorState.tabSize.of(2),
        placeholder ? ph(placeholder) : [],
        theme,
        EditorView.theme({ '.cm-content, .cm-gutter': { minHeight: `${minHeight}px` } }),
        lang,
        readOnly ? EditorState.readOnly.of(true) : [],
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  // Replace the document when the value changes from outside (load, form edits).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} />;
}
