import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");
const audioDir = path.join(publicDir, "audio");
const outDir = path.join(root, "out");
fs.mkdirSync(audioDir, {recursive: true});
fs.mkdirSync(outDir, {recursive: true});

const sampleRate = 48000;
const duration = 120;
const samples = sampleRate * duration;
const pcm = Buffer.alloc(samples * 2);

let seed = 0x0a6f7669;
const random = () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0xffffffff;
};

for (let i = 0; i < samples; i += 1) {
  const t = i / sampleRate;
  const phrase = t % 16;
  const fadeIn = Math.min(1, t / 2.5);
  const fadeOut = Math.min(1, (duration - t) / 3);
  const pulse = Math.exp(-3.2 * (phrase % 4));
  const pad =
    Math.sin(2 * Math.PI * 55 * t) * 0.10 +
    Math.sin(2 * Math.PI * 82.5 * t + 0.8) * 0.055 +
    Math.sin(2 * Math.PI * 110 * t + 1.7) * 0.035;
  const shimmer = Math.sin(2 * Math.PI * 440 * t) * 0.008 * (0.3 + pulse);
  const noise = (random() * 2 - 1) * 0.0025;
  const beat = Math.sin(2 * Math.PI * 0.5 * t) > 0.985 ? Math.sin(2 * Math.PI * 72 * t) * 0.04 : 0;
  const sample = Math.max(-1, Math.min(1, (pad + shimmer + noise + beat) * fadeIn * fadeOut));
  pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
}

const wav = Buffer.alloc(44 + pcm.length);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + pcm.length, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(pcm.length, 40);
pcm.copy(wav, 44);
fs.writeFileSync(path.join(audioDir, "ogp-ambient-original.wav"), wav);

const cues = JSON.parse(fs.readFileSync(path.join(root, "data", "cues.json"), "utf8"));
const timecode = (frames) => {
  const totalMs = Math.round((frames / 30) * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};
const srt = cues.map((cue, index) => `${index + 1}\n${timecode(cue.from)} --> ${timecode(cue.to)}\n${cue.text}\n`).join("\n");
fs.writeFileSync(path.join(outDir, "ogp-overview-pt-br.srt"), srt);

const script = cues.map((cue) => cue.text).join(" ");
fs.writeFileSync(path.join(outDir, "narration-script-pt-br.txt"), `${script}\n`);
console.log("Trilha original, SRT e roteiro gerados.");
