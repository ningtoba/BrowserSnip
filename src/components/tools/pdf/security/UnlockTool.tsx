import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';

export function UnlockTool() {
  const { process } = usePDFEngine();
  const [password, setPassword] = useState('');

  const handleProcess = useCallback(() => {
    if (!password) return;
    process({ toolId: 'unlock', params: { password } });
  }, [process, password]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Unlock PDF</motion.p>
      <motion.div variants={scaleIn} className="rounded-[12px] border border-accent/20 bg-accent/[0.06] p-2.5">
        <p className="text-[10px] text-ink-soft">
          You must provide the correct password. This tool cannot bypass encryption — it only removes password protection when you already know the password.
        </p>
      </motion.div>
      <input type="password" value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Enter PDF password" className="doodle-input" />
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn" disabled={!password}>
        Unlock PDF
      </button>
    </motion.div>
  );
}
