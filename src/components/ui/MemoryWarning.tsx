export function MemoryWarning() {
  return (
    <div className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
      <p className="text-xs font-medium text-yellow-300">Large File Warning</p>
      <p className="mt-1 text-xs leading-relaxed text-yellow-400/70">
        This file exceeds 500 MB and may cause browser tab crashes due to
        WebAssembly memory limits. Consider using the Compress or Resize tools
        first to reduce the processing load.
      </p>
    </div>
  );
}
