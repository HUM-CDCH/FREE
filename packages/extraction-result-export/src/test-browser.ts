/** Minimal browser double for the download path. Tests only. */
export function stubBrowser() {
  const downloads: { blob: Blob; filename: string }[] = [];
  const blobs = new Map<string, Blob>();
  const original = {
    document: globalThis.document,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { append: () => undefined },
      createElement: () => ({
        href: "",
        download: "",
        hidden: false,
        remove: () => undefined,
        click(this: { href: string; download: string }) {
          downloads.push({ blob: blobs.get(this.href)!, filename: this.download });
        },
      }),
    },
  });
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => undefined;

  return {
    downloads,
    restore() {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: original.document,
      });
      URL.createObjectURL = original.createObjectURL;
      URL.revokeObjectURL = original.revokeObjectURL;
    },
  };
}
