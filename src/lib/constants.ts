import type { ToolDefinition } from '@/types';

export const TOOLS: ToolDefinition[] = [
  {
    id: 'trim',
    name: 'Trim & Cut',
    description: 'Instant trim via stream copy — no re-encoding, preserves original quality and bitrate',
    icon: '✂',
  },
  {
    id: 'resize',
    name: 'Resize',
    description: 'Scale video to standard resolutions with aspect ratio lock',
    icon: '↔',
  },
  {
    id: 'crop',
    name: 'Crop & Reframe',
    description: 'Crop to social media aspect ratios (9:16, 1:1, 21:9)',
    icon: '⊞',
  },
  {
    id: 'compress',
    name: 'Compress',
    description: 'Target specific file sizes for Discord, Slack, or email limits',
    icon: '↓',
  },
  {
    id: 'gif',
    name: 'GIF Converter',
    description: 'Convert short clips to high-quality looping GIFs with palette optimization',
    icon: '◉',
  },
  {
    id: 'audio',
    name: 'Audio Tools',
    description: 'Mute, extract MP3, or adjust volume (0%–300%)',
    icon: '♪',
  },
  {
    id: 'speed',
    name: 'Speed Control',
    description: 'Create timelapse or slow-motion (0.25× to 4.0×)',
    icon: '⏱',
  },
  {
    id: 'metadata',
    name: 'Privacy Purge',
    description: 'Strip all metadata, location tags, and creation markers instantly',
    icon: '🛡',
  },
];
