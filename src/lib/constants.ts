import type { ToolDefinition, ToolCategoryDefinition } from '@/types';

export const TOOL_CATEGORIES: ToolCategoryDefinition[] = [
  { id: 'video', label: 'Video Tools', icon: '🎬' },
  { id: 'organize', label: 'Organize PDF', icon: '📑' },
  { id: 'optimize', label: 'Optimize PDF', icon: '⚡' },
  { id: 'convert-to', label: 'Convert to PDF', icon: '📥' },
  { id: 'convert-from', label: 'Convert from PDF', icon: '📤' },
  { id: 'edit', label: 'Edit PDF', icon: '✏️' },
  { id: 'security', label: 'PDF Security', icon: '🔒' },
];

export const TOOLS: ToolDefinition[] = [
  // ── Video Tools ──
  {
    id: 'trim',
    name: 'Trim & Cut',
    description: 'Instant trim via stream copy — no re-encoding, preserves original quality and bitrate',
    icon: '✂',
    category: 'video',
  },
  {
    id: 'resize',
    name: 'Resize',
    description: 'Scale video to standard resolutions with aspect ratio lock',
    icon: '↔',
    category: 'video',
  },
  {
    id: 'crop',
    name: 'Crop & Reframe',
    description: 'Crop to social media aspect ratios (9:16, 1:1, 21:9)',
    icon: '⊞',
    category: 'video',
  },
  {
    id: 'compress',
    name: 'Compress',
    description: 'Target specific file sizes for Discord, Slack, or email limits',
    icon: '↓',
    category: 'video',
  },
  {
    id: 'gif',
    name: 'GIF Converter',
    description: 'Convert short clips to high-quality looping GIFs with palette optimization',
    icon: '◉',
    category: 'video',
  },
  {
    id: 'audio',
    name: 'Audio Tools',
    description: 'Mute, extract MP3, or adjust volume (0%–300%)',
    icon: '♪',
    category: 'video',
  },
  {
    id: 'speed',
    name: 'Speed Control',
    description: 'Create timelapse or slow-motion (0.25× to 4.0×)',
    icon: '⏱',
    category: 'video',
  },
  {
    id: 'metadata',
    name: 'Privacy Purge',
    description: 'Strip all metadata, location tags, and creation markers instantly',
    icon: '🛡',
    category: 'video',
  },

  // ── Organize PDF ──
  {
    id: 'merge',
    name: 'Merge PDF',
    description: 'Combine multiple PDFs into a single document with drag-and-drop ordering',
    icon: '📑',
    category: 'organize',
    multiFile: true,
  },
  {
    id: 'split',
    name: 'Split PDF',
    description: 'Extract pages by range, every page individually, or separate odd/even pages',
    icon: '✂️',
    category: 'organize',
  },
  {
    id: 'remove-pages',
    name: 'Remove Pages',
    description: 'Delete unwanted pages from your PDF with a visual page selector',
    icon: '🗑️',
    category: 'organize',
  },
  {
    id: 'extract-pages',
    name: 'Extract Pages',
    description: 'Pull out selected pages and save them as a new PDF',
    icon: '📤',
    category: 'organize',
  },
  {
    id: 'organize',
    name: 'Organize PDF',
    description: 'Drag-and-drop to reorder, insert blank pages, duplicate, or delete pages',
    icon: '📋',
    category: 'organize',
  },
  {
    id: 'rotate',
    name: 'Rotate PDF',
    description: 'Rotate individual pages or the entire document 90°, 180°, or 270°',
    icon: '🔄',
    category: 'organize',
  },
  {
    id: 'scan-to-pdf',
    name: 'Scan to PDF',
    description: 'Capture documents with your camera, with edge detection and perspective correction',
    icon: '📸',
    category: 'organize',
  },

  // ── Optimize PDF ──
  {
    id: 'pdf-compress',
    name: 'Compress PDF',
    description: 'Reduce file size with low, medium, or high compression while preserving quality',
    icon: '📦',
    category: 'optimize',
  },
  {
    id: 'repair',
    name: 'Repair PDF',
    description: 'Attempt to recover damaged or corrupted PDF files',
    icon: '🔧',
    category: 'optimize',
  },

  // ── Convert to PDF ──
  {
    id: 'image-to-pdf',
    name: 'Image to PDF',
    description: 'Convert JPG, PNG, WEBP, GIF, AVIF, or TIFF images to PDF',
    icon: '🖼️',
    category: 'convert-to',
    multiFile: true,
  },
  {
    id: 'digitize-document',
    name: 'Digitize Document',
    description: 'OCR a photo of a document into a clean, searchable digital PDF',
    icon: '📄',
    category: 'convert-to',
    multiFile: true,
  },
  {
    id: 'html-to-pdf',
    name: 'HTML to PDF',
    description: 'Convert HTML files or rendered web content to PDF',
    icon: '🌐',
    category: 'convert-to',
  },

  // ── Convert from PDF ──
  {
    id: 'pdf-to-image',
    name: 'PDF to Image',
    description: 'Export PDF pages as high-quality JPG, PNG, or WEBP images',
    icon: '🖼️',
    category: 'convert-from',
  },
  {
    id: 'pdf-to-word',
    name: 'PDF to Word',
    description: 'Extract text and structure from PDF into an editable format',
    icon: '📝',
    category: 'convert-from',
  },
  {
    id: 'pdf-to-excel',
    name: 'PDF to Excel',
    description: 'Extract tables from PDF into structured spreadsheet data',
    icon: '📊',
    category: 'convert-from',
  },
  {
    id: 'pdf-to-pdfa',
    name: 'PDF to PDF/A',
    description: 'Convert PDF to PDF/A format for long-term archival',
    icon: '🏛️',
    category: 'convert-from',
  },

  // ── Edit PDF ──
  {
    id: 'page-numbers',
    name: 'Page Numbers',
    description: 'Add custom page numbers with font, size, and position controls',
    icon: '🔢',
    category: 'edit',
  },
  {
    id: 'watermark',
    name: 'Add Watermark',
    description: 'Stamp text or image watermarks with opacity and rotation controls',
    icon: '💧',
    category: 'edit',
  },
  {
    id: 'pdf-crop',
    name: 'Crop PDF',
    description: 'Trim page margins with visual crop tool or precise numeric input',
    icon: '✂️',
    category: 'edit',
  },

  // ── PDF Security ──
  {
    id: 'protect',
    name: 'Protect PDF',
    description: 'Encrypt PDF with password and set permissions for printing, copying, and editing',
    icon: '🔐',
    category: 'security',
  },
  {
    id: 'unlock',
    name: 'Unlock PDF',
    description: 'Remove password protection from PDF (requires the correct password)',
    icon: '🔓',
    category: 'security',
  },
  {
    id: 'sign',
    name: 'Sign PDF',
    description: 'Add handwritten, image, or text signatures to your PDF documents',
    icon: '✍️',
    category: 'security',
  },
  {
    id: 'redact',
    name: 'Redact PDF',
    description: 'Permanently remove sensitive information — not just visual masking',
    icon: '🟦',
    category: 'security',
  },
  {
    id: 'compare',
    name: 'Compare PDF',
    description: 'Visually compare two PDFs side by side and highlight differences',
    icon: '🔍',
    category: 'security',
    multiFile: true,
  },
];
