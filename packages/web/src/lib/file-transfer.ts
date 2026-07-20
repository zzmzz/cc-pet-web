/** Helpers for pulling File objects out of drag-and-drop / clipboard events. */

/** Collect File objects from a drag or clipboard DataTransfer. */
export function extractFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  if (out.length === 0 && dt.files && dt.files.length > 0) {
    out.push(...Array.from(dt.files));
  }
  return out;
}

/** True if a drag payload carries files (vs. plain text/html). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

/** Pasted screenshots arrive as anonymous `image.png`; give them a unique, descriptive name. */
export function normalizePastedFile(file: File, index: number): File {
  const hasRealName = !!file.name && !/^image\.\w+$/i.test(file.name);
  if (hasRealName) return file;
  const ext = (file.type.split("/")[1] || "png").replace("+xml", "");
  const name = `pasted-${Date.now()}${index ? `-${index}` : ""}.${ext}`;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}
