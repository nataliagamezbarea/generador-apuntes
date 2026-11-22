import { createHash } from "node:crypto";
import {
  convertirLatexATextoPlano,
  normalizarTexto,
  obtenerTerminos,
  similitudJaccard,
} from "./utilidades-nombres.js";

export class IndiceConceptos {
  constructor() {
    this.titles = [];
    this.sentences = [];
    this.tokenSets = [];
    this.hashes = new Set();
  }

  addText(text) {
    const plain = convertirLatexATextoPlano(text);
    for (const sentence of plain.split(/(?<=[.!?;])\s+|\n+/)) {
      const trimmed = sentence.trim();
      const normalized = normalizarTexto(trimmed);
      if (normalized.length < 20 || trimmed.length < 25 || trimmed.length > 420)
        continue;
      const hash = createHash("sha1").update(normalized).digest("hex");
      if (this.hashes.has(hash)) continue;
      this.hashes.add(hash);
      this.sentences.push(trimmed);
      this.tokenSets.push(obtenerTerminos(trimmed));
      if (this.sentences.length >= 6000) break;
    }
  }

  isDuplicate(text, threshold = 0.72) {
    const normalized = normalizarTexto(text);
    if (normalized.length < 12) return false;
    if (this.hashes.has(createHash("sha1").update(normalized).digest("hex")))
      return true;
    const candidate = obtenerTerminos(text);
    return this.tokenSets.some(
      (existing) => similitudJaccard(candidate, existing) >= threshold,
    );
  }

  summary(maxChars = 14000) {
    const lines = [];
    if (this.titles.length)
      lines.push(
        "TÍTULOS/APARTADOS:",
        ...this.titles.slice(-180).map((title) => `- ${title}`),
      );
    if (this.sentences.length)
      lines.push(
        "",
        "IDEAS YA EXPLICADAS:",
        ...this.sentences.slice(-320).map((sentence) => `- ${sentence}`),
      );
    return lines.join("\n").slice(0, maxChars);
  }
}
