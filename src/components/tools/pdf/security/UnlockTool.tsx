import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function UnlockTool() {
  const { process } = usePDFEngine();
  const [password, setPassword] = useState('');

  const handleProcess = useCallback(() => {
    if (!password) return;
    process({ toolId: 'unlock', params: { password } });
  }, [process, password]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Unlock PDF</p>
      <div className="rounded bg-accent/5 border border-accent/20 p-2">
        <p className="text-[10px] text-ink-soft">
          You must provide the correct password. This tool cannot bypass encryption — it only removes password protection when you already know the password.
        </p>
      </div>
      <input type="password" value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Enter PDF password" className="doodle-input" />
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn" disabled={!password}>
        Unlock PDF
      </button>
    </div>
  );
}
