import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import type { ProtectParams } from '@/types';

export function ProtectTool() {
  const { process } = usePDFEngine();
  const [params, setParams] = useState<ProtectParams>({
    userPassword: '',
    ownerPassword: '',
    allowPrinting: true,
    allowCopying: true,
    allowModifying: false,
    allowAnnotating: true,
    allowFillingForms: true,
    allowAccessibility: true,
    allowAssembling: false,
    encryptionLevel: 'aes-128',
  });

  const update = <K extends keyof ProtectParams>(key: K, value: ProtectParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const handleProcess = useCallback(() => {
    if (!params.userPassword && !params.ownerPassword) return;
    process({ toolId: 'protect', params: params as unknown as Record<string, unknown> });
  }, [process, params]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Protect PDF</p>

      <input type="password" value={params.userPassword}
        onChange={(e) => update('userPassword', e.target.value)}
        placeholder="User password (to open)" className="doodle-input" />

      <input type="password" value={params.ownerPassword}
        onChange={(e) => update('ownerPassword', e.target.value)}
        placeholder="Owner password (for permissions)" className="doodle-input" />

      <div>
        <label className="text-[11px] font-medium text-ink-soft">Encryption</label>
        <div className="flex gap-1 mt-1">
          {(['aes-128', 'aes-256', 'rc4-128'] as const).map((e) => (
            <button key={e} onClick={() => update('encryptionLevel', e)}
              className={`doodle-chip text-[10px] ${params.encryptionLevel === e ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {e.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-ink-soft">Permissions</p>
        {([
          ['allowPrinting', 'Printing'],
          ['allowCopying', 'Copying'],
          ['allowModifying', 'Modifying'],
          ['allowAnnotating', 'Annotating'],
          ['allowFillingForms', 'Filling Forms'],
          ['allowAccessibility', 'Accessibility'],
          ['allowAssembling', 'Assembling'],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-[11px] text-ink-soft cursor-pointer">
            <input type="checkbox" checked={params[key]}
              onChange={(e) => update(key, e.target.checked)} />
            {label}
          </label>
        ))}
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn"
        disabled={!params.userPassword && !params.ownerPassword}>
        Encrypt PDF
      </button>
    </div>
  );
}
