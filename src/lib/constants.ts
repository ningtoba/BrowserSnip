import { PDF_TOOLS, PDF_CATEGORIES } from '@/lib/pdf/tools/registry';
import type { ToolCategoryDefinition, ToolDefinition } from '@/types';

/**
 * Video tools are declared here; the PDF catalogue lives in
 * `src/lib/pdf/tools/` and is derived below. Previously every PDF tool had to be
 * written twice — once in this file and once in `ToolWorkspace.tsx` — which is
 * how tools ended up registered with no component, or implemented with no card.
 */
const VIDEO_TOOLS: ToolDefinition[] = [
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
];

export const TOOL_CATEGORIES: ToolCategoryDefinition[] = [
  { id: 'video', label: 'Video Tools', icon: '🎬' },
  ...PDF_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    icon: category.icon,
  })),
];

export const TOOLS: ToolDefinition[] = [
  ...VIDEO_TOOLS,
  ...PDF_TOOLS.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    icon: tool.icon,
    category: tool.category,
    multiFile: tool.multiFile,
  })),
];

export const VIDEO_TOOL_COUNT = VIDEO_TOOLS.length;
export const PDF_TOOL_COUNT = PDF_TOOLS.length;

export function categoryBlurb(id: ToolCategoryDefinition['id']): string {
  return PDF_CATEGORIES.find((category) => category.id === id)?.blurb ?? 'Everything runs in this tab.';
}
