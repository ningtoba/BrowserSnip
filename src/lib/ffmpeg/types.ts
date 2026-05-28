export interface FFmpegCommand {
  args: string[];
  inputFile: string;
  outputFile: string;
}

export type FFmpegLogLevel = 'info' | 'warning' | 'error' | 'debug';
