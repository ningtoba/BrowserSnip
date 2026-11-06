/** Ambient types for `mammoth/mammoth.browser`, which ships JavaScript only. */
declare module 'mammoth/mammoth.browser' {
  interface MammothImage {
    src: string;
    altText?: string | null;
  }

  interface MammothResult {
    value: string;
    messages: { type: string; message: string }[];
  }

  interface MammothOptions {
    convertImage?: unknown;
    styleMap?: string | string[];
    includeDefaultStyleMap?: boolean;
    ignoreEmptyParagraphs?: boolean;
  }

  interface Mammoth {
    convertToHtml(
      input: { arrayBuffer: ArrayBuffer },
      options?: MammothOptions,
    ): Promise<MammothResult>;
    convertToMarkdown(
      input: { arrayBuffer: ArrayBuffer },
      options?: MammothOptions,
    ): Promise<MammothResult>;
    extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
    imgElement: {
      attributes(
        value:
          | Record<string, string | null | undefined>
          | ((image: MammothImage) => Record<string, string | null | undefined>),
      ): unknown;
      inline(): unknown;
    };
    images: { inline: unknown; dataUri: unknown };
  }

  const mammoth: Mammoth;
  export default mammoth;
}
