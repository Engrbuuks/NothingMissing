'use client';

import { useRef, useState } from 'react';

/**
 * Choosing a .csv instead of pasting.
 *
 * The import has always taken pasted text, which is fine when the spreadsheet
 * is already open and hopeless when somebody has been emailed a file. The file
 * is read in the browser and dropped into the same paste box, so everything
 * downstream is unchanged: the same parser, the same preview, the same commit.
 * Nothing is uploaded anywhere. The file never leaves the machine except as the
 * rows the person then confirms.
 */
export default function CsvFile({ target }: { target: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [bad, setBad] = useState(false);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setBad(false);
    setNote(null);

    // A spreadsheet saved as .xlsx is a zip, not text. Reading it would fill
    // the box with binary and the parser would report nonsense about headers,
    // so say the real thing instead.
    const looksBinary = /\.(xlsx|xls|numbers|ods)$/i.test(file.name);
    if (looksBinary) {
      setBad(true);
      setName(file.name);
      setNote('That is a spreadsheet file, not a CSV. In Excel or Google Sheets choose File, then Download or Save As, then CSV.');
      e.target.value = '';
      return;
    }

    const text = await file.text();

    const box = document.querySelector<HTMLTextAreaElement>(`textarea[name="${target}"]`);
    if (!box) return;

    // Strip a UTF-8 byte order mark. Excel writes one, and left in place it
    // becomes part of the first header, so "Name" arrives as "﻿Name" and
    // matches nothing. Our own export writes one too, which would make a round
    // trip through this importer fail on its own file.
    box.value = text.replace(/^﻿/, '').trim();
    box.dispatchEvent(new Event('input', { bubbles: true }));

    const lines = box.value.split(/\r?\n/).filter((l) => l.trim());
    setName(file.name);
    setNote(
      lines.length < 2
        ? 'That file has no rows under its header line.'
        : `${lines.length - 1} row${lines.length - 1 === 1 ? '' : 's'} loaded. Check them below, then preview.`,
    );
    setBad(lines.length < 2);
  }

  return (
    <div className="csvpick">
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={onPick}
        style={{ display: 'none' }}
      />
      <button type="button" className="btn btn-g" onClick={() => input.current?.click()}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 9l5-5 5 5M12 4v12" />
        </svg>
        Choose a CSV file
      </button>
      {name && (
        <span className={bad ? 'csvpick-n bad' : 'csvpick-n'}>
          <b>{name}</b>
          {note ? ` ${note}` : ''}
        </span>
      )}
      {!name && <span className="csvpick-n">or paste the rows below</span>}
    </div>
  );
}
