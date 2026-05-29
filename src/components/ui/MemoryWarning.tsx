export function MemoryWarning() {
  return (
    <div className="mt-3 rounded-doodle-md border border-warn/20 bg-warn/5 p-3">
      <p className="text-[11px] font-semibold text-warn">Large File Warning</p>
      <p className="mt-1 text-[11px] leading-relaxed text-warn/80">
        This file exceeds 500 MB and may cause browser tab crashes due to
        WebAssembly memory limits. Consider using the Compress or Resize tools
        first to reduce the processing load.
      </p>
    </div>
  );
}
