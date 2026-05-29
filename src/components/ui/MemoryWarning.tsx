export function MemoryWarning() {
  return (
    <div className="mt-3 rounded-doodle border-2 border-warn/30 bg-warn/10 p-3">
      <p className="text-xs font-extrabold text-warn">Large File Warning</p>
      <p className="mt-1 text-xs leading-relaxed text-warn/80">
        This file exceeds 500 MB and may cause browser tab crashes due to
        WebAssembly memory limits. Consider using the Compress or Resize tools
        first to reduce the processing load.
      </p>
    </div>
  );
}
