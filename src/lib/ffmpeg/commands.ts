import type {
  TrimParams,
  ResizeParams,
  CropParams,
  CompressParams,
  GifParams,
  AudioParams,
  SpeedParams,
} from '@/types';
import { calculateBitrate } from '@/lib/utils/bitrate';
import { formatTime } from '@/lib/utils/time';

export function trimCommand(
  inputName: string,
  outputName: string,
  params: TrimParams
): string[] {
  const start = formatTime(params.startTime);
  const duration = formatTime(params.endTime - params.startTime);

  if (params.mode === 'lossless') {
    // Input seeking: -ss before -i seeks to nearest keyframe before the cut
    // point so the first copied packet is a proper I-frame. Uses -t (duration)
    // for reliable stream copy segment length.
    return [
      '-ss', start,
      '-i', inputName,
      '-t', duration,
      '-c', 'copy',
      outputName,
    ];
  }
  // Accurate: input seeking + re-encode at CRF 18 (visually lossless).
  // The re-encode generates a proper I-frame at exactly the cut point.
  return [
    '-ss', start,
    '-i', inputName,
    '-t', duration,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
    '-c:a', 'aac',
    outputName,
  ];
}

export function resizeCommand(
  inputName: string,
  outputName: string,
  params: ResizeParams
): string[] {
  return [
    '-i', inputName,
    '-vf', `scale=${params.width}:${params.height}`,
    '-c:v', 'libx264', '-crf', '23',
    '-c:a', 'aac',
    outputName,
  ];
}

export function cropCommand(
  inputName: string,
  outputName: string,
  params: CropParams
): string[] {
  if (params.mode === 'pad') {
    const [w, h] = params.aspectRatio.split(':').map(Number);
    const targetW = 1080;
    const targetH = Math.round(1080 * (h / w));
    return [
      '-i', inputName,
      '-vf',
      `split[original][copy];[copy]scale=${targetW}:${targetH},boxblur=20:20[blurred];[blurred][original]overlay=(W-w)/2:(H-h)/2`,
      '-c:v', 'libx264', '-crf', '23',
      '-c:a', 'aac',
      outputName,
    ];
  }

  const [w, h] = params.aspectRatio.split(':').map(Number);
  return [
    '-i', inputName,
    '-vf', `crop=ih*${w}/${h}:ih`,
    '-c:v', 'libx264', '-crf', '23',
    '-c:a', 'aac',
    outputName,
  ];
}

export function compressCommand(
  inputName: string,
  outputName: string,
  params: CompressParams,
  duration: number
): string[] {
  const bitrate = calculateBitrate(params.targetSizeMB, duration);
  const bufsize = bitrate * 2;

  return [
    '-i', inputName,
    '-b:v', `${Math.round(bitrate)}k`,
    '-bufsize', `${Math.round(bufsize)}k`,
    '-c:a', 'aac', '-b:a', '128k',
    outputName,
  ];
}

export function gifCommand(
  inputName: string,
  outputName: string,
  params: GifParams
): string[] {
  const start = formatTime(params.startTime);
  const dur = formatTime(params.duration);

  return [
    '-ss', start, '-t', dur,
    '-i', inputName,
    '-vf',
    `fps=${params.fps},scale=${params.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
    outputName,
  ];
}

export function audioCommand(
  inputName: string,
  outputName: string,
  params: AudioParams
): string[] {
  switch (params.mode) {
    case 'mute':
      return ['-i', inputName, '-an', '-c:v', 'copy', outputName];
    case 'extract':
      return ['-i', inputName, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', outputName];
    case 'volume':
      return [
        '-i', inputName,
        '-af', `volume=${params.volume}`,
        '-c:v', 'libx264', '-crf', '23',
        '-c:a', 'aac',
        outputName,
      ];
  }
}

export function speedCommand(
  inputName: string,
  outputName: string,
  params: SpeedParams
): string[] {
  const ptsFactor = (1 / params.speed).toFixed(1);
  const atempo = params.speed.toFixed(1);

  return [
    '-i', inputName,
    '-vf', `setpts=${ptsFactor}*PTS`,
    '-af', `atempo=${atempo}`,
    '-c:v', 'libx264', '-crf', '23',
    '-c:a', 'aac',
    outputName,
  ];
}

export function metadataCommand(inputName: string, outputName: string): string[] {
  return ['-i', inputName, '-map_metadata', '-1', '-c', 'copy', outputName];
}

export function concatCommand(
  inputFiles: string[],
  outputName: string
): string[] {
  const listName = 'concat_list.txt';
  const fileList = inputFiles.map((f) => `file '${f}'`).join('\n');
  return {
    args: ['-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', outputName],
    listName,
    listContent: fileList,
  } as unknown as string[];
}

export function buildConcatArgs(
  inputFiles: string[],
  outputName: string
): { args: string[]; listName: string; listContent: string } {
  const listName = 'concat_list.txt';
  const fileList = inputFiles.map((f) => `file '${f}'`).join('\n');
  return {
    args: ['-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', outputName],
    listName,
    listContent: fileList,
  };
}
