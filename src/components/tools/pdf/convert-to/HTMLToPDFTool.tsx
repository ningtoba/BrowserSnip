import { useState, useCallback, useRef } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

const EXAMPLE_HTML = `<h1>Hello World</h1>
<p>This is a <strong>sample</strong> document.</p>
<ul>
  <li>Item one</li>
  <li>Item two</li>
</ul>`;

export function HTMLToPDFTool() {
  const { process } = usePDFEngine();
  const [htmlContent, setHtmlContent] = useState(EXAMPLE_HTML);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleProcess = useCallback(() => {
    process({ toolId: 'html-to-pdf', params: { html: htmlContent } });
  }, [process, htmlContent]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      setHtmlContent(reader.result as string);
    };
    reader.readAsText(f);
    e.target.value = '';
  }, []);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">HTML to PDF</p>

      <div className="flex items-center gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="doodle-chip doodle-chip-inactive text-[10px]"
        >
          Upload .html file
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".html,.htm,text/html"
          onChange={handleFileUpload}
          className="hidden"
        />
        {fileName && (
          <span className="text-[10px] text-ink-muted truncate">{fileName}</span>
        )}
      </div>

      <textarea
        value={htmlContent}
        onChange={(e) => setHtmlContent(e.target.value)}
        placeholder="<h1>Hello World</h1><p>Paste HTML content here...</p>"
        className="doodle-input h-48 resize-y font-mono text-[11px]"
        spellCheck={false}
      />

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Convert HTML to PDF
      </button>
    </div>
  );
}
