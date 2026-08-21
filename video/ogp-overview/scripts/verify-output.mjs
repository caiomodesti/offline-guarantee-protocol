import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {getVideoMetadata} from "@remotion/renderer";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const video = path.join(root, "out", "ogp-overview-pt-br.mp4");
const subtitle = path.join(root, "out", "ogp-overview-pt-br.srt");
const thumbnail = path.join(root, "out", "ogp-thumbnail.png");

for (const file of [video, subtitle, thumbnail]) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error(`Artefato ausente ou vazio: ${file}`);
  }
}

const metadata = await getVideoMetadata(video);
if (metadata.width !== 1920 || metadata.height !== 1080) {
  throw new Error(`Resolução inesperada: ${metadata.width}x${metadata.height}`);
}
if (metadata.durationInSeconds < 118 || metadata.durationInSeconds > 122) {
  throw new Error(`Duração inesperada: ${metadata.durationInSeconds}s`);
}
if (!metadata.audioCodec) {
  throw new Error("Faixa de áudio ausente.");
}
if (metadata.codec !== "h264") {
  throw new Error(`Codec de vídeo inesperado: ${metadata.codec}`);
}

console.log(JSON.stringify({
  video,
  bytes: fs.statSync(video).size,
  width: metadata.width,
  height: metadata.height,
  durationInSeconds: metadata.durationInSeconds,
  videoCodec: metadata.codec,
  audioCodec: metadata.audioCodec,
  subtitleBytes: fs.statSync(subtitle).size,
  thumbnailBytes: fs.statSync(thumbnail).size,
}, null, 2));
