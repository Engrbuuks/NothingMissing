/**
 * One attribute rendered as the right kind of input.
 *
 * A choice is a select, a boolean is a checkbox, a dimension is a number with
 * its unit shown beside it. This is the whole reason attributes are typed:
 * a text box asking for "memory" gets "8gb", "8 GB", "8192MB" and "eight".
 */
export function AttrField({
  code, label, kind, unit, choices, required, value, help,
}: {
  code: string;
  label: string;
  kind: string;
  unit?: string | null;
  choices?: string[] | null;
  required?: boolean;
  value?: string | null;
  help?: string | null;
}) {
  const name = `attr_${code}`;
  const id = `f_${code}`;

  return (
    <div>
      <label className="lbl" htmlFor={id}>
        {label}
        {required && <span style={{ color: 'var(--bad)' }}> *</span>}
      </label>

      {kind === 'choice' ? (
        <select className="inp" id={id} name={name} defaultValue={value ?? ''} required={required}>
          <option value="">Not recorded</option>
          {(choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : kind === 'boolean' ? (
        <select className="inp" id={id} name={name} defaultValue={value === 'Yes' ? 'yes' : value === 'No' ? 'no' : ''}>
          <option value="">Not recorded</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      ) : kind === 'number' || kind === 'dimension' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input className="inp" id={id} name={name} type="number" step="any"
                 defaultValue={value ?? ''} required={required} style={{ flex: 1 }} />
          {unit && <span className="mono" style={{ fontSize: 13, color: 'var(--text-3)', flex: 'none' }}>{unit}</span>}
        </div>
      ) : (
        <input className="inp" id={id} name={name} defaultValue={value ?? ''} required={required} />
      )}

      {help && <div className="hint">{help}</div>}
    </div>
  );
}
